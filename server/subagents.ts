import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SubagentInfo, SubagentStatus } from './types.js';

export function subagentStatus(value: unknown): SubagentStatus {
  switch (value) {
    case 'started': case 'running': case 'in_progress': case 'working': return 'running';
    case 'completed': case 'done': return 'completed';
    case 'failed': case 'error': case 'errored': return 'failed';
    case 'cancelled': case 'canceled': case 'stopped': case 'interrupted': case 'aborted': case 'killed': return 'cancelled';
    default: return 'unknown';
  }
}

export function boundedEntries(dir: string, limit = 200): string[] {
  const names: string[] = [];
  let handle;
  try {
    handle = opendirSync(dir);
    for (let entry; names.length < limit && (entry = handle.readSync());) names.push(entry.name);
  } catch { /* unavailable */ }
  finally { handle?.closeSync(); }
  return names;
}

export function containedRegularPath(root: string, file: string): boolean {
  const rel = relative(root, file);
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) return false;
  let current = root;
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return false;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

export function readSubagentTail(root: string, file: string, budget = 512 * 1024): string {
  if (!containedRegularPath(root, file)) return '';
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const offset = Math.max(0, st.size - budget);
    const buf = Buffer.alloc(Math.min(st.size, budget));
    const n = readSync(fd, buf, 0, buf.length, offset);
    const text = buf.subarray(0, n).toString('utf8');
    const newline = text.indexOf('\n');
    return offset ? (newline < 0 ? '' : text.slice(newline + 1)) : text;
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readSubagentJson(root: string, file: string): Record<string, unknown> | undefined {
  try {
    const text = readSubagentTail(root, file, 64 * 1024);
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* invalid or oversized */ }
  return undefined;
}

export function grokDiskSubagents(root: string, sessionId: string): SubagentInfo[] {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return [];
  const result: SubagentInfo[] = [];
  let inspected = 0;
  for (const group of boundedEntries(root)) {
    const dir = join(root, group, sessionId, 'subagents');
    if (!containedRegularPath(root, dir)) continue;
    for (const id of boundedEntries(dir)) {
      if (++inspected > 200) return result;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      const meta = readSubagentJson(root, join(dir, id, 'meta.json'));
      if (!meta || meta.parent_session_id !== sessionId || meta.subagent_id !== id) continue;
      const agentId = typeof meta.child_session_id === 'string' ? meta.child_session_id : id;
      if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) continue;
      result.push({
        agentId,
        status: subagentStatus(meta.status),
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
        ...(typeof meta.subagent_type === 'string' ? { subagentType: meta.subagent_type } : {}),
        ...(typeof meta.tool_call_id === 'string' ? { parentToolUseId: meta.tool_call_id } : {}),
        ...(typeof meta.started_at === 'string' ? { startedAt: meta.started_at } : {}),
        ...(typeof meta.completed_at === 'string' ? { endedAt: meta.completed_at } : {}),
      });
      if (result.length >= 200) return result;
    }
  }
  return result;
}
