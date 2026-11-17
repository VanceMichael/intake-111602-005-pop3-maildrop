import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

// 状态机（任何状态都不允许从“发过 DELE”直接推出）：
// retained             完整原件已留存，来源端仍可能在邮箱里
// marked               本会话 DELE 已确认，尚未 QUIT，邮箱未更新
// marked-ambiguous     DELE 应答前断连，是否已标记无法确认
// deleted-confirmed    新会话核对确认邮箱里已不存在（唯一可视为“已清掉”的状态）
// acknowledged-unverified  QUIT 应答确认但尚未经新会话核对
// quit-ambiguous       QUIT 应答前断连，删除是否生效未知，禁止再下结论
// still-present        核对发现仍在邮箱，回到可重新标记的安全起点
// present-again        曾确认删除后又出现（来源端回滚等异常），需要人工处置
export const CLEANUP_STATES = Object.freeze({
  RETAINED: 'retained',
  MARKED: 'marked',
  MARKED_AMBIGUOUS: 'marked-ambiguous',
  DELETED_CONFIRMED: 'deleted-confirmed',
  ACKNOWLEDGED_UNVERIFIED: 'acknowledged-unverified',
  QUIT_AMBIGUOUS: 'quit-ambiguous',
  STILL_PRESENT: 'still-present',
  PRESENT_AGAIN: 'present-again'
});

export class Ledger {
  constructor(root) {
    this.root = root;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.root, 'ledger'), { recursive: true });
    return this;
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

  async run(task) {
    const operation = this.serial.then(async () => {
      await this.initialize();
      return task();
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async readAll() {
    await this.initialize();
    const names = (await readdir(join(this.root, 'ledger')))
      .filter(name => name.endsWith('.json') && !name.startsWith('reconciliation-') && name !== 'counters.json')
      .sort();
    return Promise.all(names.map(name => readFile(join(this.root, 'ledger', name), 'utf8').then(JSON.parse)));
  }

  async nextSessionId() {
    return this.run(async () => {
      const path = join(this.root, 'ledger', 'counters.json');
      let counters = { nextSessionId: 1 };
      try {
        counters = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const sessionId = counters.nextSessionId++;
      await this.atomic(path, Buffer.from(JSON.stringify(counters, null, 2)));
      return sessionId;
    });
  }

  async saveMessage(record) {
    await this.atomic(join(this.root, 'ledger', `message-${record.id}.json`),
      Buffer.from(JSON.stringify(record, null, 2)));
    return record;
  }

  async findByUidl(uidl) {
    const records = await this.readAll();
    return records.find(record => record.identity?.basis === 'uidl' && record.identity.uidl === uidl) || null;
  }

  async findByDigest(digest) {
    const records = await this.readAll();
    return records.find(record => record.identity?.digest === digest) || null;
  }

  async saveReconciliation(record) {
    await this.atomic(join(this.root, 'ledger', `reconciliation-${record.id}.json`),
      Buffer.from(JSON.stringify(record, null, 2)));
    return record;
  }

  async reconciliations() {
    await this.initialize();
    const names = (await readdir(join(this.root, 'ledger')))
      .filter(name => name.startsWith('reconciliation-')).sort();
    return Promise.all(names.map(name => readFile(join(this.root, 'ledger', name), 'utf8').then(JSON.parse)));
  }
}
