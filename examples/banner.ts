/**
 * A banner shown before authentication, password auth, and the elapsed
 * middleware that prints how long the session took.
 *
 *   bun examples/banner.ts
 *   ssh -p 23234 localhost        (the password is in the banner)
 */
import { readFileSync } from 'node:fs';
import {
  ErrServerClosed,
  NewServer,
  Println,
  WithAddress,
  WithBannerHandler,
  WithHostKeyPath,
  WithMiddleware,
  WithPasswordAuth,
  elapsed,
  log,
  logging,
  sprintf,
} from '../src/index.ts';

const host = '127.0.0.1';
const port = 23234;
const banner = readFileSync(new URL('./banner.txt', import.meta.url), 'utf8');

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  // A banner is always shown, even before authentication.
  WithBannerHandler((ctx) => sprintf(banner, ctx.user())),
  // A demo password, printed in the banner. Never ship a fixed password.
  WithPasswordAuth((_ctx, password) => password === 'asd123'),
  WithMiddleware(
    (next) => (sess) => {
      Println(sess, `Hello, ${sess.user()}!`);
      return next(sess);
    },
    logging.Middleware(),
    // Prints the session duration before disconnecting.
    elapsed.Middleware(),
  ),
);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
