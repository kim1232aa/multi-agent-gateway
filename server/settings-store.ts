/**
 * settings-store:会话级设置(model/thinking/permission/plan)的磁盘持久化。
 *
 * 背景:这些设置在 facade 适配器里原是内存 Map,网关一重启就丢——实测
 * 重启后 codex 会话的"完全自主"消失,resume 不再显式传 approvalPolicy,
 * thread 回落到它创建时存的 untrusted 策略,审批弹窗全回来了。
 *
 * 每 provider 一个 JSON 文件({scope: {sessionId: value}}),写穿 +
 * tmp+rename 原子替换。读不到/损坏就当空启动:丢持久化不丢功能。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SettingsStore {
  private data: Record<string, Record<string, unknown>> = {};

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // 文件不存在或损坏:空启动,不阻塞网关。
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
    this.flush();
  }

  delete(scope: string, sessionId: string): void {
    const bucket = this.data[scope];
    if (bucket && sessionId in bucket) {
      delete bucket[sessionId];
      this.flush();
    }
  }

  private flush(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.path);
    } catch (err) {
      // 写失败只影响重启后的记忆,不影响本次设置生效;但磁盘满/权限错
      // 这类故障不能无声吞掉,留一行日志可查(审查发现)。
      console.warn(`[settings] flush ${this.path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
