/**
 * logging logs connects and disconnects, as wish/logging.
 */

import { formatDuration, formatValue } from './format.js';
import { DefaultStructuredLogger, Level, StandardLog, type Logger, type StructuredLogger } from './log.js';
import type { Middleware } from './wish.js';

export type { Logger, StructuredLogger } from './log.js';

/**
 * Middleware logs each connect with the user, remote address, whether a
 * public key was used, the command, TERM, window size and client version,
 * and each disconnect with the duration. It uses the default logger.
 */
export function Middleware(): Middleware {
  return MiddlewareWithLogger(StandardLog());
}

/** MiddlewareWithLogger is Middleware with a Printf-style logger. */
export function MiddlewareWithLogger(logger: Logger): Middleware {
  return (next) => async (sess) => {
    const start = process.hrtime.bigint();
    const hpk = sess.publicKey() !== null;
    const [pty] = sess.pty();
    logger.printf(
      '%s connect %s %v %v %s %v %v %v',
      sess.user(),
      sess.remoteAddr().toString(),
      hpk,
      sess.command(),
      pty.term,
      pty.window.width,
      pty.window.height,
      sess.context().clientVersion(),
    );
    try {
      await next(sess);
    } finally {
      logger.printf('%s disconnect %s\n', sess.remoteAddr().toString(), formatDuration(process.hrtime.bigint() - start));
    }
  };
}

/** StructuredMiddleware logs the same fields as key/value pairs at Info level. */
export function StructuredMiddleware(): Middleware {
  return StructuredMiddlewareWithLogger(DefaultStructuredLogger(), Level.Info);
}

/** StructuredMiddlewareWithLogger is StructuredMiddleware with a logger and level. */
export function StructuredMiddlewareWithLogger(logger: StructuredLogger, level: Level): Middleware {
  return (next) => async (sess) => {
    const start = process.hrtime.bigint();
    const [pty] = sess.pty();
    logger.log(
      level,
      'connect',
      'user', sess.user(),
      'remote-addr', sess.remoteAddr().toString(),
      'public-key', sess.publicKey() !== null,
      'command', formatValue(sess.command()),
      'term', pty.term,
      'width', pty.window.width,
      'height', pty.window.height,
      'client-version', sess.context().clientVersion(),
    );
    try {
      await next(sess);
    } finally {
      logger.log(
        level,
        'disconnect',
        'user', sess.user(),
        'remote-addr', sess.remoteAddr().toString(),
        'duration', formatDuration(process.hrtime.bigint() - start),
      );
    }
  };
}
