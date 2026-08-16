(function () {
  'use strict';

  var PROVIDERS = ['kimi', 'claude', 'codex'];
  var LABELS = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex' };
  var STORAGE_KEY = 'multi-agent-gateway.provider.v1';
  var originalFetch = window.fetch || fetch;
  var OriginalWebSocket = window.WebSocket;
  var providerSockets = new Set();

  function isProvider(value) {
    return PROVIDERS.indexOf(value) !== -1;
  }

  function storedProvider() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return isProvider(value) ? value : 'kimi';
    } catch (_) {
      return 'kimi';
    }
  }

  function providerFromPath(pathname) {
    var match = /^\/sessions\/([^/]+)/.exec(pathname || '');
    if (!match) return null;
    var id;
    try {
      id = decodeURIComponent(match[1]);
    } catch (_) {
      id = match[1];
    }
    if (id.indexOf('codex_') === 0) return 'codex';
    if (id.indexOf('claude_') === 0) return 'claude';
    return 'kimi';
  }

  function selectedProvider() {
    return providerFromPath(window.location.pathname) || storedProvider();
  }

  function setProvider(provider) {
    if (!isProvider(provider)) return;
    try {
      localStorage.setItem(STORAGE_KEY, provider);
    } catch (_) {
      /* localStorage may be unavailable in hardened browsers. */
    }
    syncUi();
  }

  function needsProvider(pathname) {
    // /api/v1/auth 永不带 provider:登录是 Kimi 的全局状态,切 Agent 只切
    // 会话/模型/命令来源,不切登录体系(否则 Claude/Codex 会被误显示成未登录)。
    if (pathname === '/api/v1/models' || pathname === '/api/v1/workspaces' || pathname === '/api/v1/config' || pathname === '/api/v1/commands' || pathname === '/api/v1/meta') return true;
    if (pathname === '/api/v1/sessions' || pathname === '/api/v2/sessions' || pathname === '/api/v1/files' || pathname === '/api/v1/fs:home' || pathname === '/api/v1/fs:browse' || /^\/api\/v1\/files\//.test(pathname)) return true;
    // /providers 和 /catalog/providers 是 Kimi 的供应商目录(设置页),不跟 Agent 切换走。
    return /^\/api\/v1\/workspaces\/[^/]+\/skills$/.test(pathname);
  }

  function rewriteApiUrl(input) {
    var raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    var url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return url;
    if (url.pathname !== '/api/v1' && url.pathname.indexOf('/api/v1/') !== 0 && url.pathname.indexOf('/api/v2/') !== 0) return url;
    if (needsProvider(url.pathname) && !url.searchParams.has('provider')) {
      url.searchParams.set('provider', selectedProvider());
    }
    return url;
  }

  window.fetch = function (input, init) {
    var url = rewriteApiUrl(input);
    if (input instanceof Request) {
      return originalFetch.call(window, new Request(url.href, input), init);
    }
    return originalFetch.call(window, url.href, init);
  };

  if (typeof OriginalWebSocket === 'function') {
    function ProviderWebSocket(url, protocols) {
      var target = new URL(url instanceof URL ? url.href : String(url), window.location.origin);
      var page = new URL(window.location.origin);
      var gatewaySocket = target.host === page.host && target.pathname === '/api/v1/ws';
      if (gatewaySocket && !target.searchParams.has('provider')) {
        target.searchParams.set('provider', selectedProvider());
      }
      var ws = protocols === undefined
        ? new OriginalWebSocket(target.href)
        : new OriginalWebSocket(target.href, protocols);
      // 跟踪网关事件 WS:切换 Agent 时关掉它们,官方前端会自动重连,
      // 重连走新 provider 并触发它自己的全量重新同步——不需要整页 reload。
      if (gatewaySocket) {
        providerSockets.add(ws);
        if (ws && typeof ws.addEventListener === 'function') {
          ws.addEventListener('close', function () { providerSockets.delete(ws); });
        }
      }
      return ws;
    }
    ProviderWebSocket.prototype = OriginalWebSocket.prototype;
    if (Object.setPrototypeOf) Object.setPrototypeOf(ProviderWebSocket, OriginalWebSocket);
    window.WebSocket = ProviderWebSocket;
  }

  function closeProviderSockets() {
    providerSockets.forEach(function (ws) {
      try { ws.close(1000, 'provider-switch'); } catch (_) {}
    });
    providerSockets.clear();
  }

  // -- 可用 provider(按网关 /meta 实际安装情况过滤) ---------------------------

  function tokenFromHash() {
    var match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash || '');
    if (match) {
      try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
    }
    // hash 没带 token 时回退官方前端存的服务凭证(登录后写入;JSON 或裸串)。
    try {
      var stored = localStorage.getItem('kimi-web.server-credential');
      if (!stored) return null;
      try {
        var parsed = JSON.parse(stored);
        return parsed && typeof parsed.token === 'string' ? parsed.token : null;
      } catch (_) {
        return stored;
      }
    } catch (_) {
      return null;
    }
  }

  // 没装 codex/claude 的机器不该在选择器里看到它们。网关 /meta 的 providers
  // 是启动时的本机探测结果;meta 请求失败则保持全量(网络抖动不误隐藏)。
  function loadAvailableProviders() {
    var token = tokenFromHash();
    originalFetch
      .call(window, '/api/v1/meta', token ? { headers: { authorization: 'Bearer ' + token } } : undefined)
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (body) {
        var list = body && body.data && body.data.providers;
        if (!Array.isArray(list)) return;
        var filtered = list.filter(isProvider);
        if (filtered.length === 0 || filtered.indexOf('kimi') === -1) return;
        var changed = filtered.length !== PROVIDERS.length;
        PROVIDERS.length = 0;
        Array.prototype.push.apply(PROVIDERS, filtered);
        if (window.__multiAgent) window.__multiAgent.providers = PROVIDERS;
        if (PROVIDERS.indexOf(selectedProvider()) === -1) setProvider('kimi');
        if (changed) {
          if (providerMenu && providerMenu.isConnected) { providerMenu.remove(); providerMenu = null; }
          syncUi();
        }
      })
      .catch(function () {});
  }

  // -- 每个 provider 记住自己的模型选择 ----------------------------------------

  var MODEL_MEMORY_KEY = 'multi-agent-gateway.modelByProvider.v1';

  function modelMemory() {
    try {
      var value = JSON.parse(localStorage.getItem(MODEL_MEMORY_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function rememberModel(provider, model) {
    if (!isProvider(provider) || typeof model !== 'string' || !model) return;
    var memory = modelMemory();
    memory[provider] = model;
    try { localStorage.setItem(MODEL_MEMORY_KEY, JSON.stringify(memory)); } catch (_) {}
  }

  function unwrapRef(value) {
    return value && typeof value === 'object' && 'value' in value ? value.value : value;
  }

  // 官方应用把上一次选择原样带到新 provider(实测 Claude 页显示 Kimi 的 k3)。
  // 目录里没有当前选择时:优先回本 provider 上次记住的选择,否则用目录第一项。
  function reconcileModel(facade, provider) {
    if (!facade || typeof facade.setModel !== 'function') return;
    var catalog = unwrapRef(facade.models);
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    var ids = catalog
      .map(function (entry) { return entry && entry.model; })
      .filter(function (id) { return typeof id === 'string' && id; });
    if (ids.length === 0) return;
    var current = unwrapRef(facade.defaultModel);
    if (current && ids.indexOf(current) !== -1) return;
    var saved = modelMemory()[provider];
    var pick = saved && ids.indexOf(saved) !== -1 ? saved : ids[0];
    try {
      facade.setModel(pick);
    } catch (error) {
      if (window.console && console.warn) console.warn('[multi-agent] setModel failed', error);
    }
  }

  var providerMenu = null;

  function copyScopeAttributes(source, target) {
    if (!source || !source.attributes) return;
    for (var i = 0; i < source.attributes.length; i += 1) {
      var attr = source.attributes[i];
      if (attr.name.indexOf('data-v-') === 0) target.setAttribute(attr.name, '');
    }
  }

  function closeMenu() {
    if (providerMenu && providerMenu.isConnected) providerMenu.hidden = true;
    else providerMenu = null;
    var pill = document.querySelector('.multi-agent-provider-pill');
    if (pill) {
      pill.classList.remove('open');
      pill.setAttribute('aria-expanded', 'false');
    }
  }

  function dispatchPopstate() {
    try {
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (_) {
      try { window.dispatchEvent(new Event('popstate')); } catch (_) {}
    }
  }

  // 官方应用把自己暴露成 KimiWebClientFacade(Vue provide),列表数据只在
  // bootstrap 时取一次——切换 provider 后要让它用自己的加载器重取,
  // 这些加载器走我们 patch 过的 fetch,自动带上新 provider。
  function findFacade() {
    var root = document.querySelector('#app');
    var app = root && root.__vue_app__;
    var provides = app && app._context && app._context.provides;
    if (!provides || typeof Object.getOwnPropertySymbols !== 'function') return null;
    var symbols = Object.getOwnPropertySymbols(provides);
    for (var i = 0; i < symbols.length; i += 1) {
      if (String(symbols[i]).indexOf('KimiWebClientFacade') === -1) continue;
      var facade = provides[symbols[i]];
      if (facade && typeof facade === 'object') return facade;
    }
    return null;
  }

  // 慢 provider(codex 全量扫描实测 ~4s)的响应若在下次切换后才返回,
  // 会把列表覆盖回旧 provider;刷新串行排队,保证最后选中的 provider 最后落盘。
  var refreshChain = Promise.resolve();

  function refreshProviderData() {
    var facade = findFacade();
    if (!facade || typeof facade.load !== 'function') {
      // facade 不存在说明官方前端结构变了(注入本应按哈希失配关闭);
      // 兜底整页刷新,保证列表内容一定正确。
      window.location.reload();
      return;
    }
    closeProviderSockets();
    // 入队时捕获 provider:慢 provider 的 load 落地时选择可能已变,旧 provider
    // 的目录不能用新 provider 的记忆/默认值去校正。
    var provider = selectedProvider();
    // facade.load() 是官方应用自己的完整引导(工作区+会话+模型,实测不弹
    // 全屏 splash);loadAllSessions 只服务搜索且有 sessionsFullyLoaded 早退,
    // 不能用它刷新侧边栏。引导完成后把模型选择校正到当前 provider 的目录。
    refreshChain = refreshChain.then(function () {
      return Promise.resolve(facade.load()).catch(function () {});
    }).then(function () {
      if (provider !== selectedProvider()) return;
      reconcileModel(facade, provider);
    }).then(undefined, function () {
      // 自愈:facade.load 同步抛错曾让链永久 rejected,后续刷新全部静默失效。
    });
  }

  function switchProvider(provider) {
    if (!isProvider(provider) || provider === selectedProvider()) {
      closeMenu();
      return;
    }
    var facadeBefore = findFacade();
    if (facadeBefore) rememberModel(selectedProvider(), unwrapRef(facadeBefore.defaultModel));
    var onSessionPage = /^\/sessions\//.test(window.location.pathname);
    setProvider(provider);
    closeMenu();
    // 不整页 reload:在会话页先软导航回主页(官方路由监听 popstate),
    // 再让官方 facade 按新 provider 重取工作区/会话/模型。
    if (onSessionPage) {
      window.history.pushState(null, '', '/');
      dispatchPopstate();
    }
    refreshProviderData();
  }

  function buildMenu(wrap) {
    var menu = document.createElement('div');
    menu.className = 'multi-agent-provider-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    PROVIDERS.forEach(function (provider) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'multi-agent-provider-row';
      row.setAttribute('role', 'menuitemradio');

      var check = document.createElement('span');
      check.className = 'multi-agent-provider-check';
      check.textContent = provider === selectedProvider() ? '✓' : '';

      var name = document.createElement('span');
      name.className = 'multi-agent-provider-label';
      name.textContent = LABELS[provider];

      row.appendChild(check);
      row.appendChild(name);
      row.addEventListener('click', function (event) {
        event.stopPropagation();
        switchProvider(provider);
      });
      menu.appendChild(row);
    });

    wrap.appendChild(menu);
    providerMenu = menu;
    return menu;
  }

  // 选择器挂在侧边栏底部、官方账号行正上方(用户指定位置):克隆账号行的
  // 官方类名与 scoped-style 属性,视觉与原版侧边栏项一致;账号行本身不改。
  function installSelector() {
    if (!document.querySelector) return;
    var existing = document.querySelector('.multi-agent-provider-wrap');
    var anchor = document.querySelector('.user-menu-trigger, .user-menu-login');
    if (!anchor || !anchor.parentElement) {
      // 账号区未挂载(加载中/被官方重渲染拆掉):选择器一并移除,不留孤儿。
      if (existing) existing.remove();
      if (providerMenu && providerMenu.isConnected) providerMenu.remove();
      providerMenu = null;
      return;
    }
    if (existing) return;

    var wrap = document.createElement('div');
    wrap.className = 'multi-agent-provider-wrap';

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-menu-trigger multi-agent-provider-pill';
    row.setAttribute('aria-label', 'Agent');
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-expanded', 'false');
    copyScopeAttributes(anchor, row);

    var avatar = document.createElement('span');
    avatar.className = 'user-menu-avatar multi-agent-provider-avatar';
    avatar.textContent = LABELS[selectedProvider()].slice(0, 1);
    copyScopeAttributes(anchor, avatar);
    var name = document.createElement('span');
    name.className = 'user-menu-name multi-agent-provider-name';
    name.textContent = LABELS[selectedProvider()];
    copyScopeAttributes(anchor, name);
    row.appendChild(avatar);
    row.appendChild(name);

    row.addEventListener('click', function (event) {
      event.stopPropagation();
      if (providerMenu && !providerMenu.isConnected) providerMenu = null;
      var menu = providerMenu || buildMenu(wrap);
      menu.hidden = !menu.hidden;
      row.classList.toggle('open', !menu.hidden);
      row.setAttribute('aria-expanded', String(!menu.hidden));
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      }
    });

    wrap.appendChild(row);
    anchor.parentElement.insertBefore(wrap, anchor);
  }

  function gateModes() {
    if (!document.querySelectorAll) return;
    var provider = selectedProvider();
    document.querySelectorAll('.modes-menu').forEach(function (menu) {
      var rows = Array.from(menu.children).filter(function (node) {
        return node.classList && node.classList.contains('mode-row');
      });
      rows.forEach(function (row) {
        var labelNode = row.querySelector('.mode-row-name');
        var label = labelNode ? String(labelNode.textContent || '').trim().toLowerCase() : '';
        var isSwarm = label === 'swarm';
        var isGoal = label === 'goal' || label === '目标';
        var hide = provider === 'claude' ? isSwarm || isGoal : provider === 'codex' ? isSwarm : false;
        if (hide) {
          row.hidden = true;
          row.style.display = 'none';
          row.setAttribute('data-multi-agent-hidden', '');
        } else if (row.hasAttribute('data-multi-agent-hidden')) {
          row.hidden = false;
          row.style.display = '';
          row.removeAttribute('data-multi-agent-hidden');
        }
      });
    });
  }

  function syncUi() {
    if (!document.querySelector) return;
    installSelector();
    var name = document.querySelector('.multi-agent-provider-name');
    if (name && name.textContent !== LABELS[selectedProvider()]) name.textContent = LABELS[selectedProvider()];
    var avatar = document.querySelector('.multi-agent-provider-avatar');
    var letter = LABELS[selectedProvider()].slice(0, 1);
    if (avatar && avatar.textContent !== letter) avatar.textContent = letter;
    if (providerMenu && providerMenu.isConnected) {
      Array.from(providerMenu.querySelectorAll('.multi-agent-provider-row')).forEach(function (row, index) {
        var active = PROVIDERS[index] === selectedProvider();
        row.classList.toggle('is-current', active);
        row.setAttribute('aria-checked', String(active));
        var check = row.querySelector('.multi-agent-provider-check');
        var mark = active ? '✓' : '';
        if (check && check.textContent !== mark) check.textContent = mark;
      });
    } else {
      providerMenu = null;
    }
    gateModes();
  }

  function onRouteChange() {
    closeMenu();
    providerMenu = null;
    syncUi();
  }

  ['pushState', 'replaceState'].forEach(function (method) {
    var original = window.history && window.history[method];
    if (typeof original !== 'function') return;
    window.history[method] = function () {
      var result = original.apply(this, arguments);
      onRouteChange();
      return result;
    };
  });
  window.addEventListener('popstate', onRouteChange);
  if (document.addEventListener) {
    // 官方菜单(账号/模型)的触发按钮 stopPropagation,冒泡监听收不到 →
    // 用捕获阶段关我们的菜单;点在自己 wrap(pill/菜单)内的交给行/toggle。
    document.addEventListener('click', function (event) {
      var target = event && event.target;
      if (target && typeof target.closest === 'function' && target.closest('.multi-agent-provider-wrap')) return;
      closeMenu();
    }, true);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncUi, { once: true });
  }
  var syncTimer = null;
  var uiMutationSelector = '.user-menu-trigger, .user-menu-login, .multi-agent-provider-wrap, .multi-agent-provider-menu, .modes-menu';
  function scheduleSyncUi() {
    if (syncTimer !== null) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      syncUi();
    }, 0);
  }
  function nodeAffectsUi(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.matches === 'function' && node.matches(uiMutationSelector)) return true;
    return typeof node.querySelector === 'function' && Boolean(node.querySelector(uiMutationSelector));
  }
  function mutationAffectsUi(record) {
    var added = record.addedNodes || [];
    for (var i = 0; i < added.length; i += 1) {
      if (nodeAffectsUi(added[i])) return true;
    }
    var removed = record.removedNodes || [];
    for (var j = 0; j < removed.length; j += 1) {
      if (nodeAffectsUi(removed[j])) return true;
    }
    return false;
  }
  var observer = new MutationObserver(function (records) {
    if (records.some(mutationAffectsUi)) scheduleSyncUi();
  });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') syncUi();
  loadAvailableProviders();

  window.__multiAgent = {
    version: 1,
    providers: PROVIDERS,
    selectedProvider: selectedProvider,
    setProvider: setProvider,
    switchProvider: switchProvider,
    rewriteApiUrl: rewriteApiUrl,
  };
})();
