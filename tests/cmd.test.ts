// Ports cmd_test.go. There is no real PTY in this port, so the PTY cases
// run on an emulated PTY (the client still requests one).
import { afterEach, expect, test } from 'bun:test';
import { PassThrough, Readable } from 'node:stream';
import { Command, Fatal, Fatalf, Server, type Session, testsession } from '../src/index.ts';
import { cleanupDirs, sleep, tempDir } from './helpers.ts';

afterEach(async () => {
  await testsession.CloseAll();
  cleanupDirs();
});

async function runEcho(s: Session, str: string) {
  const cmd = Command(s, 'echo', str);
  // With all handles null the command runs on the session.
  cmd.setStderr(null);
  cmd.setStdin(null);
  cmd.setStdout(null);
  await cmd.run().catch((err) => Fatal(s, err));
}

async function runEnv(s: Session, env: string[]) {
  const cmd = Command(s, 'env');
  cmd.setEnv(env);
  await cmd.run().catch((err) => Fatal(s, err));
  if (cmd.environ().length === 0) await Fatal(s, 'cmd.Environ() should not be empty');
}

async function runPwd(s: Session, dir: string) {
  const cmd = Command(s, 'pwd');
  cmd.setDir(dir);
  await cmd.run().catch((err) => Fatal(s, err));
}

test('command without a PTY', async () => {
  const tmp = tempDir();
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        await runEcho(s, 'hello');
        await runEnv(s, ['HELLO=world']);
        await runPwd(s, tmp);
      },
    }),
  );
  const out = (await sess.output('')).toString();
  expect(out).toContain('hello');
  expect(out).toContain('HELLO=world');
  expect(out).toContain(tmp);
});

test('command with a PTY', async () => {
  const tmp = tempDir();
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        await runEcho(s, 'hello');
        await runEnv(s, ['HELLO=world']);
        await runPwd(s, tmp);
      },
    }),
  );
  sess.requestPty('xterm', 500, 200);
  const out = (await sess.output('')).toString();
  expect(out).toContain('hello\r\n');
  expect(out).toContain('HELLO=world');
  expect(out).toContain(tmp);
});

test('command with a PTY that does not exist', async () => {
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        await Command(s, 'nopenopenope').run().catch((err) => Fatal(s, err));
      },
    }),
  );
  sess.requestPty('xterm', 500, 200);
  const err = await sess.run('').then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err.stderr.toString()).toContain('exec: "nopenopenope"');
});

// Custom handles are used when all three are set: the cat round trip proves
// both stdin and stdout flow through them.
test('command with custom stdio', async () => {
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        const cmd = Command(s, 'cat');
        const out = new PassThrough();
        const chunks: Buffer[] = [];
        out.on('data', (d: Buffer) => chunks.push(d));
        cmd.setStdin(Readable.from(['roundtrip\n']));
        cmd.setStdout(out);
        cmd.setStderr(new PassThrough());
        await cmd.run().catch((err) => Fatal(s, err));
        const got = Buffer.concat(chunks).toString();
        if (!got.includes('roundtrip')) {
          await Fatalf(s, 'expected stdin to round trip through custom stdout, got %q', got);
          return;
        }
        s.write('SUCCESS');
      },
    }),
  );
  sess.requestPty('xterm', 500, 200);
  expect((await sess.output('')).toString()).toContain('SUCCESS');
});

// A partial set keeps the session wiring: the gate is all-or-nothing.
test('command with partial custom stdio on a PTY', async () => {
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        const cmd = Command(s, 'echo', 'partial');
        const sink = new PassThrough();
        let len = 0;
        sink.on('data', (d: Buffer) => (len += d.length));
        cmd.setStdout(sink);
        await cmd.run().catch((err) => Fatal(s, err));
        await sleep(10);
        if (len !== 0) await Fatalf(s, 'expected PTY fallback with partial stdio set, but output went to custom stdout');
      },
    }),
  );
  sess.requestPty('xterm', 500, 200);
  expect((await sess.output('')).toString()).toContain('partial');
});

test('command reads the session as stdin', async () => {
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        await Command(s, 'tr', 'a-z', 'A-Z').run().catch((err) => Fatal(s, err));
      },
    }),
  );
  sess.stdin = 'piped through tr\n';
  expect((await sess.output('')).toString()).toBe('PIPED THROUGH TR\n');
});

test('a non-zero exit is an error', async () => {
  let message = '';
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        await Command(s, 'sh', '-c', 'exit 3').run().catch((err) => (message = err.message));
      },
    }),
  );
  await sess.run('');
  expect(message).toBe('exit status 3');
});

// Reading the input with `for await` must leave the session open for the reply.
test('for await over the session, then reply', async () => {
  const sess = await testsession.New(
    new Server({
      handler: async (s) => {
        let lines = 0;
        for await (const chunk of s) lines += String(chunk).split('\n').length - 1;
        s.write(`lines=${lines}\n`);
      },
    }),
  );
  sess.stdin = 'a\nb\nc\n';
  expect((await sess.output('count')).toString()).toBe('lines=3\n');
});
