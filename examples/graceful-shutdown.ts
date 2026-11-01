/**
 * Stops on ctrl+c or SIGTERM, letting open sessions finish (up to 30 s).
 *
 *   bun examples/graceful-shutdown.ts
 *   ssh -p 23234 localhost
 */
import { ErrServerClosed, NewServer, Println, WithAddress, WithHostKeyPath, WithMiddleware, log, logging } from '../src/index.ts';

const host = '127.0.0.1';
const port = 23234;

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(
    (next) => async (sess) => {
      Println(sess, 'Hello! This session takes 5 seconds; stop the server meanwhile.');
      await new Promise((r) => setTimeout(r, 5000));
      Println(sess, 'Bye!');
      return next(sess);
    },
    logging.Middleware(),
  ),
);

async function stop() {
  log.info('Stopping SSH server');
  try {
    await srv.shutdown(AbortSignal.timeout(30_000));
  } catch (err) {
    log.error('Could not stop server', 'error', err);
    await srv.close();
  }
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
