import { Catalog } from './catalog.mjs';
import { Ledger, STATUS, digestOf } from './ledger.mjs';
import { Pop3Session, Pop3Error } from './pop3.mjs';
import { decode, extractMessage } from './decode.mjs';

const NO_UIDL_LIMITS = [
  '来源当前不支持 UIDL，邮箱内没有稳定编号，会话编号只在该次连接内有效',
  '身份仅由完整原件的 SHA-256 摘要确认；摘要相同的两封来信无法区分，可能是两封不同邮件',
  '主题、日期、Message-ID 不作为合并依据（Message-ID 不保证存在或唯一）',
  '若来源端重新投递，摘要比对无法判断它是否就是原来的那一封'
];

const UIDL_LIMITS = [
  'UIDL 仅在当前来源邮箱内有效，不能与其他邮箱混用',
  'Message-ID 不保证存在或唯一，仅作头部信息留存'
];

export class MailboxService {
  constructor({ source, root, clientOptions } = {}) {
    if (!source || !root) throw new TypeError('source 与 root 不能为空');
    this.source = source;
    this.root = root;
    this.catalog = new Catalog(root);
    this.ledger = new Ledger(root, source);
    this.clientOptions = clientOptions;
  }

  async openSession() {
    const sessionId = await this.ledger.nextSessionId();
    const session = new Pop3Session(this.source, sessionId, this.clientOptions);
    return { sessionId, session };
  }

  // 用一次全新连接读取邮箱现状，作为后续所有判断的唯一依据。
  async discover() {
    const { sessionId, session } = await this.openSession();
    try {
      const capabilities = await session.capa();
      const uidl = await session.uidl();
      if (capabilities.uidl && uidl.supported) {
        return { sessionId, uidlSupported: true, entries: uidl.entries };
      }
      // 无 UIDL：LIST 只能给出本会话编号与大小，编号在下次连接里不保证稳定。
      const listing = await session.list();
      return {
        sessionId,
        uidlSupported: false,
        entries: listing.map(item => ({ number: item.number, uid: null, size: item.size }))
      };
    } finally {
      // 发现阶段只发只读命令，直接断开不影响邮箱状态。
      await safeClose(session);
    }
  }

  // 正式收件：只有完整 RETR 通过校验并写入原件目录后才登记台账。
  // TOP 看到的正文只是预览，不产生任何收件记录。编号只在本次新开会话内有效。
  async intake({ number = 1 } = {}) {
    const { sessionId, session } = await this.openSession();
    try {
      const result = await session.retr(number);
      const preview = decode(result.bytes);
      const messageBytes = extractMessage(result.bytes);
      const digest = digestOf(messageBytes);
      const capabilities = await session.capa();
      const uidl = await session.uidl();
      const listing = uidl.supported ? uidl.entries : await session.list();
      const receipt = await this.catalog.accept({
        source: result.url, bytes: messageBytes,
        mediaType: 'message/rfc822', preview
      });
      const uid = uidl.supported ? (uidl.entries.find(item => item.number === number)?.uid ?? null) : null;
      const outcome = await this.ledger.mutate(state => {
        const identity = uid ? 'uidl' : 'digest';
        const { record, created } = this.ledger.findOrCreate(state, {
          uid, digest, identity,
          identityLimits: uid ? UIDL_LIMITS : NO_UIDL_LIMITS,
          identityNote: uid ? null : '无 UIDL 来源：身份仅由完整摘要确认，重投或同摘要多信无法区分'
        });
        record.size = messageBytes.length;
        record.messageId = preview.headers['message-id'] ?? null;
        record.subject = preview.headers.subject ?? null;
        if (!record.receiptIds.includes(receipt.id)) record.receiptIds.push(receipt.id);
        this.ledger.appendHistory(record, 'retr-received', {
          sessionId, number,
          evidence: uid
            ? { uidlSupported: true, uid, sessionListing: uidl.entries }
            : { uidlSupported: false, digest, sessionListing: listing },
          detail: { receiptId: receipt.id, source: result.url }
        });
        return { receipt, record: publicRecord(record), created };
      });
      return { sessionId, ...outcome };
    } finally {
      await safeClose(session);
    }
  }

  // 清理：只删除本地已有完整凭据的邮件；删除前先做一次新鲜核对。
  async purge() {
    const discovery = await this.discover();
    const { sessionId, session } = await this.openSession();
    const marked = [];
    const skipped = [];
    try {
      const plan = await this.planDeletions(discovery, skipped);
      for (const item of plan) {
        await session.dele(item.number);
        await this.ledger.mutate(state => {
          const record = state.records[item.recordId];
          record.status = STATUS.DELETE_MARKED;
          this.ledger.appendHistory(record, 'dele-sent', {
            sessionId, number: item.number,
            evidence: discovery.uidlSupported
              ? { uidl: item.uid }
              : { digest: item.digest, sessionListing: discovery.entries },
            detail: { note: 'DELE 只是本会话标记，QUIT 应答前来源端未更新' }
          });
        });
        marked.push(item);
      }
      const quit = await session.quit();
      if (quit.outcome === 'acknowledged') {
        // +OK 只能证明“本次标记的邮件”进入更新流程，仍要以新会话列表复核。
        await this.ledger.mutate(state => {
          for (const item of marked) {
            const record = state.records[item.recordId];
            this.ledger.appendHistory(record, 'quit-acknowledged', {
              sessionId, detail: { note: '收到 QUIT +OK，等待新会话列表最终确认' }
            });
          }
        });
      } else {
        // QUIT 无应答：客户端无法区分“退出前断开（删除未提交）”与“已生效但应答丢失”，
        // 一律保持待核对，绝不能按已发命令推断，结论只能来自下一次新会话证据。
        await this.ledger.mutate(state => {
          for (const item of marked) {
            const record = state.records[item.recordId];
            record.status = STATUS.QUIT_AMBIGUOUS;
            this.ledger.appendHistory(record, 'quit-response-lost', {
              sessionId,
              detail: {
                note: 'QUIT 已发出但未收到应答，来源端可能已更新也可能未更新，禁止按已发命令推断；等待新会话核对',
                error: quit.cause?.message ?? null
              }
            });
          }
        });
      }
      const reconciliation = await this.reconcile();
      return { sessionId, quit: quit.outcome, marked, skipped, reconciliation };
    } catch (error) {
      // DELE 阶段或其它命令在 QUIT 前断开：标记随会话失效，记录回到 received。
      if (error instanceof Pop3Error && error.kind === 'disconnect') {
        await this.ledger.mutate(state => {
          for (const item of marked) {
            const record = state.records[item.recordId];
            record.status = STATUS.RECEIVED;
            this.ledger.appendHistory(record, 'session-dropped-before-quit', {
              sessionId, detail: { note: '连接在 QUIT 前断开，本会话 DELE 未提交，邮件仍在来源端', error: error.message }
            });
          }
        });
      }
      throw error;
    } finally {
      await safeClose(session);
    }
  }

  async planDeletions(discovery, skipped) {
    const state = await this.ledger.load();
    const records = Object.values(state.records);
    const plan = [];
    if (discovery.uidlSupported) {
      const byUid = new Map(records.filter(r => r.uidl).map(r => [r.uidl, r]));
      for (const entry of discovery.entries) {
        const record = byUid.get(entry.uid);
        if (!record) { skipped.push({ number: entry.number, uid: entry.uid, reason: '本地没有完整原件凭据' }); continue; }
        if (record.status === STATUS.DELETED_CONFIRMED) { skipped.push({ number: entry.number, uid: entry.uid, reason: '已确认清理' }); continue; }
        plan.push({ number: entry.number, uid: entry.uid, digest: record.digest, recordId: record.id });
      }
    } else {
      // 无 UIDL：逐个 RETR 取完整摘要再决定，禁止按主题/日期合并。
      // 同一摘要可能对应多封来信；只要本地有该摘要的完整凭据，邮箱中的每一封都可被标记。
      const { sessionId, session } = await this.openSession();
      try {
        const byDigest = new Map(records
          .filter(r => r.identity === 'digest' && r.status !== STATUS.DELETED_CONFIRMED)
          .map(r => [r.digest, r]));
        for (const entry of discovery.entries) {
          let result;
          try {
            result = await session.retr(entry.number);
          } catch (error) {
            skipped.push({ number: entry.number, reason: `RETR 失败，跳过：${error.message}` });
            continue;
          }
          const digest = digestOf(extractMessage(result.bytes));
          const record = byDigest.get(digest);
          if (!record) {
            skipped.push({ number: entry.number, digest, reason: '本地没有同摘要的完整原件凭据' });
            continue;
          }
          plan.push({ number: entry.number, digest, recordId: record.id });
        }
      } finally {
        await safeClose(session);
      }
    }
    return plan;
  }

  // 用全新会话的邮箱现状重判每一封的真实状态，是交接后唯一可信的核对入口。
  async reconcile() {
    const discovery = await this.discover();
    let presentDigests = null;
    if (!discovery.uidlSupported) {
      // 无 UIDL：编号在新会话里重新排列，列表本身不含身份，
      // 只能逐封完整 RETR 取摘要与本地凭据比对。
      presentDigests = new Map();
      const { session } = await this.openSession();
      try {
        for (const entry of discovery.entries) {
          try {
            const result = await session.retr(entry.number);
            presentDigests.set(entry.number, digestOf(extractMessage(result.bytes)));
          } catch (error) {
            presentDigests.set(entry.number, { error: error.message });
          }
        }
      } finally {
        await safeClose(session);
      }
    }
    return this.ledger.mutate(state => {
      const records = Object.values(state.records);
      const findings = [];
      if (discovery.uidlSupported) {
        const presentUids = new Set(discovery.entries.map(entry => entry.uid));
        for (const record of records) {
          if (!record.uidl) continue;
          const seen = presentUids.has(record.uidl);
          findings.push(this.applyFinding(record, seen, discovery,
            seen ? '新会话 UIDL 列表仍包含该邮件' : '新会话 UIDL 列表已无该 UIDL，确认来源端已删除'));
        }
        const knownUids = new Set(records.filter(r => r.uidl).map(r => r.uidl));
        for (const entry of discovery.entries) {
          if (!knownUids.has(entry.uid)) {
            findings.push({ recordId: null, uid: entry.uid, number: entry.number,
              status: 'unmanaged', note: '来源端存在本地无凭据的邮件，不会被清理' });
          }
        }
      } else {
        const digestCounts = new Map();
        for (const value of presentDigests.values()) {
          if (typeof value === 'string') digestCounts.set(value, (digestCounts.get(value) || 0) + 1);
        }
        for (const record of records) {
          if (record.identity !== 'digest') continue;
          const seen = digestCounts.has(record.digest);
          findings.push(this.applyFinding(record, seen, discovery,
            seen
              ? '新会话逐封 RETR 摘要比对：来源端仍存在同摘要原件，之前的删除未生效'
              : '新会话逐封 RETR 摘要比对：来源端已无同摘要原件，确认已删除'));
        }
        const knownDigests = new Set(records.filter(r => r.identity === 'digest').map(r => r.digest));
        for (const entry of discovery.entries) {
          const value = presentDigests.get(entry.number);
          if (typeof value === 'string' && !knownDigests.has(value)) {
            findings.push({ recordId: null, number: entry.number, digest: value,
              status: 'unmanaged', note: '来源端存在本地无凭据的邮件，不会被清理' });
          } else if (typeof value !== 'string') {
            findings.push({ recordId: null, number: entry.number,
              status: 'unverifiable', note: `RETR 失败，身份无法确认：${value.error}` });
          }
        }
      }
      return {
        sessionId: discovery.sessionId,
        uidlSupported: discovery.uidlSupported,
        listing: discovery.entries,
        findings
      };
    });
  }

  applyFinding(record, seen, discovery, note) {
    const before = record.status;
    if (!seen && before !== STATUS.DELETED_CONFIRMED) {
      record.status = STATUS.DELETED_CONFIRMED;
      this.ledger.appendHistory(record, 'absence-confirmed', {
        sessionId: discovery.sessionId, evidence: { listing: discovery.entries }, detail: { note }
      });
    } else if (seen && (before === STATUS.DELETE_MARKED || before === STATUS.QUIT_AMBIGUOUS)) {
      record.status = STATUS.RECEIVED;
      this.ledger.appendHistory(record, 'still-present', {
        sessionId: discovery.sessionId, evidence: { listing: discovery.entries },
        detail: { note: '新会话仍可见，之前的 DELE/QUIT 未生效，按在箱邮件处理' }
      });
    } else {
      this.ledger.appendHistory(record, 'reconcile-checked', {
        sessionId: discovery.sessionId, evidence: { listing: discovery.entries }, detail: { note }
      });
    }
    return { recordId: record.id, status: record.status, before, note };
  }

  async status() {
    const state = await this.ledger.snapshot();
    const counts = {};
    for (const record of state.records) counts[record.status] = (counts[record.status] || 0) + 1;
    return {
      source: state.source,
      nextSession: state.nextSession,
      counts,
      records: state.records.map(publicRecord),
      handoff: {
        rule: '以最新一次新会话证据为准；delete-marked 与 quit-ambiguous 均不代表来源端已更新',
        openQuestions: state.records
          .filter(r => r.status === STATUS.QUIT_AMBIGUOUS || r.status === STATUS.DELETE_MARKED)
          .map(r => ({ id: r.id, status: r.status, identity: r.identity, digest: r.digest, uidl: r.uidl }))
      }
    };
  }
}

function publicRecord(record) {
  return {
    id: record.id,
    status: record.status,
    identity: record.identity,
    identityLimits: record.identityLimits,
    identityNote: record.identityNote,
    uidl: record.uidl,
    uidlScope: record.uidlScope,
    digest: record.digest,
    messageId: record.messageId,
    subject: record.subject,
    size: record.size,
    receiptIds: record.receiptIds,
    duplicateCount: record.duplicateCount,
    history: record.history
  };
}

async function safeClose(session) {
  if (session.closed) return;
  // 只读会话没有 DELE 标记，直接结束即可；不发 QUIT，以免消费来源端的一次性故障注入。
  session.closed = true;
}
