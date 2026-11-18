import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';
import { SourceClient } from '../src/transport.mjs';

function mail(id, body) {
  return {
    id,
    raw: [
      'From: operator@local.invalid',
      'To: reception@local.invalid',
      `Subject: 预约编号 ${id}`,
      'Date: Wed, 18 Nov 2026 08:00:00 +0800',
      `Message-ID: <${id}@local.invalid>`,
      '',
      body,
      ''
    ].join('\r\n')
  };
}

const post = (base, path) => fetch(`${base}${path}`, { method: 'POST' }).then(r => r.json());

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource({ scenario: 'purge' });
const app = await startApplication({ source: source.base, root: directory });
const client = new SourceClient(source.base);
try {
  await client.control({ action: 'seed', mail: [mail('visit-1', '第一班需要留存的预约确认'), mail('visit-2', '第二封预约确认')] });

  process.stdout.write('— 邮箱现状（新会话发现）\n');
  const discovery = await post(app.base, '/mailbox/reconcile');
  process.stdout.write(`${JSON.stringify(discovery.listing)}\n`);

  process.stdout.write('— 正式收件（完整 RETR 留存原件与凭据）\n');
  const intake = await post(app.base, '/mailbox/intake');
  process.stdout.write(`身份=${intake.record.identity} 状态=${intake.record.status} 摘要=${intake.record.digest.slice(0, 12)}…\n`);

  process.stdout.write('— 来源端清理（仅清理本地已有凭据的 visit-1，visit-2 跳过）\n');
  const purge = await post(app.base, '/mailbox/purge');
  process.stdout.write(`QUIT=${purge.quit} 标记=${purge.marked.length} 跳过=${purge.skipped.length} 核对=${purge.reconciliation.findings[0].status}\n`);

  process.stdout.write('— 交接核对状态\n');
  const status = await fetch(`${app.base}/mailbox/status`).then(r => r.json());
  process.stdout.write(`${JSON.stringify(status.counts)} 待核对问题=${status.handoff.openQuestions.length}\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
