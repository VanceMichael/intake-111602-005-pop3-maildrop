function multiline(text) {
  const first = text.indexOf('\r\n');
  if (first < 0 || !text.startsWith('+OK') || !text.endsWith('\r\n.\r\n')) {
    throw new Error('POP3 多行资料未完整结束');
  }
  return text.slice(first + 2, -3).replace(/^\.\./gm, '.');
}

export function extractMessage(bytes) {
  const message = multiline(bytes.toString('utf8'));
  return Buffer.from(message, 'utf8');
}

export function decode(bytes) {
  const message = multiline(bytes.toString('utf8'));
  const split = message.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('没有邮件头分界');
  const headers = {};
  for (const line of message.slice(0, split).split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { headers, body: message.slice(split + 4), messageBytes: Buffer.byteLength(message) };
}
