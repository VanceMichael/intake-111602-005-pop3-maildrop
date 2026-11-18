import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { MailboxService } from '../src/mailbox.mjs';
import { Ledger, STATUS } from '../src/ledger.mjs';
import { Pop3Session, Pop3Error } from '../src/pop3.mjs';
import { decode } from '../src/decode.mjs';

function rawMail(id, { subject = '预约通知', date = 'Wed, 18 Nov 2026 08:00:00 +0800', body = `正文-${id}`, messageId = `<${id}@local.invalid>` } = {}) {
  return {
    id,
    raw: [
      'From: operator@local.invalid',
      `To: reception@local.invalid`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: ${messageId}`,
      '',
      body,
      ''
    ].join('\r\n')
  };
}

// 两封字节完全相同（含头部）的邮件：来源端 id 不同，但完整原件摘要一致。
function identicalMail(id) {
  return {
    id,
    raw: [
      'From: operator@local.invalid',
      'To: reception@local.invalid',
      'Subject: 同一主题',
      'Date: Wed, 18 Nov 2026 08:00:00 +0800',
      'Message-ID: <shared@local.invalid>',
      '',
      '两份内容完全相同的预约确认',
      ''
    ].join('\r\n')
  };
}

async function harness(scenario = 'purge') {
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-test-'));
  const source = await startSource({ scenario });
  const client = new SourceClient(source.base);
  const service = new MailboxService({ source: source.base, root: directory });
  return {
    directory, source, service,
    control: action => client.control(action),
    async cleanup() { await source.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('正式收件留存完整原件，RETR 截断不产生凭据', async () => {
  const h = await harness();
  try {
    await h.control({ action: 'seed', mail: [rawMail('msg-a'), rawMail('msg-b')] });
    const before = await h.service.status();
    assert.equal(before.records.length, 0);

    // TOP 只能预览，不登记任何收件状态。
    const topSession = new Pop3Session(h.source.base, 900);
    const top = await topSession.top(1);
    assert.ok(decode(top.bytes).headers.subject);
    assert.equal((await h.service.status()).records.length, 0);

    await h.control({ action: 'truncate-retr' });
    await assert.rejects(h.service.intake(), error => error instanceof Pop3Error && error.kind === 'truncated');
    assert.equal((await h.service.status()).records.length, 0);

    const intake = await h.service.intake();
    assert.equal(intake.record.status, STATUS.RECEIVED);
    assert.equal(intake.record.identity, 'uidl');
    const bytes = await h.service.catalog.object(intake.record.digest);
    assert.ok(bytes.includes(Buffer.from('正文-msg-a')));
    const status = await h.service.status();
    assert.equal(status.records.length, 1);
    assert.equal(status.records[0].receiptIds.length, 1);
    assert.ok(status.records[0].receiptIds.includes(intake.receipt.id));
  } finally { await h.cleanup(); }
});

test('QUIT 静默断开且删除未提交：先挂待核对，再由新会话证据回到 received', async () => {
  const h = await harness();
  try {
    await h.control({ action: 'seed', mail: [rawMail('msg-a')] });
    await h.service.intake();
    // drop-quit：连接在 QUIT 处理前断开，删除实际未生效，但客户端无法当场判断。
    await h.control({ action: 'drop-quit' });
    const result = await h.service.purge();
    assert.equal(result.quit, 'ambiguous');
    const status = await h.service.status();
    // purge 末尾已自动开新会话核对：邮件仍在，证据把状态拉回 received。
    assert.equal(status.records[0].status, STATUS.RECEIVED);
    const events = status.records[0].history.map(e => e.event);
    // 先记录过 QUIT 无应答的不确定，再由新会话证据翻回，全程不靠命令记忆推断。
    assert.ok(events.includes('quit-response-lost'));
    assert.ok(events.includes('still-present'));

    // 新会话核对：邮件仍在，不能凭“发过 DELE”认定已删。
    const reconcile = await h.service.reconcile();
    assert.equal(reconcile.findings[0].status, STATUS.RECEIVED);
    assert.equal(reconcile.listing.length, 1);

    // 再来一次正常清理即可收敛，不需要清空邮箱。
    const again = await h.service.purge();
    assert.equal(again.quit, 'acknowledged');
    const finalStatus = await h.service.status();
    assert.equal(finalStatus.records[0].status, STATUS.DELETED_CONFIRMED);
    assert.equal(again.reconciliation.findings[0].status, STATUS.DELETED_CONFIRMED);
  } finally { await h.cleanup(); }
});

test('QUIT 已生效但应答丢失：新会话证据确认删除，不重删', async () => {
  const h = await harness();
  try {
    await h.control({ action: 'seed', mail: [rawMail('msg-a'), rawMail('msg-b')] });
    await h.service.intake();
    await h.control({ action: 'flaky-quit' });
    const result = await h.service.purge();
    assert.equal(result.quit, 'ambiguous');
    const mid = await h.service.status();
    // purge 末尾的新会话核对已凭“UIDL 列表中消失”确认删除，而非凭 QUIT 推断。
    assert.equal(mid.records[0].status, STATUS.DELETED_CONFIRMED);
    const events = mid.records[0].history.map(e => e.event);
    assert.ok(events.includes('quit-response-lost'));
    assert.ok(events.includes('absence-confirmed'));
    // 来源端其实已更新：只剩第二封。
    const discovery = await h.service.discover();
    assert.deepEqual(discovery.entries.map(e => e.uid), ['msg-b']);

    const reconcile = await h.service.reconcile();
    const finding = reconcile.findings.find(f => f.recordId === mid.records[0].id);
    assert.equal(finding.status, STATUS.DELETED_CONFIRMED);

    // 再次 purge 不会对已确认删除的邮件发 DELE，未留存的 msg-b 被跳过。
    const second = await h.service.purge();
    assert.deepEqual(second.marked, []);
    assert.equal(second.skipped[0].reason, '本地没有完整原件凭据');
  } finally { await h.cleanup(); }
});

test('无 UIDL 邮箱：保留可确认身份与局限，同摘要多信不合并', async () => {
  const h = await harness();
  try {
    await h.control({
      action: 'seed',
      mail: [identicalMail('dup-1'), identicalMail('dup-2')]
    });
    await h.control({ action: 'advance' }); // phase 1：CAPA 无 UIDL，UIDL 返回 -ERR
    const discovery = await h.service.discover();
    assert.equal(discovery.uidlSupported, false);

    // intake 在无 UIDL 下按完整摘要登记，并显式记录身份局限。
    const first = await h.service.intake();
    assert.equal(first.record.identity, 'digest');
    assert.ok(first.record.identityLimits.some(text => text.includes('SHA-256')));
    const second = await h.service.intake();
    // 两封完整原件摘要相同：不制造第二张台账主记录，但记录重复次数与不可区分事实。
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.duplicateCount, 2);
    assert.ok(second.record.identityNote.includes('无法区分'));
    // 两封都有独立接收凭据与原件。
    assert.equal(second.record.receiptIds.length, 2);

    // 无 UIDL 清理：逐封 RETR 摘要比对，两封都可被确认并删除。
    const purge = await h.service.purge();
    assert.equal(purge.marked.length, 2);
    const after = await h.service.status();
    assert.equal(after.records[0].status, STATUS.DELETED_CONFIRMED);
    assert.equal((await h.service.discover()).entries.length, 0);
  } finally { await h.cleanup(); }
});

test('主题与日期相同但内容不同的两封信不会被合并', async () => {
  const h = await harness();
  try {
    await h.control({
      action: 'seed',
      mail: [
        rawMail('mail-x', { subject: '周一预约', date: 'Wed, 18 Nov 2026 08:00:00 +0800', body: '内容 X' }),
        rawMail('mail-y', { subject: '周一预约', date: 'Wed, 18 Nov 2026 08:00:00 +0800', body: '内容 Y' })
      ]
    });
    await h.service.intake({ number: 1 });
    await h.service.intake({ number: 2 });
    const status = await h.service.status();
    assert.equal(status.records.length, 2);
    assert.notEqual(status.records[0].digest, status.records[1].digest);
    const purge = await h.service.purge();
    assert.equal(purge.marked.length, 2);
    assert.equal((await h.service.status()).counts[STATUS.DELETED_CONFIRMED], 2);
  } finally { await h.cleanup(); }
});

test('台账持久化：重启后的下一班只凭新邮箱状态核对', async () => {
  const h = await harness();
  try {
    await h.control({ action: 'seed', mail: [rawMail('msg-a')] });
    await h.service.intake();
    await h.control({ action: 'flaky-quit' });
    const purge = await h.service.purge();
    assert.equal(purge.quit, 'ambiguous');
    const before = await h.service.status();
    // 即使 purge 已自动核对，历史里仍保留“应答丢失→新会话证据确认”的完整轨迹。
    const beforeEvents = before.records[0].history.map(e => e.event);
    assert.ok(beforeEvents.includes('quit-response-lost'));
    assert.ok(beforeEvents.includes('absence-confirmed'));

    // 模拟换班：用同一目录新建服务实例（进程重启），不依赖上一班内存里的命令记录。
    const nextShift = new MailboxService({ source: h.source.base, root: h.directory });
    const reconcile = await nextShift.reconcile();
    assert.equal(reconcile.findings[0].status, STATUS.DELETED_CONFIRMED);
    const reopened = new Ledger(h.directory, h.source.base);
    const snapshot = await reopened.snapshot();
    assert.equal(snapshot.records[0].status, STATUS.DELETED_CONFIRMED);
    // 历史链完整持久化，可回看每一步证据。
    const events = snapshot.records[0].history.map(e => e.event);
    assert.ok(events.includes('quit-response-lost'));
    assert.ok(events.includes('absence-confirmed'));
  } finally { await h.cleanup(); }
});

test('无凭据邮件不会被清理，本地凭据是删除的前置条件', async () => {
  const h = await harness();
  try {
    await h.control({ action: 'seed', mail: [rawMail('kept'), rawMail('saved')] });
    // 只接收编号 1。
    await h.service.intake();
    const purge = await h.service.purge();
    assert.equal(purge.marked.length, 1);
    assert.equal(purge.marked[0].uid, 'kept');
    assert.equal(purge.skipped.length, 1);
    assert.equal(purge.skipped[0].uid, 'saved');
    const remaining = await h.service.discover();
    assert.deepEqual(remaining.entries.map(e => e.uid), ['saved']);
  } finally { await h.cleanup(); }
});
