import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

async function loadShim(pathname = '/', options: { readyState?: string; querySelector?: (selector: string) => unknown; querySelectorAll?: (selector: string) => unknown[] } = {}): Promise<any> {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const webSocketCalls: Array<{ url: string; protocols: unknown }> = [];
  const location = { origin: 'http://localhost:58630', pathname, search: '', hash: '' };
  let mutationCallback: ((records: any[]) => void) | undefined;
  class NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      webSocketCalls.push({ url: String(url), protocols });
    }
  }
  class TestMutationObserver {
    constructor(callback: (records: any[]) => void) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const documentObject: any = {
    readyState: options.readyState ?? 'loading',
    documentElement: {},
    querySelector: options.querySelector ?? (() => null),
    querySelectorAll: options.querySelectorAll ?? (() => []),
    createElement: () => ({}),
  };
  const windowObject: any = {
    location,
    WebSocket: NativeWebSocket,
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
    document: documentObject,
    location,
    localStorage: windowObject.localStorage,
    URL,
    Request,
    MutationObserver: TestMutationObserver,
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'boot.js' });
  const api = windowObject.__multiAgent;
  api.testWindow = windowObject;
  api.webSocketCalls = webSocketCalls;
  api.emitMutations = (records: any[]) => mutationCallback?.(records);
  return api;
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
  // 登录是全局 Kimi 状态:/auth 永不带 provider,UI 只显示 Kimi 的登录态。
  assert.equal(api.rewriteApiUrl('/api/v1/auth').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/sessions/codex_abc/snapshot').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/files/abc').searchParams.get('provider'), 'claude');
  const codexSession = await loadShim('/sessions/codex_abc');
  assert.equal(codexSession.selectedProvider(), 'codex');
  assert.equal(codexSession.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'codex');
});

test('routes only same-origin gateway WebSockets through the selected provider', async () => {
  const api = await loadShim('/');
  api.setProvider('claude');
  const protocols = ['kimi-code.bearer.gateway-token'];
  new api.testWindow.WebSocket(
    'ws://localhost:58630/api/v1/ws?client_id=browser',
    protocols,
  );
  new api.testWindow.WebSocket('ws://localhost:58630/terminal', 'terminal-v1');
  new api.testWindow.WebSocket('wss://example.test/api/v1/ws', 'external-v1');

  assert.equal(
    api.webSocketCalls[0].url,
    'ws://localhost:58630/api/v1/ws?client_id=browser&provider=claude',
  );
  assert.deepEqual(api.webSocketCalls[0].protocols, protocols);
  assert.equal(api.webSocketCalls[1].url, 'ws://localhost:58630/terminal');
  assert.equal(api.webSocketCalls[1].protocols, 'terminal-v1');
  assert.equal(api.webSocketCalls[2].url, 'wss://example.test/api/v1/ws');
  assert.equal(api.webSocketCalls[2].protocols, 'external-v1');
});

test('routes filesystem APIs through the selected provider', async () => {
  const api = await loadShim('/');
  api.setProvider('codex');
  assert.equal(api.rewriteApiUrl('/api/v1/fs:home').searchParams.get('provider'), 'codex');
  assert.equal(api.rewriteApiUrl('/api/v1/fs:browse?path=%2Ftmp').searchParams.get('provider'), 'codex');
});

test('updates provider menu aria state when it opens and closes', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  assert.match(source, /setAttribute\(['\"]aria-expanded['\"],\s*String\(!menu\.hidden\)\)/);
  assert.match(source, /setAttribute\(['\"]aria-expanded['\"],\s*['\"]false['\"]\)/);
});

test('leaves the official Kimi account controls unchanged', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const nameAttributes = new Map<string, string>();
  const name = {
    textContent: 'Kimi User',
    hasAttribute: (key: string) => nameAttributes.has(key),
    getAttribute: (key: string) => nameAttributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => nameAttributes.set(key, value),
    removeAttribute: (key: string) => nameAttributes.delete(key),
  };
  const login = { hidden: false, setAttribute() {}, removeAttribute() {} };
  const trigger = {
    classList: {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    },
    querySelector: (selector: string) => selector === '.user-menu-name' ? name : null,
  };
  const location = { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' };
  const windowObject: any = {
    location,
    WebSocket: class {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };
  const documentObject: any = {
    readyState: 'loading',
    documentElement: {},
    addEventListener: () => {},
    createElement: () => ({}),
    querySelector: (selector: string) => selector === '.user-menu-trigger' ? trigger : null,
    querySelectorAll: (selector: string) => selector.indexOf('.user-menu-login') === 0 ? [login] : [],
  };
  vm.runInNewContext(source, {
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
  }, { filename: 'boot.js' });
  windowObject.__multiAgent.setProvider('claude');
  assert.equal(name.textContent, 'Kimi User');
  assert.equal(login.hidden, false);
  assert.equal(classes.has('multi-agent-provider-account'), false);
});

function fakeElement(tag: string): any {
  const el: any = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [] as any[],
    attributes: [] as Array<{ name: string; value: string }>,
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    type: '',
    isConnected: true,
    parentElement: null,
  };
  const classes = (): string[] => String(el.className).split(/\s+/).filter(Boolean);
  el.classList = {
    add: (...names: string[]) => { el.className = [...new Set([...classes(), ...names])].join(' '); },
    remove: (...names: string[]) => { el.className = classes().filter((c) => !names.includes(c)).join(' '); },
    toggle: (name: string, force?: boolean) => {
      const want = force === undefined ? !classes().includes(name) : force;
      if (want) el.classList.add(name); else el.classList.remove(name);
    },
    contains: (name: string) => classes().includes(name),
  };
  el.setAttribute = (name: string, value: string) => {
    const found = el.attributes.find((a: any) => a.name === name);
    if (found) found.value = value; else el.attributes.push({ name, value });
  };
  el.getAttribute = (name: string) => el.attributes.find((a: any) => a.name === name)?.value ?? null;
  el.appendChild = (child: any) => { child.parentElement = el; el.children.push(child); return child; };
  el.insertBefore = (child: any, ref: any) => {
    child.parentElement = el;
    const index = el.children.indexOf(ref);
    el.children.splice(index < 0 ? el.children.length : index, 0, child);
    return child;
  };
  el.addEventListener = (name: string, fn: any) => { (el._listeners ??= new Map()).set(name, fn); };
  el.click = () => { el._listeners?.get('click')?.({ stopPropagation() {}, preventDefault() {} }); };
  el.remove = () => {
    el.isConnected = false;
    if (el.parentElement) el.parentElement.children = el.parentElement.children.filter((c: any) => c !== el);
  };
  const matchesClass = (node: any, selector: string): boolean =>
    String(node.className ?? '').split(/\s+/).includes(selector.replace(/^\./, ''));
  el.matches = (selector: string) =>
    selector.split(',').some((part) => {
      const trimmed = part.trim();
      return trimmed.startsWith('.') && String(el.className).split(/\s+/).includes(trimmed.slice(1));
    });
  const walk = (node: any, selector: string, out: any[]): void => {
    for (const child of node.children) {
      if (selector.startsWith('.') && matchesClass(child, selector)) out.push(child);
      walk(child, selector, out);
    }
  };
  el.querySelector = (selector: string) => { const out: any[] = []; walk(el, selector, out); return out[0] ?? null; };
  el.querySelectorAll = (selector: string) => { const out: any[] = []; walk(el, selector, out); return out; };
  return el;
}

async function loadDomShim(options: {
  pathname?: string;
  getAnchor?: () => any;
  withFacade?: boolean;
  metaProviders?: string[];
  metaFails?: boolean;
  storedProvider?: string;
} = {}): Promise<any> {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  if (options.storedProvider) storage.set('multi-agent-gateway.provider.v1', options.storedProvider);
  const queries: string[] = [];
  const dispatched: string[] = [];
  const pushes: any[][] = [];
  const wsInstances: any[] = [];
  const facadeCalls: Record<string, number> = {};
  let reloads = 0;
  let mutationCallback: ((records: any[]) => void) | undefined;
  const location: any = {
    origin: 'http://localhost:58630',
    pathname: options.pathname ?? '/',
    search: '',
    hash: '',
    reload: () => { reloads += 1; },
  };
  const sidebar = fakeElement('div');
  const track = (name: string) => () => { facadeCalls[name] = (facadeCalls[name] ?? 0) + 1; return Promise.resolve(); };
  const facade = {
    load: track('load'),
  };
  const facadeSymbol = Symbol('KimiWebClientFacade');
  const appRoot = {
    __vue_app__: { _context: { provides: { [facadeSymbol]: facade } } },
  };
  const documentObject: any = {
    readyState: 'complete',
    documentElement: fakeElement('html'),
    addEventListener: () => {},
    createElement: (tag: string) => fakeElement(tag),
    querySelector: (selector: string) => {
      queries.push(selector);
      if (selector === '#app') return options.withFacade === false ? null : appRoot;
      if (selector === '.user-menu-trigger, .user-menu-login') return options.getAnchor?.() ?? null;
      if (selector === '.multi-agent-provider-wrap') {
        return sidebar.children.find((c: any) => c.classList.contains('multi-agent-provider-wrap')) ?? null;
      }
      if (selector === '.multi-agent-provider-name' || selector === '.multi-agent-provider-avatar' || selector === '.multi-agent-provider-pill') {
        return documentObject.querySelector('.multi-agent-provider-wrap')?.querySelector(selector) ?? null;
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  const windowObject: any = {
    location,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: () => {},
    dispatchEvent: (event: { type: string }) => { dispatched.push(event.type); return true; },
    history: {
      pushState: (...args: any[]) => {
        pushes.push(args);
        if (typeof args[2] === 'string') location.pathname = new URL(args[2], location.origin).pathname;
      },
      replaceState: () => {},
    },
    WebSocket: class {
      url: string; protocols: unknown; closed = false;
      constructor(url: string | URL, protocols?: unknown) {
        this.url = String(url); this.protocols = protocols; wsInstances.push(this);
      }
      close() { this.closed = true; }
    },
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location,
    localStorage: windowObject.localStorage,
    URL,
    Request,
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    PopStateEvent: class { type: string; constructor(type: string) { this.type = type; } },
    MutationObserver: class {
      constructor(callback: (records: any[]) => void) { mutationCallback = callback; }
      observe() {}
      disconnect() {}
    },
    fetch: async (input: unknown) => {
      if (options.metaFails) throw new Error('meta unreachable');
      const url = String((input as { url?: string })?.url ?? input);
      if (url.includes('/api/v1/meta')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { providers: options.metaProviders ?? ['kimi', 'claude', 'codex'] },
        }));
      }
      return new Response('{}');
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });
  const api = windowObject.__multiAgent;
  api.testWindow = windowObject;
  api.sidebar = sidebar;
  api.queries = queries;
  api.dispatched = dispatched;
  api.pushes = pushes;
  api.wsInstances = wsInstances;
  api.facadeCalls = facadeCalls;
  api.facade = facade;
  api.reloads = () => reloads;
  api.emitMutations = (records: any[]) => mutationCallback?.(records);
  return api;
}

function makeAnchor(): any {
  const anchor = fakeElement('button');
  anchor.className = 'user-menu-trigger';
  anchor.attributes.push({ name: 'data-v-9dadb2bf', value: '' });
  return anchor;
}

test('mounts the Agent selector directly above the sidebar account row', async () => {
  const anchor = makeAnchor();
  const api = await loadDomShim({ getAnchor: () => anchor });
  api.sidebar.appendChild(anchor);
  // 初次 syncUi 在脚本加载时已跑过(当时 anchor 尚未挂载),模拟账号区后出现。
  api.emitMutations([{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const wrap = api.sidebar.children[0];
  assert.ok(wrap, 'selector wrap should be inserted');
  assert.equal(api.sidebar.children[1], anchor);
  assert.equal(wrap.classList.contains('multi-agent-provider-wrap'), true);

  const row = wrap.querySelector('.multi-agent-provider-pill');
  assert.ok(row.classList.contains('user-menu-trigger'));
  assert.equal(row.getAttribute('aria-haspopup'), 'menu');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.equal(wrap.querySelector('.multi-agent-provider-name').textContent, 'Kimi');

  // 不动官方账号行本身,也不再探测 composer 的模型按钮。
  assert.equal(anchor.className, 'user-menu-trigger');
  assert.equal(anchor.children.length, 0);
  assert.equal(api.queries.some((q: string) => q.includes('.composer')), false);

  row.click();
  const menu = wrap.querySelector('.multi-agent-provider-menu');
  assert.equal(menu.hidden, false);
  assert.equal(row.getAttribute('aria-expanded'), 'true');

  menu.querySelectorAll('.multi-agent-provider-row')[1].click();
  assert.equal(api.selectedProvider(), 'claude');
  assert.equal(api.reloads(), 0);
  assert.equal(wrap.querySelector('.multi-agent-provider-name').textContent, 'Claude');
});

test('switches providers without reloading the page', async () => {
  const api = await loadDomShim({ pathname: '/sessions/session_abc', getAnchor: () => null });
  assert.equal(typeof api.switchProvider, 'function');
  new api.testWindow.WebSocket('ws://localhost:58630/api/v1/ws?client_id=a', ['kimi-code.bearer.t']);
  const terminal = new api.testWindow.WebSocket('ws://localhost:58630/terminal');

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(api.reloads(), 0);
  assert.deepEqual(api.pushes.map((args: any[]) => args[2]), ['/']);
  assert.equal(api.dispatched.includes('popstate'), true);
  assert.equal(api.wsInstances[0].closed, true);
  assert.equal(terminal.closed, false);
  assert.equal(api.selectedProvider(), 'claude');
  // 列表刷新走官方 facade 自己的完整引导,不是整页 reload。
  assert.deepEqual(api.facadeCalls, { load: 1 });

  // 已在主页时只做软刷新:不再改路由,也不弹 popstate。
  const popsBefore = api.dispatched.filter((type: string) => type === 'popstate').length;
  api.switchProvider('codex');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(api.reloads(), 0);
  assert.equal(api.pushes.length, 1);
  assert.equal(api.dispatched.filter((type: string) => type === 'popstate').length, popsBefore);
  assert.equal(api.facadeCalls.load, 2);
});

test('serializes provider refreshes so the latest selection lands last', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null });
  // 把 facade 加载器换成可控 deferred:第一次刷新挂起,模拟慢 provider。
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  api.facade.load = () => {
    call += 1;
    order.push(`start-${call}`);
    const marker = call;
    return (marker === 1 ? first : Promise.resolve()).then(() => order.push(`end-${marker}`));
  };

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.switchProvider('codex');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['start-1']);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('falls back to a full reload only when the official facade is unavailable', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null, withFacade: false });

  api.switchProvider('claude');

  assert.equal(api.reloads(), 1);
});

test('limits the selector to providers the gateway reports as installed', async () => {
  const api = await loadDomShim({ storedProvider: 'claude', metaProviders: ['kimi', 'codex'] });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(Array.from(api.providers), ['kimi', 'codex']);
  assert.equal(api.selectedProvider(), 'kimi');
});

test('keeps all providers when the meta request fails', async () => {
  const api = await loadDomShim({ metaFails: true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(Array.from(api.providers), ['kimi', 'claude', 'codex']);
});

test('reconciles the draft model to the provider catalog after switching', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null });
  const setModelCalls: string[] = [];
  api.facade.defaultModel = 'kimi-code/k3';
  api.facade.models = [{ model: 'kimi-code/k3' }, { model: 'kimi-code/k2' }];
  api.facade.setModel = (model: string) => { setModelCalls.push(model); api.facade.defaultModel = model; };
  api.facade.load = () => {
    const provider = api.selectedProvider();
    api.facade.models = provider === 'claude'
      ? [{ model: 'default' }, { model: 'sonnet' }]
      : provider === 'codex'
        ? [{ model: 'gpt-5.6-sol' }]
        : [{ model: 'kimi-code/k3' }, { model: 'kimi-code/k2' }];
    return Promise.resolve();
  };

  // 当前选择(k3)不在 Claude 目录里 → 校正为该 provider 的默认模型。
  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(setModelCalls, ['default']);

  // 切回 Kimi → 恢复离开 Kimi 时记住的选择,而不是落回目录第一个。
  api.switchProvider('kimi');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(setModelCalls, ['default', 'kimi-code/k3']);
});

test('removes and restores the Agent selector with the official account row', async () => {
  let anchor: any = makeAnchor();
  const api = await loadDomShim({ getAnchor: () => anchor });
  api.sidebar.appendChild(anchor);
  api.emitMutations([{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.sidebar.children[0]?.classList.contains('multi-agent-provider-wrap'), true);

  // 官方账号区卸载(如登录态切换重渲染)→ 选择器一并移除,不留孤儿。
  api.sidebar.children = [];
  anchor = null;
  const goneNode = { nodeType: 1, matches: (s: string) => s.includes('.user-menu-trigger'), querySelector: () => null };
  api.emitMutations([{ type: 'childList', addedNodes: [goneNode], removedNodes: [goneNode] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.sidebar.children.length, 0);

  // 账号区重新挂载 → 选择器恢复,仍在账号行正上方。
  anchor = makeAnchor();
  api.sidebar.appendChild(anchor);
  api.emitMutations([{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.sidebar.children[0]?.classList.contains('multi-agent-provider-wrap'), true);
  assert.equal(api.sidebar.children[1], anchor);
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

test('leaves unlabeled official mode rows unchanged', async () => {
  const { api, rows } = await loadModeShim();
  rows[1].querySelector = () => null;
  rows[2].querySelector = () => null;

  api.setProvider('claude');

  assert.deepEqual(rows.map((row) => row.style.display), ['', '', '']);
});

test('ignores transcript DOM mutations outside extension controls', async () => {
  let queryCount = 0;
  const api = await loadShim('/', {
    readyState: 'complete',
    querySelector: () => {
      queryCount += 1;
      return null;
    },
  });
  const initialQueryCount = queryCount;
  const transcriptNode = {
    nodeType: 1,
    matches: () => false,
    querySelector: () => null,
  };

  api.emitMutations([{
    type: 'childList',
    target: transcriptNode,
    addedNodes: [transcriptNode],
    removedNodes: [],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(queryCount, initialQueryCount);
});

test('ignores content mutations inside the official composer', async () => {
  let queryCount = 0;
  const api = await loadShim('/', {
    readyState: 'complete',
    querySelector: () => {
      queryCount += 1;
      return null;
    },
  });
  const initialQueryCount = queryCount;
  const composerNode = {
    nodeType: 1,
    matches: (selector: string) => selector.split(',').some((part) => part.trim() === '.composer'),
    querySelector: () => null,
  };
  const textNode = { nodeType: 3 };

  api.emitMutations([{
    type: 'childList',
    target: composerNode,
    addedNodes: [textNode],
    removedNodes: [],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(queryCount, initialQueryCount);
});

test('resyncs when the official account row is mounted', async () => {
  let queryCount = 0;
  const api = await loadShim('/', {
    readyState: 'complete',
    querySelector: () => {
      queryCount += 1;
      return null;
    },
  });
  const initialQueryCount = queryCount;
  const accountNode = {
    nodeType: 1,
    matches: (selector: string) => selector.split(',').some((part) => part.trim() === '.user-menu-trigger'),
    querySelector: () => null,
  };

  api.emitMutations([{
    type: 'childList',
    target: accountNode,
    addedNodes: [accountNode],
    removedNodes: [],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(queryCount > initialQueryCount);
});
