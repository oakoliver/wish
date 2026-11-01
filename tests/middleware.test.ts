// Ports the tests of accesscontrol, activeterm, comment, elapsed, logging,
// ratelimiter, recover and testsession.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  Level,
  type Logger,
  type Middleware,
  Server,
  type StructuredLogger,
  accesscontrol,
  activeterm,
  comment,
  elapsed,
  logging,
  ratelimiter,
  recover,
  testsession,
} from '../src/index.ts';
import { sleep } from './helpers.ts';

afterEach(() => testsession.CloseAll());

async function result(p: Promise<Buffer>): Promise<[string, Error | null]> {
  try {
    return [(await p).toString(), null];
  } catch (err) {
    return [((err as { stdout?: Buffer }).stdout ?? Buffer.alloc(0)).toString(), err as Error];
  }
}

describe('accesscontrol', () => {
  const out = 'hello world';
  const setup = (...cmds: string[]) =>
    testsession.New(new Server({ handler: accesscontrol.Middleware(...cmds)((s) => void s.write(out)) }));
  const denied = (cmd: string) => `Command is not allowed: ${cmd}\n`;

  test('no allowed cmds no cmd', async () => {
    const [o, err] = await result((await setup()).output(''));
    expect(err).toBeNull();
    expect(o).toBe(out);
  });
  test('no allowed cmds with cmd', async () => {
    const [o, err] = await result((await setup()).output('echo'));
    expect(err).not.toBeNull();
    expect(o).toBe(denied('echo'));
  });
  test('allowed cmds no cmd', async () => {
    const [o, err] = await result((await setup('echo')).output(''));
    expect(err).toBeNull();
    expect(o).toBe(out);
  });
  test('allowed cmds with allowed cmd', async () => {
    const [o, err] = await result((await setup('echo')).output('echo'));
    expect(err).toBeNull();
    expect(o).toBe(out);
  });
  test('allowed cmds with disallowed cmd', async () => {
    const [o, err] = await result((await setup('echo')).output('cat'));
    expect(err).not.toBeNull();
    expect(o).toBe(denied('cat'));
  });
  test('allowed cmds with allowed cmd followed disallowed cmd', async () => {
    const [o, err] = await result((await setup('echo')).output('cat echo'));
    expect(err).not.toBeNull();
    expect(o).toBe(denied('cat'));
  });
});

describe('activeterm', () => {
  test('inactive term', async () => {
    const sess = await testsession.New(new Server({ handler: activeterm.Middleware()((s) => void s.write('hello')) }));
    const [o, err] = await result(sess.output(''));
    expect(err).not.toBeNull();
    expect(o).toBe('Requires an active PTY\n');
  });
  test('active term', async () => {
    const sess = await testsession.New(new Server({ handler: activeterm.Middleware()((s) => void s.write('hello')) }));
    sess.requestPty('xterm', 24, 80);
    const [o, err] = await result(sess.output(''));
    expect(err).toBeNull();
    expect(o).toBe('hello');
  });
});

test('comment', async () => {
  const sess = await testsession.New(new Server({ handler: comment.Middleware('test')(() => {}) }));
  const [o, err] = await result(sess.output(''));
  expect(err).toBeNull();
  expect(o).toBe('test\n');
});

test('elapsed', async () => {
  const sess = await testsession.New(
    new Server({ handler: elapsed.MiddlewareWithFormat('%v')(() => sleep(1000)) }),
  );
  const [o, err] = await result(sess.output(''));
  expect(err).toBeNull();
  // A Go duration such as "1.001234567s".
  expect(o).toMatch(/^1(\.\d+)?s$/);
  expect(Number.parseFloat(o)).toBeGreaterThanOrEqual(1);
});

describe('logging', () => {
  const setup = (mw: Middleware) => testsession.New(new Server({ handler: mw((s) => void s.write('hello')) }));

  test('middleware', async () => {
    const lines: string[] = [];
    const logger: Logger = { printf: (f, ...v) => lines.push([f, ...v].join('|')) };
    await (await setup(logging.MiddlewareWithLogger(logger))).run('');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('connect');
    expect(lines[0]).toContain('testuser');
    expect(lines[1]).toContain('disconnect');
  });

  test('structured middleware', async () => {
    const entries: Array<[Level, string, unknown[]]> = [];
    const logger: StructuredLogger = { log: (level, msg, ...kv) => entries.push([level, msg, kv]) };
    await (await setup(logging.StructuredMiddlewareWithLogger(logger, Level.Info))).run('');
    expect(entries.map((e) => e[1])).toEqual(['connect', 'disconnect']);
    expect(entries[0][2]).toContain('client-version');
  });

  test('default loggers', async () => {
    await (await setup(logging.Middleware())).run('');
    await (await setup(logging.StructuredMiddleware())).run('');
  });
});

describe('ratelimiter', () => {
  test('no limit', async () => {
    const s = new Server({ handler: ratelimiter.Middleware(ratelimiter.NewRateLimiter(0, 0, 5))((s) => void s.write('hello')) });
    const err = await (await testsession.New(s)).run('').then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(err.stderr.toString()).toContain('rate limit exceeded');
  });

  test('zeroed max entries', async () => {
    const s = new Server({ handler: ratelimiter.Middleware(ratelimiter.NewRateLimiter(1, 1, 0))((s) => void s.write('hello')) });
    await (await testsession.New(s)).run('');
  });

  test('limits and recovers', async () => {
    const s = new Server({ handler: ratelimiter.Middleware(ratelimiter.NewRateLimiter(10, 4, 1))(() => {}) });
    const addr = await testsession.Listen(s);
    const runs = await Promise.all(
      Array.from({ length: 10 }, async () => (await testsession.NewClientSession(addr)).run('').then(() => null, (e) => e)),
    );
    const failures = runs.filter((e) => e !== null).length;
    expect(failures).toBeGreaterThan(0);
    // The bucket refills at 10 per second.
    await sleep(150);
    await (await testsession.NewClientSession(addr)).run('');
  });

  test('token bucket', () => {
    let now = 0;
    const l = new ratelimiter.Limiter(2, 2, () => now);
    expect([l.allow(), l.allow(), l.allow()]).toEqual([true, true, false]);
    now = 500;
    expect([l.allow(), l.allow()]).toEqual([true, false]);
    expect(new ratelimiter.Limiter(ratelimiter.Inf, 0).allow()).toBe(true);
  });
});

describe('recover', () => {
  const quiet: Logger = { printf: () => {} };

  test('recover session', async () => {
    const sess = await testsession.New(
      new Server({
        handler: recover.MiddlewareWithLogger(quiet, () => () => {
          throw new Error('hello');
        })(() => {}),
      }),
    );
    const [, err] = await result(sess.output(''));
    expect(err).toBeNull();
  });

  // The next handler runs inside the guard too, so a throw there ends this
  // session, not the server.
  test('recover next handler', async () => {
    const sess = await testsession.New(
      new Server({
        handler: recover.MiddlewareWithLogger(quiet, (h) => (s) => h(s))(() => {
          throw new Error('panic in next handler');
        }),
      }),
    );
    const [, err] = await result(sess.output(''));
    expect(err).toBeNull();
  });

  test('next handler runs after chain panics', async () => {
    let called = false;
    const sess = await testsession.New(
      new Server({
        handler: recover.MiddlewareWithLogger(quiet, () => async () => {
          throw new Error('panic in chain');
        })(() => {
          called = true;
        }),
      }),
    );
    const [, err] = await result(sess.output(''));
    expect(err).toBeNull();
    expect(called).toBe(true);
  });

  test('logs the error with its stack', async () => {
    const lines: string[] = [];
    const sess = await testsession.New(
      new Server({
        handler: recover.MiddlewareWithLogger({ printf: (f, ...v) => lines.push(`${f} ${v.join(' ')}`) }, () => () => {
          throw new Error('boom');
        })(() => {}),
      }),
    );
    await sess.run('');
    expect(lines[0]).toContain('boom');
    expect(lines[0]).toContain('middleware.test');
  });
});

test('testsession', async () => {
  const out = 'hello world';
  const sess = await testsession.New(new Server({ handler: (s) => void s.write(out) }));
  expect((await sess.output('')).toString()).toBe(out);
});
