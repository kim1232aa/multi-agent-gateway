import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

export interface WebShellOptions {
  root: string;
  extensionDir: string;
  manifestPath: string;
}

export interface WebShell {
  injectionEnabled: boolean;
  reason: string;
  indexHtml: Buffer;
  originalIndexHtml: Buffer;
  extensionAsset(pathname: string): { body: Buffer; contentType: string } | null;
}

interface WebOriginManifest {
  version: string;
  tag: string;
  commit: string;
  files: Record<string, string>;
}

const INJECTION =
  '\n    <link rel="stylesheet" href="/__multi_agent/style.css">' +
  '\n    <script src="/__multi_agent/boot.js"></script>';
const BOOT_MARKER = '<script src="/boot.js"></script>';

function sha256(body: Buffer): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export async function loadWebShell(options: WebShellOptions): Promise<WebShell> {
  const originalIndexHtml = await readFile(join(options.root, 'index.html'));
  const extensionAssets = new Map<string, { body: Buffer; contentType: string }>();
  const base: WebShell = {
    injectionEnabled: false,
    reason: 'extension disabled',
    indexHtml: originalIndexHtml,
    originalIndexHtml,
    extensionAsset: (pathname) => extensionAssets.get(pathname) ?? null,
  };

  try {
    const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as WebOriginManifest;
    for (const [relative, expected] of Object.entries(manifest.files)) {
      const normalized = normalize(relative);
      if (isAbsolute(relative) || normalized.split(/[\\/]/).includes('..')) {
        return { ...base, reason: `official asset path escapes root: ${relative}` };
      }
      const actual = sha256(await readFile(join(options.root, normalized)));
      if (actual !== expected) {
        return { ...base, reason: `official asset hash mismatch: ${relative}` };
      }
    }

    const html = originalIndexHtml.toString('utf8');
    const markerIndex = html.indexOf(BOOT_MARKER);
    if (markerIndex === -1) return { ...base, reason: 'official boot script marker not found' };
    if (html.includes('/__multi_agent/boot.js') || html.includes('/__multi_agent/style.css')) {
      return { ...base, reason: 'extension tags already present in official shell' };
    }

    extensionAssets.set('/__multi_agent/boot.js', {
      body: await readFile(join(options.extensionDir, 'boot.js')),
      contentType: 'text/javascript; charset=utf-8',
    });
    extensionAssets.set('/__multi_agent/style.css', {
      body: await readFile(join(options.extensionDir, 'style.css')),
      contentType: 'text/css; charset=utf-8',
    });
    const insertAt = markerIndex + BOOT_MARKER.length;
    return {
      ...base,
      injectionEnabled: true,
      reason: `${manifest.version} (${manifest.commit.slice(0, 7)})`,
      indexHtml: Buffer.from(`${html.slice(0, insertAt)}${INJECTION}${html.slice(insertAt)}`),
    };
  } catch (error) {
    return {
      ...base,
      reason: `extension validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
