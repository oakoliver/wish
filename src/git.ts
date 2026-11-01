/**
 * git serves Git repositories over SSH, as wish/git. It runs the `git`
 * binary (git upload-pack, receive-pack, upload-archive), which must be
 * installed on the server.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { posix, join } from 'node:path';
import type { PublicKey } from './keys.js';
import { log } from './log.js';
import type { Session } from './session.js';
import { WriteString, type Middleware as WishMiddleware } from './wish.js';

/** Unauthorized access, as git.ErrNotAuthed. */
export const ErrNotAuthed = new Error('you are not authorized to do this');
/** A general error reported to clients, as git.ErrSystemMalfunction. */
export const ErrSystemMalfunction = new Error('something went wrong');
/** A repo that does not exist or a name the server refuses, as git.ErrInvalidRepo. */
export const ErrInvalidRepo = new Error('invalid repo');

/** The access a key has to a repo, as git.AccessLevel. */
export enum AccessLevel {
  NoAccess = 0,
  ReadOnlyAccess = 1,
  ReadWriteAccess = 2,
  AdminAccess = 3,
}
export const { NoAccess, ReadOnlyAccess, ReadWriteAccess, AdminAccess } = AccessLevel;

/**
 * Hooks decide access and hear about pushes and fetches, as git.Hooks.
 * `authRepo` gets the client's public key, or null for password and
 * keyboard-interactive logins.
 */
export interface Hooks {
  authRepo(repo: string, key: PublicKey | null): AccessLevel | Promise<AccessLevel>;
  push(repo: string, key: PublicKey | null): void;
  fetch(repo: string, key: PublicKey | null): void;
}

/** @deprecated use Hooks, as upstream's GitHooks. */
export type GitHooks = Hooks;

/**
 * Middleware serves `git-receive-pack`, `git-upload-pack` and
 * `git-upload-archive` for repos under `repoDir`, as git.Middleware. A push
 * to a repo that does not exist creates it. Other sessions go to the next
 * handler.
 */
export function Middleware(repoDir: string, gh: Hooks): WishMiddleware {
  return (next) => async (s) => {
    const cmd = s.command();
    if (cmd.length === 2) {
      const gc = cmd[0];
      const [repo, ok] = cleanRepo(cmd[1]);
      if (!ok) {
        await Fatal(s, ErrInvalidRepo);
        return;
      }
      const pk = s.publicKey();
      const access = await gh.authRepo(repo, pk);
      switch (gc) {
        case 'git-receive-pack':
          if (access === ReadWriteAccess || access === AdminAccess) {
            try {
              await gitPack(s, gc, repoDir, repo);
              gh.push(repo, pk);
            } catch {
              await Fatal(s, ErrSystemMalfunction);
            }
          } else await Fatal(s, ErrNotAuthed);
          return;
        case 'git-upload-archive':
        case 'git-upload-pack':
          if (access === ReadOnlyAccess || access === ReadWriteAccess || access === AdminAccess) {
            try {
              await gitPack(s, gc, repoDir, repo);
              gh.fetch(repo, pk);
            } catch (err) {
              if (err === ErrInvalidRepo) await Fatal(s, ErrInvalidRepo);
              else {
                log.error('unknown git error', 'error', err);
                await Fatal(s, ErrSystemMalfunction);
              }
            }
          } else await Fatal(s, ErrNotAuthed);
          return;
      }
    }
    return next(s);
  };
}

/**
 * Normalizes a repo name from the wire and reports whether the server will
 * act on it: `repo.git` or `user/repo.git`, and nothing that leaves the repo
 * directory. Backslashes count as separators everywhere.
 * @internal exported for tests
 */
export function cleanRepo(name: string): [string, boolean] {
  const trimmed = name.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const repo = posix.normalize(trimmed === '' ? '.' : trimmed).replace(/\/+$/, '');
  const local = repo !== '.' && repo !== '..' && !repo.startsWith('../') && !posix.isAbsolute(repo);
  if (!local || repo.split('/').length - 1 > 1) return ['', false];
  return [repo, true];
}

async function gitPack(s: Session, gitCmd: string, repoDir: string, repo: string): Promise<void> {
  const cmd = gitCmd.replace(/^git-/, '');
  const rp = join(repoDir, repo);
  switch (gitCmd) {
    case 'git-upload-archive':
    case 'git-upload-pack':
      if (!existsSync(rp)) throw ErrInvalidRepo;
      await runGit(s, '', cmd, rp);
      return;
    case 'git-receive-pack':
      await EnsureRepo(repoDir, repo);
      await runGit(s, '', cmd, rp);
      await ensureDefaultBranch(rp);
      // Needed for the git dumb HTTP server.
      await runGit(null, rp, 'update-server-info');
      return;
    default:
      throw new Error(`unknown git command: ${gitCmd}`);
  }
}

/** Writes an error to the session as a git pkt-line and exits 1, as git.Fatal. */
export async function Fatal(s: Session, ...v: unknown[]): Promise<void> {
  const msg = v.map((x) => (x instanceof Error ? x.message : String(x))).join('');
  // The length includes the 4-byte prefix and the trailing newline.
  const pktLine = `${(Buffer.byteLength(msg) + 5).toString(16).padStart(4, '0')}${msg}\n`;
  WriteString(s, pktLine);
  await s.exit(1).catch(() => {});
}

/**
 * Makes sure `repo` exists in `dir` as a bare Git repository, creating `dir`
 * (mode 0700) and running `git init --bare` as needed, as git.EnsureRepo.
 */
export async function EnsureRepo(dir: string, repo: string): Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rp = join(dir, repo);
  if (!existsSync(rp) || !statSync(rp).isDirectory() || !existsSync(join(rp, 'HEAD'))) {
    await runGit(null, '', 'init', '--quiet', '--bare', rp);
  }
}

function runGit(s: Session | null, dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: s?.context().signal,
    });
    let out = '';
    const onData = (chunk: Buffer) => {
      if (!child.stdin.write(chunk)) {
        s!.pause();
        child.stdin.once('drain', () => s!.resume());
      }
    };
    const onEnd = () => child.stdin.end();
    child.stdin.on('error', () => {});
    if (s) {
      s.on('data', onData);
      s.once('end', onEnd);
      child.stdout.on('data', (chunk: Buffer) => {
        if (!s.write(chunk)) {
          child.stdout.pause();
          s.once('drain', () => child.stdout.resume());
        }
      });
    } else {
      child.stdin.end();
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    }
    child.stderr.resume();
    const detach = () => {
      if (s) {
        s.off('data', onData);
        s.off('end', onEnd);
      }
    };
    child.once('error', (err) => {
      detach();
      reject(new Error(`git ${args.join(' ')}: ${err.message}`));
    });
    child.once('close', (code) => {
      detach();
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.join(' ')}: exit status ${code}`));
    });
  });
}

async function ensureDefaultBranch(repoPath: string): Promise<void> {
  const branches = (await runGit(null, repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'))
    .split('\n')
    .filter(Boolean);
  if (branches.length === 0) throw new Error('next branch: no branches');
  try {
    await runGit(null, repoPath, 'rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    // HEAD points at a branch that was never pushed: rename it to the first one.
    await runGit(null, repoPath, 'symbolic-ref', 'HEAD', `refs/heads/${branches[0]}`);
  }
}
