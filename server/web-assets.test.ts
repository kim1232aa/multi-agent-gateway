import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadWebShell } from './web-assets.js';

const sha256 = (value: Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function fixture(): Promise<{ root: string; extension: string; manifest: string; index: Buffer }> {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-web-assets-'));
  const root = join(base, 'web-dist');
  const extension = join(base, 'web-extension');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(extension, { recursive: true });
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from('<script src="/boot.js"></script><script type="module" src="/assets/app.js"></script>'),
    'boot.js': Buffer.from('window.boot = true;'),
    'assets/app.js': Buffer.from('console.log("official");'),
    'assets/app.css': Buffer.from('body{}'),
  };
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(join(root, relative), content);
  }
  await writeFile(join(extension, 'boot.js'), 'window.__multiAgent = true;');
  await writeFile(join(extension, 'style.css'), '.multi-agent-provider-pill{}');
  const manifest = {
    version: '0.37.2',
    tag: '@moonshot-ai/kimi-code@0.37.2',
    commit: 'test',
    files: Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, sha256(content)])),
  };
  const manifestPath = join(base, 'web-origin-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, extension, manifest: manifestPath, index: files['index.html'] };
}

test('injects extension after the official boot script without changing official assets', async () => {
  const f = await fixture();
  try {
    const shell = await loadWebShell({ root: f.root, extensionDir: f.extension, manifestPath: f.manifest });
    const html = shell.indexHtml.toString('utf8');
    assert.equal(shell.injectionEnabled, true);
    assert.equal((html.match(/\/__multi_agent\/boot\.js/g) ?? []).length, 1);
    assert.equal((html.match(/\/__multi_agent\/style\.css/g) ?? []).length, 1);
    assert.ok(html.indexOf('/boot.js') < html.indexOf('/__multi_agent/boot.js'));
    assert.ok(html.indexOf('/__multi_agent/boot.js') < html.indexOf('/assets/app.js'));
    assert.deepEqual(shell.originalIndexHtml, f.index);
    assert.deepEqual(shell.extensionAsset('/__multi_agent/boot.js')?.body, Buffer.from('window.__multiAgent = true;'));
    assert.equal(shell.extensionAsset('/__multi_agent/boot.js')?.contentType, 'text/javascript; charset=utf-8');
  } finally {
    await rm(join(f.root, '..'), { recursive: true, force: true });
  }
});

test('fails open to the exact official shell when a manifest hash mismatches', async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(f.manifest, 'utf8')) as { files: Record<string, string> };
    manifest.files['assets/app.js'] = 'sha256:broken';
    await writeFile(f.manifest, JSON.stringify(manifest));
    const shell = await loadWebShell({ root: f.root, extensionDir: f.extension, manifestPath: f.manifest });
    assert.equal(shell.injectionEnabled, false);
    assert.deepEqual(shell.indexHtml, f.index);
    assert.match(shell.reason, /hash/i);
  } finally {
    await rm(join(f.root, '..'), { recursive: true, force: true });
  }
});
