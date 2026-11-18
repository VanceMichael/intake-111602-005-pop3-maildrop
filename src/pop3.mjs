import { SourceClient } from './transport.mjs';

export class Pop3Error extends Error {
  constructor(message, { kind = 'protocol', status, cause } = {}) {
    super(message);
    this.name = 'Pop3Error';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (cause) this.cause = cause;
  }
}

async function read(client, path, options) {
  try {
    return await client.request(path, options);
  } catch (error) {
    throw new Pop3Error(`POP3 传输中断：${path}`, { kind: 'disconnect', cause: error });
  }
}

function parseStatus(bytes) {
  const lineEnd = bytes.indexOf('\r\n');
  const first = lineEnd < 0 ? bytes.toString('utf8') : bytes.subarray(0, lineEnd).toString('utf8');
  if (first.startsWith('+OK')) return { ok: true, first };
  if (first.startsWith('-ERR')) return { ok: false, first };
  throw new Pop3Error(`POP3 应答无法识别：${first || '(空)'}`);
}

// 一个实例对应一次 POP3 会话（网关路径里的 sessionId）。
// 编号只在本会话内有效，断开后必须新建实例重新发现。
export class Pop3Session {
  constructor(base, sessionId, options = {}) {
    this.client = new SourceClient(base, options);
    this.sessionId = sessionId;
    this.closed = false;
  }

  path(command, number) {
    return `/session/${this.sessionId}/${command}${number ? `/${number}` : ''}`;
  }

  async capa() {
    const result = await read(this.client, this.path('capa'));
    if (result.status !== 200) throw new Pop3Error(`CAPA 响应：${result.status}`, { status: result.status });
    const { ok, first } = parseStatus(result.bytes);
    if (!ok) throw new Pop3Error(first);
    return { uidl: result.bytes.toString('utf8').includes('\r\nUIDL\r\n') };
  }

  async uidl() {
    const result = await read(this.client, this.path('uidl'));
    if (result.status !== 200) throw new Pop3Error(`UIDL 响应：${result.status}`, { status: result.status });
    const text = result.bytes.toString('utf8');
    const firstEnd = text.indexOf('\r\n');
    const first = text.slice(0, firstEnd);
    if (first.startsWith('-ERR')) return { supported: false, entries: [] };
    if (!first.startsWith('+OK')) throw new Pop3Error(`UIDL 应答无法识别：${first}`);
    const entries = [];
    for (const line of text.slice(firstEnd + 2, -3).split('\r\n')) {
      const match = /^(\d+) (.+)$/.exec(line);
      if (match) entries.push({ number: Number(match[1]), uid: match[2] });
    }
    return { supported: true, entries };
  }

  async list() {
    const result = await read(this.client, this.path('list'));
    if (result.status !== 200) throw new Pop3Error(`LIST 响应：${result.status}`, { status: result.status });
    const text = result.bytes.toString('utf8');
    const firstEnd = text.indexOf('\r\n');
    const first = text.slice(0, firstEnd);
    if (!first.startsWith('+OK')) throw new Pop3Error(`LIST 应答无法识别：${first}`);
    const entries = [];
    for (const line of text.slice(firstEnd + 2, -3).split('\r\n')) {
      const match = /^(\d+) (\d+)$/.exec(line);
      if (match) entries.push({ number: Number(match[1]), size: Number(match[2]) });
    }
    return entries;
  }

  async retr(number) {
    let result;
    try {
      result = await read(this.client, this.path('retr', number));
    } catch (error) {
      // 传输在完整应答前中断：TOP/RETR 看过的片段都不能算收妥。
      throw new Pop3Error(`RETR 传输中断，原件不完整：${error.message}`, { kind: 'truncated', cause: error });
    }
    if (result.status !== 200) throw new Pop3Error(`RETR 响应：${result.status}`, { status: result.status });
    const status = parseStatus(result.bytes);
    if (!status.ok) throw new Pop3Error(status.first);
    // 完整多行应答必须以 CRLF.CRLF 收尾；传输中断时 fetch 本身会抛 truncated，
    // 这里再兜底一次，防止网关返回截断数据。
    const terminator = Buffer.from('\r\n.\r\n');
    if (result.bytes.length < terminator.length ||
        !result.bytes.subarray(-terminator.length).equals(terminator)) {
      throw new Pop3Error('RETR 资料未完整结束', { kind: 'truncated' });
    }
    return result;
  }

  async top(number) {
    const result = await read(this.client, this.path('top', number));
    if (result.status !== 200) throw new Pop3Error(`TOP 响应：${result.status}`, { status: result.status });
    const status = parseStatus(result.bytes);
    if (!status.ok) throw new Pop3Error(status.first);
    const terminator = Buffer.from('\r\n.\r\n');
    if (result.bytes.length < terminator.length ||
        !result.bytes.subarray(-terminator.length).equals(terminator)) {
      throw new Pop3Error('TOP 资料未完整结束', { kind: 'truncated' });
    }
    return result;
  }

  async post(command, number) {
    const result = await read(this.client, this.path(command, number), { method: 'POST' });
    if (result.status !== 200) throw new Pop3Error(`${command.toUpperCase()} 响应：${result.status}`, { status: result.status });
    const status = parseStatus(result.bytes);
    if (!status.ok) throw new Pop3Error(status.first);
    if (command === 'quit') this.closed = true;
    return { first: status.first, bytes: result.bytes };
  }

  dele(number) { return this.post('dele', number); }
  rset() { return this.post('rset'); }

  // QUIT 的结果有三种语义，必须如实区分：
  // - acknowledged：收到 +OK，邮箱确定已更新
  // - disconnect：连接在退出前断开，删除确定未提交
  // - ambiguous：应答丢失，命令可能已生效也可能未生效，只能靠下一次会话核对
  async quit() {
    try {
      await this.post('quit');
      return { outcome: 'acknowledged' };
    } catch (error) {
      if (error.kind !== 'disconnect') throw error;
      return { outcome: 'ambiguous', cause: error };
    }
  }
}
