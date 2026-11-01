/**
 * comment prints a line at the end of a session, as wish/comment.
 */

import { Println, type Middleware } from './wish.js';

/** Middleware prints `comment` after the rest of the chain has run. */
export function Middleware(comment: string): Middleware {
  return (next) => async (s) => {
    await next(s);
    Println(s, comment);
  };
}
