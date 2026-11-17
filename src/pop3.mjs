// POP3 协议错误：收到了明确的 -ERR 应答，邮箱状态有确定结论。
export class Pop3Error extends Error {
  constructor(command, text, status) {
    super(`POP3 ${command.toUpperCase()} 被拒绝：${text}`);
    this.name = 'Pop3Error';
    this.command = command;
    this.statusText = text;
    this.httpStatus = status;
  }
}

// 传输在应答前中断：DELE/QUIT 可能已经在来源端生效，也可能没有，本地禁止做乐观假设。
export class Pop3Ambiguous extends Error {
  constructor(command, cause) {
    super(`POP3 ${command.toUpperCase()} 应答前连接中断，来源端是否生效无法确认`);
    this.name = 'Pop3Ambiguous';
    this.command = command;
    this.cause = cause;
  }
}

const statusLine = (bytes, command) => {
  const text = bytes.toString('latin1');
  const line = text.slice(0, text.indexOf('\r\n') >= 0 ? text.indexOf('\r\n') : undefined);
  if (line.startsWith('+OK')) return { ok: true, line: line.slice(3).trim() };
  if (line.startsWith('-ERR')) return { ok: false, line: line.slice(4).trim() };
  throw new Error(`POP3 ${command.toUpperCase()} 应答格式无法识别`);
};

// 一个会话对象只对应一个来源端会话编号；编号在该会话之外没有身份意义。
export class Pop3Session {
  constructor(client, sessionId) {
    if (!/^\d+$/.test(String(sessionId))) throw new Error('会话编号必须是数字');
    this.client = client;
    this.sessionId = String(sessionId);
    this.closed = false;
  }

  path(command, number) {
    return `/session/${this.sessionId}/${command}${number ? `/${number}` : ''}`;
  }

  async capa() {
    const result = await this.client.request(this.path('capa'));
    if (result.status !== 200) throw new Error(`CAPA 来源响应：${result.status}`);
    const text = result.bytes.toString('latin1');
    if (!text.startsWith('+OK')) throw new Error('CAPA 应答格式无法识别');
    const capabilities = text.split('\r\n').slice(1).filter(line => line && line !== '.').map(line => line.trim().toUpperCase());
    return { uidl: capabilities.includes('UIDL'), top: capabilities.includes('TOP'), capabilities };
  }

  async uidlAll() {
    const result = await this.client.request(this.path('uidl'));
    if (result.status !== 200) throw new Error(`UIDL 来源响应：${result.status}`);
    const text = result.bytes.toString('latin1');
    if (!text.startsWith('+OK')) {
      const status = statusLine(result.bytes, 'uidl');
      throw new Pop3Error('uidl', status.line, result.status);
    }
    const entries = [];
    for (const line of text.split('\r\n').slice(1)) {
      if (!line || line === '.') continue;
      const match = /^(\d+)\s+(\S+)$/.exec(line);
      if (!match) throw new Error('UIDL 列表格式无法识别');
      entries.push({ number: Number(match[1]), uidl: match[2] });
    }
    return entries;
  }

  async retr(number) {
    let result;
    try {
      result = await this.client.request(this.path('retr', number));
    } catch (error) {
      throw new Pop3Ambiguous('retr', error);
    }
    if (result.status === 404) throw new Pop3Error('retr', 'no such message', result.status);
    if (result.status !== 200) throw new Error(`RETR 来源响应：${result.status}`);
    const status = statusLine(result.bytes, 'retr');
    if (!status.ok) throw new Pop3Error('retr', status.line, result.status);
    return result.bytes;
  }

  // TOP 只取回部分正文，结果只能用于预览，不能作为收妥凭据。
  async top(number, lines = 0) {
    let result;
    try {
      result = await this.client.request(this.path('top', number) + (lines ? `?lines=${lines}` : ''));
    } catch (error) {
      throw new Pop3Ambiguous('top', error);
    }
    if (result.status === 404) throw new Pop3Error('top', 'no such message', result.status);
    if (result.status !== 200) throw new Error(`TOP 来源响应：${result.status}`);
    const status = statusLine(result.bytes, 'top');
    if (!status.ok) throw new Pop3Error('top', status.line, result.status);
    return result.bytes;
  }

  async postCommand(command, number) {
    try {
      const result = await this.client.request(this.path(command, number), { method: 'POST' });
      if (result.status === 404) throw new Pop3Error(command, 'no such message', result.status);
      if (result.status !== 200) throw new Error(`${command.toUpperCase()} 来源响应：${result.status}`);
      const status = statusLine(result.bytes, command);
      if (!status.ok) throw new Pop3Error(command, status.line, result.status);
      return status.line;
    } catch (error) {
      if (error instanceof Pop3Error) throw error;
      // 没有拿到应答：来源端可能已经执行，也可能没有。
      throw new Pop3Ambiguous(command, error);
    }
  }

  async dele(number) {
    if (!Number.isInteger(number) || number < 1) throw new Error('邮件编号必须是正整数');
    return this.postCommand('dele', number);
  }

  async rset() {
    return this.postCommand('rset');
  }

  async quit() {
    const text = await this.postCommand('quit');
    this.closed = true;
    return text;
  }
}
