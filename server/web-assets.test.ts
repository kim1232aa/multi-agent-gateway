import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWebShell } from './web-assets.js';

const sha256 = (value: Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFFICIAL_ROOT = join(repoRoot, 'web-dist');
const OFFICIAL_EXTENSION = join(repoRoot, 'web-extension');
const OFFICIAL_MANIFEST = join(repoRoot, 'web-origin-manifest.json');
const OFFICIAL_FILES: Record<string, string> = {
  'index.html': 'sha256:a6dcedb8d09f6c43989329ef8c7302dd4bf1a7bbf2639cb92f701db75822f95b',
  'boot.js': 'sha256:0bce32ba35f72acf1130dd19eafa7db96967a1597618310e650b83c046f42931',
  'assets/index-BNG6LZmM.js': 'sha256:d8b253fe10fe4335cae046cd9229e12dd33e5618b68897de0fb4c1fb22e135d1',
  'assets/index-DTeGWdC0.css': 'sha256:0f838232de6a929888b17f1354a16d475f122979b648599677a73f68703adcfc',
};

async function fixture(): Promise<{ root: string; extension: string; manifest: string; index: Buffer }> {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-web-assets-'));
  const root = join(base, 'web-dist');
  const extension = join(base, 'web-extension');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(extension, { recursive: true });
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from('<script src="/boot.js"></script><script type="module" src="/assets/index-BNG6LZmM.js"></script>'),
    'boot.js': Buffer.from('window.boot = true;'),
    'assets/index-BNG6LZmM.js': Buffer.from('console.log("official");'),
    'assets/index-DTeGWdC0.css': Buffer.from('body{}'),
  };
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(join(root, relative), content);
  }
  await writeFile(join(extension, 'boot.js'), 'window.__multiAgent = true;');
  await writeFile(join(extension, 'style.css'), '.multi-agent-provider-pill{}');
  const manifest = {
    version: '2.6.2',
    tag: '@moonshot-ai/kimi-code@2.6.2',
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
    assert.ok(html.indexOf('/__multi_agent/boot.js') < html.indexOf('/assets/index-BNG6LZmM.js'));
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
    manifest.files['assets/index-BNG6LZmM.js'] = 'sha256:broken';
    await writeFile(f.manifest, JSON.stringify(manifest));
    const shell = await loadWebShell({ root: f.root, extensionDir: f.extension, manifestPath: f.manifest });
    assert.equal(shell.injectionEnabled, false);
    assert.deepEqual(shell.indexHtml, f.index);
    assert.match(shell.reason, /hash/i);
  } finally {
    await rm(join(f.root, '..'), { recursive: true, force: true });
  }
});

test('verifies the committed official 2.6.2 manifest and injects only the in-memory shell', async () => {
  const manifest = JSON.parse(await readFile(OFFICIAL_MANIFEST, 'utf8'));
  assert.deepEqual(manifest, {
    version: '2.6.2',
    tag: '@moonshot-ai/kimi-code@2.6.2',
    commit: '6a8493df3e1d796a63f7c7ca0de76c1e690cd943',
    files: OFFICIAL_FILES,
  });
  for (const [relative, expected] of Object.entries(OFFICIAL_FILES)) {
    assert.equal(sha256(await readFile(join(OFFICIAL_ROOT, relative))), expected, relative);
  }
  const original = await readFile(join(OFFICIAL_ROOT, 'index.html'));
  const originalHtml = original.toString('utf8');
  const shell = await loadWebShell({
    root: OFFICIAL_ROOT,
    extensionDir: OFFICIAL_EXTENSION,
    manifestPath: OFFICIAL_MANIFEST,
  });
  const html = shell.indexHtml.toString('utf8');
  assert.equal(shell.injectionEnabled, true);
  assert.equal(shell.reason, '2.6.2 (6a8493d)');
  assert.deepEqual(shell.originalIndexHtml, original);
  assert.match(originalHtml, /\/assets\/index-BNG6LZmM\.js/);
  assert.match(originalHtml, /\/assets\/index-DTeGWdC0\.css/);
  assert.doesNotMatch(originalHtml, /\/__multi_agent\//);
  assert.equal((html.match(/\/__multi_agent\/boot\.js/g) ?? []).length, 1);
  assert.equal((html.match(/\/__multi_agent\/style\.css/g) ?? []).length, 1);
  assert.ok(html.indexOf('/boot.js') < html.indexOf('/__multi_agent/boot.js'));
  assert.ok(html.indexOf('/__multi_agent/boot.js') < html.indexOf('/assets/index-BNG6LZmM.js'));
  assert.deepEqual(shell.extensionAsset('/__multi_agent/boot.js')?.body, await readFile(join(OFFICIAL_EXTENSION, 'boot.js')));
  assert.equal(shell.extensionAsset('/__multi_agent/boot.js')?.contentType, 'text/javascript; charset=utf-8');
  assert.deepEqual(shell.extensionAsset('/__multi_agent/style.css')?.body, await readFile(join(OFFICIAL_EXTENSION, 'style.css')));
  assert.equal(shell.extensionAsset('/__multi_agent/style.css')?.contentType, 'text/css; charset=utf-8');
  for (const [relative, expected] of Object.entries(OFFICIAL_FILES)) {
    assert.equal(sha256(await readFile(join(OFFICIAL_ROOT, relative))), expected, relative);
  }
});
