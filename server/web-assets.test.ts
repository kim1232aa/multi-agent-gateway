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
const OFFICIAL_040_ROOT = join(repoRoot, 'web-dist');
const OFFICIAL_040_EXTENSION = join(repoRoot, 'web-extension');
const OFFICIAL_040_FILES: Record<string, string> = {
  'index.html': 'sha256:128c3ffa5cc0f079755fefadafca154715833a83d44de9266f18e34add93ddba',
  'boot.js': 'sha256:81976f84e9679f26658800df8a6fb074ee1cee42b7d05c961386c7dc1ac68129',
  'assets/index--0t1wzw_.js': 'sha256:e754b3142f70ac7298b36294edaa0f5ed9df948a2454b4095c870c7e99171d2f',
  'assets/index-DDrI0Pxr.css': 'sha256:61e701365b653726780d3acd7bc8dea66f200ce6759b0586fcbe055df5dbcbf5',
};

async function fixture(): Promise<{ root: string; extension: string; manifest: string; index: Buffer }> {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-web-assets-'));
  const root = join(base, 'web-dist');
  const extension = join(base, 'web-extension');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(extension, { recursive: true });
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from('<script src="/boot.js"></script><script type="module" src="/assets/index--0t1wzw_.js"></script>'),
    'boot.js': Buffer.from('window.boot = true;'),
    'assets/index--0t1wzw_.js': Buffer.from('console.log("official");'),
    'assets/index-DDrI0Pxr.css': Buffer.from('body{}'),
  };
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(join(root, relative), content);
  }
  await writeFile(join(extension, 'boot.js'), 'window.__multiAgent = true;');
  await writeFile(join(extension, 'style.css'), '.multi-agent-provider-pill{}');
  const manifest = {
    version: '0.40.1',
    tag: '@moonshot-ai/kimi-code@0.40.1',
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
    assert.ok(html.indexOf('/__multi_agent/boot.js') < html.indexOf('/assets/index--0t1wzw_.js'));
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
    manifest.files['assets/index--0t1wzw_.js'] = 'sha256:broken';
    await writeFile(f.manifest, JSON.stringify(manifest));
    const shell = await loadWebShell({ root: f.root, extensionDir: f.extension, manifestPath: f.manifest });
    assert.equal(shell.injectionEnabled, false);
    assert.deepEqual(shell.indexHtml, f.index);
    assert.match(shell.reason, /hash/i);
  } finally {
    await rm(join(f.root, '..'), { recursive: true, force: true });
  }
});

test('enables injection against official 0.40.1 dist-web when the manifest hashes match', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-web-assets-039-'));
  try {
    const manifestPath = join(base, 'web-origin-manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      version: '0.40.1',
      tag: '@moonshot-ai/kimi-code@0.40.1',
      commit: '0.40.1',
      files: OFFICIAL_040_FILES,
    }));
    const original = await readFile(join(OFFICIAL_040_ROOT, 'index.html'));
    const originalHtml = original.toString('utf8');
    const shell = await loadWebShell({
      root: OFFICIAL_040_ROOT,
      extensionDir: OFFICIAL_040_EXTENSION,
      manifestPath,
    });
    const html = shell.indexHtml.toString('utf8');
    const boot = await readFile(join(OFFICIAL_040_EXTENSION, 'boot.js'));
    assert.equal(shell.injectionEnabled, true);
    assert.match(shell.reason, /0\.40\.1/);
    assert.deepEqual(shell.originalIndexHtml, original);
    assert.match(originalHtml, /\/assets\/index--0t1wzw_\.js/);
    assert.match(originalHtml, /\/assets\/index-DDrI0Pxr\.css/);
    assert.doesNotMatch(originalHtml, /index-ClWTW3HX/);
    assert.doesNotMatch(originalHtml, /index-BeWF_T60/);
    assert.equal((html.match(/\/__multi_agent\/boot\.js/g) ?? []).length, 1);
    assert.equal((html.match(/\/__multi_agent\/style\.css/g) ?? []).length, 1);
    assert.ok(html.indexOf('/boot.js') < html.indexOf('/__multi_agent/boot.js'));
    assert.ok(html.indexOf('/__multi_agent/boot.js') < html.indexOf('/assets/index--0t1wzw_.js'));
    assert.deepEqual(shell.extensionAsset('/__multi_agent/boot.js')?.body, boot);
    assert.equal(shell.extensionAsset('/__multi_agent/boot.js')?.contentType, 'text/javascript; charset=utf-8');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
