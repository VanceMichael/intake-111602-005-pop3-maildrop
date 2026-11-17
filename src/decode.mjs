// 拆出 POP3 多行应答信封，返回信封内的完整邮件字节（二进制安全，按字节处理圆点填充）。
export function extractMessage(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('POP3 资料必须是字节');
  const head = bytes.toString('latin1');
  const first = head.indexOf('\r\n');
  if (first < 0 || !head.startsWith('+OK')) throw new Error('POP3 多行资料未完整结束');
  if (!head.endsWith('\r\n.\r\n')) throw new Error('POP3 多行资料未完整结束');
  const inner = bytes.subarray(first + 2, bytes.length - 3);
  const lines = [];
  let lineStart = 0;
  for (let index = 0; index < inner.length - 1; index++) {
    if (inner[index] === 0x0d && inner[index + 1] === 0x0a) {
      let line = inner.subarray(lineStart, index);
      if (line[0] === 0x2e && line[1] === 0x2e) line = line.subarray(1);
      lines.push(line);
      lineStart = index + 2;
      index++;
    }
  }
  if (lineStart < inner.length) {
    let tail = inner.subarray(lineStart);
    if (tail[0] === 0x2e && tail[1] === 0x2e) tail = tail.subarray(1);
    lines.push(tail);
  }
  const output = [];
  lines.forEach((line, index) => {
    if (index > 0) output.push(Buffer.from('\r\n', 'ascii'));
    output.push(line);
  });
  return Buffer.concat(output);
}

export function decode(bytes) {
  const message = extractMessage(bytes);
  const text = message.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('没有邮件头分界');
  const headers = {};
  for (const line of text.slice(0, split).split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { headers, body: text.slice(split + 4), messageBytes: message.length };
}
