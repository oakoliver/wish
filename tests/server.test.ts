// Limits, timeouts and authentication edge cases. These have no upstream
// counterpart; they check that the protections actually hold.
import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import ssh2 from 'ssh2';
import {
  ErrServerClosed,
  KeysEqual,
  NewServer,
  ParseAuthorizedKey,
  Server,
  WithAddress,
  WithHandshakeTimeout,
  WithHostKeyPath,
  WithIdleTimeout,
  WithKeyboardInteractiveAuth,
  WithMaxAuthTries,
  WithMaxTimeout,
  WithPasswordAuth,
  WithPublicKeyAuth,
  WrapConn,
  testsession,
} from '../src/index.ts';
import { cleanupDirs, hostPort, keyPair, sleep, tempDir, waitFor } from './helpers.ts';
import { join } from 'node:path';

afterEach(async () => {
  await testsession.CloseAll();
  cleanupDirs();
});

function rawConnect(addr: string): Promise<{ socket: net.Socket; closed: Promise<number> }> {
  const { host, port } = hostPort(addr);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host, () => {
      const start = performance.now();
      const closed = new Promise<number>((r) => socket.once('close', () => r(performance.now() - start)));
      resolve({ socket, closed });
    });
    socket.on('error', () => {});
    socket.on('data', () => {});
  });
}

describe('timeouts', () => {
  test('idle timeout closes a silent connection', async () => {
    const srv = new Server({ handler: () => new Promise(() => {}) });
    WithIdleTimeout(300)(srv);
    const sess = await testsession.New(srv);
    await sess.start('');
    const start = performance.now();
    // ssh2's client reports a dropped connection on the client, not the channel.
    await new Promise<void>((r) => sess.client.once('close', () => r()));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });

  test('traffic resets the idle timeout', async () => {
    const srv = new Server({
      handler: (s) =>
        new Promise<void>((resolve) => {
          s.on('data', (d: Buffer) => {
            s.write(d);
            if (d.toString().includes('q')) resolve();
          });
        }),
    });
    WithIdleTimeout(300)(srv);
    const sess = await testsession.New(srv);
    const stream = await sess.start('');
    let closed = false;
    sess.client.once('close', () => (closed = true));
    for (let i = 0; i < 6; i++) {
      await sleep(150);
      stream.write('x');
    }
    // 900 ms in, past three idle periods, still open.
    expect(closed).toBe(false);
    stream.write('q');
  });

  test('max timeout closes a busy connection', async () => {
    const srv = new Server({
      handler: (s) =>
        new Promise<void>(() => {
          setInterval(() => s.write('.'), 20).unref();
        }),
    });
    WithMaxTimeout(400)(srv);
    const sess = await testsession.New(srv);
    const stream = await sess.start('');
    stream.on('data', () => {});
    const start = performance.now();
    await new Promise<void>((r) => sess.client.once('close', () => r()));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(1500);
  });

  test('handshake timeout closes a connection that never authenticates', async () => {
    const srv = new Server({ handler: () => {} });
    WithHandshakeTimeout(300)(srv);
    const { closed } = await rawConnect(await testsession.Listen(srv));
    const elapsed = await closed;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });

  test('without timeouts a silent TCP connection stays open', async () => {
    const srv = new Server({ handler: () => {} });
    const { socket, closed } = await rawConnect(await testsession.Listen(srv));
    const result = await Promise.race([closed.then(() => 'closed'), sleep(600).then(() => 'open')]);
    expect(result).toBe('open');
    socket.destroy();
  });
});

describe('authentication', () => {
  test('no handlers accepts everyone (as upstream)', async () => {
    const sess = await testsession.New(new Server({ handler: (s) => void s.write(s.user()) }), { username: 'anyone' });
    expect((await sess.output('')).toString()).toBe('anyone');
  });

  test('password', async () => {
    const srv = new Server({ handler: (s) => void s.write('in') });
    WithPasswordAuth((_ctx, pass) => pass === 'right')(srv);
    const addr = await testsession.Listen(srv);
    await expect(testsession.NewClientSession(addr, { password: 'wrong' })).rejects.toThrow('authentication methods failed');
    const sess = await testsession.NewClientSession(addr, { password: 'right' });
    expect((await sess.output('')).toString()).toBe('in');
  });

  test('async handlers and handler errors', async () => {
    const srv = new Server({ handler: (s) => void s.write('in') });
    WithPasswordAuth(async (_ctx, pass) => {
      await sleep(5);
      if (pass === 'throw') throw new Error('handler bug');
      return pass === 'ok';
    })(srv);
    const addr = await testsession.Listen(srv);
    await expect(testsession.NewClientSession(addr, { password: 'throw' })).rejects.toThrow();
    expect((await (await testsession.NewClientSession(addr, { password: 'ok' })).output('')).toString()).toBe('in');
  });

  test('public key, and the key reaches the session', async () => {
    const allowed = keyPair();
    const other = keyPair();
    const [allowedKey] = ParseAuthorizedKey(allowed.publicKey);
    const srv = new Server({ handler: (s) => void s.write(s.publicKey()!.fingerprint()) });
    WithPublicKeyAuth((_ctx, key) => KeysEqual(key, allowedKey))(srv);
    const addr = await testsession.Listen(srv);
    await expect(testsession.NewClientSession(addr, { privateKey: other.privateKey })).rejects.toThrow();
    const sess = await testsession.NewClientSession(addr, { privateKey: allowed.privateKey });
    expect((await sess.output('')).toString()).toBe(allowedKey.fingerprint());
  });

  test('a signature made with another key is refused', async () => {
    const victim = keyPair();
    const attacker = keyPair();
    const [victimKey] = ParseAuthorizedKey(victim.publicKey);
    let handled = false;
    const srv = new Server({ handler: () => void (handled = true) });
    WithPublicKeyAuth((_ctx, key) => KeysEqual(key, victimKey))(srv);
    const addr = await testsession.Listen(srv);
    // Present the victim's public key but sign with the attacker's private key.
    const victimParsed = ssh2.utils.parseKey(victim.privateKey) as ssh2.ParsedKey;
    const attackerParsed = ssh2.utils.parseKey(attacker.privateKey) as ssh2.ParsedKey;
    const forged = Object.create(victimParsed);
    forged.sign = (data: Buffer, algo?: string) => attackerParsed.sign(data, algo);
    forged.isPrivateKey = () => true;
    let tries = 0;
    await expect(
      testsession.NewClientSession(addr, {
        authHandler: (_methods: unknown, _partial: unknown, next: (m: unknown) => void) => {
          if (tries++ > 0) return next(false);
          next({ type: 'publickey', username: 'mallory', key: forged });
        },
      } as never),
    ).rejects.toThrow();
    expect(handled).toBe(false);
  });

  test('keyboard-interactive', async () => {
    const srv = new Server({ handler: (s) => void s.write('ok') });
    WithKeyboardInteractiveAuth(async (_ctx, challenge) => {
      const answers = await challenge('', '', ['2+3? ', 'editor? '], [true, true]);
      return answers[0] === '5' && answers[1] === 'vim';
    })(srv);
    const addr = await testsession.Listen(srv);
    await expect(testsession.NewClientSession(addr, { tryKeyboard: true, onKeyboardInteractive: () => ['4', 'vim'] })).rejects.toThrow();
    const sess = await testsession.NewClientSession(addr, { tryKeyboard: true, onKeyboardInteractive: () => ['5', 'vim'] });
    expect((await sess.output('')).toString()).toBe('ok');
  });

  test('too many failures disconnects', async () => {
    const srv = new Server({ handler: () => {} });
    WithPasswordAuth(() => false)(srv);
    WithMaxAuthTries(3)(srv);
    const addr = await testsession.Listen(srv);
    let attempts = 0;
    const err = await testsession
      .NewClientSession(addr, {
        authHandler: (_m: unknown, _p: unknown, next: (m: unknown) => void) => {
          attempts++;
          next({ type: 'password', username: 'u', password: `guess${attempts}` });
        },
      } as never)
      .then(() => null, (e) => e);
    expect(err).not.toBeNull();
    // Three failures are answered; the fourth gets the connection closed.
    expect(attempts).toBe(4);
  });

  test('WrapConn can refuse a connection', async () => {
    const srv = new Server({ handler: () => {} });
    WrapConn(() => null)(srv);
    await expect(testsession.New(srv)).rejects.toThrow();
  });
});

describe('isolation', () => {
  test('a handler that throws ends only its own session', async () => {
    const srv = new Server({
      handler: async (s) => {
        if (s.rawCommand() === 'crash') throw new Error('boom');
        await sleep(200);
        s.write('survived');
      },
    });
    const addr = await testsession.Listen(srv);
    const long = (await testsession.NewClientSession(addr)).output('slow');
    await sleep(20);
    const crashed = await (await testsession.NewClientSession(addr)).run('crash').then(() => null, (e) => e);
    expect(crashed?.code).toBe(1);
    expect((await long).toString()).toBe('survived');
    expect((await (await testsession.NewClientSession(addr)).output('again')).toString()).toBe('survived');
  });

  test('sessions run concurrently', async () => {
    const srv = new Server({
      handler: async (s) => {
        await sleep(200);
        s.write(s.rawCommand());
      },
    });
    const addr = await testsession.Listen(srv);
    const start = performance.now();
    const outs = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => (await (await testsession.NewClientSession(addr)).output(`n${i}`)).toString()),
    );
    expect(outs).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('lifecycle', () => {
  test('listenAndServe rejects with ErrServerClosed after close', async () => {
    const srv = NewServer(WithHostKeyPath(join(tempDir(), 'id')), WithAddress('127.0.0.1:0'));
    const done = srv.listenAndServe().catch((e) => e);
    await waitFor(() => srv.address() !== null);
    await srv.close();
    expect(await done).toBe(ErrServerClosed);
  });

  test('shutdown waits for sessions to end', async () => {
    let release!: () => void;
    const srv = new Server({ handler: () => new Promise<void>((r) => (release = r)) });
    const sess = await testsession.New(srv);
    const out = sess.run('');
    await waitFor(() => release !== undefined);
    let finished = false;
    const shutdown = srv.shutdown().then(() => (finished = true));
    await sleep(100);
    expect(finished).toBe(false);
    release();
    await out;
    await sess.close();
    await shutdown;
    expect(finished).toBe(true);
  });

  test('shutdown gives up when its signal aborts', async () => {
    const srv = new Server({ handler: () => new Promise<void>(() => {}) });
    const sess = await testsession.New(srv);
    void sess.run('').catch(() => {});
    await waitFor(() => srv.connections() === 1);
    await expect(srv.shutdown(AbortSignal.timeout(100))).rejects.toThrow();
  });

  test('context carries connection metadata', async () => {
    const srv = new Server({
      handler: (s) => {
        const ctx = s.context();
        s.write(JSON.stringify({ id: ctx.sessionID().length, client: ctx.clientVersion(), server: ctx.serverVersion(), remote: ctx.remoteAddr().ip }));
      },
    });
    srv.version = 'WishTest_1.0';
    const meta = JSON.parse((await (await testsession.New(srv)).output('')).toString());
    expect(meta.id).toBe(64);
    expect(meta.client.startsWith('SSH-2.0-')).toBe(true);
    expect(meta.server).toBe('SSH-2.0-WishTest_1.0');
    expect(meta.remote).toContain('127.0.0.1');
  });

  test('a corrupt host key is refused at startup', () => {
    expect(() => NewServer(WithHostKeyPath(join(__dirname ?? '.', 'testdata', 'ca.pub')))).toThrow();
  });
});
