import assert from 'node:assert/strict';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const DIST_ROOT = resolve('dist');
const INDEX_PATH = join(DIST_ROOT, 'index.html');

assert.equal(existsSync(INDEX_PATH), true, 'dist/index.html is missing; run npm run build first');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(DIST_ROOT, normalize(relativePath));

  if (!filePath.startsWith(`${DIST_ROOT}${sep}`) && filePath !== INDEX_PATH) {
    response.writeHead(403).end();
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, {
    'content-type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});

try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const indexResponse = await fetch(`${baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get('content-type') ?? '', /^text\/html/u);

  const indexHtml = await indexResponse.text();
  const assetPaths = Array.from(
    indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu),
    (match) => match[1],
  );
  assert.ok(assetPaths.length > 0, 'built index does not reference any assets');

  for (const assetPath of assetPaths) {
    const assetResponse = await fetch(`${baseUrl}${assetPath}`);
    assert.equal(assetResponse.status, 200, `${assetPath} is not served`);
    assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, `${assetPath} is empty`);
  }

  console.log(`[smoke-built-site] OK — index and ${assetPaths.length} assets served`);
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
