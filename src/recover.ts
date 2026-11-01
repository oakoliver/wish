/**
 * recover keeps a throwing handler from taking the server down, as
 * wish/recover.
 *
 * It catches what a handler throws and what the Promise it returns rejects
 * with. Like Go's recover, which only sees panics on its own goroutine, it
 * cannot see errors thrown later from callbacks the handler scheduled
 * (timers, event listeners): handle those where they are scheduled.
 */

import { StandardLog, type Logger } from './log.js';
import type { Handler } from './server.js';
import type { Middleware as WishMiddleware } from './wish.js';

export type { Logger } from './log.js';

/**
 * Middleware runs the given middleware chain and then the next handler, each
 * guarded: an error in either is logged with its stack and the session goes
 * on (the next handler still runs after the chain fails).
 */
export function Middleware(...mw: WishMiddleware[]): WishMiddleware {
  return MiddlewareWithLogger(null, ...mw);
}

/** MiddlewareWithLogger is Middleware with a Printf-style logger. */
export function MiddlewareWithLogger(logger: Logger | null, ...mw: WishMiddleware[]): WishMiddleware {
  const out = logger ?? StandardLog();
  let h: Handler = () => {};
  for (const m of mw) h = m(h);
  return (next) => async (s) => {
    await guard(out, () => h(s));
    await guard(out, () => next(s));
  };
}

async function guard(logger: Logger, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const stack = err instanceof Error && err.stack ? err.stack : '';
    logger.printf('panic: %v\n%s', err, stack);
  }
}
