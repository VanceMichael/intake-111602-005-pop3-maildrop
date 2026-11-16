function mailbox(state, phase) {
  if (!state.mail) state.mail = ['permanent-01', 'permanent-02'];
  return state.mail;
}

export function dispatch({ url, method, phase, state }) {
  const match = /^\/session\/(\d+)\/(uidl|capa|dele|rset|quit)(?:\/(\d+))?$/.exec(url.pathname);
  if (!match) return null;
  const [, sessionId, command, number] = match;
  const mail = mailbox(state, phase);
  state.sessions ||= {};
  state.sessions[sessionId] ||= { view: [...mail], deleted: [], closed: false };
  const session = state.sessions[sessionId];
  const answer = text => ({ body: text, headers: { 'content-type': 'application/octet-stream' } });
  if (session.closed) return answer('-ERR session closed\r\n');
  if (command === 'capa') return answer('+OK\r\nTOP\r\n' + (phase ? '' : 'UIDL\r\n') + '.\r\n');
  if (command === 'uidl') {
    if (phase) return answer('-ERR UIDL unavailable\r\n');
    return answer('+OK\r\n' + session.view.map((id, index) => `${index + 1} ${id}\r\n`).join('') + '.\r\n');
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
    state.mail = mail.filter(id => !session.deleted.includes(id)); session.closed = true;
    return answer('+OK mailbox updated\r\n');
  }
  return null;
}
