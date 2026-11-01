/**
 * elapsed prints how long a session took, as wish/elapsed.
 */

import { formatDuration } from './format.js';
import { Printf, type Middleware } from './wish.js';

/**
 * MiddlewareWithFormat prints the session's duration with `format` (Go's
 * `%v` prints it like time.Duration, for example `1.002345s`). Put it last
 * in WithMiddleware so it wraps the whole chain.
 */
export function MiddlewareWithFormat(format: string): Middleware {
  return (next) => async (s) => {
    const start = process.hrtime.bigint();
    await next(s);
    Printf(s, format, formatDuration(process.hrtime.bigint() - start));
  };
}

/** Middleware prints `elapsed time: <duration>` at the end of the session. */
export function Middleware(): Middleware {
  return MiddlewareWithFormat('elapsed time: %v\n');
}
