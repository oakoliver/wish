/**
 * scp serves `scp` uploads and downloads, as wish/scp. It speaks the classic
 * SCP protocol (`scp -O`, or any client whose server side runs `scp -t` /
 * `scp -f`); OpenSSH 9+ defaults to SFTP, which this middleware does not
 * implement.
 */

import { createReadStream, constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, utimes } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import type { Session } from './session.js';
import { Fatal, type Middleware as WishMiddleware } from './wish.js';

// ─── Handlers ───────────────────────────────────────────────────────────────

/** A directory entry as WalkDir reports it, as fs.DirEntry. */
export interface DirEntryInfo {
  name: string;
  isDir(): boolean;
}

/** Returned by a WalkDirFunc to skip a directory, as fs.SkipDir. */
export const SkipDir = Symbol('SkipDir');
/** Called for each file and directory, as fs.WalkDirFunc. */
export type WalkDirFunc = (path: string, d: DirEntryInfo | null, err: Error | null) => Promise<void | typeof SkipDir> | void | typeof SkipDir;

/** Handles copies from the server to the client (`scp -f`), as scp.CopyToClientHandler. */
export interface CopyToClientHandler {
  /**
   * Expands a pattern on the server. Return `[pattern]` to disable globbing.
   * Return relative paths if the other methods expect them.
   */
  glob(s: Session | null, pattern: string): Promise<string[]>;
  /** Walks a tree, for recursive copies. */
  walkDir(s: Session | null, path: string, fn: WalkDirFunc): Promise<void>;
  newDirEntry(s: Session | null, path: string): Promise<DirEntry>;
  /** Returns the entry and an optional function that releases it. */
  newFileEntry(s: Session | null, path: string): Promise<[FileEntry, (() => void | Promise<void>) | null]>;
}

/** Handles copies from the client to the server (`scp -t`), as scp.CopyFromClientHandler. */
export interface CopyFromClientHandler {
  /** Creates one directory (usually not recursively). */
  mkdir(s: Session | null, entry: DirEntry): Promise<void>;
  /** Writes a file and resolves with the number of bytes written. */
  write(s: Session | null, entry: FileEntry): Promise<number>;
}

/** Handles both directions, as scp.Handler. */
export interface Handler extends CopyToClientHandler, CopyFromClientHandler {}

/**
 * Middleware serves SCP with the given handlers, as scp.Middleware. Either
 * may be null to refuse that direction. Other sessions go to the next handler.
 */
export function Middleware(rh: CopyToClientHandler | null, wh: CopyFromClientHandler | null): WishMiddleware {
  return (next) => async (s) => {
    const info = GetInfo(s.command());
    if (!info.ok) return next(s);
    try {
      switch (info.op) {
        case OpCopyToClient:
          if (!rh) throw new Error('no handler provided for scp -f');
          await copyToClient(s, info, rh);
          break;
        case OpCopyFromClient:
          if (!wh) throw new Error('no handler provided for scp -t');
          await copyFromClient(s, info, wh);
          break;
      }
    } catch (err) {
      await Fatal(s, err);
    }
  };
}

// ─── Entries ────────────────────────────────────────────────────────────────

/** A single NUL byte, as scp.NULL. */
export const NULL = Buffer.from([0]);

function writeAll(w: Writable, data: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (w.write(data)) resolve();
    else w.once('drain', () => resolve());
  });
}

function octalPerms(mode: number): string {
  return '0' + (mode & 0o777).toString(8);
}

/** Something that writes itself in SCP format, as scp.Entry. */
export interface Entry {
  readonly filepath: string;
  write(w: Writable): Promise<void>;
}

/** A file and its contents, as scp.FileEntry. */
export class FileEntry implements Entry {
  name = '';
  filepath = '';
  mode = 0;
  size = 0;
  reader: Readable | null = null;
  atime = 0;
  mtime = 0;

  constructor(init: Partial<FileEntry> = {}) {
    Object.assign(this, init);
  }

  async write(w: Writable): Promise<void> {
    if (this.mtime > 0 && this.atime > 0) await writeAll(w, `T${this.mtime} 0 ${this.atime} 0\n`);
    await writeAll(w, `C${octalPerms(this.mode)} ${this.size} ${this.name}\n`);
    if (this.reader) {
      for await (const chunk of this.reader) await writeAll(w, chunk as Buffer);
    }
    await writeAll(w, NULL);
  }
}

/** A directory and its children, as scp.DirEntry. */
export class DirEntry implements Entry {
  children: Entry[] = [];
  name = '';
  filepath = '';
  mode = 0;
  atime = 0;
  mtime = 0;

  constructor(init: Partial<DirEntry> = {}) {
    Object.assign(this, init);
  }

  async write(w: Writable): Promise<void> {
    if (this.mtime > 0 && this.atime > 0) await writeAll(w, `T${this.mtime} 0 ${this.atime} 0\n`);
    await writeAll(w, `D${octalPerms(this.mode)} 0 ${this.name}\n`);
    for (const child of this.children) await child.write(w);
    await writeAll(w, 'E\n');
  }

  /** Adds an entry to the first child directory that contains it, or here. */
  append(entry: Entry): void {
    appendEntry(this.children, entry);
  }
}

/** The root of a copy: only children, as scp.RootEntry. */
export class RootEntry {
  readonly children: Entry[] = [];

  append(entry: Entry): void {
    appendEntry(this.children, entry);
  }

  async write(w: Writable): Promise<void> {
    for (const child of this.children) await child.write(w);
  }
}

function appendEntry(children: Entry[], entry: Entry): void {
  const parent = normalizePath(dirname(entry.filepath));
  for (const child of children) {
    if (child instanceof DirEntry && isWithin(normalizePath(child.filepath), parent)) {
      child.append(entry);
      return;
    }
  }
  children.push(entry);
}

/**
 * Reports whether the normalized path `p` is `dir` or below it, comparing
 * whole path components.
 * @internal exported for tests
 */
export function isWithin(dir: string, p: string): boolean {
  if (dir === '.') return p !== '..' && !p.startsWith('../') && !isAbsolute(p);
  return p === dir || p.startsWith(dir.replace(/\/$/, '') + '/');
}

/** filepath.Clean for slash paths. */
function normalizePath(p: string): string {
  if (p === '') return '.';
  const n = posix.normalize(p.replaceAll('\\', '/'));
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/**
 * Rejects names that are empty, `.`, `..` or contain a separator.
 * @internal exported for tests
 */
export function validateName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(`invalid filename: ${JSON.stringify(name)}`);
  }
}

// ─── Info ───────────────────────────────────────────────────────────────────

/** The direction of an SCP operation, as scp.Op. */
export type Op = 'f' | 't';
/** Server to client (`scp -f`). */
export const OpCopyToClient: Op = 'f';
/** Client to server (`scp -t`). */
export const OpCopyFromClient: Op = 't';

/** What a session's command asks for, as scp.Info. */
export interface Info {
  ok: boolean;
  recursive: boolean;
  path: string;
  op: Op | '';
}

/** Parses an `scp` command line, as scp.GetInfo. */
export function GetInfo(cmd: string[]): Info {
  const info: Info = { ok: false, recursive: false, path: '', op: '' };
  if (cmd.length === 0 || cmd[0] !== 'scp') return info;
  for (let i = 0; i < cmd.length; i++) {
    switch (cmd[i]) {
      case '-r':
        info.recursive = true;
        break;
      case '-f':
        if (i + 1 >= cmd.length) return info;
        info.op = OpCopyToClient;
        info.path = cmd[i + 1];
        break;
      case '-t':
        if (i + 1 >= cmd.length) return info;
        info.op = OpCopyFromClient;
        info.path = cmd[i + 1];
        break;
    }
  }
  info.ok = true;
  return info;
}

// ─── Copy to client ─────────────────────────────────────────────────────────

async function copyToClient(s: Session, info: Info, handler: CopyToClientHandler): Promise<void> {
  const matches = await handler.glob(s, info.path);
  if (matches.length === 0) throw new Error(`no files matching ${JSON.stringify(info.path)}`);
  const root = new RootEntry();
  const closers: Array<() => void | Promise<void>> = [];
  try {
    for (const match of matches) {
      if (!info.recursive) {
        const [entry, closer] = await handler.newFileEntry(s, match);
        if (closer) closers.push(closer);
        root.append(entry);
        continue;
      }
      await handler.walkDir(s, match, async (path, d, err) => {
        if (err) throw err;
        if (d!.isDir()) {
          root.append(await handler.newDirEntry(s, path));
        } else {
          const [entry, closer] = await handler.newFileEntry(s, path);
          if (closer) closers.push(closer);
          root.append(entry);
        }
      });
    }
    await root.write(s);
  } finally {
    for (const closer of closers) await closer();
  }
}

// ─── Copy from client ───────────────────────────────────────────────────────

const reTimestamp = /^T(\d{10}) 0 (\d{10}) 0$/;
const reNewFolder = /^D(\d{4}) 0 (.*)$/;
const reNewFile = /^C(\d{4}) (\d+) (.*)$/;

/** Reads lines and byte runs from a stream, holding at most ~1 MiB. */
class StreamReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(private readonly src: Readable) {
    src.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      if (this.length > 1 << 20) src.pause();
      this.notify();
    });
    src.on('end', () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    this.src.resume();
    await new Promise<void>((resolve) => (this.wake = resolve));
    return true;
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** Resolves with a line without its "\n", or null at EOF (a partial line is dropped). */
  async readLine(): Promise<string | null> {
    for (;;) {
      if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
      const all = this.chunks[0] ?? Buffer.alloc(0);
      const i = all.indexOf(0x0a);
      if (i >= 0) return this.take(i + 1).subarray(0, i).toString('utf8');
      if (!(await this.more())) return null;
    }
  }

  /** Resolves with up to `max` bytes, or null at EOF. */
  async read(max: number): Promise<Buffer | null> {
    while (this.length === 0) {
      if (!(await this.more())) return null;
    }
    return this.take(Math.min(max, this.length));
  }
}

/** A Readable of at most `limit` bytes from the reader, as scp's limitReader. */
function limitReader(r: StreamReader, limit: number): Readable {
  let left = limit;
  return Readable.from(
    (async function* () {
      while (left > 0) {
        const chunk = await r.read(Math.min(left, 64 * 1024));
        if (!chunk) return;
        left -= chunk.length;
        yield chunk;
      }
    })(),
  );
}

class ParseError extends Error {
  constructor(subject: string) {
    super(`failed to parse: ${JSON.stringify(subject)}`);
  }
}

async function copyFromClient(s: Session, info: Info, handler: CopyFromClientHandler): Promise<void> {
  // Accept the request.
  s.write(NULL);
  let path = info.path;
  const r = new StreamReader(s);
  let mtime = 0;
  let atime = 0;

  for (;;) {
    const line = await r.readLine();
    if (line === null) break;

    let m = reTimestamp.exec(line);
    if (m) {
      mtime = Number(m[1]);
      atime = Number(m[2]);
      s.write(NULL);
      continue;
    }

    m = reNewFile.exec(line);
    if (m) {
      const mode = parseInt(m[1], 8);
      const size = Number(m[2]);
      if (!Number.isSafeInteger(size)) throw new ParseError(line);
      const name = m[3];
      validateName(name);
      s.write(NULL);
      let written: number;
      try {
        written = await handler.write(
          s,
          new FileEntry({ name, filepath: join(path, name), mode, size, mtime, atime, reader: limitReader(r, size) }),
        );
      } catch (err) {
        throw new Error(`failed to write file: ${JSON.stringify(name)}: ${(err as Error).message}`);
      }
      if (written !== size) {
        throw new Error(`failed to write the file: ${JSON.stringify(name)}: written ${written} out of ${size} bytes`);
      }
      // The trailing NUL.
      await r.read(1);
      s.write(NULL);
      mtime = 0;
      atime = 0;
      continue;
    }

    m = reNewFolder.exec(line);
    if (m) {
      const mode = parseInt(m[1], 8);
      const name = m[2];
      validateName(name);
      path = join(path, name);
      try {
        await handler.mkdir(s, new DirEntry({ name, filepath: path, mode, mtime, atime }));
      } catch (err) {
        throw new Error(`failed to create dir: ${JSON.stringify(name)}: ${(err as Error).message}`);
      }
      mtime = 0;
      atime = 0;
      s.write(NULL);
      continue;
    }

    if (line === 'E') {
      path = dirname(path);
      s.write(NULL);
      continue;
    }

    throw new Error(`unhandled input: ${JSON.stringify(line)}`);
  }
  s.write(NULL);
}

// ─── Glob and Match (Go's path.Match and filepath.Glob) ─────────────────────

/** A pattern is malformed, as path.ErrBadPattern. */
export const ErrBadPattern = new Error('syntax error in pattern');

function scanChunk(pattern: string): [boolean, string, string] {
  let star = false;
  while (pattern.length > 0 && pattern[0] === '*') {
    pattern = pattern.slice(1);
    star = true;
  }
  let inrange = false;
  let i = 0;
  scan: for (; i < pattern.length; i++) {
    switch (pattern[i]) {
      case '\\':
        if (i + 1 < pattern.length) i++;
        break;
      case '[':
        inrange = true;
        break;
      case ']':
        inrange = false;
        break;
      case '*':
        if (!inrange) break scan;
        break;
    }
  }
  return [star, pattern.slice(0, i), pattern.slice(i)];
}

function getEsc(chunk: string): [string, string] {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') throw ErrBadPattern;
  if (chunk[0] === '\\') {
    chunk = chunk.slice(1);
    if (chunk.length === 0) throw ErrBadPattern;
  }
  const r = String.fromCodePoint(chunk.codePointAt(0)!);
  const rest = chunk.slice(r.length);
  if (rest.length === 0) throw ErrBadPattern;
  return [r, rest];
}

function matchChunk(chunk: string, s: string): [string, boolean] {
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;
    switch (chunk[0]) {
      case '[': {
        let r = '';
        if (!failed) {
          r = String.fromCodePoint(s.codePointAt(0)!);
          s = s.slice(r.length);
        }
        chunk = chunk.slice(1);
        let negated = false;
        if (chunk.length > 0 && chunk[0] === '^') {
          negated = true;
          chunk = chunk.slice(1);
        }
        let match = false;
        let nrange = 0;
        for (;;) {
          if (chunk.length > 0 && chunk[0] === ']' && nrange > 0) {
            chunk = chunk.slice(1);
            break;
          }
          let lo: string;
          [lo, chunk] = getEsc(chunk);
          let hi = lo;
          if (chunk[0] === '-') [hi, chunk] = getEsc(chunk.slice(1));
          const cp = r === '' ? -1 : r.codePointAt(0)!;
          if (lo.codePointAt(0)! <= cp && cp <= hi.codePointAt(0)!) match = true;
          nrange++;
        }
        if (match === negated) failed = true;
        break;
      }
      case '?':
        if (!failed) {
          if (s[0] === '/') failed = true;
          s = s.slice(String.fromCodePoint(s.codePointAt(0)!).length);
        }
        chunk = chunk.slice(1);
        break;
      case '\\':
        chunk = chunk.slice(1);
        if (chunk.length === 0) throw ErrBadPattern;
      // falls through
      default:
        if (!failed) {
          if (chunk[0] !== s[0]) failed = true;
          s = s.slice(1);
        }
        chunk = chunk.slice(1);
    }
  }
  if (failed) return ['', false];
  return [s, true];
}

/** Reports whether `name` matches the shell pattern, as path.Match. Throws ErrBadPattern. */
export function Match(pattern: string, name: string): boolean {
  outer: while (pattern.length > 0) {
    let star: boolean;
    let chunk: string;
    [star, chunk, pattern] = scanChunk(pattern);
    if (star && chunk === '') return !name.includes('/');
    const [t, ok] = matchChunk(chunk, name);
    if (ok && (t.length === 0 || pattern.length > 0)) {
      name = t;
      continue;
    }
    if (star) {
      for (let i = 0; i < name.length && name[i] !== '/'; i++) {
        const [t2, ok2] = matchChunk(chunk, name.slice(i + 1));
        if (ok2) {
          if (pattern.length === 0 && t2.length > 0) continue;
          name = t2;
          continue outer;
        }
      }
    }
    while (pattern.length > 0) {
      [, chunk, pattern] = scanChunk(pattern);
      matchChunk(chunk, '');
    }
    return false;
  }
  return name.length === 0;
}

function hasMeta(p: string): boolean {
  return /[*?[\\]/.test(p);
}

interface GlobFS {
  exists(p: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
  names(p: string): Promise<string[]>;
  join(a: string, b: string): string;
  split(p: string): [string, string];
  sep: string;
}

async function globWith(fsys: GlobFS, pattern: string): Promise<string[]> {
  Match(pattern, '');
  if (!hasMeta(pattern)) return (await fsys.exists(pattern)) ? [pattern] : [];
  let [dir, file] = fsys.split(pattern);
  dir = dir === '' ? '.' : dir === fsys.sep ? dir : dir.slice(0, -1);
  const globDir = async (d: string, out: string[]) => {
    if (!(await fsys.isDir(d))) return;
    const names = (await fsys.names(d)).sort();
    for (const n of names) if (Match(file, n)) out.push(fsys.join(d, n));
  };
  const out: string[] = [];
  if (!hasMeta(dir)) {
    await globDir(dir, out);
    return out;
  }
  if (dir === pattern) throw ErrBadPattern;
  for (const d of await globWith(fsys, dir)) await globDir(d, out);
  return out;
}

const osGlobFS: GlobFS = {
  exists: async (p) => !!(await lstat(p).catch(() => null)),
  isDir: async (p) => !!(await stat(p).catch(() => null))?.isDirectory(),
  names: async (p) => readdir(p).catch(() => []),
  join: (a, b) => join(a, b),
  split: (p) => {
    const i = p.lastIndexOf(sep);
    return [p.slice(0, i + 1), p.slice(i + 1)];
  },
  sep,
};

/** Expands a pattern on the local filesystem, as filepath.Glob. */
export function Glob(pattern: string): Promise<string[]> {
  return globWith(osGlobFS, pattern);
}

// ─── fs.FS ──────────────────────────────────────────────────────────────────

/** File metadata, as fs.FileInfo. `mode` holds the permission bits. */
export interface FileInfo {
  name: string;
  size: number;
  mode: number;
  modTime: Date;
  isDir(): boolean;
}

/**
 * A read-only file system, as Go's io/fs.FS. Paths are slash-separated,
 * unrooted and clean (`a/b.txt`, `.`), as fs.ValidPath requires.
 */
export interface FS {
  stat(path: string): Promise<FileInfo>;
  open(path: string): Promise<Readable>;
  readDir(path: string): Promise<DirEntryInfo[]>;
}

/** Reports whether a path is valid for an FS, as fs.ValidPath. */
export function ValidPath(name: string): boolean {
  if (name === '.') return true;
  if (name === '' || name.startsWith('/') || name.endsWith('/')) return false;
  return name.split('/').every((el) => el !== '' && el !== '.' && el !== '..');
}

function fileInfo(name: string, st: Stats): FileInfo {
  return { name, size: st.size, mode: st.mode & 0o777, modTime: st.mtime, isDir: () => st.isDirectory() };
}

/**
 * DirFS returns an FS for the tree at `dir`, as os.DirFS. Like os.DirFS it
 * follows symlinks, so it confines `..` but not links that point outside.
 */
export function DirFS(dir: string): FS {
  const full = (name: string, op: string) => {
    if (!ValidPath(name)) throw new Error(`${op} ${name}: invalid argument`);
    return name === '.' ? dir : join(dir, ...name.split('/'));
  };
  return {
    async stat(name) {
      const st = await stat(full(name, 'stat'));
      return fileInfo(name === '.' ? '.' : posix.basename(name), st);
    },
    async open(name) {
      const p = full(name, 'open');
      await stat(p);
      return createReadStream(p);
    },
    async readDir(name) {
      const entries = await readdir(full(name, 'readdir'), { withFileTypes: true });
      return entries
        .map((e) => ({ name: e.name, isDir: () => e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}

async function walkFS(fsys: FS, root: string, fn: WalkDirFunc): Promise<void> {
  let info: FileInfo;
  try {
    info = await fsys.stat(root);
  } catch (err) {
    await fn(root, null, err as Error);
    return;
  }
  const d: DirEntryInfo = { name: info.name, isDir: () => info.isDir() };
  const walk = async (path: string, entry: DirEntryInfo): Promise<void | typeof SkipDir> => {
    const res = await fn(path, entry, null);
    if (res === SkipDir || !entry.isDir()) return res === SkipDir && !entry.isDir() ? SkipDir : undefined;
    let children: DirEntryInfo[];
    try {
      children = await fsys.readDir(path);
    } catch (err) {
      const r2 = await fn(path, entry, err as Error);
      return r2 === SkipDir ? undefined : r2;
    }
    for (const child of children) {
      const r3 = await walk(path === '.' ? child.name : `${path}/${child.name}`, child);
      if (r3 === SkipDir) break;
    }
  };
  await walk(root, d);
}

class FSHandler implements CopyToClientHandler {
  constructor(private readonly fsys: FS) {}

  glob(_s: Session | null, pattern: string): Promise<string[]> {
    const fsys = this.fsys;
    return globWith(
      {
        exists: async (p) => !!(await fsys.stat(p).catch(() => null)),
        isDir: async (p) => !!(await fsys.stat(p).catch(() => null))?.isDir(),
        names: async (p) => (await fsys.readDir(p).catch(() => [])).map((e) => e.name),
        join: (a, b) => (a === '.' ? b : posix.join(a, b)),
        split: (p) => {
          const i = p.lastIndexOf('/');
          return [p.slice(0, i + 1), p.slice(i + 1)];
        },
        sep: '/',
      },
      pattern,
    );
  }

  walkDir(_s: Session | null, path: string, fn: WalkDirFunc): Promise<void> {
    return walkFS(this.fsys, path, fn);
  }

  async newDirEntry(_s: Session | null, path: string): Promise<DirEntry> {
    const p = normalizePath(path);
    let info: FileInfo;
    try {
      info = await this.fsys.stat(p);
    } catch (err) {
      throw new Error(`failed to open dir: ${JSON.stringify(p)}: ${(err as Error).message}`);
    }
    const t = Math.floor(info.modTime.getTime() / 1000);
    return new DirEntry({ children: [], name: info.name, filepath: p, mode: info.mode, mtime: t, atime: t });
  }

  async newFileEntry(_s: Session | null, path: string): Promise<[FileEntry, () => void]> {
    let info: FileInfo;
    try {
      info = await this.fsys.stat(path);
    } catch (err) {
      throw new Error(`failed to stat ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
    let reader: Readable;
    try {
      reader = await this.fsys.open(path);
    } catch (err) {
      throw new Error(`failed to open ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
    const t = Math.floor(info.modTime.getTime() / 1000);
    return [
      new FileEntry({ name: info.name, filepath: path, mode: info.mode, size: info.size, mtime: t, atime: t, reader }),
      () => {
        reader.destroy();
      },
    ];
  }
}

/** A read-only CopyToClientHandler over any FS, as scp.NewFSReadHandler. */
export function NewFSReadHandler(fsys: FS): CopyToClientHandler {
  return new FSHandler(fsys);
}

// ─── Filesystem handler ─────────────────────────────────────────────────────

/** @internal exported for tests */
export class FileSystemHandler implements Handler {
  readonly root: string;

  constructor(root: string) {
    this.root = normalizeOS(root);
  }

  /** @internal */
  async chtimes(path: string, mtime: number, atime: number): Promise<void> {
    if (mtime === 0 || atime === 0) return;
    const p = await this.prefixed(path);
    try {
      await utimes(p, atime, mtime);
    } catch (err) {
      throw new Error(`failed to chtimes: ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
  }

  /**
   * Maps a client path into the root and checks, with symlinks resolved,
   * that it stays there.
   * @internal
   */
  async prefixed(path: string): Promise<string> {
    const clean = normalizeOS(path);
    let joined = clean;
    if (clean !== this.root && !clean.startsWith(this.root + sep)) {
      const safe = normalizeOS('/' + path);
      joined = normalizeOS(join(this.root, safe));
      if (joined !== this.root && !joined.startsWith(this.root + sep)) {
        throw new Error(`path traversal detected: ${JSON.stringify(path)} resolves outside root`);
      }
    }
    await this.confined(joined);
    return joined;
  }

  private async confined(path: string): Promise<void> {
    let root: string;
    try {
      root = await realpath(this.root);
    } catch (err) {
      throw new Error(`failed to resolve root ${JSON.stringify(this.root)}: ${(err as Error).message}`);
    }
    for (let cur = path; ; ) {
      try {
        const resolved = await realpath(cur);
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          throw new Error(`path traversal detected: ${JSON.stringify(path)} resolves outside root`);
        }
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined) throw err;
        if (code === 'EACCES' || code === 'EPERM') {
          throw new Error(`failed to resolve ${JSON.stringify(path)}: ${(err as Error).message}`);
        }
      }
      const parent = dirname(cur);
      if (parent === cur) throw new Error(`path traversal detected: ${JSON.stringify(path)} resolves outside root`);
      cur = parent;
    }
  }

  async glob(_s: Session | null, pattern: string): Promise<string[]> {
    const p = await this.prefixed(pattern);
    const matches = await Glob(p);
    const safe: string[] = [];
    for (const match of matches) {
      if (match !== this.root && !match.startsWith(this.root + sep)) continue;
      safe.push(relative(this.root, match) || '.');
    }
    return safe;
  }

  async walkDir(_s: Session | null, path: string, fn: WalkDirFunc): Promise<void> {
    const p = await this.prefixed(path);
    const walk = async (cur: string, d: DirEntryInfo): Promise<void | typeof SkipDir> => {
      // When root is ./foo/bar, serve the contents of bar, not bar itself.
      const res = cur === this.root ? undefined : await fn(cur, d, null);
      if (res === SkipDir) return d.isDir() ? undefined : SkipDir;
      if (!d.isDir()) return;
      let entries;
      try {
        entries = await readdir(cur, { withFileTypes: true });
      } catch (err) {
        if (cur !== this.root) await fn(cur, d, err as Error);
        else throw err;
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const r = await walk(join(cur, e.name), { name: e.name, isDir: () => e.isDirectory() });
        if (r === SkipDir) break;
      }
    };
    let st: Stats;
    try {
      st = await lstat(p);
    } catch (err) {
      if (p === this.root) throw err;
      await fn(p, null, err as Error);
      return;
    }
    await walk(p, { name: posix.basename(p), isDir: () => st.isDirectory() });
  }

  async newDirEntry(_s: Session | null, name: string): Promise<DirEntry> {
    const path = await this.prefixed(name);
    let st: Stats;
    try {
      st = await stat(path);
    } catch (err) {
      throw new Error(`failed to open dir: ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
    const t = Math.floor(st.mtimeMs / 1000);
    return new DirEntry({ children: [], name: baseName(path), filepath: path, mode: st.mode & 0o777, mtime: t, atime: t });
  }

  async newFileEntry(_s: Session | null, name: string): Promise<[FileEntry, () => void]> {
    const path = await this.prefixed(name);
    let st: Stats;
    try {
      st = await stat(path);
    } catch (err) {
      throw new Error(`failed to stat ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
    let reader: Readable;
    try {
      const fh = await open(path, 'r');
      reader = fh.createReadStream();
    } catch (err) {
      throw new Error(`failed to open ${JSON.stringify(path)}: ${(err as Error).message}`);
    }
    const t = Math.floor(st.mtimeMs / 1000);
    return [
      new FileEntry({ name: baseName(path), filepath: path, mode: st.mode & 0o777, size: st.size, mtime: t, atime: t, reader }),
      () => {
        reader.destroy();
      },
    ];
  }

  async mkdir(_s: Session | null, entry: DirEntry): Promise<void> {
    const p = await this.prefixed(entry.filepath);
    try {
      await mkdir(p, { mode: entry.mode });
    } catch (err) {
      throw new Error(`failed to create dir: ${JSON.stringify(entry.filepath)}: ${(err as Error).message}`);
    }
    await this.chtimes(entry.filepath, entry.mtime, entry.atime);
  }

  async write(_s: Session | null, entry: FileEntry): Promise<number> {
    const p = await this.prefixed(entry.filepath);
    let fh;
    try {
      fh = await open(p, fsConstants.O_TRUNC | fsConstants.O_RDWR | fsConstants.O_CREAT, entry.mode);
    } catch (err) {
      throw new Error(`failed to open file: ${JSON.stringify(entry.filepath)}: ${(err as Error).message}`);
    }
    let written = 0;
    try {
      if (!entry.reader) throw new Error('no reader');
      for await (const chunk of entry.reader) {
        const buf = chunk as Buffer;
        await fh.write(buf, 0, buf.length);
        written += buf.length;
      }
    } catch (err) {
      await fh.close().catch(() => {});
      throw new Error(`failed to write file: ${JSON.stringify(entry.filepath)}: ${(err as Error).message}`);
    }
    try {
      await fh.close();
    } catch (err) {
      throw new Error(`failed to close file: ${JSON.stringify(entry.filepath)}: ${(err as Error).message}`);
    }
    await this.chtimes(entry.filepath, entry.mtime, entry.atime);
    return written;
  }
}

function baseName(p: string): string {
  const parts = p.split(sep).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : sep;
}

function normalizeOS(p: string): string {
  if (p === '') return '.';
  const n = sep === '/' ? posix.normalize(p) : p;
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/**
 * A Handler that reads and writes files under `root`, as
 * scp.NewFileSystemHandler. Paths that leave the root, including through
 * symlinks, are refused.
 */
export function NewFileSystemHandler(root: string): Handler {
  return new FileSystemHandler(root);
}

/**
 * Wraps a stream so at most `limit` bytes are read from it, as scp's
 * limitReader.
 * @internal exported for tests
 */
export function LimitReader(src: Readable, limit: number): Readable {
  return limitReader(new StreamReader(src), limit);
}
