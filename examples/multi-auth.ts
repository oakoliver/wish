/**
 * Public key, password and keyboard-interactive authentication on one server.
 * The client picks the order; if every method fails it is not let in.
 *
 *   bun examples/multi-auth.ts
 *   ssh -o PreferredAuthentications=password -p 23234 localhost
 *   ssh -o PreferredAuthentications=keyboard-interactive -p 23234 localhost
 *   ssh -o PreferredAuthentications=publickey -p 23234 localhost
 */
import {
  ErrServerClosed,
  KeysEqual,
  NewServer,
  ParseAuthorizedKey,
  Println,
  WithAddress,
  WithHostKeyPath,
  WithKeyboardInteractiveAuth,
  WithMiddleware,
  WithPasswordAuth,
  WithPublicKeyAuth,
  log,
  logging,
} from '../src/index.ts';

const host = '127.0.0.1';
const port = 23234;
const validPassword = 'asd123'; // a demo password: never ship a fixed one

const users: Record<string, string> = {
  Carlos: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWe2rXKoiO6W14LYPVfJKzRfJ1f3Jhzxrgjc/D4tU7',
  // You can add your name and public key here :)
};
const known = Object.values(users).map((line) => ParseAuthorizedKey(line)[0]);

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),

  // First, public keys: only the ones listed above.
  WithPublicKeyAuth((_ctx, key) => {
    log.info('publickey');
    return known.some((k) => KeysEqual(key, k));
  }),

  // Then, a password.
  WithPasswordAuth((_ctx, password) => {
    log.info('password');
    return password === validPassword;
  }),

  // Finally, keyboard-interactive: ask the client some questions.
  WithKeyboardInteractiveAuth(async (_ctx, challenge) => {
    log.info('keyboard-interactive');
    try {
      const answers = await challenge('', '', ['♦ How much is 2+3: ', '♦ Which editor is best, vim or emacs? '], [true, true]);
      return answers.length === 2 && answers[0] === '5' && answers[1] === 'vim';
    } catch {
      return false;
    }
  }),

  WithMiddleware(
    logging.Middleware(),
    () => (sess) => {
      Println(sess, 'Authorized!');
      Println(sess, sess.publicKey()?.toString() ?? '(no public key)');
    },
  ),
);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
