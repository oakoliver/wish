/**
 * Identifying users by their public key.
 *
 *   bun examples/identity.ts
 *   ssh -i ~/.ssh/id_ed25519 -p 23234 localhost
 */
import {
  ErrServerClosed,
  KeysEqual,
  NewServer,
  ParseAuthorizedKey,
  Println,
  WithAddress,
  WithHostKeyPath,
  WithMiddleware,
  WithPublicKeyAuth,
  log,
  logging,
} from '../src/index.ts';

const host = '127.0.0.1';
const port = 23234;

const users: Record<string, string> = {
  Carlos: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWe2rXKoiO6W14LYPVfJKzRfJ1f3Jhzxrgjc/D4tU7',
  // You can add your name and public key here :)
};

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  // DEMO ONLY: this lets in anyone who has an ed25519 key, known or not.
  // The point here is to recognise people, not to keep anyone out. To
  // restrict access, compare the key with a list (see multi-auth.ts) or use
  // WithAuthorizedKeys.
  WithPublicKeyAuth((_ctx, key) => key.type() === 'ssh-ed25519'),
  WithMiddleware(
    (next) => (sess) => {
      for (const [name, line] of Object.entries(users)) {
        const [known] = ParseAuthorizedKey(line);
        if (KeysEqual(sess.publicKey(), known)) {
          Println(sess, `Hey ${name}!`);
          return next(sess);
        }
      }
      Println(sess, "Hey, I don't know who you are!");
      Println(sess, `Your key is ${sess.publicKey()?.fingerprint()}`);
      return next(sess);
    },
    logging.Middleware(),
  ),
);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
