import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStaticServer } from './static.js';
import { loadWebShell, type WebShell } from './web-assets.js';

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('serves the injected shell and real assets with safe HTTP behavior', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-static-'));
  const root = join(base, 'web-dist');
  try {
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<html>official</html>');
    await writeFile(join(root, 'assets', 'index--0t1wzw_.js'), 'console.log("official");');
    await writeFile(join(base, 'outside.txt'), 'secret outside root');
    await symlink(join(base, 'outside.txt'), join(root, 'assets', 'link.txt'));

    const original = Buffer.from('<html>official</html>');
    const injected = Buffer.from('<html>injected</html>');
    const shell: WebShell = {
      injectionEnabled: true,
      reason: 'test',
      indexHtml: injected,
      originalIndexHtml: original,
      extensionAsset: (pathname) => pathname === '/__multi_agent/boot.js'
        ? { body: Buffer.from('window.__multiAgent = true;'), contentType: 'text/javascript; charset=utf-8' }
        : null,
    };
    const handler = createStaticServer(root, shell);
    const server = await listen(createServer((req, res) => {
      if (!handler(req, res)) res.writeHead(404).end();
    }));
    try {
      const home = await fetch(`${server.url}/`);
      assert.equal(home.status, 200);
      assert.equal(await home.text(), injected.toString('utf8'));
      assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(home.headers.get('x-frame-options'), 'DENY');
      assert.equal(home.headers.get('cache-control'), 'no-cache');

      const asset = await fetch(`${server.url}/assets/index--0t1wzw_.js`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), 'console.log("official");');
      assert.match(asset.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

      const extension = await fetch(`${server.url}/__multi_agent/boot.js`);
      assert.equal(extension.status, 200);
      assert.match(await extension.text(), /__multiAgent/);

      const route = await fetch(`${server.url}/sessions/example`);
      assert.equal(route.status, 200);
      assert.equal(await route.text(), injected.toString('utf8'));

      const missing = await fetch(`${server.url}/assets/missing.js`);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');

      const traversal = await fetch(`${server.url}/assets/..%2f..%2foutside.txt`);
      assert.equal(traversal.status, 403);

      const link = await fetch(`${server.url}/assets/link.txt`);
      assert.equal(link.status, 403);

      const head = await fetch(`${server.url}/`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(injected.byteLength));
      assert.equal((await head.arrayBuffer()).byteLength, 0);

      const malformed = await fetch(`${server.url}/assets/%invalid`);
      assert.equal(malformed.status, 400);
    } finally {
      await server.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

 test('does not expose extension routes without an injected shell', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-static-no-shell-'));
  const root = join(base, 'web-dist');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), '<html>official</html>');
    const handler = createStaticServer(root);
    const server = await listen(createServer((req, res) => {
      if (!handler(req, res)) res.writeHead(404).end();
    }));
    try {
      const response = await fetch(`${server.url}/__multi_agent/boot.js`);
      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('serves the official 2.6.2 bundle byte-for-byte with matching MIME types and runtime-only injection', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const root = join(repoRoot, 'web-dist');
  const shell = await loadWebShell({
    root,
    extensionDir: join(repoRoot, 'web-extension'),
    manifestPath: join(repoRoot, 'web-origin-manifest.json'),
  });
  assert.equal(shell.injectionEnabled, true);
  assert.equal(shell.reason, '2.6.2 (6a8493d)');
  const handler = createStaticServer(root, shell);
  const server = await listen(createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  }));
  const mime: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };
  try {
    const home = await fetch(`${server.url}/`);
    assert.equal(home.status, 200);
    assert.equal(await home.text(), shell.indexHtml.toString('utf8'));
    const boot = await fetch(`${server.url}/boot.js`);
    assert.equal(boot.status, 200);
    assert.equal(boot.headers.get('content-type'), mime['.js']);
    assert.deepEqual(Buffer.from(await boot.arrayBuffer()), await readFile(join(root, 'boot.js')));
    for (const name of await readdir(join(root, 'assets'))) {
      assert.ok(mime[extname(name)], `unsupported official asset type: ${name}`);
      const response = await fetch(`${server.url}/assets/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), mime[extname(name)], name);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(root, 'assets', name)), name);
    }
    for (const name of ['index--0t1wzw_.js', 'index-DDrI0Pxr.css']) {
      const stale = await fetch(`${server.url}/assets/${name}`);
      assert.equal(stale.status, 404, name);
      await stale.arrayBuffer();
    }
    for (const name of ['boot.js', 'style.css']) {
      const extension = await fetch(`${server.url}/__multi_agent/${name}`);
      assert.equal(extension.status, 200);
      assert.deepEqual(Buffer.from(await extension.arrayBuffer()), await readFile(join(repoRoot, 'web-extension', name)));
    }
    const head = await fetch(`${server.url}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(shell.indexHtml.byteLength));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.deepEqual(await readFile(join(root, 'index.html')), shell.originalIndexHtml);
  } finally {
    await server.close();
  }
});
