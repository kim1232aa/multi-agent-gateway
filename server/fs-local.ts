/**
 * fs:* 六条路由的本地实现(不走 codex fs RPC——网关本机直接做,两家通用且功能更全)。
 * 安全边界:所有路径必须 resolve 后落在会话 cwd 之内,防 ../ 穿越;git 操作
 * 一律 git -C <cwd>;遍历/搜索排除 .git、node_modules,限条目数与文件大小。
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants, existsSync, type Stats } from 'node:fs';
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

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:(?:[\\/]|$)|^\\\\/.test(p);
}

function stripWindowsDevicePrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function useWin32Paths(cwd: string, other?: string): boolean {
  return process.platform === 'win32' || isWindowsPath(cwd) || (other !== undefined && isWindowsPath(other));
}

function normalizeForCompare(p: string, win32: boolean): string {
  const cleaned = stripWindowsDevicePrefix(p);
  const resolved = win32 ? path.win32.resolve(cleaned) : path.resolve(cleaned);
  return win32 ? resolved.toLowerCase() : resolved;
}

function isWithinNormalized(base: string, target: string, win32: boolean): boolean {
  const b = normalizeForCompare(base, win32);
  const t = normalizeForCompare(target, win32);
  if (t === b) return true;
  const sep = win32 ? path.win32.sep : path.sep;
  const prefix = b.endsWith(sep) ? b : b + sep;
  return t.startsWith(prefix);
}

/** 把用户路径 resolve 到 cwd 沙箱内;越界抛 400。 */
export function resolveInCwd(cwd: string, p?: string): string {
  if (p && p.includes('\0')) {
    throw new FsError(400, 40001, 'path 包含非法空字节');
  }
  const win32 = useWin32Paths(cwd);
  if (!win32 && p && isWindowsPath(p)) {
    throw new FsError(400, 40001, `path 越出会话目录: ${p}`);
  }
  const pMod = win32 ? path.win32 : path;
  const base = pMod.resolve(stripWindowsDevicePrefix(cwd));
  const rawInput = p ?? '.';
  const normalizedInput = !win32 && rawInput.includes('\\') ? rawInput.replace(/\\/g, '/') : rawInput;
  const target = pMod.resolve(base, normalizedInput);
  if (!isWithinNormalized(base, target, win32)) {
    throw new FsError(400, 40001, `path 越出会话目录: ${p ?? ''}`);
  }
  return target;
}

/**
 * realpath 二次校验:symlink 目标也必须落在 cwd 内(词法校验拦不住
 * `cwd/evil -> /etc` 这种;审查实测 fsRead/fsList 曾跟随 symlink 读出沙箱)。
 * 路径不存在(如 diff 已删文件)时向上回溯到最近存在的祖先做 realpath 校验。
 */
export async function assertRealInCwd(cwd: string, abs: string): Promise<void> {
  const win32 = useWin32Paths(cwd, abs);
  const pMod = win32 ? path.win32 : path;
  const resolvedBase = pMod.resolve(stripWindowsDevicePrefix(cwd));
  const resolvedTarget = pMod.resolve(stripWindowsDevicePrefix(abs));
  const realBase = stripWindowsDevicePrefix(await fsp.realpath(resolvedBase).catch(() => resolvedBase));
  try {
    const realTarget = stripWindowsDevicePrefix(await fsp.realpath(resolvedTarget));
    if (!isWithinNormalized(realBase, realTarget, win32)) {
      throw new FsError(400, 40001, '路径经符号链接越出会话目录');
    }
    return;
  } catch (err) {
    if (err instanceof FsError) throw err;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP') {
      throw new FsError(400, 40001, '路径存在循环符号链接');
    }
    if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new FsError(400, 40001, `路径校验失败: ${(err as Error).message}`);
    }
  }
  let cursor = pMod.dirname(resolvedTarget);
  while (cursor && cursor !== pMod.dirname(cursor)) {
    if (!isWithinNormalized(resolvedBase, cursor, win32)) break;
    try {
      const realAncestor = stripWindowsDevicePrefix(await fsp.realpath(cursor));
      if (!isWithinNormalized(realBase, realAncestor, win32)) {
        throw new FsError(400, 40001, '路径经符号链接越出会话目录');
      }
      return;
    } catch (err) {
      if (err instanceof FsError) throw err;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP') {
        throw new FsError(400, 40001, '路径存在循环符号链接');
      }
      cursor = pMod.dirname(cursor);
    }
  }
}

/** 请求里的相对路径原样回给前端(前端按 cwd 相对路径展示);绝对路径转相对。 */
export function displayPath(cwd: string, abs: string): string {
  const win32 = useWin32Paths(cwd, abs);
  const pMod = win32 ? path.win32 : path;
  const base = pMod.resolve(stripWindowsDevicePrefix(cwd));
  const target = pMod.resolve(stripWindowsDevicePrefix(abs));
  if (normalizeForCompare(target, win32) === normalizeForCompare(base, win32)) return '.';
  const rel = pMod.relative(base, target);
  return rel === '' ? '.' : rel.split(/[\\/]/).join('/');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', '.next', 'target']);
const LIST_MAX_ENTRIES = 500;
const WALK_MAX_ENTRIES = 5000;
const READ_MAX_BYTES = 10 * 1024 * 1024; // 10MB,与前端 IMAGE_READ_MAX_BYTES 对齐(审查发现 1MB 会截断图片)
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

export interface BoundFileHandle {
  fh: fsp.FileHandle;
  stat: Stats;
  realPath: string;
}

export interface OpenBoundOptions {
  /** Test/verification hook invoked after preflight checks and before anchored open. */
  beforeAnchoredOpen?: () => void | Promise<void>;
}

const OPEN_BOUND_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const OPEN_DIR_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const HAS_PROC_SELF_FD = process.platform === 'linux' && existsSync('/proc/self/fd');
const MAX_SYMLINK_HOPS = 8;

function splitSafeSegments(rel: string, sep: string): string[] {
  if (!rel || rel === '.') return [];
  const parts = rel.split(sep).filter(Boolean);
  for (const seg of parts) {
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new FsError(400, 40001, `非法路径段: ${seg}`);
    }
  }
  return parts;
}

function mapOpenError(err: unknown, abs: string): never {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new FsError(404, 40404, `文件不存在: ${abs}`);
  }
  if (code === 'ELOOP' || code === 'ENXIO') {
    throw new FsError(400, 40001, `拒绝打开非受信任文件(${code}): ${abs}`);
  }
  if (code === 'EISDIR') {
    throw new FsError(400, 40003, `不是文件: ${abs}`);
  }
  throw new FsError(400, 40001, `打开文件失败: ${(err as Error).message}`);
}

function verifyStatMatch(opened: Stats, expected: Stats, abs: string): void {
  if (!opened.isFile()) {
    throw new FsError(400, 40003, `不是常规文件: ${abs}`);
  }
  const devMismatch = opened.dev !== expected.dev;
  const inoTestable = process.platform !== 'win32' || (opened.ino !== 0 && expected.ino !== 0);
  const inoMismatch = inoTestable && opened.ino !== expected.ino;
  if (devMismatch || inoMismatch) {
    throw new FsError(400, 40001, '文件在打开期间发生替换');
  }
}

async function openFileAtAnchoredDir(
  dirPathOrFd: string,
  displayAbs: string,
): Promise<{ fh: fsp.FileHandle; stat: Stats }> {
  const expectedLst = await fsp.lstat(dirPathOrFd).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FsError(404, 40404, `文件不存在: ${displayAbs}`);
    }
    throw new FsError(400, 40001, `无法访问文件: ${(err as Error).message}`);
  });
  if (expectedLst.isSymbolicLink()) {
    throw new FsError(400, 40001, '禁止打开符号链接');
  }
  if (!expectedLst.isFile()) {
    throw new FsError(400, 40003, `不是文件: ${displayAbs}`);
  }
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(dirPathOrFd, OPEN_BOUND_FLAGS);
  } catch (err) {
    mapOpenError(err, displayAbs);
  }
  try {
    const st = await fh.stat();
    verifyStatMatch(st, expectedLst, displayAbs);
    return { fh, stat: st };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

async function openAnchoredOnLinux(
  abs: string,
  cwd: string | undefined,
): Promise<BoundFileHandle> {
  if (cwd === undefined) {
    const resolvedTarget = path.resolve(abs);
    const parentDir = path.dirname(resolvedTarget);
    const baseName = path.basename(resolvedTarget);
    if (!baseName || baseName === '.' || baseName === '..') {
      throw new FsError(400, 40003, `不是文件: ${abs}`);
    }
    const realParent = await fsp.realpath(parentDir).catch((err: unknown) => mapOpenError(err, abs));
    const parentLst = await fsp.lstat(realParent).catch((err: unknown) => mapOpenError(err, abs));
    const parentFd = await fsp.open(realParent, OPEN_DIR_FLAGS).catch((err: unknown) => mapOpenError(err, abs));
    try {
      const pSt = await parentFd.stat();
      if (!pSt.isDirectory() || pSt.dev !== parentLst.dev || pSt.ino !== parentLst.ino) {
        throw new FsError(400, 40001, '父目录在打开期间发生变化');
      }
      const { fh, stat } = await openFileAtAnchoredDir(`/proc/self/fd/${parentFd.fd}/${baseName}`, abs);
      return { fh, stat, realPath: path.join(realParent, baseName) };
    } finally {
      await parentFd.close().catch(() => undefined);
    }
  }

  const resolvedBase = path.resolve(cwd);
  const resolvedTarget = path.resolve(abs);
  if (!isWithinNormalized(resolvedBase, resolvedTarget, false)) {
    throw new FsError(400, 40001, `path 越出会话目录: ${abs}`);
  }
  const realBase = await fsp.realpath(resolvedBase).catch((err: unknown) => mapOpenError(err, abs));
  const baseLst = await fsp.lstat(realBase).catch((err: unknown) => mapOpenError(err, abs));
  const baseFd = await fsp.open(realBase, OPEN_DIR_FLAGS).catch((err: unknown) => mapOpenError(err, abs));

  let curFd: fsp.FileHandle = baseFd;
  try {
    const baseSt = await baseFd.stat();
    if (!baseSt.isDirectory() || baseSt.dev !== baseLst.dev || baseSt.ino !== baseLst.ino) {
      throw new FsError(400, 40001, '会话根目录在打开期间发生变化');
    }

    let segments = splitSafeSegments(path.relative(resolvedBase, resolvedTarget), path.sep);
    if (segments.length === 0) {
      throw new FsError(400, 40003, `不是文件: ${abs}`);
    }

    let curRelParts: string[] = [];
    let hops = 0;

    const resolveIntraCwdSymlink = (linkTarget: string, tail: string[]): string[] => {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new FsError(400, 40001, '路径存在循环符号链接');
      }
      const curDirLogical = path.join(realBase, ...curRelParts);
      let nextPath: string;
      if (path.isAbsolute(linkTarget)) {
        if (isWithinNormalized(realBase, linkTarget, false)) {
          nextPath = path.resolve(linkTarget);
        } else if (isWithinNormalized(resolvedBase, linkTarget, false)) {
          nextPath = path.join(realBase, path.relative(resolvedBase, linkTarget));
        } else {
          throw new FsError(400, 40001, '路径经符号链接越出会话目录');
        }
      } else {
        nextPath = path.resolve(curDirLogical, linkTarget);
        if (!isWithinNormalized(realBase, nextPath, false)) {
          throw new FsError(400, 40001, '路径经符号链接越出会话目录');
        }
      }
      return [...splitSafeSegments(path.relative(realBase, nextPath), path.sep), ...tail];
    };

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      const isLast = i === segments.length - 1;
      const anchoredPath = `/proc/self/fd/${curFd.fd}/${seg}`;

      if (!isLast) {
        let nextFd: fsp.FileHandle;
        try {
          nextFd = await fsp.open(anchoredPath, OPEN_DIR_FLAGS);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'ENOENT') {
            throw new FsError(404, 40404, `文件不存在: ${abs}`);
          }
          if (code === 'ELOOP' || code === 'ENOTDIR') {
            const linkTarget = await fsp.readlink(anchoredPath).catch(() => null);
            if (linkTarget === null) {
              if (code === 'ENOTDIR') {
                throw new FsError(400, 40003, `路径中间段不是目录: ${abs}`);
              }
              throw new FsError(400, 40001, `目录打开失败: ${abs}`);
            }
            segments = resolveIntraCwdSymlink(linkTarget, segments.slice(i + 1));
            if (curFd !== baseFd) await curFd.close().catch(() => undefined);
            curFd = baseFd;
            curRelParts = [];
            i = -1;
            continue;
          }
          mapOpenError(err, abs);
        }
        if (curFd !== baseFd) await curFd.close().catch(() => undefined);
        curFd = nextFd;
        curRelParts.push(seg);
        continue;
      }

      const preLst = await fsp.lstat(anchoredPath).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new FsError(404, 40404, `文件不存在: ${abs}`);
        }
        throw new FsError(400, 40001, `无法访问文件: ${(err as Error).message}`);
      });

      if (preLst.isSymbolicLink()) {
        const linkTarget = await fsp.readlink(anchoredPath).catch(() => null);
        if (linkTarget === null) {
          throw new FsError(400, 40001, '符号链接在读取期间发生变化');
        }
        segments = resolveIntraCwdSymlink(linkTarget, []);
        if (segments.length === 0) {
          throw new FsError(400, 40003, `不是文件: ${abs}`);
        }
        if (curFd !== baseFd) await curFd.close().catch(() => undefined);
        curFd = baseFd;
        curRelParts = [];
        i = -1;
        continue;
      }

      if (!preLst.isFile()) {
        throw new FsError(400, 40003, `不是文件: ${abs}`);
      }

      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(anchoredPath, OPEN_BOUND_FLAGS);
      } catch (err) {
        mapOpenError(err, abs);
      }
      try {
        const st = await fh.stat();
        verifyStatMatch(st, preLst, abs);
        return { fh, stat: st, realPath: path.join(realBase, ...curRelParts, seg) };
      } catch (err) {
        await fh.close().catch(() => undefined);
        throw err;
      }
    }

    throw new FsError(400, 40003, `不是文件: ${abs}`);
  } finally {
    if (curFd !== baseFd) await curFd.close().catch(() => undefined);
    await baseFd.close().catch(() => undefined);
  }
}

/**
 * TOCTOU-safe bounded file opener:
 * - On Linux (/proc/self/fd), anchors traversal from an O_DIRECTORY | O_NOFOLLOW
 *   handle on the verified base directory and walks segment-by-segment with
 *   O_NOFOLLOW so parent-directory symlink swaps cannot escape the sandbox.
 * - Uses O_RDONLY | O_NONBLOCK | O_NOFOLLOW plus post-open fstat verification
 *   of regular-file type and dev/ino identity.
 */
export async function openBound(
  abs: string,
  cwd?: string,
  options?: OpenBoundOptions,
): Promise<BoundFileHandle> {
  if (cwd !== undefined) {
    await assertRealInCwd(cwd, abs);
  }
  if (options?.beforeAnchoredOpen) {
    await options.beforeAnchoredOpen();
  }
  const win32 = cwd !== undefined ? useWin32Paths(cwd, abs) : isWindowsPath(abs);
  if (HAS_PROC_SELF_FD && !win32) {
    return openAnchoredOnLinux(abs, cwd);
  }

  const initialLst = await fsp.lstat(abs).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FsError(404, 40404, `文件不存在: ${abs}`);
    }
    throw new FsError(400, 40001, `无法访问文件: ${(err as Error).message}`);
  });

  let target = abs;
  let expectedLst = initialLst;
  if (initialLst.isSymbolicLink()) {
    if (cwd === undefined) {
      throw new FsError(400, 40001, '禁止打开符号链接');
    }
    const pMod = win32 ? path.win32 : path;
    const realBase = stripWindowsDevicePrefix(
      await fsp.realpath(pMod.resolve(stripWindowsDevicePrefix(cwd))).catch(() => pMod.resolve(stripWindowsDevicePrefix(cwd))),
    );
    const resolved = await fsp.realpath(abs).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new FsError(404, 40404, `文件不存在: ${abs}`);
      }
      throw new FsError(400, 40001, '路径经符号链接越出会话目录');
    });
    const cleanedResolved = stripWindowsDevicePrefix(resolved);
    if (!isWithinNormalized(realBase, cleanedResolved, win32)) {
      throw new FsError(400, 40001, '路径经符号链接越出会话目录');
    }
    target = cleanedResolved;
    expectedLst = await fsp.lstat(target).catch(() => {
      throw new FsError(404, 40404, `文件不存在: ${abs}`);
    });
    if (expectedLst.isSymbolicLink()) {
      throw new FsError(400, 40001, '禁止打开未解析符号链接');
    }
  }

  if (!expectedLst.isFile()) {
    throw new FsError(400, 40003, `不是文件: ${abs}`);
  }

  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(target, OPEN_BOUND_FLAGS);
  } catch (err) {
    mapOpenError(err, abs);
  }

  try {
    const st = await fh.stat();
    verifyStatMatch(st, expectedLst, abs);
    return { fh, stat: st, realPath: target };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

/** 读前 8KB 判 NUL 字节,有则视为二进制。 */
async function isBinaryFile(abs: string, cwd?: string): Promise<boolean> {
  const { fh } = await openBound(abs, cwd);
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
    // 安全:不再把指向目录的 symlink 升级成 'directory'——否则 BFS 会跟进
    // 链接目录,resolveInCwd 的词法校验被绕过(审查实测逃逸)。symlink 保持
    // 'symlink' 展示,不展开、不计 child_count。
  }
  if (wire.kind === 'file') {
    wire.size = st.size;
    wire.etag = etagOf(st.size, st.mtimeMs);
    wire.mime = mimeOf(name);
    const lang = LANG_BY_EXT[extOf(name)];
    if (lang) wire.language_id = lang;
    // 只对可疑类型判二进制(已知文本类型跳过 I/O)。
    if (!lang && wire.mime === 'application/octet-stream') {
      wire.is_binary = await isBinaryFile(abs, cwd).catch(() => false);
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
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.length < 4) continue;
    if (e.startsWith('##')) continue; // --branch 的头部行,不是文件条目。
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    map.set(p, xy.trim() || '??');
    // rename/copy 在 -z 下是 "XY new\0old\0" 两段:下一个裸段是旧路径,
    // 必须跳过——否则被当成独立条目解析出乱码(审查实测 map['txt']='a.')。
    if (xy.includes('R') || xy.includes('C')) i += 1;
  }
  return map;
}

/** cwd 在 repo 内的相对前缀(如 'sub/');非仓库或就在仓库根回 ''。 */
async function repoPrefix(cwd: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--show-prefix']).catch(() => '')).trim();
}

/** porcelain/numstat 路径是 repo-root 相对;换算成 cwd 相对(entryWire/前端
 *  都按 cwd 相对路径查状态)。cwd 外的条目保留 repo-root 路径,不碍匹配。 */
function toCwdRelative(prefix: string, p: string): string {
  return prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
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
    const [out, prefix] = await Promise.all([
      runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      repoPrefix(cwd),
    ]);
    const raw = parsePorcelain(out);
    if (!prefix) return raw;
    const map = new Map<string, string>();
    for (const [k, v] of raw) map.set(toCwdRelative(prefix, k), v);
    return map;
  } catch {
    return null; // 非 git 仓库:不带状态,不报错。
  }
}

export async function fsList(
  cwd: string,
  input: { path?: string; depth?: number; include_git_status?: boolean },
): Promise<{ items: FsEntryWire[]; children_by_path?: Record<string, FsEntryWire[]>; truncated: boolean }> {
  const abs = resolveInCwd(cwd, input.path);
  await assertRealInCwd(cwd, abs);
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
  const { fh, stat: st } = await openBound(abs, cwd);

  const offset = Math.max(0, input.offset ?? 0);
  const length = Math.max(1, Math.min(READ_MAX_BYTES, input.length ?? READ_MAX_BYTES));
  const size = st.size;
  let buf: Buffer;
  try {
    const readLen = Math.min(length, Math.max(0, size - offset));
    buf = Buffer.alloc(readLen);
    if (readLen > 0) {
      const { bytesRead } = await fh.read(buf, 0, readLen, offset);
      buf = buf.subarray(0, bytesRead);
    }
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
      // 行内也查预算:灾难性回溯不能等到扫完整个文件才停。
      if (Date.now() - started > GREP_TIME_BUDGET_MS) {
        truncated = true;
        break;
      }
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
  const statusOut = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--branch']).catch(() => '');
  // 非 git 仓库:如实回空状态而不是报错(前端文件树在非 git 目录也要能用)。
  if (!statusOut) {
    return { branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
  }
  const header = statusOut.split('\0')[0] ?? '';
  // branch:rev-parse 在 unborn HEAD(仓库无提交)会失败,从 ## 头兜底;
  // unborn 时 status 本身可用,不能因此回全空(审查发现)。
  let branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (!branch || branch === 'HEAD') {
    const m = /^## (?:No commits yet on )?(\S+)/.exec(header);
    branch = m?.[1] ?? '';
  }
  const prefix = await repoPrefix(cwd);
  const map = parsePorcelain(statusOut);
  const entries: Record<string, string> = {};
  for (const [k, v] of map) entries[toCwdRelative(prefix, k)] = v;
  // ahead/behind:## branch...origin/branch [ahead N, behind M]
  let ahead = 0;
  let behind = 0;
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
  const { fh, stat: st } = await openBound(abs, cwd);
  try {
    // 大文件上限:未跟踪文件要整读拼 diff,无 cap 会把 GB 级文件读进内存(审查发现)。
    if (st.size > READ_MAX_BYTES) {
      return { path: rel, diff: `# 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),超过 ${READ_MAX_BYTES / 1024 / 1024}MB 上限,不生成 diff\n` };
    }
    const buf = await fh.readFile();
    if (buf.includes(0)) return { path: rel, diff: `Binary file ${rel} (untracked)\n` };
    const lines = buf.toString('utf8').split('\n');
    const body = lines.map((l) => `+${l}`).join('\n');
    return {
      path: rel,
      diff: `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
    };
  } finally {
    await fh.close();
  }
}
