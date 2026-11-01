/**
 * ratelimiter limits how many sessions a source may open in a span of time,
 * as wish/ratelimiter. Limiters are token buckets (golang.org/x/time/rate)
 * kept in an LRU cache keyed by the client's IP address.
 *
 * It runs after the SSH handshake and authentication, like every middleware:
 * it limits sessions, not raw TCP connections.
 */

import { log } from './log.js';
import type { Session } from './session.js';
import { Fatal, type Middleware as WishMiddleware } from './wish.js';

/** Returned when the limit is exceeded, as ratelimiter.ErrRateLimitExceeded. */
export const ErrRateLimitExceeded = new Error('rate limit exceeded, please try again later');

/** Inf is an unlimited rate, as rate.Inf. */
export const Inf = Number.POSITIVE_INFINITY;

/**
 * RateLimiter decides whether a session may go on. Implementations throw (or
 * reject with) an error to refuse it.
 */
export interface RateLimiter {
  allow(s: Session): void | Promise<void>;
}

/** Middleware ends sessions the limiter refuses with the error on stderr and status 1. */
export function Middleware(limiter: RateLimiter): WishMiddleware {
  return (next) => async (s) => {
    try {
      await limiter.allow(s);
    } catch (err) {
      await Fatal(s, err);
      return;
    }
    return next(s);
  };
}

/**
 * Limiter is a token bucket, as rate.Limiter: it refills at `limit` tokens
 * per second up to `burst`, and starts full.
 */
export class Limiter {
  private tokens: number;
  private last: number;

  constructor(
    readonly limit: number,
    readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = this.now();
  }

  /** Takes one token if there is one, as Limiter.Allow. */
  allow(): boolean {
    if (this.limit === Inf) return true;
    const now = this.now();
    if (this.limit > 0) {
      const elapsed = Math.max(0, now - this.last) / 1000;
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.limit);
    }
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * NewRateLimiter allows `r` sessions per second per IP with bursts of up to
 * `burst`, remembering at most `maxEntries` IPs (least recently used ones
 * are forgotten), as ratelimiter.NewRateLimiter.
 */
export function NewRateLimiter(r: number, burst: number, maxEntries: number): RateLimiter {
  const max = maxEntries <= 0 ? 1 : maxEntries;
  const cache = new Map<string, Limiter>();
  return {
    allow(s: Session) {
      const key = s.remoteAddr().ip || s.remoteAddr().toString();
      let limiter = cache.get(key);
      if (limiter) {
        cache.delete(key);
      } else {
        limiter = new Limiter(r, burst);
      }
      const allowed = limiter.allow();
      cache.set(key, limiter);
      while (cache.size > max) cache.delete(cache.keys().next().value as string);
      log.debug('rate limiter key', 'key', key, 'allowed', allowed);
      if (!allowed) throw ErrRateLimitExceeded;
    },
  };
}
