(function () {
  'use strict';

  var PROVIDERS = ['kimi', 'claude', 'codex', 'grok'];
  var LABELS = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex', grok: 'Grok' };
  var STORAGE_KEY = 'multi-agent-gateway.provider.v1';
  var EXPLICIT_KEY = 'multi-agent-gateway.explicitProvider.v1';
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
    if (id.indexOf('grok_') === 0) return 'grok';
    return 'kimi';
  }

  // 首页默认 kimi,不读 localStorage(否则上次的 codex 会藏掉 Swarm)。
  // 本 tab 里点过选择器则写 sessionStorage,刷新后仍跟这次选择,避免 0.39
  // 找不到 facade 整页 reload 时被打回 kimi。
  var runtimeProvider = null;

  function explicitProvider() {
    try {
      var value = sessionStorage.getItem(EXPLICIT_KEY);
      return isProvider(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function selectedProvider() {
    var fromPath = providerFromPath(window.location.pathname);
    if (fromPath) return fromPath;
    return runtimeProvider || explicitProvider() || 'kimi';
  }

  function setProvider(provider) {
    if (!isProvider(provider)) return;
    runtimeProvider = provider;
    try {
      localStorage.setItem(STORAGE_KEY, provider);
    } catch (_) {
      /* localStorage may be unavailable in hardened browsers. */
    }
    try {
      sessionStorage.setItem(EXPLICIT_KEY, provider);
    } catch (_) {
      /* sessionStorage may be unavailable. */
    }
    syncUi();
  }

  function needsProvider(pathname) {
    // /api/v1/auth 永不带 provider:登录是 Kimi 的全局状态,切 Agent 只切
    // 会话/模型/命令来源,不切登录体系(否则 Claude/Codex 会被误显示成未登录)。
    if (pathname === '/api/v1/models' || pathname === '/api/v1/workspaces' || pathname === '/api/v1/config' || pathname === '/api/v1/commands' || pathname === '/api/v1/meta') return true;
    if (pathname === '/api/v1/sessions' || pathname === '/api/v2/sessions' || pathname === '/api/v2/sessions:archive' || pathname === '/api/v2/sessions:restore' || pathname === '/api/v1/files' || pathname === '/api/v1/fs:home' || pathname === '/api/v1/fs:browse' || pathname === '/api/v1/workspace/fs:search' || /^\/api\/v1\/files\//.test(pathname)) return true;
    // 0.39 新增的 /v1/remote/devices、/capabilities、/plugins 是 Kimi 全局能力,不跟 Agent 走。
    // /workspace/fs:suggest 与 /fs:content 仍不打标:网关没有对应本地实现,打上 provider 会 404。
    // /providers 和 /catalog/providers 是 Kimi 的供应商目录(设置页),不跟 Agent 切换走。
    if (/^\/api\/v1\/workspaces\/[^/]+$/.test(pathname)) return true;
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
          var stale = document.querySelector && document.querySelector('.multi-agent-provider-wrap');
          if (stale) stale.remove();
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
    var saved = modelMemory()[provider];
    if (saved && ids.indexOf(saved) !== -1) {
      if (current !== saved) {
        try { facade.setModel(saved); } catch (error) {
          if (window.console && console.warn) console.warn('[multi-agent] setModel failed', error);
        }
      }
      return;
    }
    if (current && ids.indexOf(current) !== -1) return;
    var pick = ids[0];
    try {
      facade.setModel(pick);
    } catch (error) {
      if (window.console && console.warn) console.warn('[multi-agent] setModel failed', error);
    }
  }

  function copyScopeAttributes(source, target) {
    if (!source || !source.attributes) return;
    for (var i = 0; i < source.attributes.length; i += 1) {
      var attr = source.attributes[i];
      if (attr.name.indexOf('data-v-') === 0) target.setAttribute(attr.name, '');
    }
  }

  function dispatchPopstate() {
    try {
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (_) {
      try { window.dispatchEvent(new Event('popstate')); } catch (_) {}
    }
  }

  // 0.38 把客户端暴露成 provide(Symbol(KimiWebClientFacade))。
  // 0.39 不再 provide 这个 symbol,改成根组件 setup 返回值(setupState.load)。
  function looksLikeFacade(obj) {
    return !!(obj && typeof obj === 'object' && typeof obj.load === 'function');
  }

  function facadeFromProvides(provides) {
    if (!provides || typeof Object.getOwnPropertySymbols !== 'function') return null;
    var symbols = Object.getOwnPropertySymbols(provides);
    for (var i = 0; i < symbols.length; i += 1) {
      if (String(symbols[i]).indexOf('KimiWebClientFacade') === -1) continue;
      var facade = provides[symbols[i]];
      if (facade && typeof facade === 'object') return facade;
    }
    return null;
  }

  function facadeFromInstance(inst, depth) {
    if (!inst || depth > 8) return null;
    var buckets = [inst.setupState, inst.exposed, inst.ctx, inst.proxy];
    for (var i = 0; i < buckets.length; i += 1) {
      if (looksLikeFacade(buckets[i])) return buckets[i];
    }
    var fromProvide = facadeFromProvides(inst.provides);
    if (fromProvide) return fromProvide;
    var sub = inst.subTree;
    if (sub && sub.component) {
      var nested = facadeFromInstance(sub.component, depth + 1);
      if (nested) return nested;
    }
    var kids = sub && sub.children;
    if (Array.isArray(kids)) {
      for (var k = 0; k < kids.length; k += 1) {
        var child = kids[k] && kids[k].component;
        var hit = facadeFromInstance(child, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function findFacade() {
    var root = document.querySelector('#app');
    var app = root && root.__vue_app__;
    var fromLegacy = facadeFromProvides(app && app._context && app._context.provides);
    if (fromLegacy) return fromLegacy;
    return facadeFromInstance(app && app._instance, 0);
  }

  // 慢 provider(codex 全量扫描实测 ~4s)的响应若在下次切换后才返回,
  // 会把列表覆盖回旧 provider;刷新串行排队,保证最后选中的 provider 最后落盘。
  var refreshChain = Promise.resolve();
  var pendingProviderRefresh = false;

  function refreshProviderData() {
    var facade = findFacade();
    if (!facade || typeof facade.load !== 'function') {
      // 0.39 不再 provide KimiWebClientFacade。整页 reload 会丢掉 runtimeProvider,
      // 首页又强制 kimi,表现为点 Claude/Codex/Grok 立刻跳回 Kimi。
      // fetch 已经带上新 provider;Vue 根实例出来后再 load。
      pendingProviderRefresh = true;
      return;
    }
    pendingProviderRefresh = false;
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
    if (!isProvider(provider) || provider === selectedProvider()) return;
    var facadeBefore = findFacade();
    if (facadeBefore) rememberModel(selectedProvider(), unwrapRef(facadeBefore.defaultModel));
    var onSessionPage = /^\/sessions\//.test(window.location.pathname);
    setProvider(provider);
    // 不整页 reload:在会话页先软导航回主页(官方路由监听 popstate),
    // 再让官方 facade 按新 provider 重取工作区/会话/模型。
    if (onSessionPage) {
      window.history.pushState(null, '', '/');
      dispatchPopstate();
    }
    refreshProviderData();
  }

  function updateSegIndicator(seg) {
    if (!seg || !seg.querySelector) return;
    var indicator = seg.querySelector('.ui-seg__indicator');
    var on = seg.querySelector('.ui-seg__item.is-on');
    if (!indicator || !on) return;
    indicator.style.width = on.offsetWidth + 'px';
    indicator.style.height = on.offsetHeight + 'px';
    indicator.style.transform = 'translate(' + on.offsetLeft + 'px, ' + on.offsetTop + 'px)';
    indicator.classList.add('is-ready');
  }

  function buildSeg(wrap) {
    var seg = document.createElement('div');
    seg.className = 'ui-seg ui-seg--sm multi-agent-provider-seg status-seg';
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Agent');

    var indicator = document.createElement('span');
    indicator.className = 'ui-seg__indicator';
    indicator.setAttribute('aria-hidden', 'true');
    seg.appendChild(indicator);

    PROVIDERS.forEach(function (provider) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'ui-seg__item multi-agent-provider-item';
      item.setAttribute('role', 'tab');
      item.setAttribute('data-provider', provider);
      item.setAttribute('aria-selected', String(provider === selectedProvider()));
      if (provider === selectedProvider()) item.classList.add('is-on');

      var label = document.createElement('span');
      label.className = 'ui-seg__label';
      label.textContent = LABELS[provider];
      item.appendChild(label);

      item.addEventListener('click', function (event) {
        event.stopPropagation();
        switchProvider(provider);
      });
      seg.appendChild(item);
    });

    wrap.appendChild(seg);
    // 等布局完成后再量 indicator,避免首帧宽度为 0。
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { updateSegIndicator(seg); });
    } else {
      setTimeout(function () { updateSegIndicator(seg); }, 0);
    }
    return seg;
  }

  // 桌面:挂在侧边栏 .side-footer(账号行)正上方,视觉对齐官方 status-seg。
  // 移动端 0.39 不再渲染 Sidebar,改挂在会话 sheet 的 .view-tabs(flat / 按工作区)正上方。
  // .user-menu-login 在 0.39 是传送到 body 的菜单项,不是挂载点。
  function findMountAnchor() {
    if (!document.querySelector) return null;
    var desktop = document.querySelector('.side-footer, .user-menu-trigger');
    if (desktop && desktop.parentElement) return desktop;
    var mobileTabs = document.querySelector('.view-tabs');
    if (mobileTabs && mobileTabs.parentElement) return mobileTabs;
    return null;
  }

  function installSelector() {
    if (!document.querySelector) return;
    var existing = document.querySelector('.multi-agent-provider-wrap');
    var anchor = findMountAnchor();
    if (!anchor || !anchor.parentElement) {
      // 账号区/移动 sheet 未挂载(加载中/被官方重渲染拆掉):选择器一并移除,不留孤儿。
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      // provider 列表变化时重建分段项(meta 探测后可能变短)。
      var seg = existing.querySelector('.multi-agent-provider-seg');
      if (seg) {
        var buttons = seg.querySelectorAll('.multi-agent-provider-item');
        var same = buttons.length === PROVIDERS.length;
        if (same) {
          for (var i = 0; i < buttons.length; i += 1) {
            if (buttons[i].getAttribute('data-provider') !== PROVIDERS[i]) { same = false; break; }
          }
        }
        if (!same) {
          existing.remove();
        } else {
          return;
        }
      } else {
        existing.remove();
      }
    }

    var wrap = document.createElement('div');
    wrap.className = 'multi-agent-provider-wrap';
    copyScopeAttributes(anchor, wrap);
    buildSeg(wrap);
    anchor.parentElement.insertBefore(wrap, anchor);
  }

  function gateModes() {
    if (!document.querySelectorAll) return;
    var provider = selectedProvider();
    document.querySelectorAll('.am-row').forEach(function (row) {
      var id = row.getAttribute ? String(row.getAttribute('data-mode-id') || '') : '';
      if (!id && row.querySelector) {
        var labelNode = row.querySelector('[data-icon], .am-row-name, .mode-row-name, .am-name');
        var raw = labelNode ? String(labelNode.getAttribute && labelNode.getAttribute('name') || labelNode.textContent || '').trim().toLowerCase() : '';
        if (!raw) raw = String(row.textContent || '').trim().toLowerCase();
        if (raw.indexOf('swarm') !== -1) id = 'swarm';
        else if (raw.indexOf('goal') !== -1 || raw.indexOf('目标') !== -1) id = 'goal';
        else if (raw.indexOf('plan') !== -1 || raw.indexOf('计划') !== -1) id = 'plan';
        else if (raw.indexOf('file') !== -1 || raw.indexOf('附件') !== -1) id = 'files';
        if (id && row.setAttribute) row.setAttribute('data-mode-id', id);
      }
      var isSwarm = id === 'swarm' || id.indexOf('swarm') !== -1;
      var isGoal = id === 'goal' || id.indexOf('goal') !== -1 || id.indexOf('目标') !== -1;
      var hide = (provider === 'claude' || provider === 'grok') ? isSwarm || isGoal : provider === 'codex' ? isSwarm : false;
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
  }

  // 官方 0.39 SlashMenu 仍内置 /swarm /goal /btw,也可能列出 /compact /undo。移动端走 .slash-menu.is-sheet。
  // Kimi 全部保留。Claude compact 是真 /compact prompt,但无 rewind,藏 /undo。
  // Grok compact/undo/fork 由 adapter 执行,只藏 /swarm /goal /btw。
  // Codex compact/undo/goal 由网关执行,藏 /swarm /btw。
  function blockedSlashNames(provider) {
    if (provider === 'grok') return ['/swarm', '/goal', '/btw'];
    if (provider === 'claude') return ['/swarm', '/goal', '/btw', '/undo'];
    if (provider === 'codex') return ['/swarm', '/btw'];
    return [];
  }

  function gateSlashMenu() {
    if (!document.querySelectorAll) return;
    var blocked = blockedSlashNames(selectedProvider());
    document.querySelectorAll('.slash-menu .slash-name').forEach(function (nameEl) {
      var label = String(nameEl.textContent || '').trim().split(/\s+/)[0].toLowerCase();
      var hide = blocked.indexOf(label) !== -1;
      var row = nameEl.parentElement;
      if (!row || !row.style) return;
      if (hide) {
        row.hidden = true;
        row.style.display = 'none';
        if (row.setAttribute) row.setAttribute('data-multi-agent-slash-hidden', '');
      } else if (row.hasAttribute && row.hasAttribute('data-multi-agent-slash-hidden')) {
        row.hidden = false;
        row.style.display = '';
        if (row.removeAttribute) row.removeAttribute('data-multi-agent-slash-hidden');
      }
    });
  }

  function syncUi() {
    if (!document.querySelector) return;
    installSelector();
    var seg = document.querySelector('.multi-agent-provider-seg');
    if (seg) {
      var current = selectedProvider();
      Array.from(seg.querySelectorAll('.multi-agent-provider-item')).forEach(function (item) {
        var provider = item.getAttribute('data-provider');
        var active = provider === current;
        item.classList.toggle('is-on', active);
        item.setAttribute('aria-selected', String(active));
      });
      updateSegIndicator(seg);
    }
    gateModes();
    gateSlashMenu();
    if (pendingProviderRefresh) refreshProviderData();
  }

  function onRouteChange() {
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
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncUi, { once: true });
  }
  var syncTimer = null;
  var uiMutationSelector = '.side-footer, .user-menu-trigger, .view-tabs, .multi-agent-provider-wrap, .multi-agent-provider-seg, .am-row, .slash-menu, .slash-name, .wizard';
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
