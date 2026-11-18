import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';
import { MailboxService } from './mailbox.mjs';
import { Pop3Error } from './pop3.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  return raw.length ? JSON.parse(raw) : {};
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const mailbox = new MailboxService({ source, root });
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
        const input = await readBody(request);
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
      // 正式收件：完整 RETR 留存原件并登记台账（TOP 预览不走这里）。
      if (request.method === 'POST' && url.pathname === '/mailbox/intake') {
        const input = await readBody(request);
        const result = await mailbox.intake(input);
        response.statusCode = 201;
        return response.end(JSON.stringify(result));
      }
      // 来源端清理：仅清理本地已有完整凭据的邮件，结果以新会话复核为准。
      if (request.method === 'POST' && url.pathname === '/mailbox/purge') {
        const result = await mailbox.purge();
        return response.end(JSON.stringify(result));
      }
      // 交接核对：开新会话重查邮箱现状，不依赖历史命令记录。
      if (request.method === 'POST' && url.pathname === '/mailbox/reconcile') {
        const result = await mailbox.reconcile();
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'GET' && url.pathname === '/mailbox/status') {
        return response.end(JSON.stringify(await mailbox.status()));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = error instanceof Pop3Error && error.kind === 'disconnect' ? 503 : 422;
      response.end(JSON.stringify({ error: error.message, kind: error.kind || null }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, mailbox,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
