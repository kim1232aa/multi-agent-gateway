import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

async function loadShim(pathname = '/'): Promise<any> {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const location = { origin: 'http://localhost:58630', pathname, search: '', hash: '' };
  const windowObject: any = {
    location,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
    history: { pushState() {}, replaceState() {} },
  };
  const context: any = {
    window: windowObject,
    document: { readyState: 'loading', documentElement: {}, querySelector: () => null, createElement: () => ({}) },
    location,
    localStorage: windowObject.localStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'boot.js' });
  return windowObject.__multiAgent;
}

async function loadModeShim(): Promise<{ api: any; rows: any[] }> {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const rows = ['Plan', 'Swarm', 'Goal'].map((label, index) => {
    const attributes = new Map<string, string>();
    const classes = new Set(index === 2 ? ['mode-row', 'mode-row-goal'] : ['mode-row']);
    const labelNode = { textContent: label };
    return {
      hidden: false,
      children: [],
      style: { display: '' },
      classList: {
        contains: (name: string) => classes.has(name),
        toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      },
      querySelector: (selector: string) => selector === '.mode-row-name' ? labelNode : null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  });
  const menu = { children: rows };
  const storage = new Map<string, string>();
  const location = { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' };
  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === '.modes-menu' ? [menu] : [],
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const windowObject: any = {
    location,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };
  const context: any = {
    window: windowObject,
    document: documentObject,
    location,
    localStorage: windowObject.localStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'boot.js' });
  return { api: windowObject.__multiAgent, rows };
}

test('rewrites global API URLs for the selected provider and pins prefixed sessions', async () => {
  const api = await loadShim('/');
  assert.equal(Array.from(api.providers).join(','), 'kimi,claude,codex');
  assert.equal(api.selectedProvider(), 'kimi');
  assert.equal(api.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'kimi');
  api.setProvider('claude');
  assert.equal(api.selectedProvider(), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/sessions').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/sessions/codex_abc/snapshot').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/files/abc').searchParams.get('provider'), 'claude');
  const codexSession = await loadShim('/sessions/codex_abc');
  assert.equal(codexSession.selectedProvider(), 'codex');
  assert.equal(codexSession.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'codex');
});

test('updates provider menu aria state when it opens and closes', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  assert.match(source, /setAttribute\(['\"]aria-expanded['\"],\s*String\(!menu\.hidden\)\)/);
  assert.match(source, /setAttribute\(['\"]aria-expanded['\"],\s*['\"]false['\"]\)/);
});

test('relabels the Kimi account control for non-Kimi providers', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  assert.match(source, /multi-agent-provider-account/);
  assert.match(source, /user-menu-trigger/);
  assert.match(source, /user-menu-login/);
});

test('shows only provider-supported modes', async () => {
  const { api, rows } = await loadModeShim();
  api.setProvider('codex');
  assert.deepEqual(rows.map((row) => row.style.display), ['', 'none', '']);
  api.setProvider('claude');
  assert.deepEqual(rows.map((row) => row.style.display), ['', 'none', 'none']);
  api.setProvider('kimi');
  assert.deepEqual(rows.map((row) => row.style.display), ['', '', '']);
});
