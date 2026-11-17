import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
const call = async (path, body) => {
  const response = await fetch(`${app.base}${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  if (!response.ok) throw new Error(`${path} 失败：${response.status} ${await response.text()}`);
  return response.json();
};
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览（TOP/RETR 预览能力，不产生收妥凭据）\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  // 正式收件与来源端清理交接演示（handoff 场景含两封邮件与断连配置）。
  await app.close();
  await source.close();
  const handoffSource = await startSource({ scenario: 'handoff' });
  const handoffApp = await startApplication({ source: handoffSource.base, root: directory });
  const callH = async (path, input) => {
    const response = await fetch(`${handoffApp.base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input || {}) });
    if (!response.ok) throw new Error(`${path} 失败：${response.status}`);
    return response.json();
  };
  try {
    await callH('/maildrop/sessions', { sessionId: 10 });
    const first = await callH('/maildrop/receive', { sessionId: 10, number: 1 });
    await callH('/maildrop/receive', { sessionId: 10, number: 2 });
    process.stdout.write(`正式收件：身份依据 ${first.record.identity.basis}，摘要 ${first.record.identity.digest.slice(0, 12)}…\n`);
    await callH('/maildrop/mark-deletion', { sessionId: 11, number: 1 });
    await callH('/maildrop/commit', { sessionId: 11 });
    process.stdout.write('QUIT 已应答，但状态仍是 acknowledged-unverified，等待新会话核对\n');
    const reconciliation = await callH('/maildrop/reconcile', { sessionId: 22 });
    for (const item of reconciliation.items) {
      process.stdout.write(`核对：${item.identity.uidl || item.identity.digest.slice(0, 12)} -> ${item.state}\n`);
    }
    const handoff = await (await fetch(`${handoffApp.base}/maildrop/handoff`)).json();
    process.stdout.write(`交接摘要：已确认删除 ${handoff.totals.deletedConfirmed} 封，待办 ${handoff.totals.open} 封\n`);
  } finally {
    await handoffApp.close();
    await handoffSource.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
