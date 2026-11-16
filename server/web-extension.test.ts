import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
    sessionStorage: {
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
    sessionStorage: windowObject.sessionStorage,
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
  const rows = ['Plan', 'Swarm', 'Goal', 'Tower'].map((label) => {
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
  assert.equal(Array.from(api.providers).join(','), 'kimi,claude,codex,grok,pi,dsh');
  assert.equal(api.selectedProvider(), 'kimi');
  assert.equal(api.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'kimi');
  api.setProvider('claude');
  assert.equal(api.selectedProvider(), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/sessions').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v2/sessions').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v2/sessions:archive').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v2/sessions:restore').searchParams.get('provider'), 'claude');
  // 设置页供应商目录为全局，网关 /providers、/commands、/meta、/sessions/:id/status 与工作区按当前 provider 分流。
  assert.equal(api.rewriteApiUrl('/api/v1/providers').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/commands').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/meta').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/sessions/claude_abc/status').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/catalog/providers').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v2/mcp/auth-statuses').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/workspaces/project-config-dirs').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/workspaces/wd_1/trust').searchParams.get('provider'), 'claude');
  assert.equal(api.rewriteApiUrl('/api/v1/workspaces/wd_1/primary').searchParams.get('provider'), 'claude');
  // 登录是全局 Kimi 状态:/auth 永不带 provider,UI 只显示 Kimi 的登录态。
  assert.equal(api.rewriteApiUrl('/api/v1/auth').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/sessions/codex_abc/snapshot').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/files/abc').searchParams.get('provider'), 'claude');
  // 2.6.2 / 0.39 remote control / capabilities / plugins 是 Kimi 全局态,不跟 Agent 走。
  assert.equal(api.rewriteApiUrl('/v1/remote/devices').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/remote-control/status').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/capabilities').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/plugins').searchParams.has('provider'), false);
  assert.equal(api.rewriteApiUrl('/api/v1/plugins/marketplace').searchParams.has('provider'), false);
  const codexSession = await loadShim('/sessions/codex_abc');
  assert.equal(codexSession.selectedProvider(), 'codex');
  assert.equal(codexSession.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'codex');
  const grokSession = await loadShim('/sessions/grok_abc');
  assert.equal(grokSession.selectedProvider(), 'grok');
  assert.equal(grokSession.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'grok');
  const piSession = await loadShim('/sessions/pi_abc');
  assert.equal(piSession.selectedProvider(), 'pi');
  assert.equal(piSession.rewriteApiUrl('/api/v1/models').searchParams.get('provider'), 'pi');
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
  assert.equal(api.rewriteApiUrl('/api/v1/workspace/fs:search').searchParams.get('provider'), 'codex');
  assert.equal(api.rewriteApiUrl('/api/v1/workspace/fs:list').searchParams.get('provider'), 'codex');
  assert.equal(api.rewriteApiUrl('/api/v1/workspace/fs:suggest').searchParams.get('provider'), 'codex');
  assert.equal(api.rewriteApiUrl('/api/v1/fs:suggest').searchParams.get('provider'), 'codex');
  // 网关没有 /fs:content 的本地实现;打标会让非 Kimi 路径 404。
  assert.equal(api.rewriteApiUrl('/api/v1/fs:content').searchParams.has('provider'), false);
});

test('prevents cross-provider WebSocket subscribe frames from hitting the wrong backend', async () => {
  const sentFrames: string[] = [];
  const closedReasons: Array<{ code?: number; reason?: string }> = [];
  const source = await readFile(new URL('../../web-extension/boot.js', import.meta.url), 'utf8');
  class FakeSocket {
    url: string;
    readyState = 1;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    send(data: string) { sentFrames.push(data); }
    close(code?: number, reason?: string) { closedReasons.push({ code, reason }); }
    addEventListener() {}
  }
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
    WebSocket: FakeSocket,
  };
  const documentObject: any = {
    readyState: 'loading',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  const api = windowObject.__multiAgent;
  api.setProvider('codex');
  const ws = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws');
  const received: Array<Record<string, unknown>> = [];
  ws.onmessage = (ev: { data: string }) => received.push(JSON.parse(ev.data));

  // Stale subscribe from previous session (claude_1) while current provider is codex -> acked locally, never sent!
  ws.send(JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 'claude_1', agent_ids: ['main'] }));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(sentFrames.length, 0);
  assert.deepEqual(received[0], { type: 'response', request_id: 'r1', code: 0, msg: 'success' });

  // Valid matching subscribe -> sent through to server
  ws.send(JSON.stringify({ type: 'subscribe', request_id: 'r2', session_id: 'codex_1', agent_ids: ['main'] }));
  assert.equal(sentFrames.length, 1);

  // Subscribe matching current selectedProvider (pi) on stale codex socket -> triggers reconnect instead of mismatch
  api.setProvider('pi');
  ws.send(JSON.stringify({ type: 'subscribe', request_id: 'r3', session_id: 'pi_1', agent_ids: ['main'] }));
  assert.equal(sentFrames.length, 1);
  assert.deepEqual(closedReasons, [{ code: 1000, reason: 'provider-mismatch-reconnect' }]);
});

test('renders the Agent switcher as an official-style segmented control', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  assert.match(source, /ui-seg ui-seg--sm multi-agent-provider-seg/);
  assert.match(source, /role:\s*['\"]tablist['\"]|setAttribute\(['\"]role['\"],\s*['\"]tablist['\"]\)/);
  assert.match(source, /setAttribute\(['\"]aria-selected['\"]/);
  assert.match(source, /updateSegIndicator/);
  assert.match(source, /\.side-footer, \.user-menu-trigger/);
  assert.match(source, /querySelector\(['\"]\.view-tabs['\"]\)/);
  assert.doesNotMatch(source, /querySelector\(['\"]\.user-menu-trigger, \.user-menu-login['\"]\)/);
});

test('styles the switcher for 0.39 footer and mobile sheets without touching new chrome', async () => {
  const css = await readFile(join(process.cwd(), '../web-extension/style.css'), 'utf8');
  assert.match(css, /\.side-footer .multi-agent-provider-wrap/);
  assert.match(css, /\.sheet-panel .multi-agent-provider-wrap/);
  assert.match(css, /\.sheet-body .multi-agent-provider-wrap/);
  assert.doesNotMatch(css, /model-pill/);
  assert.doesNotMatch(css, /panel-tab-bar/);
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
    selector.split(',').some((part) => {
      const trimmed = part.trim();
      if (!trimmed.startsWith('.')) return false;
      const cls = trimmed.slice(1).split('.');
      const nodeClasses = String(node.className ?? '').split(/\s+/);
      return cls.every((c) => nodeClasses.includes(c));
    });
  el.matches = (selector: string) => matchesClass(el, selector);
  const walk = (node: any, selector: string, out: any[]): void => {
    for (const child of node.children) {
      if (matchesClass(child, selector)) out.push(child);
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
  getMobileTabs?: () => any;
  withFacade?: boolean;
  vueSetupState?: boolean;
  metaProviders?: string[];
  metaCapabilities?: Record<string, any>;
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
  const appRoot = options.vueSetupState
    ? { __vue_app__: { _context: { provides: {} }, _instance: { setupState: facade } } }
    : { __vue_app__: { _context: { provides: { [facadeSymbol]: facade } } } };
  const docListeners: Record<string, (event: any) => void> = {};
  const documentObject: any = {
    readyState: 'complete',
    documentElement: fakeElement('html'),
    addEventListener: (name: string, fn: (event: any) => void) => { docListeners[name] = fn; },
    createElement: (tag: string) => fakeElement(tag),
    querySelector: (selector: string) => {
      queries.push(selector);
      if (selector === '#app') return options.withFacade === false ? null : appRoot;
      if (selector === '.side-footer, .user-menu-trigger') return options.getAnchor?.() ?? null;
      if (selector === '.view-tabs') return options.getMobileTabs?.() ?? null;
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
    sessionStorage: {
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
    sessionStorage: windowObject.sessionStorage,
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
          data: {
            providers: options.metaProviders ?? ['kimi', 'claude', 'codex'],
            provider_capabilities: options.metaCapabilities,
          },
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

  assert.equal(api.queries.some((q: string) => q.includes('.model-pill') || q.includes('.panel-tab-bar') || q.includes('.ptb-tab')), false);

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

test('does not reload to Kimi when the 0.38 facade symbol is missing', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null, withFacade: false });

  api.switchProvider('claude');

  assert.equal(api.reloads(), 0);
  assert.equal(api.selectedProvider(), 'claude');
});

test('loads via the 0.39 Vue setupState client when KimiWebClientFacade is gone', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null, vueSetupState: true });

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(api.reloads(), 0);
  assert.equal(api.selectedProvider(), 'claude');
  assert.deepEqual(api.facadeCalls, { load: 1 });
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

  assert.deepEqual(Array.from(api.providers), ['kimi', 'claude', 'codex', 'grok', 'pi', 'dsh']);
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

test('restores the remembered model even when load already picked the catalog default', async () => {
  const api = await loadDomShim({ pathname: '/', getAnchor: () => null });
  const setModelCalls: string[] = [];
  api.testWindow.localStorage.setItem(
    'multi-agent-gateway.modelByProvider.v1',
    JSON.stringify({ claude: 'sonnet' }),
  );
  api.facade.defaultModel = 'kimi-code/k3';
  api.facade.models = [{ model: 'kimi-code/k3' }];
  api.facade.setModel = (model: string) => { setModelCalls.push(model); api.facade.defaultModel = model; };
  api.facade.load = () => {
    api.facade.models = [{ model: 'default' }, { model: 'sonnet' }];
    api.facade.defaultModel = 'default';
    return Promise.resolve();
  };

  api.switchProvider('claude');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(setModelCalls, ['sonnet']);
  assert.equal(api.facade.defaultModel, 'sonnet');
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
  assert.deepEqual(rows.map((row) => row.style.display), ['', 'none', '', 'none']);
  api.setProvider('grok');
  assert.deepEqual(rows.map((row) => row.style.display), ['', 'none', '', 'none']);
  api.setProvider('claude');
  assert.deepEqual(rows.map((row) => row.style.display), ['', 'none', 'none', 'none']);
  api.setProvider('pi');
  assert.deepEqual(rows.map((row) => row.style.display), ['none', 'none', 'none', 'none']);
  api.setProvider('kimi');
  assert.deepEqual(rows.map((row) => row.style.display), ['', '', '', '']);
});

test('recognizes 2.6.2 composer mode rows from real zh/en labels without data-mode-id', async () => {
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
    makeRow('启用 tower 模式'),
  ];
  const rowsEn = [
    makeRow('Files'),
    makeRow('Turn swarm mode on'),
    makeRow('Set a goal and keep going'),
    makeRow('Plan'),
    makeRow('Tower'),
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
    assert.equal(rows[4].style.display, 'none');
    assert.equal(rows[1].getAttribute('data-mode-id'), 'swarm');
    assert.equal(rows[2].getAttribute('data-mode-id'), 'goal');
    assert.equal(rows[4].getAttribute('data-mode-id'), 'tower');
    api.setProvider('pi');
    assert.equal(rows[3].style.display, 'none');
  }
});

test('hides official slash items that are not Kimi slots for the current provider', async () => {
  const makeItem = (name: string) => {
    const attributes = new Map<string, string>();
    const nameEl = { textContent: name };
    const row = {
      hidden: false,
      style: { display: '' },
      children: [nameEl],
      getAttribute: (key: string) => attributes.get(key) ?? null,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      hasAttribute: (key: string) => attributes.has(key),
      removeAttribute: (key: string) => attributes.delete(key),
    };
    (nameEl as { parentElement?: typeof row }).parentElement = row;
    return { nameEl, row };
  };
  const items = ['/compact', '/swarm', '/goal', '/btw', '/status', '/undo', '/tower'].map(makeItem);
  const api = await loadShim('/', {
    querySelectorAll: (selector: string) => {
      if (selector === '.slash-menu .slash-name') return items.map((item) => item.nameEl);
      return [];
    },
  });
  api.setProvider('claude');
  assert.deepEqual(items.map((item) => item.row.style.display), ['', 'none', 'none', 'none', '', 'none', 'none']);
  api.setProvider('pi');
  assert.deepEqual(items.map((item) => item.row.style.display), ['', 'none', 'none', 'none', '', 'none', 'none']);
  api.setProvider('grok');
  assert.deepEqual(items.map((item) => item.row.style.display), ['', 'none', '', 'none', '', '', 'none']);
  api.setProvider('codex');
  assert.deepEqual(items.map((item) => item.row.style.display), ['', 'none', '', 'none', '', '', 'none']);
  api.setProvider('kimi');
  assert.deepEqual(items.map((item) => item.row.style.display), ['', '', '', '', '', '', '']);
});

test('leaves unlabeled official mode rows unchanged', async () => {
  const { api, rows } = await loadModeShim();
  for (const idx of [1, 2, 3]) {
    rows[idx].querySelector = () => null;
    rows[idx].textContent = '';
    rows[idx].setAttribute('data-mode-id', '');
  }

  api.setProvider('claude');

  assert.deepEqual(rows.map((row) => row.style.display), ['', '', '', '']);
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

test('mounts the Agent selector above the desktop side-footer when present', async () => {
  const footer = fakeElement('div');
  footer.className = 'side-footer';
  const trigger = makeAnchor();
  footer.appendChild(trigger);
  const api = await loadDomShim({ getAnchor: () => footer });
  api.sidebar.appendChild(footer);
  api.emitMutations([{ type: 'childList', addedNodes: [footer], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(api.sidebar.children[0]?.classList.contains('multi-agent-provider-wrap'), true);
  assert.equal(api.sidebar.children[1], footer);
  assert.equal(footer.children[0], trigger);
});

test('mounts the Agent selector above mobile session list tabs', async () => {
  const tabs = fakeElement('div');
  tabs.className = 'view-tabs';
  const api = await loadDomShim({ getAnchor: () => null, getMobileTabs: () => tabs });
  api.sidebar.appendChild(tabs);
  api.emitMutations([{ type: 'childList', addedNodes: [tabs], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(api.sidebar.children[0]?.classList.contains('multi-agent-provider-wrap'), true);
  assert.equal(api.sidebar.children[1], tabs);
  const seg = api.sidebar.children[0].querySelector('.multi-agent-provider-seg');
  assert.ok(seg);
  assert.ok(seg.classList.contains('ui-seg'));
});

test('resyncs when the mobile session list tabs are mounted', async () => {
  let queryCount = 0;
  const api = await loadShim('/', {
    readyState: 'complete',
    querySelector: () => {
      queryCount += 1;
      return null;
    },
  });
  const initialQueryCount = queryCount;
  const tabsNode = {
    nodeType: 1,
    matches: (selector: string) => selector.split(',').some((part) => part.trim() === '.view-tabs'),
    querySelector: () => null,
  };

  api.emitMutations([{
    type: 'childList',
    target: tabsNode,
    addedNodes: [tabsNode],
    removedNodes: [],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(queryCount > initialQueryCount);
});

test('refreshes Kimi 2.6.2 Pinia stores and reconciles models when KimiWebClientFacade is absent', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  const fetchCalls: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
  const callLog: string[] = [];

  const configStore = {
    refreshServerMeta: async () => { callLog.push('refreshServerMeta'); },
    loadConfig: async () => { callLog.push('loadConfig'); },
  };
  const modelsStore: any = {
    models: [{ id: 'kimi-code/k3', model: 'kimi-code/k3' }],
    defaultModel: 'kimi-code/k3',
    draftModel: 'kimi-code/k3',
    modelsReady: false,
    setModels: (items: any[]) => { callLog.push('setModels'); modelsStore.models = items; },
    setModelsReady: (v: boolean) => { modelsStore.modelsReady = v; },
    setDefaultModel: (id: string) => { callLog.push(`setDefaultModel:${id}`); modelsStore.defaultModel = id; },
    setDraftModel: (id: string) => { callLog.push(`setDraftModel:${id}`); modelsStore.draftModel = id; },
  };
  const workspacesStore = {
    resetSessionGroupPagination: () => { callLog.push('resetSessionGroupPagination'); },
    loadWorkspaces: async () => { callLog.push('loadWorkspaces'); },
  };
  const sessionListStore = {
    resetSessionList: () => { callLog.push('resetSessionList'); },
    fireFirstSessionGroupPage: () => {
      callLog.push('fireFirstSessionGroupPage');
      return { firstPage: Promise.resolve({}), input: {}, serial: 1, signal: {} };
    },
    loadInitialSessionsByWorkspace: async () => {
      callLog.push('loadInitialSessionsByWorkspace');
      return { sessions: [{ id: 'pi_1' }] };
    },
    setSessionsPreservingLiveUsage: (items: any[]) => {
      callLog.push(`setSessionsPreservingLiveUsage:${items.length}`);
    },
  };
  const sessionsStore = {
    activeSessionId: 'kimi-1',
    setActiveSessionId: (id: unknown) => {
      callLog.push(`setActiveSessionId:${String(id)}`);
      sessionsStore.activeSessionId = id as any;
    },
  };
  const storeMap = new Map<string, any>([
    ['kimi.config', configStore],
    ['kimi.models', modelsStore],
    ['kimi.workspaces', workspacesStore],
    ['kimi.sessionList', sessionListStore],
    ['kimi.sessions', sessionsStore],
  ]);

  const location: any = {
    origin: 'http://localhost:58630',
    pathname: '/sessions/kimi-1',
    search: '',
    hash: '#token=gw-secret',
    reload: () => { throw new Error('must not reload page'); },
  };
  const appRoot = {
    __vue_app__: {
      _context: { provides: {} },
      _instance: { setupState: {} },
      config: { globalProperties: { $pinia: { _s: storeMap } } },
    },
  };
  const documentObject: any = {
    readyState: 'complete',
    documentElement: fakeElement('html'),
    addEventListener: () => {},
    createElement: (tag: string) => fakeElement(tag),
    querySelector: (selector: string) => (selector === '#app' ? appRoot : null),
    querySelectorAll: () => [],
  };
  const windowObject: any = {
    location,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: () => {},
    dispatchEvent: () => true,
    history: {
      pushState: (...args: any[]) => {
        if (typeof args[2] === 'string') location.pathname = new URL(args[2], location.origin).pathname;
      },
      replaceState: () => {},
    },
    WebSocket: class {
      addEventListener() {}
      close() {}
    },
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    PopStateEvent: class { type: string; constructor(t: string) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = String((input as { url?: string })?.url ?? input);
      fetchCalls.push({
        url,
        method: init?.method ?? 'GET',
        auth: init?.headers?.authorization,
        body: init?.body,
      });
      if (url.includes('/api/v1/meta')) {
        return new Response(JSON.stringify({ code: 0, data: { providers: ['kimi', 'claude', 'codex', 'grok', 'pi'] } }));
      }
      if (url.includes('/api/v1/models')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            items: [{
              provider: 'pi',
              model: 'anthropic/claude-sonnet-4',
              display_name: 'Claude Sonnet 4',
              max_context_size: 200000,
              capabilities: ['thinking'],
              support_efforts: ['low', 'high'],
              default_effort: 'low',
            }],
          },
        }));
      }
      return new Response(JSON.stringify({ code: 0, data: {} }));
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.switchProvider('pi');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(windowObject.__multiAgent.selectedProvider(), 'pi');
  assert.equal(location.pathname, '/');
  assert.equal(sessionsStore.activeSessionId, undefined);
  assert.equal(modelsStore.models[0]?.displayName, 'Claude Sonnet 4');
  assert.equal(modelsStore.models[0]?.maxContextSize, 200000);
  assert.equal(modelsStore.defaultModel, 'anthropic/claude-sonnet-4');
  assert.equal(modelsStore.draftModel, 'anthropic/claude-sonnet-4');
  assert.ok(callLog.includes('refreshServerMeta'));
  assert.ok(callLog.includes('loadConfig'));
  assert.ok(callLog.includes('loadWorkspaces'));
  assert.ok(callLog.includes('loadInitialSessionsByWorkspace'));
  assert.ok(callLog.includes('setSessionsPreservingLiveUsage:1'));
  const modelsReq = fetchCalls.find((c) => c.url.includes('/api/v1/models?provider=pi'));
  assert.equal(modelsReq?.auth, 'Bearer gw-secret');
  const configSync = fetchCalls.find((c) => c.url.includes('/api/v1/config?provider=pi') && c.method === 'POST');
  assert.equal(JSON.parse(configSync?.body ?? '{}').default_model, 'anthropic/claude-sonnet-4');
});

test('closes stale gateway WebSockets on visibility/online wakeup and closes all on pagehide', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const winListeners = new Map<string, Array<() => void>>();
  const docListeners = new Map<string, Array<() => void>>();
  const createdSockets: any[] = [];
  let fakeNow = 100_000;

  class FakeWs {
    url: string;
    readyState = 1;
    closedWith: Array<{ code?: number; reason?: string }> = [];
    private listeners = new Map<string, Array<() => void>>();
    constructor(url: string | URL) {
      this.url = String(url);
      createdSockets.push(this);
    }
    addEventListener(type: string, fn: () => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type: string) {
      for (const fn of this.listeners.get(type) ?? []) fn();
    }
    close(code?: number, reason?: string) {
      this.readyState = 3;
      this.closedWith.push({ code, reason });
      this.emit('close');
    }
  }

  const RealDate = Date;
  class FakeDate extends RealDate {
    static override now() { return fakeNow; }
  }

  const documentObject: any = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (name: string, fn: () => void) => {
      const list = docListeners.get(name) ?? [];
      list.push(fn);
      docListeners.set(name, list);
    },
    createElement: () => ({}),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    WebSocket: FakeWs,
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (name: string, fn: () => void) => {
      const list = winListeners.get(name) ?? [];
      list.push(fn);
      winListeners.set(name, list);
    },
    history: { pushState() {}, replaceState() {} },
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    Date: FakeDate,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  const staleWs = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws?client_id=stale');
  const freshWs = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws?client_id=fresh');
  fakeNow += 40_000;
  freshWs.emit('message');
  fakeNow += 10_000; // staleWs silent for 50s (> 45s), freshWs silent for 10s
  for (const fn of docListeners.get('visibilitychange') ?? []) fn();

  assert.deepEqual(staleWs.closedWith, [{ code: 4008, reason: 'stale-wakeup' }]);
  assert.deepEqual(freshWs.closedWith, []);

  for (const fn of winListeners.get('pagehide') ?? []) fn();
  assert.deepEqual(freshWs.closedWith, [{ code: 1000, reason: 'pagehide' }]);
});

test('blocks /plan for Pi and renders cached skill argument_hint in slash menu', async () => {
  const hintsCreated: Array<{ className: string; textContent: string }> = [];
  const makeRow = (name: string) => {
    const attrs = new Map<string, string>();
    const children: any[] = [];
    const nameEl: any = { textContent: name, nextSibling: null };
    const row: any = {
      hidden: false,
      style: { display: '' },
      children: [nameEl],
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      hasAttribute: (k: string) => attrs.has(k),
      removeAttribute: (k: string) => attrs.delete(k),
      querySelector: (sel: string) => sel === '.multi-agent-slash-hint' ? children.find((c) => c.className === 'multi-agent-slash-hint') ?? null : null,
      insertBefore: (node: any) => {
        node.remove = () => {
          const i = children.indexOf(node);
          if (i >= 0) children.splice(i, 1);
        };
        children.push(node);
      },
    };
    nameEl.parentElement = row;
    return { nameEl, row, children };
  };
  const rows = ['/plan', '/review', '/skill:deploy'].map(makeRow);

  const source = await readFile(new URL('../../web-extension/boot.js', import.meta.url), 'utf8');
  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (sel: string) => sel === '.slash-menu .slash-name' ? rows.map((r) => r.nameEl) : [],
    addEventListener: () => {},
    createElement: () => {
      const node = { className: '', textContent: '' };
      hintsCreated.push(node);
      return node;
    },
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({
      code: 0,
      data: {
        skills: [
          { name: 'review', description: 'Review changes', argument_hint: '[instructions]' },
          { name: 'deploy', description: 'Deploy env', argument_hint: '<env>' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  const api = windowObject.__multiAgent;
  api.setProvider('codex');
  await windowObject.fetch('/api/v1/sessions/codex_s1/skills');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(rows[0].row.style.display, '');
  assert.equal(rows[1].children[0]?.textContent, '[instructions]');
  assert.equal(rows[2].children[0]?.textContent, '<env>');

  api.setProvider('pi');
  assert.equal(rows[0].row.style.display, 'none');
  assert.equal(rows[1].children.length, 0);
});

test('slash menu keyboard navigation skips hidden rows and blocks hidden active Enter', async () => {
  const makeSlashItem = (label: string, active: boolean) => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>(active ? ['slash-item', 'active'] : ['slash-item']);
    const nameEl: any = { textContent: label, nextSibling: null };
    const row: any = {
      hidden: false,
      style: { display: '' },
      classList: { contains: (c: string) => classes.has(c), add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      hasAttribute: (k: string) => attrs.has(k),
      removeAttribute: (k: string) => attrs.delete(k),
      querySelector: () => null,
    };
    nameEl.parentElement = row;
    return { nameEl, row, classes };
  };

  const items = [makeSlashItem('/compact', true), makeSlashItem('/plan', false), makeSlashItem('/help', false)];
  const dispatched: string[] = [];
  const docListeners = new Map<string, Array<(e: any) => void>>();
  const activeTarget: any = {
    dispatchEvent: (ev: any) => {
      dispatched.push(ev.key);
      return true;
    },
  };
  const menuEl: any = {
    querySelectorAll: (sel: string) => sel === '.slash-item' ? items.map((i) => i.row) : [],
  };

  const source = await readFile(new URL('../../web-extension/boot.js', import.meta.url), 'utf8');
  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    activeElement: activeTarget,
    querySelector: (sel: string) => sel === '.slash-menu' ? menuEl : null,
    querySelectorAll: (sel: string) => sel === '.slash-menu .slash-name' ? items.map((i) => i.nameEl) : [],
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    createElement: () => ({ className: '', textContent: '' }),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };
  class FakeKeyboardEvent {
    key: string;
    code: string;
    constructor(_type: string, init: any) {
      this.key = init.key;
      this.code = init.code;
    }
  }
  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    KeyboardEvent: FakeKeyboardEvent,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.setProvider('pi');
  assert.equal(items[1].row.hasAttribute('data-multi-agent-slash-hidden'), true);

  let prevented = false;
  let stopped = false;
  for (const fn of docListeners.get('keydown') ?? []) {
    fn({
      key: 'ArrowDown',
      code: 'ArrowDown',
      target: activeTarget,
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
    });
  }
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(dispatched, ['ArrowDown', 'ArrowDown']);

  // Enter when active row itself is hidden must be blocked
  items[0].classes.delete('active');
  items[1].classes.add('active');
  let enterPrevented = false;
  for (const fn of docListeners.get('keydown') ?? []) {
    fn({
      key: 'Enter',
      code: 'Enter',
      target: activeTarget,
      preventDefault: () => { enterPrevented = true; },
      stopImmediatePropagation: () => {},
    });
  }
  assert.equal(enterPrevented, true);
});

test('reads 2.6.2 credential field and isolates Pinia model/workspace state across rapid provider switches', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const storage = new Map<string, string>();
  storage.set(
    'kimi-web.server-credential',
    JSON.stringify({ version: 1, credential: 'cred-262-secret', expiresAt: Date.now() + 60_000 }),
  );
  const fetchCalls: Array<{ url: string; auth?: string }> = [];
  let releaseCodex!: () => void;
  const codexGate = new Promise<void>((resolve) => { releaseCodex = resolve; });

  const configStore = {
    refreshServerMeta: async () => {},
    loadConfig: async () => {
      if (windowObject.__multiAgent.selectedProvider() === 'pi') {
        modelsStore.setDefaultModel('ccwu/gemini-3.8-flash');
      } else if (windowObject.__multiAgent.selectedProvider() === 'codex') {
        modelsStore.setDefaultModel('gemini-3.8-flash');
      }
    },
  };
  const modelsStore: any = {
    models: [{ id: 'default', provider: 'claude', model: 'default' }],
    defaultModel: 'default',
    draftModel: 'default',
    modelsReady: true,
    setModels: (items: any[]) => { modelsStore.models = items; },
    setModelsReady: (v: boolean) => { modelsStore.modelsReady = v; },
    setDefaultModel: (id: string | null) => { modelsStore.defaultModel = id; },
    setDraftModel: (id: string | null) => { modelsStore.draftModel = id; },
  };
  const workspacesStore: any = {
    workspaces: [{ id: 'wd_claude_only', root: '/tmp/claude' }],
    activeWorkspaceId: 'wd_claude_only',
    selectWorkspace: (id: string | null) => { workspacesStore.activeWorkspaceId = id; },
    resetSessionGroupPagination: () => {},
    loadWorkspaces: async () => {
      const p = windowObject.__multiAgent.selectedProvider();
      workspacesStore.workspaces = p === 'pi' ? [{ id: 'wd_pi_only', root: '/tmp/pi' }] : [];
    },
  };
  const sessionsStore: any = {
    activeSessionId: 'claude_s1',
    sessions: [{ id: 'claude_s1', workspaceId: 'wd_claude_only' }],
    setActiveSessionId: (id: unknown) => { sessionsStore.activeSessionId = id; },
    setSessions: (items: any[]) => { sessionsStore.sessions = items; },
  };
  const sessionListStore: any = {
    resetSessionList: () => {},
    fireFirstSessionGroupPage: () => ({ firstPage: Promise.resolve({}), input: {}, serial: 1, signal: {} }),
    loadInitialSessionsByWorkspace: async () => ({ sessions: [] }),
    setSessionsPreservingLiveUsage: () => {},
  };
  const storeMap = new Map<string, any>([
    ['kimi.config', configStore],
    ['kimi.models', modelsStore],
    ['kimi.workspaces', workspacesStore],
    ['kimi.sessions', sessionsStore],
    ['kimi.sessionList', sessionListStore],
  ]);

  const location: any = { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' };
  const appRoot = {
    __vue_app__: {
      _context: { provides: {} },
      _instance: { setupState: {} },
      config: { globalProperties: { $pinia: { _s: storeMap } } },
    },
  };
  const windowObject: any = {
    location,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    dispatchEvent: () => true,
    history: { pushState() {}, replaceState() {} },
    WebSocket: class { addEventListener() {} close() {} },
  };
  vm.runInNewContext(source, {
    window: windowObject,
    document: {
      readyState: 'complete',
      documentElement: fakeElement('html'),
      addEventListener: () => {},
      createElement: (tag: string) => fakeElement(tag),
      querySelector: (sel: string) => (sel === '#app' ? appRoot : null),
      querySelectorAll: () => [],
    },
    location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    PopStateEvent: class { type: string; constructor(t: string) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String((input as { url?: string })?.url ?? input);
      fetchCalls.push({ url, auth: init?.headers?.authorization });
      if (url.includes('/api/v1/meta')) {
        return new Response(JSON.stringify({ code: 0, data: { providers: ['kimi', 'claude', 'codex', 'grok', 'pi'] } }));
      }
      if (url.includes('/api/v1/models?provider=codex')) {
        await codexGate;
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [{ provider: 'codex', model: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', is_default: true }] },
        }));
      }
      if (url.includes('/api/v1/models?provider=pi')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            items: [
              { provider: 'pi', model: 'ccwu/gemini-3.8-flash', display_name: 'Gemini 3.8 Flash (ccwu)', is_default: true },
              { provider: 'pi', model: 'xai/grok-4.6', display_name: 'Grok 4.6 (xai)' },
            ],
          },
        }));
      }
      return new Response(JSON.stringify({ code: 0, data: {} }));
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.setProvider('claude');
  windowObject.__multiAgent.switchProvider('codex');
  // Switching immediately clears stale Claude models/draft/workspaces before network settles
  assert.equal(modelsStore.models.length, 0);
  assert.equal(modelsStore.draftModel, null);
  assert.equal(workspacesStore.workspaces.length, 0);
  assert.equal(workspacesStore.activeWorkspaceId, null);
  assert.equal(sessionsStore.sessions.length, 0);

  // Rapid switch to Pi while Codex request is still pending
  windowObject.__multiAgent.switchProvider('pi');
  releaseCodex();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(windowObject.__multiAgent.selectedProvider(), 'pi');
  assert.equal(modelsStore.models[0]?.provider, 'pi');
  assert.equal(modelsStore.models[0]?.id, 'ccwu/gemini-3.8-flash');
  assert.equal(modelsStore.defaultModel, 'ccwu/gemini-3.8-flash');
  assert.equal(modelsStore.draftModel, 'ccwu/gemini-3.8-flash');
  assert.equal(workspacesStore.activeWorkspaceId, 'wd_pi_only');
  assert.equal(fetchCalls.find((c) => c.url.includes('/api/v1/models?provider=pi'))?.auth, 'Bearer cred-262-secret');
  assert.equal(fetchCalls.find((c) => c.url.includes('/api/v1/meta'))?.auth, 'Bearer cred-262-secret');
});

test('sends active ping probe on wakeup after 10s idle and closes at 3s if pong never arrives', async () => {
  const source = await readFile(new URL('../../web-extension/boot.js', import.meta.url), 'utf8');
  const docListeners = new Map<string, Array<() => void>>();
  let fakeNow = 100_000;

  class ProbeWs {
    url: string;
    readyState = 1;
    sent: string[] = [];
    closedWith: Array<{ code?: number; reason?: string }> = [];
    private listeners = new Map<string, Array<(ev?: unknown) => void>>();
    constructor(url: string | URL) {
      this.url = String(url);
    }
    addEventListener(type: string, fn: (ev?: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type: string, ev?: unknown) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code?: number, reason?: string) {
      this.readyState = 3;
      this.closedWith.push({ code, reason });
      this.emit('close');
    }
  }

  const RealDate = Date;
  class FakeDate extends RealDate {
    static override now() { return fakeNow; }
  }

  const documentObject: any = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (name: string, fn: () => void) => {
      const list = docListeners.get(name) ?? [];
      list.push(fn);
      docListeners.set(name, list);
    },
    createElement: () => ({}),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    WebSocket: ProbeWs,
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    const entry = { fn, ms, cleared: false };
    scheduled.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeClearTimeout = (id: ReturnType<typeof setTimeout>) => {
    const entry = id as unknown as { cleared?: boolean };
    if (entry && typeof entry === 'object') entry.cleared = true;
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    Date: FakeDate,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  }, { filename: 'boot.js' });

  const healthyWs = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws?client_id=healthy');
  const deadWs = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws?client_id=dead');

  // 15s idle (> 10s probe threshold, < 45s hard stale threshold)
  fakeNow += 15_000;
  for (const fn of docListeners.get('visibilitychange') ?? []) fn();

  assert.deepEqual(healthyWs.sent, [JSON.stringify({ type: 'ping' })]);
  assert.deepEqual(deadWs.sent, [JSON.stringify({ type: 'ping' })]);

  // Healthy socket receives pong before 3s timer fires
  fakeNow += 100;
  healthyWs.emit('message', { data: JSON.stringify({ type: 'pong' }) });

  for (const t of scheduled) {
    if (!t.cleared && t.ms === 3000) t.fn();
  }

  assert.deepEqual(healthyWs.closedWith, []);
  assert.deepEqual(deadWs.closedWith, [{ code: 4008, reason: 'stale-wakeup' }]);
});

test('dynamically updates gateModes and gateSlashMenu when /api/v1/meta returns provider_capabilities', async () => {
  const source = await readFile(
    existsSync(join(process.cwd(), '../web-extension/boot.js'))
      ? join(process.cwd(), '../web-extension/boot.js')
      : join(process.cwd(), 'web-extension/boot.js'),
    'utf8',
  );

  const makeModeRow = (id: string) => {
    const attributes = new Map<string, string>([['data-mode-id', id]]);
    return {
      hidden: false,
      style: { display: '' },
      textContent: id,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => attributes.delete(name),
      querySelector: () => ({ textContent: id, getAttribute: () => null }),
    };
  };
  const modeRows = ['plan', 'swarm', 'goal', 'tower'].map(makeModeRow);

  const makeSlashItem = (name: string) => {
    const attributes = new Map<string, string>();
    const classes = new Set(['slash-item']);
    const nameEl = { textContent: name };
    const row = {
      hidden: false,
      style: { display: '' },
      children: [nameEl],
      classList: {
        contains: (c: string) => classes.has(c),
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: string) => attributes.set(k, v),
      hasAttribute: (k: string) => attributes.has(k),
      removeAttribute: (k: string) => attributes.delete(k),
    };
    (nameEl as any).parentElement = row;
    return { nameEl, row };
  };
  const slashItems = ['/tower', '/swarm', '/goal', '/plan', '/btw', '/undo', '/compact', '/fork'].map(makeSlashItem);

  let metaResponse = {
    code: 0,
    data: {
      providers: ['kimi', 'claude', 'codex', 'grok', 'pi'],
      provider_capabilities: {
        claude: {
          tower: true,
          goals: true,
          planMode: true,
          swarm: false,
          btw: false,
          rollback: false,
          compact: true,
          fork: true,
        },
        pi: {
          planMode: true,
          tower: false,
          swarm: false,
          goals: false,
          btw: false,
          rollback: false,
          compact: true,
          fork: true,
        },
      },
    },
  };

  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '.am-row') return modeRows;
      if (selector === '.slash-menu .slash-name') return slashItems.map((i) => i.nameEl);
      return [];
    },
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (input: unknown) => {
      const url = String((input as any)?.url ?? input);
      if (url.includes('/api/v1/meta')) {
        return new Response(JSON.stringify(metaResponse));
      }
      return new Response('{}');
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  const api = windowObject.__multiAgent;
  // Wait for initial loadAvailableProviders to settle
  await new Promise((r) => setTimeout(r, 20));

  // Claude dynamically gained tower: true and goals: true from /api/v1/meta
  api.setProvider('claude');
  assert.equal(modeRows[0].style.display, ''); // plan
  assert.equal(modeRows[1].style.display, 'none'); // swarm
  assert.equal(modeRows[2].style.display, ''); // goal (unlocked!)
  assert.equal(modeRows[3].style.display, ''); // tower (unlocked!)

  // In slash menu, /tower and /goal are now unlocked for Claude
  assert.equal(slashItems[0].row.style.display, ''); // /tower unlocked
  assert.equal(slashItems[1].row.style.display, 'none'); // /swarm still blocked
  assert.equal(slashItems[2].row.style.display, ''); // /goal unlocked
  assert.equal(slashItems[3].row.style.display, ''); // /plan
  assert.equal(slashItems[4].row.style.display, 'none'); // /btw still blocked
  assert.equal(slashItems[5].row.style.display, 'none'); // /undo still blocked
  assert.equal(slashItems[6].row.style.display, ''); // /compact
  assert.equal(slashItems[7].row.style.display, ''); // /fork

  // Pi dynamically gained planMode: true
  api.setProvider('pi');
  assert.equal(modeRows[0].style.display, ''); // plan (unlocked!)
  assert.equal(modeRows[1].style.display, 'none'); // swarm
  assert.equal(modeRows[2].style.display, 'none'); // goal
  assert.equal(modeRows[3].style.display, 'none'); // tower
  assert.equal(slashItems[3].row.style.display, ''); // /plan unlocked
});

test('distinguishes Tier-1 (.slash-item) vs Tier-2 (.slash-item.is-skill) when gating /plan and /goal', async () => {
  const source = await readFile(
    existsSync(join(process.cwd(), '../web-extension/boot.js'))
      ? join(process.cwd(), '../web-extension/boot.js')
      : join(process.cwd(), 'web-extension/boot.js'),
    'utf8',
  );

  const makeRow = (name: string, isSkill: boolean) => {
    const classes = new Set(['slash-item']);
    if (isSkill) classes.add('is-skill');
    const attributes = new Map<string, string>();
    const nameEl = { textContent: name };
    const row = {
      hidden: false,
      style: { display: '' },
      children: [nameEl],
      classList: {
        contains: (c: string) => classes.has(c),
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: string) => attributes.set(k, v),
      hasAttribute: (k: string) => attributes.has(k),
      removeAttribute: (k: string) => attributes.delete(k),
    };
    (nameEl as any).parentElement = row;
    return { nameEl, row };
  };

  const menuRows = [
    makeRow('/plan', false), // Tier-1 Kimi mode command
    makeRow('/plan', true),  // Tier-2 provider skill command
    makeRow('/goal', false), // Tier-1 Kimi mode command
    makeRow('/goal', true),  // Tier-2 provider skill command
    makeRow('/status', false),
  ];

  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '.slash-menu .slash-name') return menuRows.map((m) => m.nameEl);
      return [];
    },
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  const api = windowObject.__multiAgent;

  // On Pi: caps.planMode === false, caps.goals === false.
  // Tier-1 /plan and /goal must be hidden, but Tier-2 (.is-skill) /plan and /goal must stay visible!
  api.setProvider('pi');
  assert.equal(menuRows[0].row.style.display, 'none'); // Tier-1 /plan hidden
  assert.equal(menuRows[1].row.style.display, '');     // Tier-2 /plan VISIBLE
  assert.equal(menuRows[2].row.style.display, 'none'); // Tier-1 /goal hidden
  assert.equal(menuRows[3].row.style.display, '');     // Tier-2 /goal VISIBLE
  assert.equal(menuRows[4].row.style.display, '');     // Tier-1 /status visible

  // On Claude: caps.planMode === true, caps.goals === false.
  // Tier-1 /plan is visible. Tier-1 /goal is hidden, but Tier-2 (.is-skill) /goal stays visible!
  api.setProvider('claude');
  assert.equal(menuRows[0].row.style.display, '');     // Tier-1 /plan visible
  assert.equal(menuRows[1].row.style.display, '');     // Tier-2 /plan visible
  assert.equal(menuRows[2].row.style.display, 'none'); // Tier-1 /goal hidden
  assert.equal(menuRows[3].row.style.display, '');     // Tier-2 /goal VISIBLE
  assert.equal(menuRows[4].row.style.display, '');     // Tier-1 /status visible
});

test('slash menu active selection advances past invisible rows and protects enter key', async () => {
  const source = await readFile(
    existsSync(join(process.cwd(), '../web-extension/boot.js'))
      ? join(process.cwd(), '../web-extension/boot.js')
      : join(process.cwd(), 'web-extension/boot.js'),
    'utf8',
  );

  const docListeners = new Map<string, Array<(e: any) => void>>();
  const dispatched: string[] = [];
  const activeTarget: any = {
    dispatchEvent: (ev: { key: string }) => {
      dispatched.push(ev.key);
      return true;
    },
  };

  const makeRow = (name: string, isSkill: boolean, isActive = false) => {
    const classes = new Set(['slash-item']);
    if (isSkill) classes.add('is-skill');
    if (isActive) classes.add('active');
    const attributes = new Map<string, string>();
    const nameEl = { textContent: name };
    const row = {
      hidden: false,
      style: { display: '' },
      children: [nameEl],
      classList: {
        contains: (c: string) => classes.has(c),
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: string) => attributes.set(k, v),
      hasAttribute: (k: string) => attributes.has(k),
      removeAttribute: (k: string) => attributes.delete(k),
    };
    (nameEl as any).parentElement = row;
    return { nameEl, row, classes };
  };

  const items = [
    makeRow('/plan', false, true), // Tier-1 /plan (initially active, will be hidden on Pi)
    makeRow('/plan', true, false), // Tier-2 /plan (.is-skill, stays visible on Pi)
    makeRow('/status', false, false),
  ];

  const menuEl = {
    querySelectorAll: (sel: string) => (sel === '.slash-item' ? items.map((i) => i.row) : []),
    querySelector: () => activeTarget,
  };

  class FakeKeyboardEvent {
    key: string;
    code: string;
    constructor(_type: string, init: any) {
      this.key = init.key;
      this.code = init.code;
    }
  }

  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    activeElement: activeTarget,
    querySelector: (sel: string) => (sel === '.slash-menu' ? menuEl : null),
    querySelectorAll: (sel: string) => (sel === '.slash-menu .slash-name' ? items.map((i) => i.nameEl) : []),
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    createElement: () => ({ className: '', textContent: '' }),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    KeyboardEvent: FakeKeyboardEvent,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  // Switching to Pi hides Tier-1 /plan (items[0])
  windowObject.__multiAgent.setProvider('pi');
  assert.equal(items[0].row.style.display, 'none');
  assert.equal(items[1].row.style.display, '');

  // gateSlashMenu advanced active selection from invisible items[0] to visible items[1]
  assert.equal(items[0].classes.has('active'), false);
  assert.equal(items[1].classes.has('active'), true);
  assert.deepEqual(dispatched, ['ArrowDown']);

  // Enter when visible Tier-2 skill is active must NOT be blocked
  let enterPrevented = false;
  for (const fn of docListeners.get('keydown') ?? []) {
    fn({
      key: 'Enter',
      code: 'Enter',
      target: activeTarget,
      preventDefault: () => { enterPrevented = true; },
      stopImmediatePropagation: () => {},
    });
  }
  assert.equal(enterPrevented, false);
});

test('resets kimi.mode state on provider switch so stale plan/goal/thinking does not bleed', async () => {
  const source = await readFile(
    existsSync(join(process.cwd(), '../web-extension/boot.js'))
      ? join(process.cwd(), '../web-extension/boot.js')
      : join(process.cwd(), 'web-extension/boot.js'),
    'utf8',
  );

  let resetModeCalled = false;
  const modeStore: any = {
    thinking: { value: 'high' },
    draftThinkingExplicit: { value: true },
    thinkingBySession: { s1: 'high' },
    planModeBySession: { s1: true },
    goalModeBySession: { s1: true },
    draftModes: {
      planMode: true,
      swarmMode: true,
      towerMode: false,
      towerBase: undefined,
      goalMode: true,
    },
    planMode: { value: true },
    goalMode: { value: true },
    resetMode: () => {
      resetModeCalled = true;
    },
  };
  const sessionsStore: any = {
    activeSessionId: 's1',
    sessions: [{ id: 's1' }],
    setActiveSessionId: (id: any) => { sessionsStore.activeSessionId = id; },
    setSessions: (items: any[]) => { sessionsStore.sessions = items; },
  };
  const workspacesStore: any = {
    workspaces: [{ id: 'w1' }],
    selectWorkspace: () => {},
  };
  const invalidatedWorkspaces: string[] = [];
  const invalidatedSessions: string[] = [];
  const modelsStore: any = {
    models: [{ id: 'm1' }],
    draftModel: 'm1',
    defaultModel: 'm1',
    skillsByWorkspace: { wd_shared: [{ name: 'pi-only' }] },
    skillsFetchedByWorkspace: { wd_shared: true },
    skillsBySession: { s1: [{ name: 'pi-only' }] },
    skillsFetchedBySession: { s1: true },
    invalidateSkillsForWorkspace: (id: string) => {
      invalidatedWorkspaces.push(id);
      delete modelsStore.skillsByWorkspace[id];
      delete modelsStore.skillsFetchedByWorkspace[id];
    },
    invalidateSkillsForSession: (id: string) => {
      invalidatedSessions.push(id);
      delete modelsStore.skillsBySession[id];
      delete modelsStore.skillsFetchedBySession[id];
    },
    setModels: (items: any[]) => { modelsStore.models = items; },
    setDraftModel: (m: any) => { modelsStore.draftModel = m; },
    setDefaultModel: (m: any) => { modelsStore.defaultModel = m; },
  };
  const storeMap = new Map<string, any>([
    ['kimi.mode', modeStore],
    ['kimi.sessions', sessionsStore],
    ['kimi.workspaces', workspacesStore],
    ['kimi.models', modelsStore],
  ]);

  const appRoot = {
    __vue_app__: {
      _context: { provides: {} },
      _instance: { setupState: {} },
      config: { globalProperties: { $pinia: { _s: storeMap } } },
    },
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    dispatchEvent: () => true,
    history: { pushState() {}, replaceState() {} },
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: {
      readyState: 'complete',
      documentElement: fakeElement('html'),
      addEventListener: () => {},
      createElement: (tag: string) => fakeElement(tag),
      querySelector: (sel: string) => (sel === '#app' ? appRoot : null),
      querySelectorAll: () => [],
    },
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    PopStateEvent: class { type: string; constructor(t: string) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.setProvider('kimi');
  windowObject.__multiAgent.switchProvider('pi');

  // Verify resetMode was invoked and refs/properties were cleanly cleared
  assert.equal(resetModeCalled, true);
  assert.equal(modeStore.thinking.value, undefined);
  assert.equal(modeStore.draftThinkingExplicit.value, false);
  assert.deepEqual(Object.keys(modeStore.thinkingBySession), []);
  assert.deepEqual(Object.keys(modeStore.planModeBySession), []);
  assert.deepEqual(Object.keys(modeStore.goalModeBySession), []);
  assert.equal(modeStore.draftModes.planMode, false);
  assert.equal(modeStore.draftModes.goalMode, false);
  assert.equal(modeStore.planMode.value, false);
  assert.equal(modeStore.goalMode.value, false);
  assert.deepEqual(invalidatedWorkspaces, ['wd_shared']);
  assert.deepEqual(invalidatedSessions, ['s1']);
});

test('handles argument_hint and argumentHint cleanly for both /cmd and /skill:cmd rows', async () => {
  const source = await readFile(
    existsSync(join(process.cwd(), '../web-extension/boot.js'))
      ? join(process.cwd(), '../web-extension/boot.js')
      : join(process.cwd(), 'web-extension/boot.js'),
    'utf8',
  );

  const makeRow = (name: string) => {
    const classes = new Set(['slash-item', 'is-skill']);
    const nameEl: any = { textContent: name, nextSibling: null };
    const children: any[] = [nameEl];
    const row = {
      hidden: false,
      style: { display: '' },
      children,
      classList: { contains: (c: string) => classes.has(c) },
      hasAttribute: () => false,
      querySelector: (sel: string) => children.find((c) => c.className === sel.replace(/^\./, '')) ?? null,
      insertBefore: (node: any, ref: any) => {
        const idx = children.indexOf(ref);
        if (idx === -1) children.push(node);
        else children.splice(idx, 0, node);
        return node;
      },
      appendChild: (node: any) => { children.push(node); return node; },
    };
    nameEl.parentElement = row;
    return { nameEl, row };
  };

  const rows = [
    makeRow('/review'),
    makeRow('/skill:review'),
    makeRow('/deploy'),
    makeRow('/skill:deploy'),
  ];

  const documentObject: any = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '.slash-menu .slash-name') return rows.map((r) => r.nameEl);
      return [];
    },
    addEventListener: () => {},
    createElement: (tag: string) => fakeElement(tag),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };

  const skillsPayload = JSON.stringify({
    code: 0,
    data: {
      skills: [
        { name: 'review', argument_hint: '<pr-or-branch>' },
        { name: 'skill:deploy', argumentHint: '<env>' },
      ],
    },
  });

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (input: unknown) => {
      const url = String((input as any)?.url ?? input);
      if (url.includes('/skills')) {
        return new Response(skillsPayload, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}');
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.setProvider('pi');
  await windowObject.fetch('http://localhost:58630/api/v1/sessions/pi_1/skills?provider=pi');
  await new Promise((r) => setTimeout(r, 20));

  // Both /review and /skill:review receive the hint
  const hintReviewBare = rows[0].row.querySelector('.multi-agent-slash-hint');
  const hintReviewPrefixed = rows[1].row.querySelector('.multi-agent-slash-hint');
  assert.equal(hintReviewBare?.textContent, '<pr-or-branch>');
  assert.equal(hintReviewPrefixed?.textContent, '<pr-or-branch>');

  // Both /deploy and /skill:deploy receive the hint
  const hintDeployBare = rows[2].row.querySelector('.multi-agent-slash-hint');
  const hintDeployPrefixed = rows[3].row.querySelector('.multi-agent-slash-hint');
  assert.equal(hintDeployBare?.textContent, '<env>');
  assert.equal(hintDeployPrefixed?.textContent, '<env>');
});

test('enhanceQuestionCards adds live filter bar for >6 options and syncExtBar renders Pi extension statuses/widgets', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const qopts = fakeElement('div');
  qopts.className = 'qopts';
  for (let i = 0; i < 8; i += 1) {
    const opt = fakeElement('label');
    opt.className = 'qopt';
    opt.textContent = i === 3 ? 'cx/gpt-6.1-sol (alibb9)' : `model-${i}`;
    qopts.appendChild(opt);
  }
  const qpane = fakeElement('div');
  qpane.className = 'qpane';
  qpane.appendChild(qopts);
  const qcard = fakeElement('div');
  qcard.className = 'qcard';
  qcard.appendChild(qpane);

  const composer = fakeElement('div');
  composer.className = 'composer';
  const mainPane = fakeElement('div');
  mainPane.className = 'main-pane';
  mainPane.appendChild(qcard);
  mainPane.appendChild(composer);

  const wsCreated: any[] = [];
  class MockWebSocket {
    listeners = new Map<string, Array<(ev: any) => void>>();
    readyState = 1;
    constructor(public url: string) {
      wsCreated.push(this);
    }
    addEventListener(type: string, fn: (ev: any) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type: string, ev: any) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
    send() {}
    close() {}
  }

  const documentObject: any = {
    readyState: 'complete',
    documentElement: mainPane,
    querySelector: (sel: string) => mainPane.querySelector(sel),
    querySelectorAll: (sel: string) => {
      if (sel === '.qcard .qpane .qopts') return [qopts];
      return mainPane.querySelectorAll(sel);
    },
    addEventListener: () => {},
    createElement: (tag: string) => fakeElement(tag),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/sessions/pi_s1', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
    WebSocket: MockWebSocket,
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    WebSocket: MockWebSocket,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response('{}'),
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  // 1. Search bar injected for 8 options and filters live
  const searchBox = qpane.querySelector('.multi-agent-qsearch');
  assert.ok(searchBox, 'expected search bar when options > 6');
  const searchInput = searchBox.querySelector('.multi-agent-qsearch__input');
  const countEl = searchBox.querySelector('.multi-agent-qsearch__count');
  assert.equal(countEl.textContent, '8 / 8');

  searchInput.value = 'gpt-6.1';
  searchInput._listeners.get('input')?.();
  assert.equal(countEl.textContent, '1 / 8');
  const optEls = qopts.querySelectorAll('.qopt');
  assert.equal(optEls[3].hidden, false);
  assert.equal(optEls[0].hidden, true);
  assert.equal(optEls[0].getAttribute('data-multi-agent-qhidden'), '');

  // Escape with query clears filter
  let stopped = false;
  searchInput._listeners.get('keydown')?.({
    key: 'Escape',
    stopPropagation: () => { stopped = true; },
    preventDefault: () => {},
  });
  assert.equal(stopped, true);
  assert.equal(searchInput.value, '');
  assert.equal(countEl.textContent, '8 / 8');
  assert.equal(optEls[0].hidden, false);

  // 2. WS extension_ui message renders status pills and widgets for Pi session
  windowObject.__multiAgent.setProvider('pi');
  const ws = new windowObject.WebSocket('ws://localhost:58630/api/v1/ws');
  ws.emit('message', {
    data: JSON.stringify({
      type: 'extension_ui',
      session_id: 'pi_s1',
      statuses: { 'plan-mode': 'Plan active' },
      widgets: { plan: { lines: ['A', 'B'] } },
      title: 'Planning',
    }),
  });
  await new Promise((r) => setTimeout(r, 20));
  const extBar = mainPane.querySelector('.multi-agent-ext-bar');
  assert.ok(extBar, 'expected Pi extension UI bar above composer');
  assert.equal(extBar.querySelector('.multi-agent-ext-pill')?.textContent, 'plan-mode: Plan active');
  assert.equal(extBar.querySelector('.multi-agent-ext-widgets')?.textContent, 'A\nB');

  // Switching away from Pi hides the Pi extension bar
  windowObject.location.pathname = '/sessions/claude_c1';
  windowObject.__multiAgent.setProvider('claude');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mainPane.querySelector('.multi-agent-ext-bar'), null);
});

test('Pi bare /plan bypasses Kimi mode hijack and dispatches POST /prompts on Enter and Send click', async () => {
  const source = await readFile(join(process.cwd(), '../web-extension/boot.js'), 'utf8');
  const editor = fakeElement('div');
  editor.className = 'ProseMirror';
  editor.textContent = '/plan';
  editor.closest = (sel: string) => (sel.includes('.composer') ? composer : null);

  const sendBtn = fakeElement('button');
  sendBtn.className = 'send';
  sendBtn.setAttribute('aria-label', '发送 ↵');
  sendBtn.closest = (sel: string) => (sel.includes('button') ? sendBtn : null);

  const composer = fakeElement('div');
  composer.className = 'composer';
  composer.appendChild(editor);
  composer.appendChild(sendBtn);

  const docListeners = new Map<string, Array<(e: any) => void>>();
  const posted: Array<{ url: string; body: string }> = [];

  const documentObject: any = {
    readyState: 'complete',
    documentElement: composer,
    activeElement: editor,
    querySelector: (sel: string) => {
      if (sel.includes('ProseMirror')) return editor;
      if (sel === '.slash-menu') return null;
      return composer.querySelector(sel);
    },
    querySelectorAll: (sel: string) => composer.querySelectorAll(sel),
    addEventListener: (ev: string, fn: (e: any) => void) => {
      const list = docListeners.get(ev) ?? [];
      list.push(fn);
      docListeners.set(ev, list);
    },
    createElement: (tag: string) => fakeElement(tag),
  };
  const windowObject: any = {
    location: { origin: 'http://localhost:58630', pathname: '/sessions/pi_p1', search: '', hash: '#token=t1' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    history: { pushState() {}, replaceState() {} },
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: documentObject,
    location: windowObject.location,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    URL,
    Request,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (input: unknown, init?: any) => {
      if (init?.method === 'POST') {
        posted.push({ url: String((input as any)?.url ?? input), body: String(init?.body ?? '') });
      }
      return new Response('{}');
    },
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'boot.js' });

  windowObject.__multiAgent.setProvider('pi');

  // 1. Enter keydown bypasses client hijack and posts /plan
  let prevented = false;
  let stopped = false;
  for (const fn of docListeners.get('keydown') ?? []) {
    fn({
      key: 'Enter',
      target: editor,
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
    });
  }
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(editor.textContent, '');
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.url, /\/api\/v1\/sessions\/pi_p1\/prompts\?provider=pi$/);
  assert.deepEqual(JSON.parse(posted[0]!.body), { content: [{ type: 'text', text: '/plan' }] });

  // 2. Send button click also bypasses client hijack when editor has /plan
  editor.textContent = '/plan';
  let clickPrevented = false;
  for (const fn of docListeners.get('click') ?? []) {
    fn({
      target: sendBtn,
      preventDefault: () => { clickPrevented = true; },
      stopImmediatePropagation: () => {},
    });
  }
  assert.equal(clickPrevented, true);
  assert.equal(posted.length, 2);
});


