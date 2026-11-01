// Ports git/git_test.go: real git clients push and clone over OpenSSH.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KeysEqual, NewServer, ParseAuthorizedKey, type PublicKey, type Server, WithHostKeyPath, WithMiddleware, WithPublicKeyAuth, git } from '../src/index.ts';
import { cleanupDirs, keyPair, tempDir } from './helpers.ts';

const { AccessLevel } = git;

interface Action {
  key: PublicKey | null;
  repo: string;
}

class TestHooks implements git.Hooks {
  pushes: Action[] = [];
  fetches: Action[] = [];
  readonly access: Array<[PublicKey, string, git.AccessLevel]>;
  constructor(access: Array<[PublicKey, string, git.AccessLevel]>) {
    this.access = access;
  }
  authRepo(repo: string, key: PublicKey | null): git.AccessLevel {
    for (const [k, r, level] of this.access) if (r === repo && KeysEqual(key, k)) return level;
    return AccessLevel.NoAccess;
  }
  push(repo: string, key: PublicKey | null): void {
    this.pushes.push({ key, repo });
  }
  fetch(repo: string, key: PublicKey | null): void {
    this.fetches.push({ key, repo });
  }
}

let srv: Server;
let remote = '';
let pkPath = '';
let pubkey: PublicKey;
let repoDir = '';
let hooks: TestHooks;

beforeAll(async () => {
  const kp = keyPair();
  pkPath = kp.path;
  [pubkey] = ParseAuthorizedKey(kp.publicKey);
  repoDir = tempDir();
  hooks = new TestHooks([
    [pubkey, 'repo1', AccessLevel.AdminAccess],
    [pubkey, 'repo2', AccessLevel.AdminAccess],
    [pubkey, 'repo3', AccessLevel.AdminAccess],
    [pubkey, 'repo4', AccessLevel.AdminAccess],
    [pubkey, 'repo5', AccessLevel.NoAccess],
    [pubkey, 'repo6', AccessLevel.ReadOnlyAccess],
    [pubkey, 'repo7', AccessLevel.AdminAccess],
    [pubkey, 'abc/repo1', AccessLevel.AdminAccess],
    [pubkey, 'abc/def/repo1', AccessLevel.AdminAccess],
    // Permissive hooks: the middleware, not the hooks, keeps traversal out.
    [pubkey, '../escaped', AccessLevel.AdminAccess],
  ]);
  srv = NewServer(
    WithHostKeyPath(join(tempDir(), 'id_ed25519')),
    WithMiddleware(git.Middleware(repoDir, hooks)),
    WithPublicKeyAuth(() => true),
  );
  srv.addr = '127.0.0.1:0';
  const { port } = await srv.listen();
  remote = `ssh://127.0.0.1:${port}`;
});

afterAll(async () => {
  await srv.close();
  cleanupDirs();
});

function runGit(cwd: string, ...args: string[]): Promise<Error | null> {
  const all = [
    '-c', "user.name='wish'",
    '-c', "user.email='test@wish'",
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'log.showSignature=false',
    '-c', 'ssh.variant=ssh',
    ...args,
  ];
  return new Promise((resolve) => {
    execFile(
      'git',
      all,
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_SSH_COMMAND: `ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR -o IdentitiesOnly=yes -i "${pkPath}" -F /dev/null`,
        },
        timeout: 20_000,
      },
      (err) => resolve(err),
    );
  });
}

async function initRepo(branch: string, url: string): Promise<string> {
  const cwd = tempDir();
  expect(await runGit(cwd, 'init', '-b', branch)).toBeNull();
  expect(await runGit(cwd, 'remote', 'add', 'origin', url)).toBeNull();
  expect(await runGit(cwd, 'commit', '--allow-empty', '-m', 'initial commit')).toBeNull();
  return cwd;
}

const hasAction = (actions: Action[], repo: string) => actions.some((a) => a.repo === repo && KeysEqual(a.key, pubkey));

describe('git middleware', () => {
  test('create repo on master', async () => {
    const cwd = await initRepo('master', `${remote}/repo1`);
    expect(await runGit(cwd, 'push', 'origin', 'master')).toBeNull();
    expect(hasAction(hooks.pushes, 'repo1')).toBe(true);
  });

  test('create repo on main', async () => {
    const cwd = await initRepo('main', `${remote}/repo2`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).toBeNull();
    expect(hasAction(hooks.pushes, 'repo2')).toBe(true);
  });

  test('create repo in subdir', async () => {
    const cwd = await initRepo('main', `${remote}/abc/repo1`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).toBeNull();
    expect(hasAction(hooks.pushes, 'abc/repo1')).toBe(true);
  });

  test('create wrong repo', async () => {
    const cwd = await initRepo('main', `${remote}//../../repo1`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).not.toBeNull();
  });

  test('create wrong repo in subdir', async () => {
    const cwd = await initRepo('main', `${remote}/abc/def/repo1`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).not.toBeNull();
  });

  test('push one level above the repo dir', async () => {
    const cwd = await initRepo('main', `${remote}/../escaped`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).not.toBeNull();
    expect(existsSync(join(dirname(repoDir), 'escaped'))).toBe(false);
  });

  test('create and clone repo', async () => {
    const cwd = await initRepo('main', `${remote}/repo3`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).toBeNull();
    expect(await runGit(tempDir(), 'clone', `${remote}/repo3`)).toBeNull();
    expect(hasAction(hooks.pushes, 'repo3')).toBe(true);
    expect(hasAction(hooks.fetches, 'repo3')).toBe(true);
  });

  test("clone repo that doesn't exist", async () => {
    expect(await runGit(tempDir(), 'clone', `${remote}/repo4`)).not.toBeNull();
  });

  test('clone repo with no access', async () => {
    expect(await runGit(tempDir(), 'clone', `${remote}/repo5`)).not.toBeNull();
  });

  test('push repo with readonly access', async () => {
    const cwd = await initRepo('main', `${remote}/repo6`);
    expect(await runGit(cwd, 'push', 'origin', 'main')).not.toBeNull();
  });

  test('create and clone repo on weird branch', async () => {
    const cwd = await initRepo('a-weird-branch-name', `${remote}/repo7`);
    expect(await runGit(cwd, 'push', 'origin', 'a-weird-branch-name')).toBeNull();
    const dest = tempDir();
    expect(await runGit(dest, 'clone', `${remote}/repo7`)).toBeNull();
    expect(existsSync(join(dest, 'repo7', '.git'))).toBe(true);
    expect(hasAction(hooks.pushes, 'repo7')).toBe(true);
    expect(hasAction(hooks.fetches, 'repo7')).toBe(true);
  });
});

test('cleanRepo', () => {
  const cases: Array<[string, string]> = [
    ['repo.git', 'repo.git'],
    ['/repo.git', 'repo.git'],
    ['/repo.git/', 'repo.git'],
    ['user/repo.git', 'user/repo.git'],
    ['user/./repo.git', 'user/repo.git'],
    ['user/sub/../repo.git', 'user/repo.git'],
    ['/../repo.git', ''],
    ['../repo.git', ''],
    ['user/../../repo.git', ''],
    ['//../../repo.git', ''],
    ['..', ''],
    ['/', ''],
    ['', ''],
    ['..\\repo.git', ''],
    ['..\\..\\..\\repo.git', ''],
    ['user\\..\\..\\repo.git', ''],
    ['a/b/repo.git', ''],
    ['a\\b\\repo.git', ''],
  ];
  for (const [input, want] of cases) {
    const [got, ok] = git.cleanRepo(input);
    expect([input, got, ok]).toEqual([input, want, want !== '']);
  }
});

