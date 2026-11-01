/**
 * A Git server. `ssh` to it to list the repos; push to create one.
 *
 *   bun examples/git.ts
 *   ssh -p 23233 localhost
 *   git remote add wish ssh://localhost:23233/some_repo && git push wish
 *
 * Needs `git` installed on the server.
 */
import { readdirSync } from 'node:fs';
import {
  ErrServerClosed,
  type Middleware,
  NewServer,
  Printf,
  Println,
  type PublicKey,
  WithAddress,
  WithHostKeyPath,
  WithMiddleware,
  WithPasswordAuth,
  WithPublicKeyAuth,
  git,
  log,
  logging,
} from '../src/index.ts';

const host = '127.0.0.1';
const port = 23233;
const repoDir = '.repos';

// Hooks that grant everyone read-write access and log pushes and fetches.
const app: git.Hooks = {
  authRepo: (_repo: string, _key: PublicKey | null) => git.ReadWriteAccess,
  push: (repo) => log.info('push', 'repo', repo),
  fetch: (repo) => log.info('fetch', 'repo', repo),
};

// Lists the repos when someone connects without a command.
const gitListMiddleware: Middleware = (next) => (sess) => {
  if (sess.command().length !== 0) return next(sess);
  let repos: string[] = [];
  try {
    repos = readdirSync(repoDir);
  } catch {
    // no repos yet
  }
  if (repos.length > 0) Printf(sess, '\n### Repo Menu ###\n\n');
  for (const name of repos) {
    Println(sess, `• ${name} - `);
    Println(sess, `git clone ssh://${host}:${port}/${name}`);
  }
  Printf(sess, '\n\n### Add some repos! ###\n\n');
  Printf(sess, '> cd some_repo\n');
  Printf(sess, '> git remote add wish_test ssh://%s:%d/some_repo\n', host, port);
  Printf(sess, '> git push wish_test\n\n\n');
  return next(sess);
};

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  // DEMO ONLY: any public key gets read-write access to every repo. Before
  // you expose this, check the key in authRepo (or use WithAuthorizedKeys).
  WithPublicKeyAuth(() => true),
  // No password logins.
  WithPasswordAuth(() => false),
  WithMiddleware(git.Middleware(repoDir, app), gitListMiddleware, logging.Middleware()),
);

process.once('SIGINT', () => srv.shutdown(AbortSignal.timeout(30_000)).finally(() => process.exit(0)));
log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
