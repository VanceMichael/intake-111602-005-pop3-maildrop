import { createHash } from 'node:crypto';

// 完整原件的内容摘要：无 UIDL 时唯一能够确认的跨会话身份依据。
export function contentDigest(messageBytes) {
  if (!Buffer.isBuffer(messageBytes)) throw new TypeError('邮件原件必须是字节');
  return createHash('sha256').update(messageBytes).digest('hex');
}

// 身份分两类：
// - uidl：邮箱公告的 UIDL，可确认，但只在该邮箱内有效；
// - content：完整原件摘要，可确认与本地留存一致，但内容相同的不同邮件无法区分。
// 主题、日期、Message-ID 只作参考记录，不参与合并判断（Message-ID 不保证存在或唯一）。
export function buildIdentity({ uidl, messageBytes, headers }) {
  const digest = contentDigest(messageBytes);
  if (uidl) {
    return { basis: 'uidl', uidl, digest,
      headerRef: pickHeaders(headers), uncertainty: ['UIDL 身份仅在当前邮箱内有效，邮箱重建后可能失效'] };
  }
  return { basis: 'content', digest, headerRef: pickHeaders(headers),
    uncertainty: ['来源不支持 UIDL，身份仅由完整原件摘要确认；内容完全相同的不同邮件无法区分，主题、日期、Message-ID 不参与身份判断'] };
}

export function pickHeaders(headers = {}) {
  const ref = {};
  for (const name of ['message-id', 'subject', 'date', 'from', 'to']) {
    if (headers[name] !== undefined) ref[name] = headers[name];
  }
  return ref;
}
