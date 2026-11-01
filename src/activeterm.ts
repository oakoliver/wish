/**
 * activeterm refuses sessions without a PTY, as wish/activeterm.
 */

import { Println, type Middleware } from './wish.js';

/** Middleware exits with status 1 unless the client requested a PTY. */
export function Middleware(): Middleware {
  return (next) => async (sess) => {
    const [, , active] = sess.pty();
    if (active) return next(sess);
    Println(sess, 'Requires an active PTY');
    await sess.exit(1).catch(() => {});
  };
}
