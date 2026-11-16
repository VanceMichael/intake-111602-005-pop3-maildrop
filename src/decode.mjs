export function decode(bytes) {
  const text = bytes.toString('utf8');
  const first = text.indexOf('\r\n');
  if (first < 0 || !text.startsWith('+OK') || !text.endsWith('\r\n.\r\n')) throw new Error('POP3 多行资料未完整结束');
  const message = text.slice(first + 2, -3).replace(/^\.\./gm, '.');
  const split = message.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('没有邮件头分界');
  const headers = {};
  for (const line of message.slice(0, split).split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { headers, body: message.slice(split + 4), messageBytes: Buffer.byteLength(message) };
}
