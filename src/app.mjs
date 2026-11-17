import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';
import { Ledger } from './ledger.mjs';
import { Maildrop } from './maildrop.mjs';
import { Pop3Ambiguous, Pop3Error } from './pop3.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

const readJson = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

const positiveInt = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} 必须是正整数`);
  return number;
};

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const ledger = await new Ledger(root).initialize();
  const client = new SourceClient(source);
  const maildrop = new Maildrop({ source: client, catalog, ledger });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await readJson(request);
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }

      // 正式收件与来源端清理（编号均为来源端会话内编号，由调用方显式给出）。
      if (request.method === 'POST' && url.pathname === '/maildrop/sessions') {
        const body = await readJson(request);
        const opened = await maildrop.openSession(body.sessionId ? positiveInt(body.sessionId, 'sessionId') : undefined);
        return response.end(JSON.stringify({ sessionId: opened.sessionId, uidlSupported: opened.uidlSupported,
          capabilities: opened.capabilities, openedAt: opened.openedAt }));
      }
      if (request.method === 'GET' && url.pathname === '/maildrop/scan') {
        const sessionId = positiveInt(url.searchParams.get('sessionId'), 'sessionId');
        return response.end(JSON.stringify(await maildrop.scan(sessionId)));
      }
      if (request.method === 'POST' && url.pathname === '/maildrop/receive') {
        const body = await readJson(request);
        const result = await maildrop.receive({ sessionId: positiveInt(body.sessionId, 'sessionId'),
          number: positiveInt(body.number, 'number') });
        response.statusCode = 201;
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'POST' && url.pathname === '/maildrop/mark-deletion') {
        const body = await readJson(request);
        const result = await maildrop.markForDeletion({ sessionId: positiveInt(body.sessionId, 'sessionId'),
          number: positiveInt(body.number, 'number') });
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'POST' && url.pathname === '/maildrop/commit') {
        const body = await readJson(request);
        const result = await maildrop.commitDeletions(positiveInt(body.sessionId, 'sessionId'));
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'POST' && url.pathname === '/maildrop/reconcile') {
        const body = await readJson(request);
        const result = await maildrop.reconcile(positiveInt(body.sessionId, 'sessionId'));
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'GET' && url.pathname === '/maildrop/handoff') {
        return response.end(JSON.stringify(await maildrop.handoff()));
      }
      if (request.method === 'GET' && url.pathname === '/maildrop/messages') {
        return response.end(JSON.stringify(await ledger.readAll()));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = error instanceof Pop3Ambiguous ? 409
        : error instanceof Pop3Error ? 422 : 422;
      response.end(JSON.stringify({ error: error.message, type: error.name }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, ledger, maildrop,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
