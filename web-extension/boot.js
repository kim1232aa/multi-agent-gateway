(function () {
  'use strict';

  var PROVIDERS = ['kimi', 'claude', 'codex', 'grok', 'pi'];
  var LABELS = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex', grok: 'Grok', pi: 'Pi' };
  var STORAGE_KEY = 'multi-agent-gateway.provider.v1';
  var EXPLICIT_KEY = 'multi-agent-gateway.explicitProvider.v1';
  var WS_STALE_WAKE_MS = 45000;
  var WS_WAKE_PROBE_AFTER_MS = 10000;
  var WS_WAKE_PONG_TIMEOUT_MS = 3000;
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

  function providerFromSessionId(id) {
    if (typeof id !== 'string' || !id) return 'kimi';
    if (id.indexOf('codex_') === 0) return 'codex';
    if (id.indexOf('claude_') === 0) return 'claude';
    if (id.indexOf('grok_') === 0) return 'grok';
    if (id.indexOf('pi_') === 0) return 'pi';
    return 'kimi';
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
    return providerFromSessionId(id);
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
    // /api/v1/auth 与 /api/v2/mcp/* 永不带 provider:登录和官方 MCP 认证是 Kimi 全局状态。
    if (pathname === '/api/v1/models' || pathname === '/api/v1/workspaces' || pathname === '/api/v1/config' || pathname === '/api/v1/commands' || pathname === '/api/v1/meta' || pathname === '/api/v1/providers') return true;
    if (pathname === '/api/v1/sessions' || pathname === '/api/v2/sessions' || pathname === '/api/v2/sessions:archive' || pathname === '/api/v2/sessions:restore' || pathname === '/api/v1/files' || pathname === '/api/v1/fs:home' || pathname === '/api/v1/fs:browse' || pathname === '/api/v1/fs:suggest' || pathname === '/api/v1/workspace/fs:list' || pathname === '/api/v1/workspace/fs:search' || pathname === '/api/v1/workspace/fs:suggest' || /^\/api\/v1\/files\//.test(pathname)) return true;
    // 2.6.2 / 0.39 全局能力不跟 Agent 切换走:
    // /v1/remote*、/capabilities、/plugins、/remote-control*、/api/v2/mcp/*、/providers、/catalog/providers、/fs:content。
    // /workspaces/* (project-config-dirs、/:id、/:id/trust、/:id/primary、/:id/skills) 必须带 provider,
    // 否则本地 Agent 的 wd_ 工作区 id 会被透传给 Kimi 上游而报 "workspace does not exist / 无法确认项目信任状态"。
    return /^\/api\/v1\/workspaces\/.+/.test(pathname);
  }

  var SKILL_CHIP_RE = /\[([^\]]+)\]\((?:kimi-code:\/\/skill\/|kimi-code-composer:\/\/skills\/)([^)\s?]+)(?:[?#][^)]*)?\)/g;

  function stripSkillChips(text) {
    if (typeof text !== 'string' || !text) return text;
    if (text.indexOf('kimi-code://skill/') === -1 && text.indexOf('kimi-code-composer://skills/') === -1) return text;
    var out = text.replace(
      /^(\s*\/([^\s]+))(?:\s+\[([^\]]+)\]\((?:kimi-code:\/\/skill\/|kimi-code-composer:\/\/skills\/)([^)\s?]+)(?:[?#][^)]*)?\))+/,
      function (full, cmdPart, cmdName, label, encodedSlug) {
        var slug = encodedSlug;
        try { slug = decodeURIComponent(encodedSlug); } catch (_) {}
        if (String(slug).toLowerCase() === String(cmdName).toLowerCase() || String(label).trim().toLowerCase() === String(cmdName).toLowerCase()) {
          return cmdPart;
        }
        return full;
      },
    );
    out = out.replace(SKILL_CHIP_RE, function (_full, label, encodedSlug) {
      var slug = encodedSlug;
      try { slug = decodeURIComponent(encodedSlug); } catch (_) {}
      return slug ? '/' + slug : label;
    });
    return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  function sanitizePromptBody(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText) return bodyText;
    if (bodyText.indexOf('kimi-code://skill/') === -1 && bodyText.indexOf('kimi-code-composer://skills/') === -1) return bodyText;
    try {
      var body = JSON.parse(bodyText);
      var changed = false;
      if (body && typeof body.args === 'string') {
        var nextArgs = stripSkillChips(body.args);
        if (/^\/[^\s]+$/.test(nextArgs)) nextArgs = '';
        if (nextArgs !== body.args) {
          body.args = nextArgs;
          changed = true;
        }
      }
      var composer = body && body.metadata && body.metadata.kimi_code_composer;
      if (composer && composer.doc && Array.isArray(composer.doc.content)) {
        for (var p = 0; p < composer.doc.content.length; p += 1) {
          var block = composer.doc.content[p];
          var pieces = block && Array.isArray(block.content) ? block.content : [];
          for (var q = 0; q < pieces.length; q += 1) {
            if (pieces[q] && typeof pieces[q].text === 'string') {
              var cleanPiece = stripSkillChips(pieces[q].text);
              if (cleanPiece !== pieces[q].text) {
                pieces[q].text = cleanPiece;
                changed = true;
              }
            }
          }
        }
      }
      if (body && body.metadata && typeof body.metadata.display_text === 'string') {
        var cleanDisplay = stripSkillChips(body.metadata.display_text);
        if (cleanDisplay !== body.metadata.display_text) {
          body.metadata.display_text = cleanDisplay;
          changed = true;
        }
      }
      var content = body && body.content;
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i += 1) {
          var part = content[i];
          if (part && part.type === 'text' && typeof part.text === 'string') {
            var nextText = stripSkillChips(part.text);
            if (nextText !== part.text) {
              part.text = nextText;
              changed = true;
            }
          }
        }
      } else if (body && typeof body.text === 'string') {
        var next = stripSkillChips(body.text);
        if (next !== body.text) {
          body.text = next;
          changed = true;
        }
      }
      return changed ? JSON.stringify(body) : bodyText;
    } catch (_) {
      return stripSkillChips(bodyText);
    }
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

  var skillHintsByProvider = Object.create(null);

  function rememberSkillHints(provider, skills) {
    if (!isProvider(provider) || !Array.isArray(skills)) return;
    var bucket = skillHintsByProvider[provider] || (skillHintsByProvider[provider] = Object.create(null));
    for (var i = 0; i < skills.length; i += 1) {
      var item = skills[i];
      if (!item || typeof item.name !== 'string' || !item.name) continue;
      var hint = typeof item.argument_hint === 'string'
        ? item.argument_hint.trim()
        : typeof item.argumentHint === 'string'
          ? item.argumentHint.trim()
          : '';
      if (hint) bucket[item.name] = hint;
      else delete bucket[item.name];
    }
  }

  function isSkillsCatalogPath(pathname) {
    return /^\/api\/v1\/(sessions|workspaces)\/[^/]+\/skills$/.test(pathname);
  }

  var capturedAuthHeader = null;

  function captureAuthHeader(input, init) {
    try {
      var auth = null;
      if (init && init.headers) {
        if (typeof Headers === 'function' && init.headers instanceof Headers) {
          auth = init.headers.get('authorization') || init.headers.get('Authorization');
        } else if (Array.isArray(init.headers)) {
          for (var i = 0; i < init.headers.length; i += 1) {
            var pair = init.headers[i];
            if (pair && String(pair[0]).toLowerCase() === 'authorization') {
              auth = pair[1];
              break;
            }
          }
        } else if (typeof init.headers === 'object') {
          auth = init.headers.authorization || init.headers.Authorization || null;
        }
      }
      if (!auth && typeof Request === 'function' && input instanceof Request && input.headers) {
        auth = input.headers.get('authorization') || input.headers.get('Authorization');
      }
      if (typeof auth === 'string' && auth.trim()) {
        capturedAuthHeader = auth.trim();
      }
    } catch (_) {}
  }

  window.fetch = function (input, init) {
    var url = rewriteApiUrl(input);
    if (url.origin === window.location.origin && (url.pathname.indexOf('/api/v1/') === 0 || url.pathname.indexOf('/api/v2/') === 0)) {
      captureAuthHeader(input, init);
    }
    var method = ((init && init.method) || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    var isPromptWrite = method !== 'GET' && method !== 'HEAD' && (
      /\/prompts$/.test(url.pathname)
      || /\/skills\/[^/]+:activate$/.test(url.pathname)
      || /\/steer$/.test(url.pathname)
    );
    if (isPromptWrite && selectedProvider() !== 'kimi') {
      var effortMatch = url.pathname.match(/\/skills\/(effort|thinking):activate$/i);
      var sessionMatch = url.pathname.match(/\/sessions\/([^/]+)\//);
      if (effortMatch && sessionMatch && init && typeof init.body === 'string') {
        try {
          var effortBody = JSON.parse(init.body);
          var effortText = [
            effortBody && effortBody.args,
            effortBody && effortBody.metadata && effortBody.metadata.display_text,
          ].filter(function (value) { return typeof value === 'string'; }).join(' ');
          var effortToken = String(effortText).toLowerCase().match(/\b(off|minimal|low|medium|high|xhigh|max|auto)\b/);
          if (effortToken) {
            var piniaForEffort = findPinia();
            var modeForEffort = getPiniaStore(piniaForEffort, 'kimi.mode');
            var sid = decodeURIComponent(sessionMatch[1]);
            if (modeForEffort) {
              modeForEffort.thinking = effortToken[1];
              modeForEffort.thinkingBySession = Object.assign({}, modeForEffort.thinkingBySession, { [sid]: effortToken[1] });
            }
          }
        } catch (_) {}
      }
    }
    if (isPromptWrite) {
      if (init && typeof init.body === 'string') {
        init = Object.assign({}, init, { body: sanitizePromptBody(init.body) });
      } else if (!init && input instanceof Request && typeof input.clone === 'function') {
        var sourceRequest = input;
        input = sourceRequest.clone();
        var rewritten = input.text().then(function (bodyText) {
          return new Request(url.href, {
            method: sourceRequest.method,
            headers: sourceRequest.headers,
            body: sanitizePromptBody(bodyText),
            credentials: sourceRequest.credentials,
            cache: sourceRequest.cache,
            redirect: sourceRequest.redirect,
            referrer: sourceRequest.referrer,
            integrity: sourceRequest.integrity,
          });
        });
        return rewritten.then(function (request) {
          return originalFetch.call(window, request);
        });
      }
    }
    var reqPromise = input instanceof Request
      ? originalFetch.call(window, new Request(url.href, input), init)
      : originalFetch.call(window, url.href, init);
    if (isSkillsCatalogPath(url.pathname) && reqPromise && typeof reqPromise.then === 'function') {
      var reqProvider = url.searchParams.get('provider') || providerFromPath(url.pathname.replace(/^\/api\/v1/, '')) || selectedProvider();
      reqPromise.then(function (res) {
        if (!res || !res.ok || typeof res.clone !== 'function') return;
        res.clone().json().then(function (body) {
          var list = body && body.data && body.data.skills;
          if (!Array.isArray(list) && body && Array.isArray(body.skills)) list = body.skills;
          if (Array.isArray(list)) {
            rememberSkillHints(reqProvider, list);
            scheduleSyncUi();
          }
        }).catch(function () {});
      }).catch(function () {});
    }
    return reqPromise;
  };

  if (typeof OriginalWebSocket === 'function') {
    function emitSyntheticWsMessage(ws, payload) {
      var raw = JSON.stringify(payload);
      setTimeout(function () {
        if (typeof MessageEvent === 'function' && typeof ws.dispatchEvent === 'function') {
          try {
            ws.dispatchEvent(new MessageEvent('message', { data: raw }));
            return;
          } catch (_) {}
        }
        if (typeof ws.onmessage === 'function') {
          ws.onmessage({ data: raw });
        }
      }, 0);
    }

    function ProviderWebSocket(url, protocols) {
      var target = new URL(url instanceof URL ? url.href : String(url), window.location.origin);
      var page = new URL(window.location.origin);
      var gatewaySocket = target.host === page.host && target.pathname === '/api/v1/ws';
      var socketProvider = target.searchParams.get('provider') || selectedProvider();
      if (gatewaySocket && !target.searchParams.has('provider')) {
        target.searchParams.set('provider', socketProvider);
      }
      var ws = protocols === undefined
        ? new OriginalWebSocket(target.href)
        : new OriginalWebSocket(target.href, protocols);
      // 跟踪网关事件 WS:切换 Agent 时关掉它们,官方前端会自动重连,
      // 重连走新 provider 并触发它自己的全量重新同步——不需要整页 reload。
      if (gatewaySocket) {
        ws._maLastActivityAt = Date.now();
        ws._maProvider = socketProvider;
        providerSockets.add(ws);
        if (typeof ws.send === 'function') {
          var rawSend = ws.send;
          ws.send = function (data) {
            if (typeof data === 'string' && data.charAt(0) === '{') {
              try {
                var frame = JSON.parse(data);
                var fType = frame && frame.type;
                var sid = (fType === 'subscribe' || fType === 'unsubscribe')
                  ? frame.session_id
                  : (fType === 'subscribe_v2' || fType === 'unsubscribe_v2') && frame.payload
                    ? frame.payload.session_id
                    : null;
                if (typeof sid === 'string' && sid) {
                  var sidProv = providerFromSessionId(sid);
                  if (sidProv !== ws._maProvider) {
                    if (fType === 'subscribe' || fType === 'subscribe_v2') {
                      if (sidProv === selectedProvider()) {
                        try { ws.close(1000, 'provider-mismatch-reconnect'); } catch (_) {}
                        return;
                      }
                      var okAck = fType === 'subscribe'
                        ? { type: 'response', request_id: frame.request_id, code: 0, msg: 'success' }
                        : {
                            type: 'ack',
                            id: frame.id,
                            code: 0,
                            msg: 'success',
                            payload: { accepted: [sid], not_found: [], resync_required: [], cursors: {} },
                          };
                      emitSyntheticWsMessage(ws, okAck);
                    }
                    return;
                  }
                }
              } catch (_) {}
            }
            return rawSend.call(this, data);
          };
        }
        if (ws && typeof ws.addEventListener === 'function') {
          ws.addEventListener('open', function () {
            ws._maLastActivityAt = Date.now();
            clearWakeProbe(ws);
          });
          ws.addEventListener('message', function () {
            ws._maLastActivityAt = Date.now();
            clearWakeProbe(ws);
          });
          ws.addEventListener('close', function () {
            clearWakeProbe(ws);
            providerSockets.delete(ws);
          });
        }
      }
      return ws;
    }
    ProviderWebSocket.prototype = OriginalWebSocket.prototype;
    if (Object.setPrototypeOf) Object.setPrototypeOf(ProviderWebSocket, OriginalWebSocket);
    window.WebSocket = ProviderWebSocket;
  }

  function clearWakeProbe(ws) {
    if (ws && ws._maProbeTimer) {
      clearTimeout(ws._maProbeTimer);
      ws._maProbeTimer = null;
    }
  }

  function closeProviderSockets(reason) {
    providerSockets.forEach(function (ws) {
      clearWakeProbe(ws);
      try { ws.close(1000, reason || 'provider-switch'); } catch (_) {}
    });
    providerSockets.clear();
  }

  // 借鉴 ovis WS 健壮性:页面冻结唤醒或恢复联网时先对空闲 >10s 连接主动发 JSON ping 探活,
  // 3s 无入站帧或总空闲超过 45s 则以 4008 关闭触发官方重连;pagehide 主动断连防 bfcache 幽灵投递。
  function checkStaleSockets() {
    var now = Date.now();
    providerSockets.forEach(function (ws) {
      var state = ws && ws.readyState;
      if (state === 2 || state === 3) {
        clearWakeProbe(ws);
        providerSockets.delete(ws);
        return;
      }
      var idleMs = ws._maLastActivityAt ? (now - ws._maLastActivityAt) : 0;
      if ((state === undefined || state === 1) && idleMs > WS_STALE_WAKE_MS) {
        clearWakeProbe(ws);
        providerSockets.delete(ws);
        try { ws.close(4008, 'stale-wakeup'); } catch (_) {}
        return;
      }
      if ((state === undefined || state === 1) && idleMs >= WS_WAKE_PROBE_AFTER_MS && typeof ws.send === 'function' && !ws._maProbeTimer) {
        var sentAt = ws._maLastActivityAt;
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (_) {
          clearWakeProbe(ws);
          providerSockets.delete(ws);
          try { ws.close(4008, 'stale-wakeup'); } catch (_) {}
          return;
        }
        ws._maProbeTimer = setTimeout(function () {
          ws._maProbeTimer = null;
          if (ws._maLastActivityAt === sentAt && providerSockets.has(ws)) {
            providerSockets.delete(ws);
            try { ws.close(4008, 'stale-wakeup'); } catch (_) {}
          }
        }, WS_WAKE_PONG_TIMEOUT_MS);
      }
    });
    syncUi();
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', function () {
      closeProviderSockets('pagehide');
    });
    window.addEventListener('online', function () {
      checkStaleSockets();
    });
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (typeof document.visibilityState !== 'string' || document.visibilityState === 'visible') {
        checkStaleSockets();
      }
    });
  }

  // -- 可用 provider(按网关 /meta 实际安装情况过滤) ---------------------------

  function readCredentialValue(raw) {
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.credential === 'string' && parsed.credential) {
          if (typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) && parsed.expiresAt <= Date.now()) {
            return null;
          }
          return parsed.credential;
        }
        return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
      }
      return null;
    } catch (_) {
      return raw;
    }
  }

  function tokenFromHash() {
    var match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash || '');
    if (match) {
      try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
    }
    // hash 没带 token 时回退官方前端存的服务凭证(2.6.2 存 { version: 1, credential, expiresAt }, 旧版为 { token } 或裸串)。
    try {
      var stored = localStorage.getItem('kimi-web.server-credential');
      var fromLocal = readCredentialValue(stored);
      if (fromLocal) return fromLocal;
    } catch (_) {}
    try {
      var fromSession = typeof sessionStorage !== 'undefined' && sessionStorage
        ? readCredentialValue(sessionStorage.getItem('kimi-web.server-credential'))
        : null;
      if (fromSession) return fromSession;
    } catch (_) {}
    return null;
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

  function findPinia() {
    var root = document.querySelector('#app');
    var app = root && root.__vue_app__;
    var pinia = app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
    return pinia && pinia._s && typeof pinia._s.get === 'function' ? pinia : null;
  }

  function getPiniaStore(pinia, id) {
    return pinia && pinia._s && typeof pinia._s.get === 'function' ? pinia._s.get(id) : null;
  }

  function authHeaders() {
    var token = tokenFromHash();
    if (token) return { authorization: 'Bearer ' + token };
    return capturedAuthHeader ? { authorization: capturedAuthHeader } : undefined;
  }

  function mapWireModelToStore(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    var modelId = entry.model || entry.id;
    return {
      id: modelId,
      provider: entry.provider,
      model: modelId,
      displayName: entry.display_name || entry.displayName || modelId,
      maxContextSize: entry.max_context_size !== undefined ? entry.max_context_size : entry.maxContextSize,
      capabilities: entry.capabilities,
      supportEfforts: entry.support_efforts !== undefined ? entry.support_efforts : entry.supportEfforts,
      defaultEffort: entry.default_effort !== undefined ? entry.default_effort : entry.defaultEffort,
      isDefault: Boolean(entry.is_default || entry.isDefault),
    };
  }

  function pickDefaultCatalogId(catalog, ids) {
    for (var i = 0; i < catalog.length; i += 1) {
      var entry = catalog[i];
      if (entry && entry.isDefault) {
        var id = entry.model || entry.id;
        if (typeof id === 'string' && ids.indexOf(id) !== -1) return id;
      }
    }
    return ids[0];
  }

  function reconcilePiniaModel(pinia, provider) {
    var modelsStore = getPiniaStore(pinia, 'kimi.models');
    if (!modelsStore) return;
    var catalog = unwrapRef(modelsStore.models);
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    var ids = catalog
      .map(function (entry) { return entry && (entry.model || entry.id); })
      .filter(function (id) { return typeof id === 'string' && id; });
    if (ids.length === 0) return;
    var current = unwrapRef(modelsStore.draftModel) || unwrapRef(modelsStore.defaultModel);
    var saved = modelMemory()[provider];
    var target = (saved && ids.indexOf(saved) !== -1)
      ? saved
      : (current && ids.indexOf(current) !== -1)
        ? current
        : pickDefaultCatalogId(catalog, ids);
    if (!target) return;
    if (target !== unwrapRef(modelsStore.defaultModel) && typeof modelsStore.setDefaultModel === 'function') {
      modelsStore.setDefaultModel(target);
    }
    if (target !== unwrapRef(modelsStore.draftModel) && typeof modelsStore.setDraftModel === 'function') {
      modelsStore.setDraftModel(target);
    }
    if (target !== current) {
      var headers = authHeaders() || {};
      headers['content-type'] = 'application/json';
      originalFetch
        .call(window, '/api/v1/config?provider=' + encodeURIComponent(provider), {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ default_model: target }),
        })
        .catch(function () {});
    }
  }

  function reconcileWorkspaceSelection(workspacesStore) {
    if (!workspacesStore) return;
    var list = unwrapRef(workspacesStore.workspaces);
    var activeId = unwrapRef(workspacesStore.activeWorkspaceId);
    if (!Array.isArray(list)) return;
    if ((activeId && !list.some(function (w) { return w && w.id === activeId; })) || (!activeId && list.length > 0)) {
      if (typeof workspacesStore.selectWorkspace === 'function') {
        workspacesStore.selectWorkspace(list[0] ? list[0].id : null);
      }
    }
  }

  function clearCrossProviderState(pinia) {
    var sessionsStore = getPiniaStore(pinia, 'kimi.sessions');
    var workspacesStore = getPiniaStore(pinia, 'kimi.workspaces');
    var modelsStore = getPiniaStore(pinia, 'kimi.models');
    if (sessionsStore && typeof sessionsStore.setActiveSessionId === 'function') {
      sessionsStore.setActiveSessionId(undefined);
    }
    if (sessionsStore && typeof sessionsStore.setSessions === 'function') {
      sessionsStore.setSessions([]);
    }
    if (workspacesStore && Array.isArray(workspacesStore.workspaces)) {
      workspacesStore.workspaces = [];
    }
    if (workspacesStore && typeof workspacesStore.selectWorkspace === 'function') {
      workspacesStore.selectWorkspace(null);
    }
    if (modelsStore && typeof modelsStore.setModels === 'function') {
      modelsStore.setModels([]);
    }
    if (modelsStore && typeof modelsStore.setDraftModel === 'function') {
      modelsStore.setDraftModel(null);
    }
    if (modelsStore && typeof modelsStore.setDefaultModel === 'function') {
      modelsStore.setDefaultModel(null);
    }
  }

  function refreshPiniaData(pinia, provider) {
    if (provider !== selectedProvider()) return Promise.resolve();
    var configStore = getPiniaStore(pinia, 'kimi.config');
    var modelsStore = getPiniaStore(pinia, 'kimi.models');
    var workspacesStore = getPiniaStore(pinia, 'kimi.workspaces');
    var sessionListStore = getPiniaStore(pinia, 'kimi.sessionList');

    var metaTask = configStore && typeof configStore.refreshServerMeta === 'function'
      ? Promise.resolve(configStore.refreshServerMeta()).catch(function () {})
      : Promise.resolve();
    var configTask = configStore && typeof configStore.loadConfig === 'function'
      ? Promise.resolve(configStore.loadConfig()).catch(function () {})
      : Promise.resolve();
    var modelsHeaders = authHeaders();
    var modelsTask = modelsStore && typeof modelsStore.setModels === 'function'
      ? originalFetch
          .call(window, '/api/v1/models?provider=' + encodeURIComponent(provider), modelsHeaders ? { headers: modelsHeaders } : undefined)
          .then(function (res) { return res && res.ok ? res.json() : null; })
          .then(function (body) {
            if (provider !== selectedProvider()) return;
            var items = (body && body.data && body.data.items) || (body && body.items);
            if (!Array.isArray(items)) return;
            modelsStore.setModels(items.map(mapWireModelToStore));
            if (typeof modelsStore.setModelsReady === 'function') modelsStore.setModelsReady(true);
          })
          .catch(function () {})
      : Promise.resolve();

    return Promise.all([metaTask, configTask, modelsTask]).then(function () {
      if (provider !== selectedProvider()) return;
      reconcilePiniaModel(pinia, provider);
      if (sessionListStore && typeof sessionListStore.resetSessionList === 'function') {
        sessionListStore.resetSessionList();
      }
      if (workspacesStore && typeof workspacesStore.resetSessionGroupPagination === 'function') {
        workspacesStore.resetSessionGroupPagination();
      }
      if (
        sessionListStore
        && typeof sessionListStore.fireFirstSessionGroupPage === 'function'
        && typeof sessionListStore.loadInitialSessionsByWorkspace === 'function'
      ) {
        var first = sessionListStore.fireFirstSessionGroupPage({});
        var wsPromise = workspacesStore && typeof workspacesStore.loadWorkspaces === 'function'
          ? Promise.resolve(workspacesStore.loadWorkspaces()).catch(function () {})
          : Promise.resolve();
        return wsPromise.then(function () {
          if (provider !== selectedProvider()) return null;
          reconcileWorkspaceSelection(workspacesStore);
          return Promise.resolve(sessionListStore.loadInitialSessionsByWorkspace({
            firstPage: first && first.firstPage,
            input: first && first.input,
            serial: first && first.serial,
            signal: first && first.signal,
          })).catch(function () { return null; });
        }).then(function (loaded) {
          if (provider !== selectedProvider()) return;
          if (loaded && Array.isArray(loaded.sessions) && typeof sessionListStore.setSessionsPreservingLiveUsage === 'function') {
            sessionListStore.setSessionsPreservingLiveUsage(loaded.sessions);
          }
        });
      }
      var wsFallback = workspacesStore && typeof workspacesStore.loadWorkspaces === 'function'
        ? Promise.resolve(workspacesStore.loadWorkspaces()).catch(function () {})
        : Promise.resolve();
      return wsFallback.then(function () {
        if (provider !== selectedProvider()) return;
        reconcileWorkspaceSelection(workspacesStore);
        if (sessionListStore && typeof sessionListStore.ensureFlatSessions === 'function') {
          return Promise.resolve(sessionListStore.ensureFlatSessions()).catch(function () {});
        }
        return undefined;
      });
    });
  }

  // 慢 provider(codex 全量扫描实测 ~4s)的响应若在下次切换后才返回,
  // 会把列表覆盖回旧 provider;刷新串行排队,保证最后选中的 provider 最后落盘。
  var refreshChain = Promise.resolve();
  var pendingProviderRefresh = false;

  function refreshProviderData() {
    var facade = findFacade();
    var hasLegacyFacade = Boolean(facade && typeof facade.load === 'function');
    var pinia = hasLegacyFacade ? null : findPinia();
    var hasPinia = Boolean(pinia && (
      getPiniaStore(pinia, 'kimi.sessionList')
      || getPiniaStore(pinia, 'kimi.workspaces')
      || getPiniaStore(pinia, 'kimi.models')
      || getPiniaStore(pinia, 'kimi.config')
    ));
    if (!hasLegacyFacade && !hasPinia) {
      // 0.39/2.6.2 挂载前拿不到实例。整页 reload 会丢掉 runtimeProvider,
      // fetch 已经带上新 provider;Vue/Pinia 就绪后再加载。
      pendingProviderRefresh = true;
      return;
    }
    pendingProviderRefresh = false;
    closeProviderSockets('provider-switch');
    // 入队时捕获 provider:慢 provider 的 load 落地时选择可能已变,旧 provider
    // 的目录不能用新 provider 的记忆/默认值去校正。
    var provider = selectedProvider();
    if (hasLegacyFacade) {
      // facade.load() 是官方 0.38/0.39 的完整引导;引导完成后校正模型目录。
      refreshChain = refreshChain.then(function () {
        return Promise.resolve(facade.load()).catch(function () {});
      }).then(function () {
        if (provider !== selectedProvider()) return;
        reconcileModel(facade, provider);
      }).then(undefined, function () {
        // 自愈:facade.load 同步抛错曾让链永久 rejected,后续刷新全部静默失效。
      });
      return;
    }
    clearCrossProviderState(pinia);
    refreshChain = refreshChain.then(function () {
      return refreshPiniaData(pinia, provider);
    }).then(undefined, function () {});
  }

  function switchProvider(provider) {
    if (!isProvider(provider) || provider === selectedProvider()) return;
    var facadeBefore = findFacade();
    if (facadeBefore) {
      rememberModel(selectedProvider(), unwrapRef(facadeBefore.defaultModel));
    } else {
      var piniaBefore = findPinia();
      var modelsBefore = getPiniaStore(piniaBefore, 'kimi.models');
      if (modelsBefore) {
        rememberModel(
          selectedProvider(),
          unwrapRef(modelsBefore.draftModel) || unwrapRef(modelsBefore.defaultModel),
        );
      }
    }
    var onSessionPage = /^\/sessions\//.test(window.location.pathname);
    lastRouteProvider = provider;
    setProvider(provider);
    var piniaNow = findPinia();
    if (piniaNow) {
      clearCrossProviderState(piniaNow);
    }
    // 不整页 reload:在会话页先软导航回主页(官方路由监听 popstate),
    // 再让官方 facade/Pinia 按新 provider 重取工作区/会话/模型。
    if (onSessionPage) {
      window.history.pushState(null, '', '/');
      dispatchPopstate();
    }
    var rootFacade = findFacade();
    if (rootFacade && typeof rootFacade.setSessionLoading === 'function') {
      rootFacade.setSessionLoading(false);
    } else if (rootFacade) {
      rootFacade.sessionLoading = false;
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
  // 移动端 0.39/2.6.2 不再渲染 Sidebar,改挂在会话 sheet 的 .view-tabs(flat / 按工作区)正上方。
  // .user-menu-login 是传送到 body 的菜单项,不是挂载点。
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
        if (raw.indexOf('tower') !== -1) id = 'tower';
        else if (raw.indexOf('swarm') !== -1) id = 'swarm';
        else if (raw.indexOf('goal') !== -1 || raw.indexOf('目标') !== -1) id = 'goal';
        else if (raw.indexOf('plan') !== -1 || raw.indexOf('计划') !== -1) id = 'plan';
        else if (raw.indexOf('file') !== -1 || raw.indexOf('附件') !== -1) id = 'files';
        if (id && row.setAttribute) row.setAttribute('data-mode-id', id);
      }
      var isTower = id === 'tower' || id.indexOf('tower') !== -1;
      var isSwarm = id === 'swarm' || id.indexOf('swarm') !== -1;
      var isGoal = id === 'goal' || id.indexOf('goal') !== -1 || id.indexOf('目标') !== -1;
      var isPlan = id === 'plan' || id.indexOf('plan') !== -1 || id.indexOf('计划') !== -1;
      var hide = provider === 'pi'
        ? (isTower || isSwarm || isGoal || isPlan)
        : provider === 'claude'
          ? (isTower || isSwarm || isGoal)
          : (provider === 'codex' || provider === 'grok')
            ? (isTower || isSwarm)
            : false;
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

  // 官方 2.6.2 SlashMenu 内置 /swarm /tower /goal /btw /compact /undo /fork 等。移动端走 .slash-menu.is-sheet。
  // Kimi 全部保留。Claude compact 是真 /compact prompt,但无 rewind,藏 /undo /goal /swarm /tower /btw。
  // Grok 1.0.77 支持 goal/compact/undo/fork,只藏 /swarm /tower /btw。
  // Codex 支持 goal/compact/undo/fork,藏 /swarm /tower /btw。
  // Pi 1.5.2 支持 compact/fork/clone/status/usage,无 goal/plan/undo/swarm/tower/btw,藏 /swarm /tower /goal /plan /btw /undo。
  function blockedSlashNames(provider) {
    if (provider === 'grok' || provider === 'codex') return ['/swarm', '/tower', '/btw'];
    if (provider === 'claude') return ['/swarm', '/tower', '/goal', '/btw', '/undo'];
    if (provider === 'pi') return ['/swarm', '/tower', '/goal', '/btw', '/undo', '/plan'];
    return [];
  }

  function skillHintLookupName(label) {
    var raw = String(label || '').trim().split(/\s+/)[0];
    if (raw.charAt(0) === '/') raw = raw.slice(1);
    if (raw.indexOf('skill:') === 0) raw = raw.slice(6);
    return raw;
  }

  var synthesizingSlashKey = false;

  function isSlashRowVisible(row) {
    if (!row) return false;
    if (typeof row.hasAttribute === 'function' && row.hasAttribute('data-multi-agent-slash-hidden')) return false;
    return !row.style || row.style.display !== 'none';
  }

  function dispatchSlashArrow(target, key, count) {
    if (!target || typeof target.dispatchEvent !== 'function' || typeof KeyboardEvent !== 'function') return;
    var code = key === 'ArrowUp' ? 'ArrowUp' : 'ArrowDown';
    synthesizingSlashKey = true;
    try {
      for (var i = 0; i < count; i += 1) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, bubbles: true, cancelable: true }));
      }
    } finally {
      synthesizingSlashKey = false;
    }
  }

  function gateSlashMenu() {
    if (!document.querySelectorAll) return;
    var provider = selectedProvider();
    var blocked = blockedSlashNames(provider);
    var hints = skillHintsByProvider[provider] || null;
    document.querySelectorAll('.slash-menu .slash-name').forEach(function (nameEl) {
      var token = String(nameEl.textContent || '').trim().split(/\s+/)[0];
      var label = token.toLowerCase();
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
      if (!hide && typeof row.querySelector === 'function' && typeof document.createElement === 'function') {
        var existingHint = row.querySelector('.multi-agent-slash-hint');
        var hintText = provider !== 'kimi' && hints ? hints[skillHintLookupName(token)] : '';
        if (hintText) {
          if (!existingHint) {
            existingHint = document.createElement('span');
            existingHint.className = 'multi-agent-slash-hint';
            if (typeof row.insertBefore === 'function') row.insertBefore(existingHint, nameEl.nextSibling || null);
            else if (typeof row.appendChild === 'function') row.appendChild(existingHint);
          }
          if (existingHint.textContent !== hintText) existingHint.textContent = hintText;
        } else if (existingHint && typeof existingHint.remove === 'function') {
          existingHint.remove();
        }
      }
    });
    var menu = document.querySelector && document.querySelector('.slash-menu');
    if (menu && typeof menu.querySelectorAll === 'function' && document.activeElement) {
      var rows = Array.prototype.slice.call(menu.querySelectorAll('.slash-item'));
      var activeIdx = -1;
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].classList && rows[i].classList.contains('active')) {
          activeIdx = i;
          break;
        }
      }
      if (activeIdx >= 0 && !isSlashRowVisible(rows[activeIdx])) {
        var steps = 1;
        while (steps < rows.length) {
          if (isSlashRowVisible(rows[(activeIdx + steps) % rows.length])) {
            dispatchSlashArrow(document.activeElement, 'ArrowDown', steps);
            break;
          }
          steps += 1;
        }
      }
    }
  }

  function onSlashKeydown(e) {
    if (synthesizingSlashKey || !e || e.isComposing) return;
    var key = e.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter' && key !== 'Tab') return;
    var menu = document.querySelector && document.querySelector('.slash-menu');
    if (!menu || typeof menu.querySelectorAll !== 'function') return;
    var rows = Array.prototype.slice.call(menu.querySelectorAll('.slash-item'));
    if (rows.length === 0) return;
    var visibleCount = 0;
    var activeIdx = -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (isSlashRowVisible(rows[i])) visibleCount += 1;
      if (activeIdx === -1 && rows[i].classList && rows[i].classList.contains('active')) activeIdx = i;
    }
    if (visibleCount === 0) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      return;
    }
    if (key === 'Enter' || key === 'Tab') {
      if (activeIdx >= 0 && !isSlashRowVisible(rows[activeIdx])) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      }
      return;
    }
    var cur = activeIdx >= 0 ? activeIdx : 0;
    var delta = key === 'ArrowDown' ? 1 : -1;
    var steps = 1;
    while (steps <= rows.length) {
      var candidate = (cur + delta * steps + rows.length * 2) % rows.length;
      if (isSlashRowVisible(rows[candidate])) break;
      steps += 1;
    }
    if (steps > 1 && steps <= rows.length) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      dispatchSlashArrow(e.target || document.activeElement, key, steps);
    }
  }

  if (document.addEventListener) {
    document.addEventListener('keydown', onSlashKeydown, true);
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

  var lastRouteProvider = selectedProvider();
  function onRouteChange() {
    var nextProvider = selectedProvider();
    if (nextProvider !== lastRouteProvider) {
      lastRouteProvider = nextProvider;
      closeProviderSockets('route-provider-change');
      refreshProviderData();
    }
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
