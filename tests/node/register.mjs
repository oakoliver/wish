// Runs the bun:test suites under Node's test runner: `bun:test` resolves to
// a small shim, and ../src/*.ts imports resolve to the built ../dist/*.js, so
// Node tests the package as published.
import { register } from 'node:module';

register(new URL('./hooks.mjs', import.meta.url));
