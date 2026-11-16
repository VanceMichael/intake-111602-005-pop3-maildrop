import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';
test('删除标记在会话退出后才影响新会话，UIDL 能力可以缺失', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    assert.match((await client.request('/session/8/uidl')).bytes.toString(), /permanent-01/);
    await client.request('/session/8/dele/1', { method: 'POST' });
    assert.match((await client.request('/session/9/uidl')).bytes.toString(), /permanent-01/);
    await client.request('/session/8/quit', { method: 'POST' });
    const after = (await client.request('/session/10/uidl')).bytes.toString();
    assert.doesNotMatch(after, /permanent-01/);
    assert.match(after, /1 permanent-02/);
    await client.control({ action: 'advance' });
    assert.match((await client.request('/session/11/uidl')).bytes.toString(), /^-ERR/);
  } finally { await source.close(); }
});
