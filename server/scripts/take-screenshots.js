/**
 * Production-ready Screenshot Generation Script for All Supported CLIs.
 *
 * Paths are resolved from the environment so anyone can run it:
 *   GATEWAY_URL   e.g. http://127.0.0.1:58629 (default)
 *   GATEWAY_TOKEN gateway token; read from $GATEWAY_SETTINGS_DIR/gateway.token when unset
 *   CHROME_PATH   browser binary (WSL default: the Windows Chrome install)
 *   OUT_DIR       output directory (default: <repo>/docs/images)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME_PATH = process.env.CHROME_PATH ?? '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9350);
const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:58629').replace(/\/+$/, '');
const SETTINGS_DIR = process.env.GATEWAY_SETTINGS_DIR ?? path.join(os.homedir(), '.config', 'multi-agent-gateway');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (e) {}
    };
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async screenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(outputPath, buf);
    console.log(`[Captured] ${path.basename(outputPath)} (${buf.length} bytes)`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function main() {
  const token = process.env.GATEWAY_TOKEN?.trim()
    || fs.readFileSync(path.join(SETTINGS_DIR, 'gateway.token'), 'utf8').trim();
  const baseUrl = `${GATEWAY_URL}/#token=${token}`;

  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--disable-gpu',
      '--window-size=1680,1050',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targetWsUrl = '';
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
      if (targets && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
        targetWsUrl = targets[0].webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }

  if (!targetWsUrl) {
    chrome.kill();
    throw new Error('Chrome CDP connection timeout');
  }

  const cdp = new Cdp(targetWsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');

  const outDir = process.env.OUT_DIR ?? path.join(repoRoot, 'docs', 'images');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const dismissModal = async () => {
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const skip = btns.find(b => b.textContent.trim() === '跳过' || b.textContent.trim() === 'Skip');
        if (skip) skip.click();
      })()
    `);
  };

  const navigateToSession = async (sid) => {
    await cdp.eval(`
      (() => {
        history.pushState({}, '', '/sessions/${sid}');
        window.dispatchEvent(new PopStateEvent('popstate'));
      })()
    `);
    await sleep(4000);
    await dismissModal();
  };

  console.log('Navigating to homepage...');
  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(4000);
  await dismissModal();

  // 1. 六大 Agent 调度总览
  console.log('1. Capturing 01-agent-overview.png...');
  await cdp.screenshot(path.join(outDir, '01-agent-overview.png'));

  // 2. DSH 真实技术对话（令牌桶限流器）
  console.log('2. Capturing 05-dsh-agent-conversation.png...');
  await navigateToSession('dsh_1077fa00-7ea9-4711-8ef7-4b939bc347f8');
  await cdp.screenshot(path.join(outDir, '05-dsh-agent-conversation.png'));

  // 3. Grok 真实技术诊断会话
  console.log('3. Capturing 02-grok-clean-sidebar.png...');
  await navigateToSession('grok_01a1de65-a11b-7d81-b7d0-1c03e6702e7b');
  await cdp.screenshot(path.join(outDir, '02-grok-clean-sidebar.png'));

  // 4. Claude Code 真实会话验证
  console.log('4. Capturing 06-claude-verification.png...');
  await navigateToSession('claude_e68b6a25-9c8e-45de-b003-8d62635fe362');
  await cdp.screenshot(path.join(outDir, '06-claude-verification.png'));

  // 5. Codex CLI 真实会话验证
  console.log('5. Capturing 07-codex-verification.png...');
  await navigateToSession('codex_01a1de64-d91b-7a00-a968-3bf8d795b57f');
  await cdp.screenshot(path.join(outDir, '07-codex-verification.png'));

  cdp.close();
  chrome.kill();
  console.log('All CLI verification screenshots captured successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
