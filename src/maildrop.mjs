import { randomUUID } from 'node:crypto';
import { Pop3Ambiguous, Pop3Error, Pop3Session } from './pop3.mjs';
import { decode, extractMessage } from './decode.mjs';
import { buildIdentity } from './identity.mjs';
import { CLEANUP_STATES } from './ledger.mjs';

const now = () => new Date().toISOString();

// 正式收件与来源端清理的编排。所有结论只来自完整原件与新会话核对，不来自“上一次发过什么命令”。
export class Maildrop {
  constructor({ source, catalog, ledger, pop3Factory = null }) {
    if (!source || !catalog || !ledger) throw new TypeError('来源、原件目录与台账不能为空');
    this.source = source;
    this.catalog = catalog;
    this.ledger = ledger;
    this.pop3Factory = pop3Factory || ((sessionId) => new Pop3Session(source, sessionId));
  }

  async openSession(sessionId) {
    const id = sessionId ?? (await this.ledger.nextSessionId());
    const pop3 = this.pop3Factory(id, this);
    const capabilities = await pop3.capa();
    return { sessionId: pop3.sessionId, pop3, capabilities,
      uidlSupported: capabilities.uidl, openedAt: now() };
  }

  // 扫描当前会话邮箱：只记录编号与 UIDL 的临时对应关系。编号不写入长期身份。
  async scan(sessionId) {
    const { pop3, uidlSupported } = await this.openSession(sessionId);
    const result = { sessionId: pop3.sessionId, uidlSupported, at: now(), entries: [] };
    if (uidlSupported) {
      result.entries = (await pop3.uidlAll()).map(({ number, uidl }) => ({ number, uidl }));
    } else {
      // 无 UIDL：编号背后是什么只能靠逐封 RETR 完整原件，用摘要确认。
      let number = 1;
      for (;;) {
        try {
          const bytes = await pop3.retr(number);
          const message = extractMessage(bytes);
          const { digest } = buildIdentity({ messageBytes: message });
          result.entries.push({ number, digest });
          number++;
        } catch (error) {
          if (error instanceof Pop3Error && error.command === 'retr') break;
          throw error;
        }
      }
    }
    return result;
  }

  // 正式收件：只接受 RETR 的完整应答；TOP 永远走不到这里。
  async receive({ sessionId, number }) {
    const { pop3, uidlSupported } = await this.openSession(sessionId);
    const bytes = await pop3.retr(number);
    const message = extractMessage(bytes);
    const preview = decode(bytes);
    let uidl = null;
    if (uidlSupported) {
      const entries = await pop3.uidlAll();
      const entry = entries.find(item => item.number === number);
      if (!entry) throw new Error(`会话 ${pop3.sessionId} 中没有编号 ${number}，不能凭编号收件`);
      uidl = entry.uidl;
    }
    const identity = buildIdentity({ uidl, messageBytes: message, headers: preview.headers });
    const existing = uidl ? await this.ledger.findByUidl(uidl) : await this.ledger.findByDigest(identity.digest);
    const warnings = [];
    if (existing) {
      if (uidl) {
        return { duplicate: true, record: existing, warnings: ['该 UIDL 已有收件记录，未重复留存'] };
      }
      warnings.push('无 UIDL 且完整原件摘要与既有记录相同：可能是同一封，也可能是内容完全相同的两封，系统未合并，需人工确认');
    }
    const receipt = await this.catalog.accept({
      source: pop3.path('retr', number), bytes,
      mediaType: 'application/octet-stream', preview
    });
    const record = await this.ledger.run(() => this.ledger.saveMessage({
      id: randomUUID(),
      identity,
      digest: identity.digest,
      cleanupState: CLEANUP_STATES.RETAINED,
      retained: { receiptId: receipt.id, bytes: message.length, objectDigest: receipt.digest, at: now() },
      observedAtSession: pop3.sessionId,
      history: [{ at: now(), event: 'retained',
        detail: { sessionId: pop3.sessionId, number, uidlSupported, source: receipt.source } }],
      warnings: [...identity.uncertainty, ...warnings]
    }));
    return { duplicate: false, record, warnings: record.warnings };
  }

  // 标记删除：本地完整原件必须先在；DELE 成功也只改变本会话状态，邮箱尚未更新。
  async markForDeletion({ sessionId, number }) {
    const { pop3, uidlSupported } = await this.openSession(sessionId);
    const target = await this.resolveTarget({ pop3, uidlSupported, sessionId: pop3.sessionId, number });
    if (target.record.cleanupState === CLEANUP_STATES.MARKED && target.record.markedInSession === pop3.sessionId) {
      throw new Error('该邮件在本会话已标记删除，请勿重复发送 DELE');
    }
    if (target.record.cleanupState === CLEANUP_STATES.DELETED_CONFIRMED) {
      throw new Error('该邮件已经新会话核对确认删除，不能再标记');
    }
    if (target.record.cleanupState === CLEANUP_STATES.PRESENT_AGAIN) {
      throw new Error('该邮件曾确认删除后再次出现，需人工处置，禁止自动标记');
    }
    try {
      await pop3.dele(number);
    } catch (error) {
      if (error instanceof Pop3Ambiguous) {
        await this.patch(target.record, {
          cleanupState: CLEANUP_STATES.MARKED_AMBIGUOUS,
          history: [...target.record.history, { at: now(), event: 'dele-ambiguous',
            detail: { sessionId: pop3.sessionId, number, reason: error.message } }]
        });
        return { record: await this.ledger.findByDigest(target.record.digest), ambiguous: true };
      }
      throw error;
    }
    const updated = await this.patch(target.record, {
      cleanupState: CLEANUP_STATES.MARKED,
      markedInSession: pop3.sessionId,
      markedNumber: number,
      history: [...target.record.history, { at: now(), event: 'dele-confirmed',
        detail: { sessionId: pop3.sessionId, number, note: '仅本会话标记，QUIT 前邮箱未更新' } }]
    });
    return { record: updated, ambiguous: false };
  }

  // 解析编号背后的长期记录，并强制“先留存后删除”。
  async resolveTarget({ pop3, uidlSupported, sessionId, number }) {
    let record;
    if (uidlSupported) {
      const entries = await pop3.uidlAll();
      const entry = entries.find(item => item.number === number);
      if (!entry) throw new Pop3Error('dele', `会话 ${sessionId} 中没有编号 ${number}`, null);
      record = await this.ledger.findByUidl(entry.uidl);
    } else {
      let bytes;
      try {
        bytes = await pop3.retr(number);
      } catch (error) {
        if (error instanceof Pop3Ambiguous) throw new Error(`编号 ${number} 的完整原件无法确认，禁止在未留存情况下删除`);
        throw error;
      }
      const message = extractMessage(bytes);
      record = await this.ledger.findByDigest(buildIdentity({ messageBytes: message }).digest);
    }
    if (!record) throw new Error('编号对应的邮件没有本地完整原件留存记录，禁止 DELE；请先正式收件');
    return { record };
  }

  async patch(record, changes) {
    return this.ledger.run(() => this.ledger.saveMessage({ ...record, ...changes }));
  }

  // 提交删除：QUIT 才是来源端更新点；应答缺失时状态保持未知，等待新会话核对。
  async commitDeletions(sessionId) {
    const { pop3 } = await this.openSession(sessionId);
    const records = await this.ledger.readAll();
    const pending = records.filter(record => record.markedInSession === pop3.sessionId
      && [CLEANUP_STATES.MARKED, CLEANUP_STATES.MARKED_AMBIGUOUS].includes(record.cleanupState));
    if (pending.length === 0) throw new Error(`会话 ${pop3.sessionId} 没有待提交的删除标记`);
    try {
      const quitText = await pop3.quit();
      for (const record of pending) {
        await this.patch(record, {
          cleanupState: CLEANUP_STATES.ACKNOWLEDGED_UNVERIFIED,
          history: [...record.history, { at: now(), event: 'quit-acknowledged',
            detail: { sessionId: pop3.sessionId, reply: quitText, note: 'QUIT 已应答，仍需新会话核对邮箱实际状态' } }]
        });
      }
      return { ambiguous: false, records: await this.recordsOf(pending) };
    } catch (error) {
      if (error instanceof Pop3Ambiguous) {
        for (const record of pending) {
          await this.patch(record, {
            cleanupState: CLEANUP_STATES.QUIT_AMBIGUOUS,
            history: [...record.history, { at: now(), event: 'quit-ambiguous',
              detail: { sessionId: pop3.sessionId, reason: error.message } }]
          });
        }
        return { ambiguous: true, reason: error.message, records: await this.recordsOf(pending) };
      }
      throw error;
    }
  }

  async recordsOf(pending) {
    const records = await this.ledger.readAll();
    const ids = new Set(pending.map(record => record.id));
    return records.filter(record => ids.has(record.id));
  }

  // 新会话核对：以邮箱当前实际内容为唯一依据，消除 QUIT 未知状态。
  async reconcile(sessionId) {
    const scan = await this.scan(sessionId);
    const records = await this.ledger.readAll();
    const presentKeys = new Set();
    const items = [];
    for (const entry of scan.entries) {
      const key = scan.uidlSupported ? `uidl:${entry.uidl}` : `digest:${entry.digest}`;
      presentKeys.add(key);
    }
    for (const record of records) {
      const key = record.identity.basis === 'uidl' ? `uidl:${record.identity.uidl}` : `digest:${record.identity.digest}`;
      const present = presentKeys.has(key);
      let nextState = record.cleanupState;
      let event;
      if (present) {
        if (record.cleanupState === CLEANUP_STATES.DELETED_CONFIRMED) {
          nextState = CLEANUP_STATES.PRESENT_AGAIN;
          event = 'present-again';
        } else if (record.cleanupState !== CLEANUP_STATES.PRESENT_AGAIN) {
          nextState = CLEANUP_STATES.STILL_PRESENT;
          event = 'still-present';
        }
      } else if (record.identity.basis === 'content' && !scan.uidlSupported) {
        nextState = CLEANUP_STATES.DELETED_CONFIRMED;
        event = 'deleted-confirmed';
      } else if (record.identity.basis === 'uidl' && scan.uidlSupported) {
        nextState = CLEANUP_STATES.DELETED_CONFIRMED;
        event = 'deleted-confirmed';
      } else {
        // 能力降级（UIDL 邮箱变成无 UIDL）：摘要匹配只能证明“相同内容不在”，无法排除同内容异邮件。
        event = 'unverifiable-capability-change';
      }
      const detail = { sessionId: scan.sessionId, present, uidlSupported: scan.uidlSupported, event };
      if (event === 'unverifiable-capability-change') detail.reason = '邮箱 UIDL 能力发生变化，跨能力身份无法确认，保持原状态';
      items.push({ id: record.id, previousState: record.cleanupState, state: nextState, present, event, identity: record.identity });
      if (nextState !== record.cleanupState || event === 'unverifiable-capability-change') {
        await this.patch(record, {
          cleanupState: nextState,
          history: [...record.history, { at: now(), event, detail: { ...detail, note: event === 'deleted-confirmed' ? '由新会话邮箱实际状态确认' : undefined } }]
        });
      }
    }
    const reconciliation = { id: randomUUID(), at: now(), sessionId: scan.sessionId,
      uidlSupported: scan.uidlSupported, mailboxEntries: scan.entries.length, items };
    await this.ledger.saveReconciliation(reconciliation);
    return reconciliation;
  }

  // 交接摘要：下一班只看台账与最新核对，不看历史命令。
  async handoff() {
    const records = await this.ledger.readAll();
    const reconciliations = await this.ledger.reconciliations();
    const latest = reconciliations.at(-1) || null;
    const open = records.filter(record => record.cleanupState !== CLEANUP_STATES.DELETED_CONFIRMED);
    return {
      generatedAt: now(),
      totals: { retained: records.length, deletedConfirmed: records.filter(r => r.cleanupState === CLEANUP_STATES.DELETED_CONFIRMED).length, open: open.length },
      latestReconciliation: latest ? { id: latest.id, at: latest.at, sessionId: latest.sessionId, uidlSupported: latest.uidlSupported } : null,
      openItems: open.map(record => ({ id: record.id, cleanupState: record.cleanupState, identity: record.identity, warnings: record.warnings })),
      rule: '只有 deleted-confirmed（经新会话核对）才可视为来源端已清掉；其余均为待办，不能凭 DELE/QUIT 命令记录下结论'
    };
  }
}
