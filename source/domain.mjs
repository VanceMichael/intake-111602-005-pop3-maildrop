function mailbox(state) {
  if (!state.mail && state.seeded) state.mail = [];
  if (!state.mail) state.mail = ['permanent-01', 'permanent-02'];
  return state.mail;
}

function entry(item) {
  if (typeof item === 'string') {
    const raw = [
      'From: operator@local.invalid',
      `Message-ID: <${item}@local.invalid>`,
      `Subject: 预约编号 ${item}`,
      '',
      `正文内容 ${item}`,
      ''
    ].join('\r\n');
    return { id: item, raw };
  }
  return item;
}

function toCrLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function stuffed(raw) {
  return toCrLf(raw).replace(/^\./gm, '..');
}

function multiline(raw) {
  const text = stuffed(raw);
  return `${text.endsWith('\r\n') ? text : `${text}\r\n`}.\r\n`;
}

export function dispatch({ url, method, phase, state }) {
  const match = /^\/session\/(\d+)\/(uidl|capa|dele|rset|quit|retr|top|list)(?:\/(\d+))?$/.exec(url.pathname);
  if (!match) return null;
  const [, sessionId, command, number] = match;
  const mail = mailbox(state);
  state.sessions ||= {};
  if (!state.sessions[sessionId]) {
    // 会话在首次命令时打开，锁定当时的邮箱快照；编号只在该会话内有效。
    state.sessions[sessionId] = { view: mail.map(item => entry(item).id), deleted: [], closed: false };
  }
  const session = state.sessions[sessionId];
  const answer = text => ({ body: text, headers: { 'content-type': 'application/octet-stream' } });
  if (session.closed) return answer('-ERR session closed\r\n');
  if (command === 'capa') return answer('+OK\r\nTOP\r\n' + (phase ? '' : 'UIDL\r\n') + '.\r\n');
  if (command === 'uidl') {
    if (phase) return answer('-ERR UIDL unavailable\r\n');
    return answer('+OK\r\n' + session.view.map((id, index) => `${index + 1} ${id}\r\n`).join('') + '.\r\n');
  }
  if (command === 'list') {
    // LIST 不依赖 UIDL 能力，无 UIDL 邮箱也能列出本会话编号与大小。
    const lines = session.view.map((id, index) => {
      const message = mail.map(entry).find(item => item.id === id);
      return `${index + 1} ${message ? Buffer.byteLength(toCrLf(message.raw)) : 0}\r\n`;
    }).join('');
    return answer(`+OK ${session.view.length} 邮件\r\n${lines}.\r\n`);
  }
  if (command === 'retr' || command === 'top') {
    // 只有显式注入过测试邮件时才动态生成 RETR/TOP；否则回落 fixture 静态路由，
    // 保留原有按发布日期切换内容的行为。
    if (!state.seeded) return null;
    const id = session.view[Number(number) - 1];
    if (!id) return answer('-ERR no such message\r\n');
    const message = mail.map(entry).find(item => item.id === id);
    if (!message) return answer('-ERR no such message\r\n');
    if (state.truncateRetr && command === 'retr') {
      state.truncateRetr = false;
      const bytes = Buffer.from(`+OK ${Buffer.byteLength(message.raw)} octets\r\n${multiline(message.raw)}`);
      return { disconnect: true, base64: bytes.toString('base64'),
        headers: { 'content-type': 'application/octet-stream' } };
    }
    if (command === 'retr') {
      return answer(`+OK ${Buffer.byteLength(toCrLf(message.raw))} octets\r\n${multiline(message.raw)}`);
    }
    const head = toCrLf(message.raw).split(/\r\n\r\n/)[0];
    return answer(`+OK\r\n${multiline(`${head}\r\n\r\n`)}`);
  }
  if (method !== 'POST') return { status: 405, json: { error: '此命令需要 POST' } };
  if (command === 'dele') {
    const id = session.view[Number(number) - 1];
    if (!id) return answer('-ERR no such message\r\n');
    session.deleted.push(id);
    return answer('+OK marked\r\n');
  }
  if (command === 'rset') { session.deleted = []; return answer('+OK reset\r\n'); }
  if (command === 'quit') {
    if (state.dropQuit) {
      // 连接在服务器处理 QUIT 前断开：DELE 标记随会话作废，邮箱不更新。
      state.dropQuit = false;
      session.closed = true;
      return { silentDrop: true };
    }
    if (state.flakyQuit) {
      // 服务器已执行删除更新，但应答在返回途中丢失。
      state.flakyQuit = false;
      state.mail = mail.filter(item => !session.deleted.includes(entry(item).id));
      session.closed = true;
      return { silentDrop: true };
    }
    state.mail = mail.filter(item => !session.deleted.includes(entry(item).id));
    session.closed = true;
    return answer('+OK mailbox updated\r\n');
  }
  return null;
}
