import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';
import { Catalog } from '../src/catalog.mjs';
import { Ledger, CLEANUP_STATES } from '../src/ledger.mjs';
import { Maildrop } from '../src/maildrop.mjs';
import { SourceClient } from '../src/transport.mjs';
import { Pop3Ambiguous, Pop3Session } from '../src/pop3.mjs';
import { decode, extractMessage } from '../src/decode.mjs';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-test-'));
  const source = await startSource({ scenario: 'handoff' });
  const app = await startApplication({ source: source.base, root: directory });
  return {
    directory, source, app,
    maildrop: app.maildrop, client: new SourceClient(source.base),
    async cleanup() { await app.close(); await source.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

const post = (app, path, body = {}) =>
  fetch(`${app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('UIDL 完整流程：留存→标记→提交仍未确认→新会话核对后才确认删除，且只发一次 DELE', async () => {
  const h = await harness();
  try {
    const { maildrop, source } = h;
    const received = await maildrop.receive({ sessionId: 10, number: 1 });
    assert.equal(received.record.cleanupState, CLEANUP_STATES.RETAINED);
    assert.equal(received.record.identity.basis, 'uidl');
    assert.equal(received.record.identity.uidl, 'permanent-01');
    // 同主题同日期的第二封是独立记录，不合并。
    const second = await maildrop.receive({ sessionId: 10, number: 2 });
    assert.notEqual(second.record.id, received.record.id);
    assert.notEqual(second.record.identity.digest, received.record.identity.digest);
    assert.equal(second.record.identity.headerRef.subject, received.record.identity.headerRef.subject);
    assert.equal(second.record.identity.headerRef.date, received.record.identity.headerRef.date);

    const marked = await maildrop.markForDeletion({ sessionId: 11, number: 1 });
    assert.equal(marked.record.cleanupState, CLEANUP_STATES.MARKED);
    assert.equal(marked.ambiguous, false);
    // 提交前另一个会话看到邮件仍在（DELE 只在会话 11 内有效）。
    const scanBefore = await maildrop.scan(12);
    assert.deepEqual(scanBefore.entries.map(e => e.uidl), ['permanent-01', 'permanent-02']);

    const committed = await maildrop.commitDeletions(11);
    assert.equal(committed.ambiguous, false);
    assert.equal(committed.records[0].cleanupState, CLEANUP_STATES.ACKNOWLEDGED_UNVERIFIED);
    // QUIT 已应答也不等于确认：交接摘要仍列为待办。
    let handoff = await maildrop.handoff();
    assert.equal(handoff.totals.open, 2);
    assert.ok(handoff.openItems.some(item => item.cleanupState === CLEANUP_STATES.ACKNOWLEDGED_UNVERIFIED));

    // 新会话核对：会话 22 只剩 permanent-02，编号已重排为 1。
    const reconciliation = await maildrop.reconcile(22);
    const item = reconciliation.items.find(entry => entry.id === marked.record.id);
    assert.equal(item.present, false);
    assert.equal(item.state, CLEANUP_STATES.DELETED_CONFIRMED);
    const records = await h.app.ledger.readAll();
    const confirmed = records.find(r => r.id === marked.record.id);
    assert.equal(confirmed.cleanupState, CLEANUP_STATES.DELETED_CONFIRMED);
    handoff = await maildrop.handoff();
    assert.equal(handoff.totals.deletedConfirmed, 1);
    assert.equal(handoff.totals.open, 1);
    // 整个流程对该邮件只发过一次 DELE（不依赖“再清空一次”消疑）。
    const audit = await h.client.control({ action: 'inspect' });
    const deleCalls = audit.requests.filter(r => r.path === '/session/11/dele/1');
    assert.equal(deleCalls.length, 1);
    void source;
  } finally { await h.cleanup(); }
});

test('QUIT 应答前断连：状态保持未知，新会话核对后按邮箱实际状态收敛，不重发删除命令', async () => {
  const h = await harness();
  try {
    const { maildrop } = h;
    await maildrop.receive({ sessionId: 30, number: 1 });
    await maildrop.markForDeletion({ sessionId: 30, number: 1 });
    // 会话 30 配置 after-commit：领域已更新但连接被销毁，客户端收不到应答。
    const committed = await maildrop.commitDeletions(30);
    assert.equal(committed.ambiguous, true);
    assert.equal(committed.records[0].cleanupState, CLEANUP_STATES.QUIT_AMBIGUOUS);
    const handoffBefore = await maildrop.handoff();
    assert.ok(handoffBefore.openItems.some(item => item.cleanupState === CLEANUP_STATES.QUIT_AMBIGUOUS));

    // 下一班不看命令历史，直接开新会话 22 核对邮箱实际状态。
    const reconciliation = await maildrop.reconcile(22);
    const item = reconciliation.items.find(entry => entry.identity.uidl === 'permanent-01');
    assert.equal(item.state, CLEANUP_STATES.DELETED_CONFIRMED);
    assert.equal(item.event, 'deleted-confirmed');
    const audit = await h.client.control({ action: 'inspect' });
    // 核对过程只发扫描类请求，没有再发 DELE/QUIT。
    assert.equal(audit.requests.filter(r => r.path.includes('/dele/')).length, 1);
    assert.equal(audit.requests.filter(r => r.path.includes('/quit')).length, 1);
  } finally { await h.cleanup(); }
});

test('DELE 应答前断连：标记状态未知且邮箱未更新，重新标记前邮件确认仍在', async () => {
  const h = await harness();
  try {
    const { maildrop } = h;
    await maildrop.receive({ sessionId: 13, number: 1 });
    const marked = await maildrop.markForDeletion({ sessionId: 13, number: 1 });
    assert.equal(marked.ambiguous, true);
    assert.equal(marked.record.cleanupState, CLEANUP_STATES.MARKED_AMBIGUOUS);
    // before-commit：领域未执行 DELE，会话 14 扫描仍能看到两封。
    const scan = await maildrop.scan(14);
    assert.equal(scan.entries.length, 2);
    // 用新会话重新标记（旧会话编号已不可靠），随后正常提交与核对。
    const remark = await maildrop.markForDeletion({ sessionId: 14, number: 1 });
    assert.equal(remark.record.cleanupState, CLEANUP_STATES.MARKED);
    await maildrop.commitDeletions(14);
    const reconciliation = await maildrop.reconcile(22);
    const item = reconciliation.items.find(entry => entry.identity.uidl === 'permanent-01');
    assert.equal(item.state, CLEANUP_STATES.DELETED_CONFIRMED);
  } finally { await h.cleanup(); }
});

test('无 UIDL 邮箱：身份降级为完整原件摘要，同主题同日期邮件保持独立并显式记录不确定性', async () => {
  const h = await harness();
  try {
    const { maildrop, client } = h;
    await client.control({ action: 'advance' });
    const capabilities = await maildrop.openSession(50);
    assert.equal(capabilities.uidlSupported, false);
    const first = await maildrop.receive({ sessionId: 50, number: 1 });
    const second = await maildrop.receive({ sessionId: 50, number: 2 });
    assert.equal(first.record.identity.basis, 'content');
    assert.equal(second.record.identity.basis, 'content');
    assert.notEqual(first.record.id, second.record.id);
    assert.ok(first.record.warnings.some(w => w.includes('UIDL')));
    assert.equal(first.record.identity.headerRef.subject, second.record.identity.headerRef.subject);
    // 无 UIDL 时编号不能直接删除：标记动作内部先 RETR 完整原件比对摘要。
    const marked = await maildrop.markForDeletion({ sessionId: 51, number: 1 });
    assert.equal(marked.record.cleanupState, CLEANUP_STATES.MARKED);
    await maildrop.commitDeletions(51);
    // 新会话 53 邮箱只剩第二封，核对确认第一封已删、第二封仍在。
    const reconciliation = await maildrop.reconcile(53);
    const byDigest = Object.fromEntries(reconciliation.items.map(item => [item.identity.digest, item]));
    assert.equal(byDigest[first.record.identity.digest].state, CLEANUP_STATES.DELETED_CONFIRMED);
    assert.equal(byDigest[second.record.identity.digest].state, CLEANUP_STATES.STILL_PRESENT);
  } finally { await h.cleanup(); }
});

test('安全护栏：未留存禁止 DELE；TOP 预览不能作为收妥依据；已确认删除禁止再标记', async () => {
  const h = await harness();
  try {
    const { maildrop } = h;
    // 没有任何留存记录时直接标记删除被拒绝。
    await assert.rejects(maildrop.markForDeletion({ sessionId: 40, number: 1 }), /没有本地完整原件留存/);
    // TOP 能取回部分正文，但系统没有任何路径把它转成收件记录。
    const pop3 = new Pop3Session(h.client, 20);
    const topBytes = await pop3.top(1);
    assert.doesNotThrow(() => decode(topBytes));
    const records = await h.app.ledger.readAll();
    assert.equal(records.length, 0);
    await assert.rejects(maildrop.markForDeletion({ sessionId: 20, number: 1 }), /没有本地完整原件留存/);

    // 完整收件→删除→核对确认后，再次标记必须被拒绝。
    await maildrop.receive({ sessionId: 41, number: 1 });
    await maildrop.markForDeletion({ sessionId: 42, number: 1 });
    await maildrop.commitDeletions(42);
    await maildrop.reconcile(22);
    await assert.rejects(maildrop.markForDeletion({ sessionId: 40, number: 1 }), /已经新会话核对确认删除/);
  } finally { await h.cleanup(); }
});

test('台账与原件持久化：重开目录后下一班可继续核对，历史状态不依赖内存', async () => {
  const h = await harness();
  try {
    const { maildrop, directory } = h;
    await maildrop.receive({ sessionId: 10, number: 1 });
    await maildrop.markForDeletion({ sessionId: 11, number: 1 });
    await maildrop.commitDeletions(11);
    // 模拟交班：重新构造全部组件。
    const reopenedCatalog = await new Catalog(directory).initialize();
    const reopenedLedger = await new Ledger(directory).initialize();
    const reopened = new Maildrop({ source: h.client, catalog: reopenedCatalog, ledger: reopenedLedger });
    const reconciliation = await reopened.reconcile(22);
    assert.equal(reconciliation.items[0].state, CLEANUP_STATES.DELETED_CONFIRMED);
    const handoff = await reopened.handoff();
    assert.equal(handoff.totals.deletedConfirmed, 1);
    // 原件仍可按摘要回读校验。
    const records = await reopenedLedger.readAll();
    const bytes = await reopenedCatalog.object(records[0].retained.objectDigest);
    assert.equal(extractMessage(bytes).length, records[0].retained.bytes);
  } finally { await h.cleanup(); }
});

test('HTTP 接口完整走通，未知断连收敛为 ambiguous 结果且不丢失台账状态', async () => {
  const h = await harness();
  try {
    const { app } = h;
    let response = await post(app, '/maildrop/sessions', { sessionId: 10 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).uidlSupported, true);
    response = await post(app, '/maildrop/receive', { sessionId: 10, number: 1 });
    assert.equal(response.status, 201);
    const record = (await response.json()).record;
    response = await post(app, '/maildrop/mark-deletion', { sessionId: 30, number: 1 });
    assert.equal(response.status, 200);
    response = await post(app, '/maildrop/commit', { sessionId: 30 });
    // 编排层把未知断连收敛成结构化结果（ambiguous），而不是把疑问抛给值班人员。
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ambiguous, true);
    const messages = await (await fetch(`${app.base}/maildrop/messages`)).json();
    const stored = messages.find(item => item.id === record.id);
    assert.equal(stored.cleanupState, CLEANUP_STATES.QUIT_AMBIGUOUS);
    response = await post(app, '/maildrop/reconcile', { sessionId: 22 });
    assert.equal(response.status, 200);
    const handoff = await (await fetch(`${app.base}/maildrop/handoff`)).json();
    assert.equal(handoff.totals.deletedConfirmed, 1);
    assert.match(handoff.rule, /deleted-confirmed/);
  } finally { await h.cleanup(); }
});

test('圆点填充行在完整原件提取时还原，二进制字节不被改写', () => {
  const envelope = Buffer.from('+OK\r\nFrom: a@x\r\n\r\n..starts with dot\r\nnormal\r\n.\r\n', 'latin1');
  const message = extractMessage(envelope);
  assert.equal(message.toString('latin1'), 'From: a@x\r\n\r\n.starts with dot\r\nnormal');
  const preview = decode(envelope);
  assert.equal(preview.body, '.starts with dot\r\nnormal');
});

test('Pop3Ambiguous 只在应答缺失时产生，明确 -ERR/404 走 Pop3Error 且不污染状态', async () => {
  const h = await harness();
  try {
    const pop3 = new Pop3Session(h.client, 99);
    // RETR 越界：fixture 无此路由，来源返回 404，映射为确定的协议错误而非未知状态。
    await assert.rejects(pop3.retr(99), error => error.name === 'Pop3Error' && error.command === 'retr');
    // 推进到无 UIDL 阶段后，UIDL 是明确的 -ERR 应答，同样不是未知状态。
    await h.client.control({ action: 'advance' });
    const degraded = new Pop3Session(h.client, 50);
    await assert.rejects(degraded.uidlAll(), error => error.name === 'Pop3Error' && error.command === 'uidl');
  } finally { await h.cleanup(); }
});
