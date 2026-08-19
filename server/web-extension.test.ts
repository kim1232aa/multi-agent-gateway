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
  const rows = ['Plan', 'Swarm', 'Goal'].map((label) => {
    const attributes = new Map<string, string>([['data-mode-id', label.toLowerCase()]]);
    const classes = new Set(['am-row']);
    const labelNode = { textContent: label, getAttribute: () => null };
    return {
      hidden: false,
      children: [],
      style: { display: '' },
      textContent: label,
      classList: {
        contains: (name: string) => classes.has(name),
        toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      },
      querySelector: () => labelNode,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  });
  const storage = new Map<string, string>();
  const location = { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' };
  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === '.am-row' ? rows : [],
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
  assert.equal(api.rewriteApiUrl('/api/v2/sessions').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v2/sessions:archive').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v2/sessions:restore').searchParams.get('provider'), 'claude');
  // 设置页供应商目录是 Kimi 全局态,不跟 Agent 切换走。
  assert.equal(api.rewriteApiUrl('/api/v1/providers').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/catalog/providers').searchParams.has('provider'), false);
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

test('renders the Agent switcher as an official-style segmented control', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  assert.match(source, /ui-seg ui-seg--sm multi-agent-provider-seg/);
  assert.match(source, /role:\s*['\"]tablist['\"]|setAttribute\(['\"]role['\"],\s*['\"]tablist['\"]\)/);
  assert.match(source, /setAttribute\(['\"]aria-selected['\"]/);
  assert.match(source, /updateSegIndicator/);
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
    // SegmentedControl indicator 量宽需要这些几何字段;测试给稳定假值即可。
    offsetWidth: 64,
    offsetHeight: 24,
    offsetLeft: 0,
    offsetTop: 0,
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
  hash?: string;
  serverCredential?: string;
} = {}): Promise<any> {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  if (options.storedProvider) storage.set('multi-agent-gateway.provider.v1', options.storedProvider);
  if (options.serverCredential) storage.set('kimi-web.server-credential', options.serverCredential);
  const queries: string[] = [];
  const dispatched: string[] = [];
  const pushes: any[][] = [];
  const wsInstances: any[] = [];
  const facadeCalls: Record<string, number> = {};
  let reloads = 0;
  let metaAuth: string | undefined;
  let mutationCallback: ((records: any[]) => void) | undefined;
  const location: any = {
    origin: 'http://localhost:58630',
    pathname: options.pathname ?? '/',
    search: '',
    hash: options.hash ?? '',
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
  const docListeners: Record<string, (event: any) => void> = {};
  const documentObject: any = {
    readyState: 'complete',
    documentElement: fakeElement('html'),
    addEventListener: (name: string, fn: (event: any) => void) => { docListeners[name] = fn; },
    createElement: (tag: string) => fakeElement(tag),
    querySelector: (selector: string) => {
      queries.push(selector);
      if (selector === '#app') return options.withFacade === false ? null : appRoot;
      if (selector === '.user-menu-trigger, .user-menu-login') return options.getAnchor?.() ?? null;
      if (selector === '.multi-agent-provider-wrap') {
        return sidebar.children.find((c: any) => c.classList.contains('multi-agent-provider-wrap')) ?? null;
      }
      if (
        selector === '.multi-agent-provider-seg'
        || selector === '.multi-agent-provider-item'
        || selector === '.ui-seg__indicator'
      ) {
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
    fetch: async (input: unknown, init?: { headers?: { authorization?: string } }) => {
      if (options.metaFails) throw new Error('meta unreachable');
      const url = String((input as { url?: string })?.url ?? input);
      if (url.includes('/api/v1/meta')) {
        metaAuth = init?.headers?.authorization;
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
  api.metaAuth = () => metaAuth;
  api.docClick = (event: any) => docListeners.click?.(event);
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

  const seg = wrap.querySelector('.multi-agent-provider-seg');
  assert.ok(seg);
  assert.equal(seg.getAttribute('role'), 'tablist');
  assert.ok(seg.classList.contains('ui-seg'));
  const items = seg.querySelectorAll('.multi-agent-provider-item');
  assert.equal(items.length, 3);
  assert.equal(items[0].getAttribute('data-provider'), 'kimi');
  assert.equal(items[0].classList.contains('is-on'), true);
  assert.equal(items[0].getAttribute('aria-selected'), 'true');
  assert.equal(items[0].querySelector('.ui-seg__label').textContent, 'Kimi');

  // 不动官方账号行本身,也不再探测 composer 的模型按钮。
  assert.equal(anchor.className, 'user-menu-trigger');
  assert.equal(anchor.children.length, 0);
  assert.equal(api.queries.some((q: string) => q.includes('.composer')), false);

  items[1].click();
  assert.equal(api.selectedProvider(), 'claude');
  assert.equal(api.reloads(), 0);
  assert.equal(items[1].classList.contains('is-on'), true);
  assert.equal(items[0].classList.contains('is-on'), false);
  assert.equal(items[1].getAttribute('aria-selected'), 'true');
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

test('recognizes 0.37 composer mode rows from real zh/en labels without data-mode-id', async () => {
  // 官方 .am-row 没有 data-mode-id,gateModes 只能靠文案识别;之前测试全预置了 id。
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const makeRow = (label: string) => {
    const attributes = new Map<string, string>();
    const labelNode = { textContent: label, getAttribute: () => null };
    return {
      hidden: false,
      style: { display: '' },
      textContent: label,
      querySelector: () => labelNode,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  };
  const rowsZh = [
    makeRow('文件'),
    makeRow('启用 swarm 模式'),
    makeRow('设定目标并持续推进'),
    makeRow('计划'),
  ];
  const rowsEn = [
    makeRow('Files'),
    makeRow('Turn swarm mode on'),
    makeRow('Set a goal and keep going'),
    makeRow('Plan'),
  ];
  for (const rows of [rowsZh, rowsEn]) {
    const storage = new Map<string, string>();
    const location = { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' };
    const documentObject: any = {
      readyState: 'complete',
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === '.am-row' ? rows : [],
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
    const api = windowObject.__multiAgent;
    api.setProvider('claude');
    assert.equal(rows[0].style.display, '');
    assert.equal(rows[1].style.display, 'none');
    assert.equal(rows[2].style.display, 'none');
    assert.equal(rows[3].style.display, '');
    assert.equal(rows[1].getAttribute('data-mode-id'), 'swarm');
    assert.equal(rows[2].getAttribute('data-mode-id'), 'goal');
  }
});

test('leaves unlabeled official mode rows unchanged', async () => {
  const { api, rows } = await loadModeShim();
  rows[1].querySelector = () => null;
  rows[2].querySelector = () => null;
  rows[1].textContent = '';
  rows[2].textContent = '';
  rows[1].setAttribute('data-mode-id', '');
  rows[2].setAttribute('data-mode-id', '');

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

test('skips the stale reconcile when the selection changes during a slow load', async () => {
  // 回归:慢 provider(claude)的 load 挂起期间切到 codex,旧链落地时曾用
  // selectedProvider()(codex)去校正 claude 目录,把 draft 模型误设成
  // claude 目录第一项('default'),随后才被 codex 刷新盖掉。
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null });
  const setModelCalls: string[] = [];
  api.facade.defaultModel = 'kimi-code/k3';
  api.facade.models = [{ model: 'kimi-code/k3' }];
  api.facade.setModel = (model: string) => { setModelCalls.push(model); api.facade.defaultModel = model; };
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  api.facade.load = () => {
    call += 1;
    const provider = api.selectedProvider();
    api.facade.models = provider === 'claude'
      ? [{ model: 'default' }, { model: 'sonnet' }]
      : [{ model: 'gpt-5.6-sol' }];
    return (call === 1 ? first : Promise.resolve());
  };

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.switchProvider('codex');
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // claude 链的 reconcile 被跳过:只有 codex 的校正发生。
  assert.deepEqual(setModelCalls, ['gpt-5.6-sol']);
});

test('recovers the refresh chain after a synchronous facade.load throw', async () => {
  // 回归:facade.load 同步抛错曾让 refreshChain 永久 rejected,之后的
  // provider 切换全部静默失效(列表再也不刷新)。
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null });
  const setModelCalls: string[] = [];
  api.facade.defaultModel = 'kimi-code/k3';
  api.facade.models = [{ model: 'kimi-code/k3' }];
  api.facade.setModel = (model: string) => { setModelCalls.push(model); api.facade.defaultModel = model; };
  let calls = 0;
  api.facade.load = () => {
    calls += 1;
    if (calls === 1) throw new Error('sync boom');
    api.facade.models = [{ model: 'gpt-5.6-sol' }];
    return Promise.resolve();
  };

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 10));
  api.switchProvider('codex');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls, 2);
  assert.deepEqual(setModelCalls, ['gpt-5.6-sol']);
});

test('falls back to the stored server credential when the hash has no token', async () => {
  const json = await loadDomShim({ serverCredential: JSON.stringify({ token: 'stored-token' }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(json.metaAuth(), 'Bearer stored-token');

  const raw = await loadDomShim({ serverCredential: 'raw-token' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(raw.metaAuth(), 'Bearer raw-token');

  // hash 里的 token 优先于存储凭证。
  const hashWins = await loadDomShim({ hash: '#token=hash-token', serverCredential: 'raw-token' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(hashWins.metaAuth(), 'Bearer hash-token');
});

test('keeps the segmented Agent switcher always visible without a popup menu', async () => {
  const anchor = makeAnchor();
  const api = await loadDomShim({ getAnchor: () => anchor });
  api.sidebar.appendChild(anchor);
  api.emitMutations([{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const wrap = api.sidebar.children[0];
  const seg = wrap.querySelector('.multi-agent-provider-seg');
  assert.ok(seg);
  assert.equal(wrap.querySelector('.multi-agent-provider-menu'), null);
  assert.equal(wrap.querySelector('.multi-agent-provider-pill'), null);
  // 分段条本身没有展开态;点官方账号行也不应拆掉选择器。
  api.docClick({ target: anchor });
  assert.equal(api.sidebar.children[0], wrap);
  assert.ok(wrap.querySelector('.multi-agent-provider-seg'));
});
