(function () {
  'use strict';

  var PROVIDERS = ['kimi', 'claude', 'codex'];
  var LABELS = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex' };
  var STORAGE_KEY = 'multi-agent-gateway.provider.v1';
  var originalFetch = window.fetch || fetch;

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
    if (pathname === '/api/v1/models' || pathname === '/api/v1/workspaces' || pathname === '/api/v1/config' || pathname === '/api/v1/commands' || pathname === '/api/v1/auth' || pathname === '/api/v1/meta') return true;
    if (pathname === '/api/v1/sessions' || pathname === '/api/v1/files' || /^\/api\/v1\/files\//.test(pathname)) return true;
    if (/^\/api\/v1\/providers(?:$|[:/])/.test(pathname)) return true;
    return /^\/api\/v1\/workspaces\/[^/]+\/skills$/.test(pathname);
  }

  function rewriteApiUrl(input) {
    var raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    var url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || (url.pathname !== '/api/v1' && url.pathname.indexOf('/api/v1/') !== 0)) return url;
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

  function switchProvider(provider) {
    if (!isProvider(provider) || provider === selectedProvider()) {
      closeMenu();
      return;
    }
    setProvider(provider);
    closeMenu();
    if (/^\/sessions\//.test(window.location.pathname)) {
      window.history.pushState(null, '', '/');
    }
    if (window.location && typeof window.location.reload === 'function') window.location.reload();
  }

  function buildMenu(modelPill, composerCard) {
    var menu = document.createElement('div');
    menu.className = 'model-dropdown multi-agent-provider-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    copyScopeAttributes(modelPill, menu);

    PROVIDERS.forEach(function (provider) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'md-row';
      row.setAttribute('role', 'menuitemradio');
      copyScopeAttributes(modelPill, row);

      var check = document.createElement('span');
      check.className = 'md-check';
      check.textContent = provider === selectedProvider() ? '✓' : '';
      copyScopeAttributes(modelPill, check);

      var name = document.createElement('span');
      name.className = 'md-name';
      name.textContent = LABELS[provider];
      copyScopeAttributes(modelPill, name);

      row.appendChild(check);
      row.appendChild(name);
      row.addEventListener('click', function (event) {
        event.stopPropagation();
        switchProvider(provider);
      });
      menu.appendChild(row);
    });

    composerCard.appendChild(menu);
    providerMenu = menu;
    return menu;
  }

  function installPill() {
    if (!document.querySelector) return;
    var modelPill = document.querySelector('.composer .toolbar-right .model-pill:not(.login-pill)');
    if (!modelPill || document.querySelector('.multi-agent-provider-pill')) return;
    var toolbar = modelPill.parentElement;
    var composerCard = modelPill.closest('.composer-card');
    if (!toolbar || !composerCard) return;

    var pill = modelPill.cloneNode(true);
    pill.classList.remove('open');
    pill.classList.add('multi-agent-provider-pill');
    pill.setAttribute('aria-label', 'Agent');
    pill.setAttribute('aria-haspopup', 'menu');
    pill.setAttribute('aria-expanded', 'false');
    var name = pill.querySelector('.mp-name');
    if (name) name.textContent = LABELS[selectedProvider()];
    var thinking = pill.querySelector('.think-suffix');
    if (thinking) thinking.remove();
    pill.addEventListener('click', function (event) {
      event.stopPropagation();
      if (providerMenu && !providerMenu.isConnected) providerMenu = null;
      var menu = providerMenu || buildMenu(modelPill, composerCard);
      menu.hidden = !menu.hidden;
      pill.classList.toggle('open', !menu.hidden);
      pill.setAttribute('aria-expanded', String(!menu.hidden));
    });
    pill.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pill.click();
      }
    });
    toolbar.insertBefore(pill, modelPill);
  }

  function gateModes() {
    if (!document.querySelectorAll) return;
    var provider = selectedProvider();
    document.querySelectorAll('.modes-menu').forEach(function (menu) {
      var rows = Array.from(menu.children).filter(function (node) {
        return node.classList && node.classList.contains('mode-row');
      });
      rows.forEach(function (row, index) {
        var labelNode = row.querySelector('.mode-row-name');
        var label = labelNode ? String(labelNode.textContent || '').trim().toLowerCase() : '';
        var isSwarm = label === 'swarm' || (!label && index === 1);
        var isGoal = label === 'goal' || label === '目标' || (!label && index === 2);
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

  function syncAccountUi() {
    var provider = selectedProvider();
    var trigger = document.querySelector('.user-menu-trigger');
    if (!trigger) return;
    var name = trigger.querySelector('.user-menu-name');
    if (provider !== 'kimi') {
      trigger.classList.add('multi-agent-provider-account');
      if (name) {
        if (!name.hasAttribute('data-multi-agent-original-text')) {
          name.setAttribute('data-multi-agent-original-text', name.textContent || '');
        }
        if (name.textContent !== LABELS[provider]) name.textContent = LABELS[provider];
      }
      document.querySelectorAll('.user-menu-login').forEach(function (item) {
        item.hidden = true;
        item.setAttribute('data-multi-agent-hidden', '');
      });
      return;
    }
    trigger.classList.remove('multi-agent-provider-account');
    if (name && name.hasAttribute('data-multi-agent-original-text')) {
      name.textContent = name.getAttribute('data-multi-agent-original-text') || '';
      name.removeAttribute('data-multi-agent-original-text');
    }
    document.querySelectorAll('.user-menu-login[data-multi-agent-hidden]').forEach(function (item) {
      item.hidden = false;
      item.removeAttribute('data-multi-agent-hidden');
    });
  }

  function syncUi() {
    if (!document.querySelector) return;
    installPill();
    var pill = document.querySelector('.multi-agent-provider-pill .mp-name');
    if (pill && pill.textContent !== LABELS[selectedProvider()]) pill.textContent = LABELS[selectedProvider()];
    if (providerMenu && providerMenu.isConnected) {
      Array.from(providerMenu.querySelectorAll('.md-row')).forEach(function (row, index) {
        var active = PROVIDERS[index] === selectedProvider();
        row.classList.toggle('is-current', active);
        row.setAttribute('aria-checked', String(active));
        var check = row.querySelector('.md-check');
        var mark = active ? '✓' : '';
        if (check && check.textContent !== mark) check.textContent = mark;
      });
    } else {
      providerMenu = null;
    }
    gateModes();
    syncAccountUi();
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
    document.addEventListener('click', closeMenu);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncUi, { once: true });
  }
  var syncTimer = null;
  function scheduleSyncUi() {
    if (syncTimer !== null) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      syncUi();
    }, 0);
  }
  var observer = new MutationObserver(scheduleSyncUi);
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') syncUi();

  window.__multiAgent = {
    version: 1,
    providers: PROVIDERS,
    selectedProvider: selectedProvider,
    setProvider: setProvider,
    rewriteApiUrl: rewriteApiUrl,
  };
})();
