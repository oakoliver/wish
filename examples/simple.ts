/**
 * The smallest wish server: it says hello and logs the connection.
 *
 *   bun examples/simple.ts
 *   ssh -p 23234 localhost
 */
import { ErrServerClosed, NewServer, Println, WithAddress, WithHostKeyPath, WithMiddleware, log, logging } from '../src/index.ts';

const host = '127.0.0.1';
const port = 23234;

const srv = NewServer(
  // The address the server listens on. Keep it on loopback until you have
  // added authentication: with no auth handler every client is let in.
  WithAddress(`${host}:${port}`),

  // The server needs its own key pair. This creates an ed25519 key at the
  // given path the first time and reuses it afterwards.
  WithHostKeyPath('.ssh/id_ed25519'),

  // Middleware does something with a session and then calls the next one.
  WithMiddleware(
    (next) => (sess) => {
      Println(sess, 'Hello, world!');
      return next(sess);
    },
    // The last item in the chain runs first.
    logging.Middleware(),
  ),
);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  // ErrServerClosed is expected after close() or shutdown().
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
