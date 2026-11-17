(function () {
  'use strict';

  var PROVIDERS = ['kimi', 'claude', 'codex', 'grok', 'pi', 'dsh'];
  var LABELS = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex', grok: 'Grok', pi: 'Pi', dsh: 'Dsh' };
  var DEFAULT_CAPABILITIES = {
    kimi: {
      tower: true,
      swarm: true,
      goals: true,
      planMode: true,
      btw: true,
      rollback: true,
      compact: true,
      fork: true,
    },
    claude: {
      tower: false,
      swarm: false,
      goals: false,
      planMode: true,
      btw: false,
      rollback: false,
      compact: true,
      fork: true,
    },
    codex: {
      tower: false,
      swarm: false,
      goals: true,
      planMode: true,
      btw: false,
      rollback: true,
      compact: true,
      fork: true,
    },
    grok: {
      tower: false,
      swarm: false,
      goals: true,
      planMode: true,
      btw: false,
      rollback: true,
      compact: true,
      fork: true,
    },
    pi: {
      tower: false,
      swarm: false,
      goals: false,
      planMode: false,
      btw: false,
      rollback: false,
      compact: true,
      fork: true,
    },
    dsh: {
      tower: false,
      swarm: false,
      goals: false,
      planMode: false,
      btw: false,
      rollback: false,
      compact: false,
      fork: false,
    },
  };
  var providerCapabilities = Object.create(null);

  function getCapabilities(provider) {
    var dynamic = providerCapabilities && providerCapabilities[provider];
    var fallback = DEFAULT_CAPABILITIES[provider] || {
      tower: false,
      swarm: false,
      goals: false,
      planMode: false,
      btw: false,
      rollback: false,
      compact: true,
      fork: true,
    };
    if (dynamic && typeof dynamic === 'object') {
      return Object.assign({}, fallback, dynamic);
    }
    return fallback;
  }
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
    if (id.indexOf('dsh_') === 0) return 'dsh';
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
    if (pathname === '/api/v1/models' || pathname === '/api/v1/workspaces' || pathname === '/api/v1/config' || pathname === '/api/v1/commands' || pathname === '/api/v1/meta' || pathname === '/api/v1/providers' || /^\/api\/v1\/providers\/[^/]+$/.test(pathname)) return true;
    if (pathname === '/api/v1/sessions' || pathname === '/api/v2/sessions' || pathname === '/api/v2/sessions:archive' || pathname === '/api/v2/sessions:restore' || pathname === '/api/v1/files' || pathname === '/api/v1/fs:home' || pathname === '/api/v1/fs:browse' || pathname === '/api/v1/fs:suggest' || pathname === '/api/v1/workspace/fs:list' || pathname === '/api/v1/workspace/fs:search' || pathname === '/api/v1/workspace/fs:suggest' || /^\/api\/v1\/files\//.test(pathname) || /^\/api\/v1\/sessions\/[^/]+\/status$/.test(pathname)) return true;
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

  function skillHintLookupName(label) {
    var raw = String(label || '').trim().split(/\s+/)[0];
    if (raw.charAt(0) === '/') raw = raw.slice(1);
    if (raw.slice(0, 6).toLowerCase() === 'skill:') raw = raw.slice(6);
    return raw;
  }

  var skillHintsByProvider = Object.create(null);
  var extUiBySession = Object.create(null);

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
      var rawName = item.name.trim();
      var cleanName = skillHintLookupName(rawName);
      if (hint) {
        bucket[rawName] = hint;
        if (cleanName) bucket[cleanName] = hint;
      } else {
        delete bucket[rawName];
        if (cleanName) delete bucket[cleanName];
      }
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
      } else if (input instanceof Request && typeof input.clone === 'function' && (!init || init.body === undefined)) {
        var sourceRequest = input;
        input = sourceRequest.clone();
        var rewritten = input.text().then(function (bodyText) {
          var sanitizedBody = sanitizePromptBody(bodyText);
          var reqInit = Object.assign({
            method: sourceRequest.method,
            headers: sourceRequest.headers,
            body: sanitizedBody,
            credentials: sourceRequest.credentials,
            cache: sourceRequest.cache,
            redirect: sourceRequest.redirect,
            referrer: sourceRequest.referrer,
            referrerPolicy: sourceRequest.referrerPolicy,
            integrity: sourceRequest.integrity,
            keepalive: sourceRequest.keepalive,
            mode: sourceRequest.mode,
            signal: sourceRequest.signal,
          }, init || {});
          reqInit.body = sanitizedBody;
          return new Request(url.href, reqInit);
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
    if ((url.pathname === '/api/v1/meta' || url.pathname === '/meta') && reqPromise && typeof reqPromise.then === 'function') {
      reqPromise.then(function (res) {
        if (!res || !res.ok || typeof res.clone !== 'function') return;
        res.clone().json().then(function (body) {
          var capsMap = (body && body.data && body.data.provider_capabilities)
            || (body && body.provider_capabilities);
          if (capsMap && typeof capsMap === 'object') {
            for (var p in capsMap) {
              if (Object.prototype.hasOwnProperty.call(capsMap, p) && capsMap[p] && typeof capsMap[p] === 'object') {
                providerCapabilities[p] = capsMap[p];
              }
            }
            if (window.__multiAgent) window.__multiAgent.providerCapabilities = providerCapabilities;
            scheduleSyncUi();
          }
        }).catch(function () {});
      }).catch(function () {});
    }
    var statusMatch = /^\/api\/v1\/sessions\/([^/]+)\/status$/.exec(url.pathname);
    if (statusMatch && reqPromise && typeof reqPromise.then === 'function') {
      var statusSid = decodeURIComponent(statusMatch[1]);
      reqPromise.then(function (res) {
        if (!res || !res.ok || typeof res.clone !== 'function') return;
        res.clone().json().then(function (body) {
          var ext = body && body.data && body.data.extension_ui;
          if (ext && typeof ext === 'object') {
            extUiBySession[statusSid] = {
              statuses: ext.statuses || {},
              widgets: ext.widgets || {},
              title: ext.title || '',
            };
          } else {
            delete extUiBySession[statusSid];
          }
          scheduleSyncUi();
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
                        try {
                          ws._intentionalClose = true;
                          ws._maIntentionalClose = true;
                          ws.onerror = null;
                          ws.close(1000, 'provider-mismatch-reconnect');
                        } catch (_) {}
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
                    } else if (fType === 'unsubscribe' || fType === 'unsubscribe_v2') {
                      var unAck = fType === 'unsubscribe'
                        ? { type: 'response', request_id: frame.request_id, code: 0, msg: 'success' }
                        : {
                            type: 'ack',
                            id: frame.id,
                            code: 0,
                            msg: 'success',
                            payload: { accepted: [sid], not_found: [], resync_required: [] },
                          };
                      emitSyntheticWsMessage(ws, unAck);
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
          ws.addEventListener('message', function (ev) {
            ws._maLastActivityAt = Date.now();
            clearWakeProbe(ws);
            if (ev && typeof ev.data === 'string' && ev.data.charAt(0) === '{') {
              try {
                var parsedMsg = JSON.parse(ev.data);
                if (parsedMsg && parsedMsg.type === 'extension_ui' && parsedMsg.session_id) {
                  extUiBySession[parsedMsg.session_id] = {
                    statuses: parsedMsg.statuses || {},
                    widgets: parsedMsg.widgets || {},
                    title: parsedMsg.title || '',
                  };
                  scheduleSyncUi();
                }
              } catch (_) {}
            }
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
      try {
        ws._intentionalClose = true;
        ws._maIntentionalClose = true;
        ws.onerror = null;
        ws.close(1000, reason || 'provider-switch');
      } catch (_) {}
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
        var capsMap = (body && body.data && body.data.provider_capabilities)
          || (body && body.provider_capabilities);
        if (capsMap && typeof capsMap === 'object') {
          for (var p in capsMap) {
            if (Object.prototype.hasOwnProperty.call(capsMap, p) && capsMap[p] && typeof capsMap[p] === 'object') {
              providerCapabilities[p] = capsMap[p];
            }
          }
          if (window.__multiAgent) window.__multiAgent.providerCapabilities = providerCapabilities;
        }
        var list = body && body.data && body.data.providers;
        if (!Array.isArray(list)) {
          if (capsMap) syncUi();
          return;
        }
        var filtered = list.filter(isProvider);
        if (filtered.length === 0 || filtered.indexOf('kimi') === -1) {
          if (capsMap) syncUi();
          return;
        }
        var changed = filtered.length !== PROVIDERS.length;
        if (!changed) {
          for (var i = 0; i < filtered.length; i += 1) {
            if (filtered[i] !== PROVIDERS[i]) {
              changed = true;
              break;
            }
          }
        }
        PROVIDERS.length = 0;
        Array.prototype.push.apply(PROVIDERS, filtered);
        if (window.__multiAgent) window.__multiAgent.providers = PROVIDERS;
        if (PROVIDERS.indexOf(selectedProvider()) === -1) setProvider('kimi');
        if (changed || capsMap) {
          var stale = document.querySelector && document.querySelector('.multi-agent-provider-wrap');
          if (stale && changed) stale.remove();
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
    var modeStore = getPiniaStore(pinia, 'kimi.mode');
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
    if (modelsStore) {
      var wsSkillsMap = unwrapRef(modelsStore.skillsByWorkspace);
      var wsFetchedMap = unwrapRef(modelsStore.skillsFetchedByWorkspace);
      var wsKeys = Object.keys(Object.assign({}, wsSkillsMap && typeof wsSkillsMap === 'object' ? wsSkillsMap : null, wsFetchedMap && typeof wsFetchedMap === 'object' ? wsFetchedMap : null));
      if (typeof modelsStore.invalidateSkillsForWorkspace === 'function') {
        for (var wi = 0; wi < wsKeys.length; wi += 1) {
          try { modelsStore.invalidateSkillsForWorkspace(wsKeys[wi]); } catch (_) {}
        }
      } else {
        if (modelsStore.skillsByWorkspace && typeof modelsStore.skillsByWorkspace === 'object' && 'value' in modelsStore.skillsByWorkspace) {
          modelsStore.skillsByWorkspace.value = {};
        } else if (modelsStore.skillsByWorkspace !== undefined) {
          modelsStore.skillsByWorkspace = {};
        }
        if (modelsStore.skillsFetchedByWorkspace && typeof modelsStore.skillsFetchedByWorkspace === 'object' && 'value' in modelsStore.skillsFetchedByWorkspace) {
          modelsStore.skillsFetchedByWorkspace.value = {};
        } else if (modelsStore.skillsFetchedByWorkspace !== undefined) {
          modelsStore.skillsFetchedByWorkspace = {};
        }
      }
      var sessSkillsMap = unwrapRef(modelsStore.skillsBySession);
      var sessFetchedMap = unwrapRef(modelsStore.skillsFetchedBySession);
      var sessKeys = Object.keys(Object.assign({}, sessSkillsMap && typeof sessSkillsMap === 'object' ? sessSkillsMap : null, sessFetchedMap && typeof sessFetchedMap === 'object' ? sessFetchedMap : null));
      if (typeof modelsStore.invalidateSkillsForSession === 'function') {
        for (var si = 0; si < sessKeys.length; si += 1) {
          try { modelsStore.invalidateSkillsForSession(sessKeys[si]); } catch (_) {}
        }
      } else {
        if (modelsStore.skillsBySession && typeof modelsStore.skillsBySession === 'object' && 'value' in modelsStore.skillsBySession) {
          modelsStore.skillsBySession.value = {};
        } else if (modelsStore.skillsBySession !== undefined) {
          modelsStore.skillsBySession = {};
        }
        if (modelsStore.skillsFetchedBySession && typeof modelsStore.skillsFetchedBySession === 'object' && 'value' in modelsStore.skillsFetchedBySession) {
          modelsStore.skillsFetchedBySession.value = {};
        } else if (modelsStore.skillsFetchedBySession !== undefined) {
          modelsStore.skillsFetchedBySession = {};
        }
      }
    }
    if (modeStore) {
      if (typeof modeStore.resetMode === 'function') {
        try { modeStore.resetMode(); } catch (_) {}
      }
      var resetProps = [
        'thinking', 'draftThinkingExplicit',
        'thinkingBySession', 'pendingThinkingBySession',
        'planModeBySession', 'planArmedBySession', 'pendingPlanBySession',
        'swarmModeBySession', 'pendingSwarmBySession',
        'towerModeBySession', 'pendingTowerBySession',
        'goalModeBySession',
      ];
      for (var m = 0; m < resetProps.length; m += 1) {
        var prop = resetProps[m];
        if (modeStore[prop] !== undefined) {
          var isMap = prop.indexOf('BySession') !== -1;
          var emptyVal = isMap ? {} : (prop === 'draftThinkingExplicit' ? false : undefined);
          if (modeStore[prop] && typeof modeStore[prop] === 'object' && 'value' in modeStore[prop]) {
            modeStore[prop].value = emptyVal;
          } else {
            modeStore[prop] = emptyVal;
          }
        }
      }
      if (modeStore.draftModes) {
        var cleanDraftModes = { planMode: false, swarmMode: false, towerMode: false, towerBase: undefined, goalMode: false };
        if (typeof modeStore.draftModes === 'object' && 'value' in modeStore.draftModes) {
          modeStore.draftModes.value = cleanDraftModes;
        } else if (typeof modeStore.draftModes === 'object') {
          modeStore.draftModes.planMode = false;
          modeStore.draftModes.swarmMode = false;
          modeStore.draftModes.towerMode = false;
          modeStore.draftModes.towerBase = undefined;
          modeStore.draftModes.goalMode = false;
        }
      }
      var modeRefs = ['planMode', 'planArmed', 'swarmMode', 'towerMode', 'goalMode'];
      for (var r = 0; r < modeRefs.length; r += 1) {
        var ref = modeRefs[r];
        if (modeStore[ref] !== undefined) {
          if (modeStore[ref] && typeof modeStore[ref] === 'object' && 'value' in modeStore[ref]) {
            modeStore[ref].value = false;
          } else if (typeof modeStore[ref] === 'boolean') {
            modeStore[ref] = false;
          }
        }
      }
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
          var activeWsId = unwrapRef(workspacesStore && workspacesStore.activeWorkspaceId);
          if (activeWsId && modelsStore && typeof modelsStore.loadSkillsForWorkspace === 'function') {
            Promise.resolve(modelsStore.loadSkillsForWorkspace(activeWsId)).catch(function () {});
          }
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
        var activeWsId = unwrapRef(workspacesStore && workspacesStore.activeWorkspaceId);
        if (activeWsId && modelsStore && typeof modelsStore.loadSkillsForWorkspace === 'function') {
          Promise.resolve(modelsStore.loadSkillsForWorkspace(activeWsId)).catch(function () {});
        }
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
    var caps = getCapabilities(provider);
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
      var hide = (isTower && !caps.tower)
        || (isSwarm && !caps.swarm)
        || (isGoal && !caps.goals)
        || (isPlan && !caps.planMode);
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
  // 基于 providerCapabilities 动态门控 Tier-1 命令，未就绪时回退安全默认值。
  function blockedSlashNames(provider) {
    var caps = getCapabilities(provider);
    var blocked = [];
    if (!caps.tower) blocked.push('/tower');
    if (!caps.swarm) blocked.push('/swarm');
    if (!caps.goals) blocked.push('/goal');
    if (!caps.planMode) blocked.push('/plan');
    if (!caps.btw) blocked.push('/btw');
    if (!caps.rollback) blocked.push('/undo');
    if (!caps.compact) blocked.push('/compact');
    if (!caps.fork) blocked.push('/fork');
    return blocked;
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
      var row = (typeof nameEl.closest === 'function' && nameEl.closest('.slash-item')) || nameEl.parentElement;
      if (!row || !row.style) return;
      var isSkill = Boolean(row.classList && typeof row.classList.contains === 'function' && row.classList.contains('is-skill'));
      var hide = blocked.indexOf(label) !== -1 && !isSkill;
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
        var hintKey = skillHintLookupName(token);
        var hintText = provider !== 'kimi' && hints ? (hints[hintKey] || hints[token] || '') : '';
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
    if (menu && typeof menu.querySelectorAll === 'function') {
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
        var nextVisibleIdx = -1;
        while (steps < rows.length) {
          var candIdx = (activeIdx + steps) % rows.length;
          if (isSlashRowVisible(rows[candIdx])) {
            nextVisibleIdx = candIdx;
            break;
          }
          steps += 1;
        }
        if (nextVisibleIdx >= 0) {
          var targetEl = document.activeElement || (document.querySelector && document.querySelector('.composer textarea, textarea, [contenteditable="true"]'));
          if (targetEl) dispatchSlashArrow(targetEl, 'ArrowDown', steps);
          if (rows[activeIdx].classList && typeof rows[activeIdx].classList.remove === 'function') {
            rows[activeIdx].classList.remove('active');
          }
          if (rows[nextVisibleIdx].classList && typeof rows[nextVisibleIdx].classList.add === 'function') {
            rows[nextVisibleIdx].classList.add('active');
          }
          if (typeof rows[activeIdx].setAttribute === 'function') {
            rows[activeIdx].setAttribute('aria-selected', 'false');
          }
          if (typeof rows[nextVisibleIdx].setAttribute === 'function') {
            rows[nextVisibleIdx].setAttribute('aria-selected', 'true');
          }
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
    if ((steps > 1 || !isSlashRowVisible(rows[cur])) && steps <= rows.length) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      dispatchSlashArrow(e.target || document.activeElement, key, steps);
    }
  }

  function getBarePlanComposerEditor() {
    if (!document.querySelector) return null;
    var ed = document.querySelector('.composer .ProseMirror, .composer [contenteditable="true"], .empty-composer .ProseMirror, .empty-composer [contenteditable="true"]');
    if (!ed) return null;
    var raw = String(ed.innerText !== undefined ? ed.innerText : (ed.textContent || '')).trim();
    return raw === '/plan' ? ed : null;
  }

  function isSlashMenuVisiblyOpen() {
    if (!document.querySelector) return false;
    var menu = document.querySelector('.slash-menu');
    if (!menu) return false;
    if (typeof window.getComputedStyle === 'function') {
      var st = window.getComputedStyle(menu);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
    }
    if (typeof menu.getBoundingClientRect === 'function') {
      var rect = menu.getBoundingClientRect();
      if (rect && rect.height === 0 && rect.width === 0) return false;
    }
    return true;
  }

  function tryBypassPiBarePlan(e, allowWhenMenuOpen) {
    if (selectedProvider() !== 'pi' || getCapabilities('pi').planMode) return false;
    var ed = getBarePlanComposerEditor();
    var sid = currentSessionIdForExtUi();
    if (!ed || !sid) return false;
    if (!allowWhenMenuOpen && isSlashMenuVisiblyOpen()) {
      var hasToken = typeof ed.querySelector === 'function' && Boolean(ed.querySelector('.composer-command-token'));
      if (!hasToken) return false;
    }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    try {
      if (typeof ed.focus === 'function') ed.focus();
      if (typeof document.execCommand === 'function') {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      } else {
        ed.textContent = '';
      }
    } catch (_) {
      ed.textContent = '';
    }
    var headers = Object.assign({ 'content-type': 'application/json' }, authHeaders() || {});
    window.fetch('/api/v1/sessions/' + encodeURIComponent(sid) + '/prompts?provider=pi', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ content: [{ type: 'text', text: '/plan' }] }),
    }).catch(function () {});
    return true;
  }

  function onComposerPlanSubmitKeydown(e) {
    if (!e || e.isComposing || e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    var target = e.target;
    var inEditor = target && typeof target.closest === 'function'
      ? Boolean(target.closest('.composer, .empty-composer'))
      : Boolean(document.activeElement && typeof document.activeElement.closest === 'function' && document.activeElement.closest('.composer, .empty-composer'));
    if (!inEditor && target && target.className && String(target.className).indexOf('ProseMirror') === -1) return;
    tryBypassPiBarePlan(e, false);
  }

  function onComposerPlanSendClick(e) {
    var target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;
    var btn = target.closest('.composer button, .empty-composer button');
    if (!btn) return;
    var aria = typeof btn.getAttribute === 'function' ? String(btn.getAttribute('aria-label') || '') : '';
    var cls = String(btn.className || '');
    var isSend = /\bsend\b/i.test(cls) || /发送|send/i.test(aria) || btn.type === 'submit';
    if (!isSend) return;
    tryBypassPiBarePlan(e, true);
  }

  if (document.addEventListener) {
    document.addEventListener('keydown', onSlashKeydown, true);
    document.addEventListener('keydown', onComposerPlanSubmitKeydown, true);
    document.addEventListener('click', onComposerPlanSendClick, true);
  }

  function enhanceQuestionCards() {
    if (!document.querySelectorAll || typeof document.createElement !== 'function') return;
    document.querySelectorAll('.qcard .qpane .qopts').forEach(function (qopts) {
      if (!qopts || !qopts.querySelectorAll || !qopts.parentElement) return;
      var opts = Array.prototype.slice.call(qopts.querySelectorAll('.qopt')).filter(function (el) {
        return !(el.classList && el.classList.contains('qopt-other'));
      });
      var existingSearch = qopts.parentElement.querySelector ? qopts.parentElement.querySelector('.multi-agent-qsearch') : null;
      if (opts.length <= 6) {
        if (qopts.classList) qopts.classList.remove('multi-agent-qopts-scroll');
        if (existingSearch && typeof existingSearch.remove === 'function') existingSearch.remove();
        return;
      }
      if (qopts.classList) qopts.classList.add('multi-agent-qopts-scroll');
      if (existingSearch) return;
      var box = document.createElement('div');
      box.className = 'multi-agent-qsearch';
      var input = document.createElement('input');
      input.type = 'search';
      input.className = 'multi-agent-qsearch__input';
      input.placeholder = '搜索选项 / Type to filter…';
      input.autocomplete = 'off';
      var count = document.createElement('span');
      count.className = 'multi-agent-qsearch__count';
      count.textContent = opts.length + ' / ' + opts.length;
      function applyFilter() {
        var q = String(input.value || '').trim().toLowerCase();
        var shown = 0;
        var currentOpts = Array.prototype.slice.call(qopts.querySelectorAll('.qopt')).filter(function (el) {
          return !(el.classList && el.classList.contains('qopt-other'));
        });
        for (var i = 0; i < currentOpts.length; i += 1) {
          var opt = currentOpts[i];
          var txt = String(opt.textContent || '').toLowerCase();
          var hit = !q || txt.indexOf(q) !== -1;
          if (hit) {
            shown += 1;
            opt.hidden = false;
            if (typeof opt.removeAttribute === 'function') opt.removeAttribute('data-multi-agent-qhidden');
          } else {
            opt.hidden = true;
            if (typeof opt.setAttribute === 'function') opt.setAttribute('data-multi-agent-qhidden', '');
          }
        }
        count.textContent = shown + ' / ' + currentOpts.length;
      }
      if (typeof input.addEventListener === 'function') {
        input.addEventListener('input', applyFilter);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && input.value) {
            input.value = '';
            applyFilter();
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
          }
        });
      }
      box.appendChild(input);
      box.appendChild(count);
      qopts.parentElement.insertBefore(box, qopts);
    });
  }

  function currentSessionIdForExtUi() {
    var m = /^\/sessions\/([^/]+)/.exec(window.location.pathname || '');
    if (m && m[1]) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    var pinia = findPinia();
    var sessionsStore = getPiniaStore(pinia, 'kimi.sessions');
    var active = sessionsStore && unwrapRef(sessionsStore.activeSessionId);
    return typeof active === 'string' && active ? active : null;
  }

  function syncExtBar() {
    if (!document.querySelector || typeof document.createElement !== 'function') return;
    var existingBars = document.querySelectorAll ? Array.prototype.slice.call(document.querySelectorAll('.multi-agent-ext-bar')) : [];
    var sid = currentSessionIdForExtUi();
    var ext = sid ? extUiBySession[sid] : null;
    var statusKeys = ext && ext.statuses ? Object.keys(ext.statuses).filter(function (k) { return ext.statuses[k]; }) : [];
    var widgetKeys = ext && ext.widgets ? Object.keys(ext.widgets).filter(function (k) { return ext.widgets[k] && Array.isArray(ext.widgets[k].lines) && ext.widgets[k].lines.length > 0; }) : [];
    if (statusKeys.length === 0 && widgetKeys.length === 0) {
      for (var r = 0; r < existingBars.length; r += 1) {
        if (typeof existingBars[r].remove === 'function') existingBars[r].remove();
      }
      return;
    }
    var composer = document.querySelector('.composer, .empty-composer');
    if (!composer || !composer.parentElement) return;
    var bar = existingBars[0];
    if (!bar || bar.parentElement !== composer.parentElement) {
      for (var d = 0; d < existingBars.length; d += 1) {
        if (typeof existingBars[d].remove === 'function') existingBars[d].remove();
      }
      bar = document.createElement('div');
      bar.className = 'multi-agent-ext-bar';
      composer.parentElement.insertBefore(bar, composer);
    }
    bar.textContent = '';
    if (statusKeys.length > 0) {
      var stRow = document.createElement('div');
      stRow.className = 'multi-agent-ext-statuses';
      for (var i = 0; i < statusKeys.length; i += 1) {
        var key = statusKeys[i];
        var pill = document.createElement('span');
        pill.className = 'multi-agent-ext-pill';
        pill.textContent = key + ': ' + ext.statuses[key];
        stRow.appendChild(pill);
      }
      bar.appendChild(stRow);
    }
    for (var j = 0; j < widgetKeys.length; j += 1) {
      var wKey = widgetKeys[j];
      var wBox = document.createElement('div');
      wBox.className = 'multi-agent-ext-widgets';
      wBox.textContent = ext.widgets[wKey].lines.join('\n');
      bar.appendChild(wBox);
    }
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
    enhanceQuestionCards();
    syncExtBar();
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
  var uiMutationSelector = '.side-footer, .user-menu-trigger, .view-tabs, .multi-agent-provider-wrap, .multi-agent-provider-seg, .am-row, .slash-menu, .slash-name, .wizard, .qcard, .qpane, .qopts, .composer, .empty-composer';
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
  // 设置 → 模型供应商：与当前 CLI 同名的那一行是 CLI 自己的原生配置，网关只读（零侵入）。
  // 打标签，并拦掉点击（否则会打开可编辑表单，保存时才收到 403）。
  function isNativeProviderRow(row) {
    var provider = selectedProvider();
    if (!row || provider === 'kimi') return false;
    var idEl = row.querySelector && row.querySelector('.pp-id');
    return Boolean(idEl && idEl.textContent && idEl.textContent.trim() === provider);
  }
  function markNativeProviderRows() {
    if (!document.querySelectorAll) return;
    document.querySelectorAll('.pp-row').forEach(function (row) {
      var native = isNativeProviderRow(row);
      var tag = row.querySelector('.multi-agent-native-tag');
      if (native && !tag) {
        tag = document.createElement('span');
        tag.className = 'multi-agent-native-tag';
        tag.textContent = '只读 · CLI 原生配置';
        var idEl = row.querySelector('.pp-id');
        if (idEl && idEl.parentElement) idEl.parentElement.appendChild(tag);
      } else if (!native && tag) {
        tag.remove();
      }
    });
  }
  document.addEventListener('click', function (event) {
    var target = event.target;
    var row = target && target.closest ? target.closest('.pp-row') : null;
    if (!row || !isNativeProviderRow(row)) return;
    event.preventDefault();
    event.stopPropagation();
    var hint = row.parentElement && row.parentElement.querySelector('.multi-agent-native-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'multi-agent-native-hint';
      hint.textContent = '这是 ' + selectedProvider() + ' CLI 自己的配置，由 CLI 管理，网关不改它的文件。要换中转或 API Key，请点「添加供应商」：只在网关启动 '
        + selectedProvider() + ' 时注入，删掉即恢复原生配置。';
      row.insertAdjacentElement('afterend', hint);
    }
  }, true);
  var providersPanelObserver = new MutationObserver(function () {
    if (document.querySelector && document.querySelector('.pp-row')) markNativeProviderRows();
  });
  if (document.documentElement) providersPanelObserver.observe(document.documentElement, { childList: true, subtree: true });

  // -- 命令形态守卫 ----------------------------------------------------------
  // 后端的命令目录带 form（client / gateway / cli / terminal / unknown）。
  // terminal 形态的命令只能在 CLI 的交互终端里跑，直接当 prompt 发出去只会得到
  // 一句“不支持”或静默失败；在这里拦下并给出可执行的替代做法。
  var commandForms = Object.create(null); // provider -> { name: { form, pinnedVersion, verified } }

  function rememberCommandForms(provider, items) {
    if (!provider || !Array.isArray(items)) return;
    var map = commandForms[provider] || (commandForms[provider] = Object.create(null));
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!item || typeof item.name !== 'string') continue;
      var name = item.name.replace(/^\//, '').toLowerCase();
      map[name] = {
        form: typeof item.form === 'string' ? item.form : '',
        pinnedVersion: typeof item.pinned_version === 'string' ? item.pinned_version : '',
        verified: item.verified === true,
      };
    }
  }

  function commandFormOf(provider, name) {
    var map = commandForms[provider];
    return map ? map[String(name).replace(/^\//, '').toLowerCase()] : undefined;
  }

  function noticeForTerminalCommand(provider, name) {
    var label = provider.charAt(0).toUpperCase() + provider.slice(1);
    return '`/' + name + '` 只能在 ' + label
      + ' 自己的交互终端里运行（它会打开需要按键操作的面板或选择器），Web 端没有对应的读法，因此没有发送。'
      + '\n\n可以改用：网页支持的命令（输入 `/help` 查看），或在该 CLI 的终端里执行这一条。';
  }

  function showComposerNotice(text) {
    if (!document.querySelector || typeof document.createElement !== 'function') return;
    var host = document.querySelector('.composer') || document.querySelector('.empty-composer');
    if (!host || !host.parentElement) return;
    var box = document.querySelector('.multi-agent-cmd-notice');
    if (!box) {
      box = document.createElement('div');
      box.className = 'multi-agent-cmd-notice';
      host.parentElement.insertBefore(box, host);
    }
    box.textContent = text;
    clearTimeout(box.__hideTimer);
    box.__hideTimer = setTimeout(function () {
      try { box.remove(); } catch (_) {}
    }, 12000);
  }

  /** 发送前的形态判定：返回 true 表示已拦下（不该作为普通 prompt 发送）。 */
  function blockTerminalCommand(bodyText) {
    var provider = selectedProvider();
    if (provider === 'kimi' || typeof bodyText !== 'string' || bodyText.indexOf('/') === -1) return false;
    var match = bodyText.match(/^\s{0,200}?\/([A-Za-z0-9_:-]+)/);
    if (!match && bodyText.charAt(0) === '{') {
      try {
        var body = JSON.parse(bodyText);
        var args = body && typeof body.args === 'string' ? body.args : '';
        match = args.match(/^\s*\/?([A-Za-z0-9_:-]+)/);
      } catch (_) { match = null; }
    }
    if (!match) return false;
    var entry = commandFormOf(provider, match[1]);
    if (!entry || entry.form !== 'terminal') return false;
    showComposerNotice(noticeForTerminalCommand(provider, match[1]));
    return true;
  }

  // 命令目录随会话/CLI 切换刷新；只缓存，不阻塞请求。
  var originalFetchForCommands = window.fetch;
  window.fetch = function (input, init) {
    var url = rewriteApiUrl(input);
    var isCommands = /\/sessions\/[^/]+\/skills$/.test(url.pathname) || /\/api\/v1\/commands$/.test(url.pathname);
    var result = originalFetchForCommands.call(this, input, init);
    if (isCommands && typeof result.then === 'function') {
      var provider = selectedProvider();
      result.then(function (res) {
        if (!res || !res.ok || typeof res.clone !== 'function') return null;
        return res.clone().json().then(function (body) {
          rememberCommandForms(provider, (body && body.data && body.data.items) || (body && body.items));
          return null;
        }).catch(function () { return null; });
      }).catch(function () {});
    }
    return result;
  };

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
    providerCapabilities: providerCapabilities,
    getCapabilities: getCapabilities,
  };
})();
