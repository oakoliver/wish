// The part of bun:test the suites use, on node:test and node:assert.
import assert from 'node:assert/strict';
import { isDeepStrictEqual, inspect } from 'node:util';
import * as nt from 'node:test';

export const describe = (name, fn) => nt.describe(name, fn);
export const test = (name, fn, timeout) => nt.test(name, { timeout: timeout ?? 5000 }, fn);
export const it = test;
export const afterEach = (fn) => nt.afterEach(fn);
export const beforeEach = (fn) => nt.beforeEach(fn);
export const afterAll = (fn) => nt.after(fn);
export const beforeAll = (fn) => nt.before(fn);

function matchesError(err, expected) {
  if (expected === undefined) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return err instanceof expected;
  return true;
}

function matchers(actual, negate) {
  const check = (pass, msg) => {
    if (pass === negate) assert.fail((negate ? 'not ' : '') + msg());
  };
  return {
    toBe: (e) => check(Object.is(actual, e), () => `expected ${inspect(actual)} to be ${inspect(e)}`),
    toEqual: (e) => check(isDeepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(e ?? null))), () => `expected ${inspect(actual)} to equal ${inspect(e)}`),
    toBeNull: () => check(actual === null, () => `expected ${inspect(actual)} to be null`),
    toBeTruthy: () => check(!!actual, () => `expected ${inspect(actual)} to be truthy`),
    toBeUndefined: () => check(actual === undefined, () => `expected ${inspect(actual)} to be undefined`),
    toContain: (e) => check(actual?.includes?.(e) ?? false, () => `expected ${inspect(actual)} to contain ${inspect(e)}`),
    toMatch: (re) => check((typeof re === 'string' ? new RegExp(re) : re).test(actual), () => `expected ${inspect(actual)} to match ${re}`),
    toBeGreaterThan: (n) => check(actual > n, () => `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, () => `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => check(actual < n, () => `expected ${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, () => `expected ${actual} <= ${n}`),
    toBeInstanceOf: (c) => check(actual instanceof c, () => `expected ${inspect(actual)} to be an instance of ${c.name}`),
    toHaveLength: (n) => check(actual?.length === n, () => `expected length ${actual?.length} to be ${n}`),
    toThrow: (e) => {
      let thrown = false;
      let error;
      try {
        actual();
      } catch (err) {
        thrown = true;
        error = err;
      }
      check(thrown && matchesError(error, e), () => `expected function to throw ${e ?? ''}`);
    },
  };
}

export function expect(actual) {
  const m = matchers(actual, false);
  m.not = matchers(actual, true);
  m.rejects = {
    toThrow: async (e) => {
      let error;
      let rejected = false;
      try {
        await actual;
      } catch (err) {
        rejected = true;
        error = err;
      }
      if (!rejected || !matchesError(error, e)) assert.fail(`expected promise to reject ${e ?? ''}`);
    },
  };
  return m;
}
