/**
 * fs:* 六条路由的本地实现(不走 codex fs RPC——网关本机直接做,两家通用且功能更全)。
 * 安全边界:所有路径必须 resolve 后落在会话 cwd 之内,防 ../ 穿越;git 操作
 * 一律 git -C <cwd>;遍历/搜索排除 .git、node_modules,限条目数与文件大小。
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ProviderError, type ProviderErrorCode } from './types.js';

/** 文件系统错误统一走 ProviderError(网关 catch 只认这个类型)。 */
export class FsError extends ProviderError {
  constructor(httpStatus: number, code: number, msg: string) {
    const mapped: ProviderErrorCode =
      httpStatus === 404 ? 'not_found' : httpStatus === 400 ? 'invalid_request' : 'upstream_error';
    super(mapped, msg, httpStatus);
    this.name = 'ProviderError';
  }
}

/** 把用户路径 resolve 到 cwd 沙箱内;越界抛 400。 */
export function resolveInCwd(cwd: string, p?: string): string {
  const base = path.resolve(cwd);
  const target = path.resolve(base, p ?? '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new FsError(400, 40001, `path 越出会话目录: ${p ?? ''}`);
  }
  return target;
}

/** 请求里的相对路径原样回给前端(前端按 cwd 相对路径展示);绝对路径转相对。 */
function displayPath(cwd: string, abs: string): string {
  const base = path.resolve(cwd);
  if (abs === base) return '.';
  const rel = path.relative(base, abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', '.next', 'target']);
const LIST_MAX_ENTRIES = 500;
const WALK_MAX_ENTRIES = 5000;
const READ_MAX_BYTES = 1024 * 1024; // 1MB
const GREP_MAX_FILE_BYTES = 512 * 1024;
const GREP_MAX_FILES = 2000;
const GREP_MAX_MATCHES_PER_FILE = 50;
const GREP_MAX_TOTAL_MATCHES = 500;
const GREP_TIME_BUDGET_MS = 5000;

const MIME_BY_EXT: Record<string, string> = {
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.js': 'text/javascript', '.jsx': 'text/javascript',
  '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  '.py': 'text/x-python', '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript', '.zsh': 'text/x-shellscript',
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/toml', '.xml': 'text/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm', '.zip': 'application/zip', '.gz': 'application/gzip',
};

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.md': 'markdown',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.sh': 'shellscript', '.html': 'html', '.css': 'css',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.sql': 'sql', '.vue': 'vue',
};

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function mimeOf(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
}

function etagOf(size: number, mtimeMs: number): string {
  return `${Math.round(mtimeMs)}:${size}`;
}

/** 读前 8KB 判 NUL 字节,有则视为二进制。 */
async function isBinaryFile(abs: string): Promise<boolean> {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

export interface FsEntryWire {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  modified_at: string;
  etag?: string;
  mime?: string;
  language_id?: string;
  is_binary?: boolean;
  is_symlink_to?: string;
  git_status?: string;
  child_count?: number;
}

async function entryWire(cwd: string, abs: string, gitMap?: Map<string, string>): Promise<FsEntryWire> {
  const st = await fsp.lstat(abs);
  const name = path.basename(abs);
  const wire: FsEntryWire = {
    path: displayPath(cwd, abs),
    name,
    kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file',
    modified_at: st.mtime.toISOString(),
  };
  if (st.isSymbolicLink()) {
    wire.is_symlink_to = await fsp.readlink(abs).catch(() => undefined);
    // symlink 指向的类型尽量解析;失败按 file 处理。
    const real = await fsp.stat(abs).catch(() => null);
    if (real?.isDirectory()) wire.kind = 'directory';
  }
  if (wire.kind === 'file') {
    wire.size = st.size;
    wire.etag = etagOf(st.size, st.mtimeMs);
    wire.mime = mimeOf(name);
    const lang = LANG_BY_EXT[extOf(name)];
    if (lang) wire.language_id = lang;
    // 只对可疑类型判二进制(已知文本类型跳过 I/O)。
    if (!lang && wire.mime === 'application/octet-stream') {
      wire.is_binary = await isBinaryFile(abs).catch(() => false);
    } else {
      wire.is_binary = false;
    }
  }
  if (wire.kind === 'directory') {
    const kids = await fsp.readdir(abs).catch(() => [] as string[]);
    wire.child_count = kids.filter((k) => !SKIP_DIRS.has(k)).length;
  }
  if (gitMap) {
    const rel = displayPath(cwd, abs);
    const gs = gitMap.get(rel);
    if (gs) wire.git_status = gs;
  }
  return wire;
}

/** git status --porcelain=v1 -z 解析成 相对路径→状态码 的 map。 */
function parsePorcelain(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const entries = out.split('\0').filter(Boolean);
  for (const e of entries) {
    if (e.length < 4) continue;
    if (e.startsWith('##')) continue; // --branch 的头部行,不是文件条目。
    const xy = e.slice(0, 2);
    let p = e.slice(3);
    // rename/copy: "XY old\0new" —— -z 模式下新路径是下一个 \0 段,这里只标旧路径。
    map.set(p, xy.trim() || '??');
  }
  return map;
}

function runGit(cwd: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new FsError(500, 50001, 'git 命令超时'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errs.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new FsError(500, 50001, `git 启动失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8');
      if (code === 0) return resolvePromise(out);
      rejectPromise(new FsError(400, 40002, `git ${args[0] ?? ''} 失败(${code}): ${Buffer.concat(errs).toString('utf8').slice(0, 200)}`));
    });
  });
}

async function gitStatusMap(cwd: string): Promise<Map<string, string> | null> {
  try {
    const out = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    return parsePorcelain(out);
  } catch {
    return null; // 非 git 仓库:不带状态,不报错。
  }
}

export async function fsList(
  cwd: string,
  input: { path?: string; depth?: number; include_git_status?: boolean },
): Promise<{ items: FsEntryWire[]; children_by_path?: Record<string, FsEntryWire[]>; truncated: boolean }> {
  const abs = resolveInCwd(cwd, input.path);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw new FsError(404, 40404, `目录不存在: ${input.path ?? '.'}`);
  if (!st.isDirectory()) throw new FsError(400, 40003, `不是目录: ${input.path ?? '.'}`);

  const depth = Math.max(1, Math.min(4, input.depth ?? 1));
  const gitMap = input.include_git_status ? await gitStatusMap(cwd) : null;
  let truncated = false;
  let count = 0;

  async function listOne(dirAbs: string): Promise<FsEntryWire[]> {
    const names = (await fsp.readdir(dirAbs)).filter((n) => !SKIP_DIRS.has(n)).sort();
    const out: FsEntryWire[] = [];
    for (const n of names) {
      if (count >= LIST_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      count += 1;
      out.push(await entryWire(cwd, path.join(dirAbs, n), gitMap ?? undefined));
    }
    // 目录在前,文件在后,各自按名称排。
    out.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    return out;
  }

  const items = await listOne(abs);
  let childrenByPath: Record<string, FsEntryWire[]> | undefined;
  if (depth >= 2) {
    childrenByPath = {};
    // BFS 到 depth 层;每层的目录都列出直接子级。
    let frontier = items.filter((e) => e.kind === 'directory');
    for (let level = 2; level <= depth && frontier.length > 0 && !truncated; level += 1) {
      const next: FsEntryWire[] = [];
      for (const dir of frontier) {
        if (truncated) break;
        const dirAbs = resolveInCwd(cwd, dir.path);
        const kids = await listOne(dirAbs);
        childrenByPath[dir.path] = kids;
        next.push(...kids.filter((e) => e.kind === 'directory'));
      }
      frontier = next;
    }
  }
  const result: { items: FsEntryWire[]; children_by_path?: Record<string, FsEntryWire[]>; truncated: boolean } = { items, truncated };
  if (childrenByPath && Object.keys(childrenByPath).length > 0) result.children_by_path = childrenByPath;
  return result;
}

export async function fsRead(
  cwd: string,
  input: { path: string; offset?: number; length?: number },
): Promise<{
  path: string; content: string; encoding: 'utf-8' | 'base64'; size: number;
  truncated: boolean; etag: string; mime: string; language_id?: string;
  line_count?: number; is_binary: boolean;
}> {
  if (!input.path) throw new FsError(400, 40001, '缺少 path');
  const abs = resolveInCwd(cwd, input.path);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw new FsError(404, 40404, `文件不存在: ${input.path}`);
  if (!st.isFile()) throw new FsError(400, 40003, `不是文件: ${input.path}`);

  const offset = Math.max(0, input.offset ?? 0);
  const length = Math.max(1, Math.min(READ_MAX_BYTES, input.length ?? READ_MAX_BYTES));
  const size = st.size;
  const fh = await fsp.open(abs, 'r');
  let buf: Buffer;
  try {
    const readLen = Math.min(length, Math.max(0, size - offset));
    buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, offset);
  } finally {
    await fh.close();
  }
  const truncated = offset + buf.length < size;
  const isBinary = buf.includes(0);
  const mime = mimeOf(path.basename(abs));
  const result: {
    path: string; content: string; encoding: 'utf-8' | 'base64'; size: number;
    truncated: boolean; etag: string; mime: string; language_id?: string;
    line_count?: number; is_binary: boolean;
  } = {
    path: displayPath(cwd, abs),
    content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8',
    size,
    truncated,
    etag: etagOf(size, st.mtimeMs),
    mime,
    is_binary: isBinary,
  };
  const lang = LANG_BY_EXT[extOf(path.basename(abs))];
  if (lang) result.language_id = lang;
  if (!isBinary) {
    result.line_count = buf.toString('utf8').split('\n').length + (truncated ? 0 : 0);
  }
  return result;
}

interface WalkItem {
  abs: string;
  rel: string;
  isDir: boolean;
}

/** BFS 遍历沙箱,跳过 SKIP_DIRS,限 WALK_MAX_ENTRIES 条。 */
async function walk(cwd: string): Promise<{ items: WalkItem[]; truncated: boolean }> {
  const base = path.resolve(cwd);
  const out: WalkItem[] = [];
  const queue: string[] = [base];
  let truncated = false;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (out.length >= WALK_MAX_ENTRIES) {
        truncated = true;
        return { items: out, truncated };
      }
      if (SKIP_DIRS.has(n)) continue;
      const abs = path.join(dir, n);
      const st = await fsp.lstat(abs).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) continue; // 不跟 symlink,防环防逃逸。
      const isDir = st.isDirectory();
      out.push({ abs, rel: displayPath(cwd, abs), isDir });
      if (isDir) queue.push(abs);
    }
  }
  return { items: out, truncated };
}

/** 简单子序列模糊评分:命中字符位置也一并返回(前端高亮用)。 */
function fuzzyScore(query: string, target: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === '') return null;
  const positions: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    positions.push(idx);
    ti = idx + 1;
  }
  // 越紧凑、越靠前、目标越短分越高;子串命中加分。
  const span = positions[positions.length - 1] - positions[0] + 1;
  let score = 100 - span - positions[0] * 0.5 - target.length * 0.05;
  if (t.includes(q)) score += 50;
  if (t.startsWith(q)) score += 25;
  return { score, positions };
}

export async function fsSearch(
  cwd: string,
  input: { query: string; limit?: number },
): Promise<{ items: Array<{ path: string; name: string; kind: 'file' | 'directory' | 'symlink'; score: number; match_positions: number[] }>; truncated: boolean }> {
  const query = (input.query ?? '').trim();
  if (!query) return { items: [], truncated: false };
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const { items: walked, truncated } = await walk(cwd);
  const scored: Array<{ path: string; name: string; kind: 'file' | 'directory' | 'symlink'; score: number; match_positions: number[] }> = [];
  for (const it of walked) {
    const name = path.basename(it.abs);
    // 文件名优先;路径也试一次取较高分。
    const byName = fuzzyScore(query, name);
    const byPath = fuzzyScore(query, it.rel);
    const best = byName && byPath ? (byName.score >= byPath.score ? byName : byPath) : byName ?? byPath;
    if (!best) continue;
    scored.push({
      path: it.rel,
      name,
      kind: it.isDir ? 'directory' : 'file',
      score: Math.round(best.score * 100) / 100,
      match_positions: best.positions,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { items: scored.slice(0, limit), truncated: truncated || scored.length > limit };
}

export async function fsGrep(
  cwd: string,
  input: { pattern: string; regex?: boolean; case_sensitive?: boolean },
): Promise<{
  files: Array<{ path: string; matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> }>;
  files_scanned: number; truncated: boolean; elapsed_ms: number;
}> {
  const pattern = input.pattern ?? '';
  if (!pattern) throw new FsError(400, 40001, '缺少 pattern');
  const started = Date.now();
  let re: RegExp;
  try {
    re = input.regex
      ? new RegExp(pattern, input.case_sensitive ? 'g' : 'gi')
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), input.case_sensitive ? 'g' : 'gi');
  } catch (err) {
    throw new FsError(400, 40001, `正则无效: ${(err as Error).message}`);
  }

  const { items: walked } = await walk(cwd);
  const files: Array<{ path: string; matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> }> = [];
  let filesScanned = 0;
  let totalMatches = 0;
  let truncated = false;

  for (const it of walked) {
    if (it.isDir) continue;
    if (filesScanned >= GREP_MAX_FILES || totalMatches >= GREP_MAX_TOTAL_MATCHES || Date.now() - started > GREP_TIME_BUDGET_MS) {
      truncated = true;
      break;
    }
    const st = await fsp.stat(it.abs).catch(() => null);
    if (!st || st.size > GREP_MAX_FILE_BYTES) continue;
    // 已知二进制扩展直接跳过;其余读内容判 NUL。
    const buf = await fsp.readFile(it.abs).catch(() => null);
    if (!buf || buf.includes(0)) continue;
    filesScanned += 1;
    const lines = buf.toString('utf8').split('\n');
    const matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      matches.push({
        line: i + 1,
        col: m.index + 1,
        text: lines[i].slice(0, 500),
        before: lines.slice(Math.max(0, i - 2), i).map((l) => l.slice(0, 500)),
        after: lines.slice(i + 1, i + 3).map((l) => l.slice(0, 500)),
      });
      if (matches.length >= GREP_MAX_MATCHES_PER_FILE || totalMatches + matches.length >= GREP_MAX_TOTAL_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (matches.length > 0) {
      files.push({ path: it.rel, matches });
      totalMatches += matches.length;
    }
  }
  return { files, files_scanned: filesScanned, truncated, elapsed_ms: Date.now() - started };
}

export async function fsGitStatus(
  cwd: string,
  _paths?: string[],
): Promise<{ branch: string; ahead: number; behind: number; entries: Record<string, string>; additions: number; deletions: number; pullRequest: null }> {
  // 非 git 仓库:如实回空状态而不是报错(前端文件树在非 git 目录也要能用)。
  const branchOut = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  const branch = branchOut.trim();
  if (!branch) {
    return { branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
  }
  const statusOut = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--branch']);
  const map = parsePorcelain(statusOut);
  const entries: Record<string, string> = {};
  for (const [k, v] of map) entries[k] = v;
  // ahead/behind:## branch...origin/branch [ahead N, behind M]
  let ahead = 0;
  let behind = 0;
  const header = statusOut.split('\0')[0] ?? '';
  const aheadMatch = /ahead (\d+)/.exec(header);
  const behindMatch = /behind (\d+)/.exec(header);
  if (aheadMatch) ahead = Number(aheadMatch[1]);
  if (behindMatch) behind = Number(behindMatch[1]);
  const numstat = await runGit(cwd, ['diff', '--numstat', 'HEAD']).catch(() => '');
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = Number(parts[0]);
    const d = Number(parts[1]);
    if (Number.isFinite(a)) additions += a;
    if (Number.isFinite(d)) deletions += d;
  }
  return { branch, ahead, behind, entries, additions, deletions, pullRequest: null };
}

export async function fsDiff(cwd: string, input: { path: string }): Promise<{ path: string; diff: string }> {
  if (!input.path) throw new FsError(400, 40001, '缺少 path');
  const abs = resolveInCwd(cwd, input.path);
  const rel = displayPath(cwd, abs);
  // 已跟踪文件:git diff HEAD -- path;未跟踪:构造 new-file diff。
  const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '--', rel]).then(() => true).catch(() => false);
  if (tracked) {
    const diff = await runGit(cwd, ['diff', 'HEAD', '--', rel]);
    return { path: rel, diff };
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new FsError(404, 40404, `文件不存在: ${input.path}`);
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) return { path: rel, diff: `Binary file ${rel} (untracked)\n` };
  const lines = buf.toString('utf8').split('\n');
  const body = lines.map((l) => `+${l}`).join('\n');
  return {
    path: rel,
    diff: `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
  };
}
