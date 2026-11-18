import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';

export const STATUS = Object.freeze({
  RECEIVED: 'received',                 // 完整 RETR 已留存
  DELETE_MARKED: 'delete-marked',       // 本会话已发 DELE，尚未确认提交
  DELETED_CONFIRMED: 'deleted-confirmed', // 已由新会话证据确认来源端不存在
  QUIT_AMBIGUOUS: 'quit-ambiguous'      // QUIT 应答丢失，来源端是否已删未知
});

// 台账与原件目录并列，所有写入走 tmp + fsync + rename。
// 状态只能由带证据的事件推进，不根据“上一次发过什么命令”推断。
export class Ledger {
  constructor(root, source) {
    this.root = root;
    this.source = source;
    this.ledgerPath = join(root, 'ledger', 'state.json');
    this.writing = Promise.resolve();
  }

  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.ledgerPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, source: this.source, nextSession: 1, records: {} };
    }
  }

  async save(state) {
    await mkdir(join(this.root, 'ledger'), { recursive: true });
    await this.atomic(this.ledgerPath, Buffer.from(JSON.stringify(state, null, 2)));
  }

  // 串行化写入：无论上一步成功与否都放行下一步，结果由各调用方自己处理。
  async mutate(fn) {
    const previous = this.writing;
    let release;
    this.writing = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      const state = await this.load();
      const result = await fn(state);
      await this.save(state);
      return result;
    } finally {
      release();
    }
  }

  nextSessionId() {
    return this.mutate(state => {
      const sessionId = state.nextSession++;
      return sessionId;
    });
  }

  appendHistory(record, event, { sessionId, number, evidence, detail } = {}) {
    record.history.push({
      event, at: new Date().toISOString(),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(evidence ? { evidence } : {}),
      ...(detail ? { detail } : {})
    });
  }

  findOrCreate(state, { uid, digest, identity, identityLimits, identityNote }) {
    const records = Object.values(state.records);
    let record;
    if (uid) {
      record = records.find(item => item.uidl === uid && item.uidlScope === this.source);
    } else {
      // 无 UIDL：完整摘要相同才视为同一份原件；主题、日期、Message-ID 均不参与合并。
      record = records.find(item => item.identity === 'digest' && item.digest === digest);
      if (record) {
        record.duplicateCount += 1;
        record.identityNote = identityNote || record.identityNote;
      }
    }
    if (record) return { record, created: false };
    const id = randomUUID();
    record = {
      id,
      identity,
      identityLimits,
      identityNote: identityNote || null,
      uidl: uid || null,
      uidlScope: uid ? this.source : null,
      digest,
      messageId: null,
      subject: null,
      size: null,
      receiptIds: [],
      duplicateCount: 1,
      status: STATUS.RECEIVED,
      history: []
    };
    state.records[id] = record;
    return { record, created: true };
  }

  snapshot() {
    return this.load().then(state => ({
      source: state.source,
      nextSession: state.nextSession,
      records: Object.values(state.records)
    }));
  }
}

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
