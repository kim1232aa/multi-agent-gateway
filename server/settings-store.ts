/**
 * settings-store:会话级设置(model/thinking/permission/plan/archived)的磁盘持久化。
 *
 * 背景:这些设置在 facade 适配器里原是内存 Map,网关一重启就丢——实测
 * 重启后 codex 会话的"完全自主"消失,resume 不再显式传 approvalPolicy,
 * thread 回落到它创建时存的 untrusted 策略,审批弹窗全回来了。
 *
 * 每 provider 一个 JSON 文件({scope: {sessionId: value}}),写穿 +
 * 独占临时文件+rename 原子替换。读不到/损坏就当空启动:丢持久化不丢功能。
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SettingsStoreOptions {
  /** Base delay (ms) before retrying a failed flush (exponential backoff). Default 100ms. */
  retryDelayMs?: number;
  /** Maximum consecutive retries after a failed flush. Default 5. */
  maxRetries?: number;
  /** Optional callback invoked when a disk flush fails. */
  onError?: (err: unknown) => void;
}

const STALE_TMP_AGE_MS = 60_000;

export class SettingsStore {
  private static tempSeq = 0;

  private data: Record<string, Record<string, unknown>> = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  private consecutiveFailures = 0;
  private lastFlushError: unknown = undefined;

  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly onError?: (err: unknown) => void;

  constructor(
    private readonly path?: string,
    options?: SettingsStoreOptions,
  ) {
    this.retryDelayMs = Math.max(1, options?.retryDelayMs ?? 100);
    this.maxRetries = Math.max(0, options?.maxRetries ?? 5);
    this.onError = options?.onError;
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // 文件不存在或损坏:空启动,不阻塞网关。
    }
    // 只清扫本进程残留的 `<base>.<pid>.*.tmp` / `<base>.<pid>.tmp`,以及超时(>60s)的孤儿 `.tmp`,
    // 避免并发实例启动时误删另一进程正在写入的原子临时文件。
    try {
      const dir = dirname(path);
      const base = path.split(/[\\/]/).pop() ?? '';
      const ownPrefix = `${base}.${process.pid}.`;
      const now = Date.now();
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue;
        const full = join(dir, name);
        if (name.startsWith(ownPrefix)) {
          try { unlinkSync(full); } catch { /* ignore */ }
          continue;
        }
        try {
          const st = statSync(full);
          if (now - st.mtimeMs >= STALE_TMP_AGE_MS) {
            unlinkSync(full);
          }
        } catch {
          // 已被并发进程 rename/unlink:忽略。
        }
      }
    } catch {
      // 目录不存在/无权限:忽略。
    }
  }

  getString(scope: string, sessionId: string): string | undefined {
    const value = this.data[scope]?.[sessionId];
    return typeof value === 'string' ? value : undefined;
  }

  getBoolean(scope: string, sessionId: string): boolean | undefined {
    const value = this.data[scope]?.[sessionId];
    return typeof value === 'boolean' ? value : undefined;
  }

  set(scope: string, sessionId: string, value: string | boolean): void {
    (this.data[scope] ??= {})[sessionId] = value;
    this.consecutiveFailures = 0;
    this.scheduleFlush();
  }

  delete(scope: string, sessionId: string): void {
    const bucket = this.data[scope];
    if (bucket && sessionId in bucket) {
      delete bucket[sessionId];
      this.consecutiveFailures = 0;
      this.scheduleFlush();
    }
  }

  /** Copy every scoped value from one session id onto another (fork). */
  copySession(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    for (const bucket of Object.values(this.data)) {
      if (fromId in bucket) {
        const value = bucket[fromId];
        if (typeof value === 'string' || typeof value === 'boolean') {
          bucket[toId] = value;
        }
      }
    }
    this.consecutiveFailures = 0;
    this.scheduleFlush();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getLastError(): unknown {
    return this.lastFlushError;
  }

  /** 测试/关停时强制落盘。 */
  flushNow(): void {
    this.clearTimers();
    this.flush();
  }

  /** 关闭存储并立即落盘,同时取消挂起的后台调度器。 */
  close(): void {
    this.closed = true;
    this.flushNow();
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.closed || this.flushTimer || !this.path) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // 同 tick 批量 set(归档多会话)合并成一次写。
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 0);
    this.flushTimer.unref?.();
  }

  private scheduleRetry(): void {
    if (this.closed || !this.dirty || !this.path || this.retryTimer) return;
    if (this.consecutiveFailures > this.maxRetries) return;
    const delay = Math.min(30_000, this.retryDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, delay);
    this.retryTimer.unref?.();
  }

  private flush(): void {
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    let tmp: string | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const payload = JSON.stringify(this.data);
      const seq = ++SettingsStore.tempSeq;
      const nonce = randomBytes(4).toString('hex');
      tmp = `${this.path}.${process.pid}.${seq}.${nonce}.tmp`;
      writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.path);
      tmp = undefined;
      try { chmodSync(this.path, 0o600); } catch { /* ignore */ }
      this.consecutiveFailures = 0;
      this.lastFlushError = undefined;
    } catch (err) {
      if (tmp) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
      // 写失败只影响重启后的记忆,不影响本次设置生效;保留 dirty 并做有界重试,同时记录错误与告警。
      this.dirty = true;
      this.consecutiveFailures += 1;
      this.lastFlushError = err;
      this.onError?.(err);
      console.warn(`[settings] flush ${this.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRetry();
    }
  }
}
