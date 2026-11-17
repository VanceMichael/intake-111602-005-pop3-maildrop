// 生成 fixtures/handoff.json：两封同主题同日期但内容不同的邮件，覆盖断连与 UIDL 缺失场景。
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// POP3 邮件按 CRLF 分行；模板源码里的真实换行统一规范化。
const crlf = text => text.replace(/\r?\n/g, '\r\n');
const retrEnvelope = (headers, body) => {
  const message = `${crlf(headers)}\r\n\r\n${crlf(body)}\r\n`;
  return `+OK 128 octets\r\n${message.replace(/^\./gm, '..')}.\r\n`;
};

const mailA = retrEnvelope(
  `From: operator@local.invalid
To: reception@local.invalid
Subject: =?UTF-8?B?5a2k5L2N55+l5aSE55CG?=
Date: Tue, 17 Nov 2026 08:00:00 +0800
Message-ID: <handover-a@local.invalid>`,
  'Confirmed group: 18\r\n.Line beginning with dot');
const mailB = retrEnvelope(
  `From: operator@local.invalid
To: reception@local.invalid
Subject: =?UTF-8?B?5a2k5L2N55+l5aSE55CG?=
Date: Tue, 17 Nov 2026 08:00:00 +0800
Message-ID: <handover-b@local.invalid>`,
  'Confirmed group: 29\r\nDifferent body, same subject and date');
const topEnvelope = '+OK\r\nSubject: =?UTF-8?B?5a2k5L2N55+l5aSE55CG?=\r\nDate: Tue, 17 Nov 2026 08:00:00 +0800\r\n\r\n(preview only)\r\n.\r\n';
const b64 = text => Buffer.from(text, 'latin1').toString('base64');
const octet = { 'content-type': 'application/octet-stream' };

const retrRoute = (session, number, body) => ({ path: `/session/${session}/retr/${number}`, headers: octet, base64: b64(body) });
const topRoute = session => ({ path: `/session/${session}/top/1`, headers: octet, base64: b64(topEnvelope) });
const deleRoute = (session, number) => ({ path: `/session/${session}/dele/${number}`, headers: octet, method: 'POST', body: '+OK marked\r\n' });
const quitRoute = session => ({ path: `/session/${session}/quit`, headers: octet, method: 'POST', body: '+OK mailbox updated\r\n' });
const rsetRoute = session => ({ path: `/session/${session}/rset`, headers: octet, method: 'POST', body: '+OK reset\r\n' });
const uidlRoute = (session, list) => ({ path: `/session/${session}/uidl`, headers: octet, body: `+OK\r\n${list.map((id, index) => `${index + 1} ${id}`).join('\r\n')}\r\n.\r\n` });
const capaRoute = session => ({ path: `/session/${session}/capa`, headers: octet, body: '+OK capabilities\r\nUIDL\r\nTOP\r\n.\r\n' });

// 阶段 0：UIDL 可用，邮箱两封。会话编号各自独立。
const phase0Routes = [];
for (const session of [10, 11, 12, 13, 14, 20, 21, 30, 31, 40, 41, 42]) {
  phase0Routes.push(capaRoute(session));
}
for (const session of [10, 11, 12, 13, 14, 30, 40, 41, 42]) {
  phase0Routes.push(uidlRoute(session, ['permanent-01', 'permanent-02']));
  phase0Routes.push(retrRoute(session, 1, mailA));
  phase0Routes.push(retrRoute(session, 2, mailB));
  phase0Routes.push(deleRoute(session, 1), deleRoute(session, 2), rsetRoute(session), quitRoute(session));
}
for (const session of [10, 12, 20, 30]) phase0Routes.push(topRoute(session));
// 会话 20 只有 TOP 预览路由，没有 RETR（用于验证 TOP 不能作为收妥依据）。
// 会话 21：扫描后删除第一封，新会话 22 只能看到第二封（编号 1 重新排列）。
phase0Routes.push(capaRoute(22), uidlRoute(22, ['permanent-02']), retrRoute(22, 1, mailB),
  deleRoute(22, 1), rsetRoute(22), quitRoute(22));
// 会话 30：QUIT 提交后断连（退出已生效、应答丢失）。
// 会话 13：DELE 应答前断连（before-commit）。

// 阶段 1：发布日期推进后 UIDL 不再支持；邮箱仍保留两封，编号重新排列。
const phase1Routes = [];
for (const session of [50, 51, 52, 60]) {
  phase1Routes.push({ path: `/session/${session}/capa`, headers: octet, body: '+OK capabilities\r\nTOP\r\n.\r\n' });
  phase1Routes.push(retrRoute(session, 1, mailA));
  phase1Routes.push(retrRoute(session, 2, mailB));
  phase1Routes.push(deleRoute(session, 1), deleRoute(session, 2), rsetRoute(session), quitRoute(session));
}
phase1Routes.push(retrRoute(60, 3, mailA));
// 会话 52 删除后核对：会话 53 只剩第二封。
phase1Routes.push({ path: '/session/53/capa', headers: octet, body: '+OK capabilities\r\nTOP\r\n.\r\n' },
  retrRoute(53, 1, mailB), deleRoute(53, 1), rsetRoute(53), quitRoute(53));

const fixture = {
  phases: [
    {
      routes: phase0Routes,
      faults: [
        { path: '/session/13/dele/1', method: 'POST', disconnect: 'before-commit' },
        { path: '/session/30/quit', method: 'POST', disconnect: 'after-commit' }
      ]
    },
    { routes: phase1Routes, faults: [] }
  ]
};

await writeFile(fileURLToPath(new URL('../fixtures/handoff.json', import.meta.url)), JSON.stringify(fixture, null, 2) + '\n');
process.stdout.write('handoff.json 已生成\n');
