/**
 * An SCP server for the files in examples/scp/testdata.
 *
 *   bun examples/scp.ts
 *   scp -O -P 23235 some-file localhost:          (upload)
 *   scp -O -P 23235 localhost:some-file ./copy    (download)
 *
 * `-O` asks OpenSSH 9+ for the classic SCP protocol; this port has no SFTP
 * subsystem (upstream's example adds one with github.com/pkg/sftp).
 */
import { fileURLToPath } from 'node:url';
import { ErrServerClosed, NewServer, WithAddress, WithHostKeyPath, WithMiddleware, log, logging, scp } from '../src/index.ts';

const host = '127.0.0.1';
const port = 23235;
const root = fileURLToPath(new URL('./scp/testdata', import.meta.url));
const handler = scp.NewFileSystemHandler(root);

// No auth handler: anyone who can reach 127.0.0.1 can read and write the
// folder. Add WithAuthorizedKeys before binding to anything else.
const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(scp.Middleware(handler, handler), logging.Middleware()),
);

process.once('SIGINT', () => srv.shutdown(AbortSignal.timeout(30_000)).finally(() => process.exit(0)));
log.info('Starting SSH server', 'host', host, 'port', port, 'root', root);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
