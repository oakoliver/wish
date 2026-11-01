// The Bubble Tea middleware. Upstream has no tests for it; these drive real
// programs through an SSH client with a PTY.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type Cmd,
  KeyPressMsg,
  type Model,
  type Msg,
  NewProgram,
  Quit,
  Suspend,
  WindowSizeMsg,
} from '@oakoliver/bubbletea';
import { newStyle } from '@oakoliver/lipgloss';
import type { ClientChannel } from 'ssh2';
import { Server, type Session, testsession } from '../src/index.ts';
import * as bubbletea from '../src/bubbletea.ts';
import { sleep, waitFor } from './helpers.ts';

afterEach(() => testsession.CloseAll());

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\/g, '');

class Probe implements Model {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly events: string[];
  readonly crashOn: string;
  constructor(label: string, width = 0, height = 0, events: string[] = [], crashOn = '') {
    this.label = label;
    this.width = width;
    this.height = height;
    this.events = events;
    this.crashOn = crashOn;
  }
  init(): Cmd {
    return null;
  }
  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof WindowSizeMsg) return [new Probe(this.label, msg.width, msg.height, this.events, this.crashOn), null];
    if (msg instanceof KeyPressMsg) {
      const key = msg.toString();
      if (key === this.crashOn) throw new Error('model crashed');
      if (key === 'q') return [this, Quit];
      if (key === 'z') return [this, Suspend];
      return [new Probe(this.label, this.width, this.height, [...this.events, key], this.crashOn), null];
    }
    const tag = (msg as { _tag?: string })?._tag;
    if (tag === 'ResumeMsg') return [new Probe(this.label, this.width, this.height, [...this.events, 'resumed'], this.crashOn), null];
    if (tag === 'Broadcast') return [new Probe(this.label, this.width, this.height, [...this.events, `bc:${(msg as { text: string }).text}`], this.crashOn), null];
    return [this, null];
  }
  view(): string {
    return `${this.label} size=${this.width}x${this.height} keys=${this.events.join(',')} end`;
  }
}

interface Client {
  stream: ClientChannel;
  output: () => string;
  waitFor: (text: string) => Promise<void>;
}

async function connect(addr: string, opts: { pty?: boolean; env?: Record<string, string>; term?: string } = {}): Promise<Client> {
  const sess = await testsession.NewClientSession(addr);
  if (opts.env) sess.env = opts.env;
  if (opts.pty !== false) sess.requestPty(opts.term ?? 'xterm-256color', 24, 80);
  const stream = await sess.start('');
  let raw = '';
  stream.on('data', (d: Buffer) => (raw += d.toString()));
  stream.stderr.on('data', (d: Buffer) => (raw += d.toString()));
  const output = () => raw;
  return {
    stream,
    output,
    waitFor: (text) => waitFor(() => strip(raw).includes(text), 3000).catch(() => {
      throw new Error(`timed out waiting for ${JSON.stringify(text)} in ${JSON.stringify(strip(raw).slice(-300))}`);
    }),
  };
}

function exitCode(stream: ClientChannel): Promise<number | null> {
  return new Promise((resolve) => {
    let code: number | null = null;
    stream.on('exit', (c: number) => (code = c));
    stream.on('close', () => resolve(code));
  });
}

describe('bubbletea.Middleware', () => {
  test('starts with the PTY size and follows window changes', async () => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [new Probe('probe'), []])(() => {}) });
    const c = await connect(await testsession.Listen(srv));
    await c.waitFor('size=80x24');
    c.stream.setWindow(40, 120, 0, 0);
    await c.waitFor('size=120x40');
    const exited = exitCode(c.stream);
    c.stream.write('q');
    expect(await exited).toBe(0);
  });

  test('keys reach the program', async () => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [new Probe('keys'), []])(() => {}) });
    const c = await connect(await testsession.Listen(srv));
    await c.waitFor('size=80x24');
    c.stream.write('ab');
    c.stream.write('\x1b[A');
    await c.waitFor('keys=a,b,up');
  });

  test('refuses sessions without a PTY', async () => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [new Probe('x'), []])(() => {}) });
    const sess = await testsession.New(srv);
    const err = await sess.run('').then(() => null, (e) => e);
    expect(err?.code).toBe(1);
    expect(err.stderr.toString()).toContain('no active terminal, skipping');
  });

  test('a null model passes the session on', async () => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [null, []])((s) => void s.write('next')) });
    const sess = await testsession.New(srv);
    sess.requestPty('xterm', 24, 80);
    expect((await sess.output('')).toString()).toBe('next');
  });

  test('suspend becomes resume instead of stopping the server', async () => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [new Probe('susp'), []])(() => {}) });
    const c = await connect(await testsession.Listen(srv));
    await c.waitFor('size=80x24');
    c.stream.write('z');
    await c.waitFor('keys=resumed');
  });

  test('a crashing program ends its session only', async () => {
    const srv = new Server({ handler: bubbletea.Middleware((s) => [new Probe(s.user(), 0, 0, [], 'x'), []])(() => {}) });
    const addr = await testsession.Listen(srv);
    const healthy = await connect(addr);
    const crashing = await connect(addr);
    await healthy.waitFor('size=80x24');
    await crashing.waitFor('size=80x24');
    const crashedExit = exitCode(crashing.stream);
    crashing.stream.write('x');
    await crashedExit;
    healthy.stream.write('k');
    await healthy.waitFor('keys=k');
    const third = await connect(addr);
    await third.waitFor('size=80x24');
  });

  test('closing the client stops the program', async () => {
    let finished = false;
    const srv = new Server({
      handler: bubbletea.Middleware(() => [new Probe('bye'), []])(() => {
        finished = true;
      }),
    });
    const c = await connect(await testsession.Listen(srv));
    await c.waitFor('size=80x24');
    c.stream.close();
    await waitFor(() => finished);
  });
});

describe('colour profile', () => {
  class Colored implements Model {
    init(): Cmd {
      return null;
    }
    update(msg: Msg): [Model, Cmd] {
      return [this, msg instanceof KeyPressMsg ? Quit : null];
    }
    view(): string {
      return newStyle().foreground('#ff8800').render('orange');
    }
  }

  const run = async (env: Record<string, string>, term = 'xterm-256color') => {
    const srv = new Server({ handler: bubbletea.Middleware(() => [new Colored(), []])(() => {}) });
    const c = await connect(await testsession.Listen(srv), { env, term });
    await c.waitFor('orange');
    await sleep(50);
    return c.output();
  };

  test('256-colour terminals get 256 colours', async () => {
    const out = await run({});
    expect(out).toContain('38;5;');
    expect(out).not.toContain('38;2;');
  });

  test('COLORTERM=truecolor keeps TrueColor', async () => {
    const out = await run({ COLORTERM: 'truecolor' });
    expect(out).toContain('38;2;255;136;0');
  });

  test('NO_COLOR removes colour', async () => {
    const out = await run({ NO_COLOR: '1' });
    expect(out).not.toMatch(/\x1b\[[0-9;]*38;/);
  });

  test('SessionColorProfile reads the session environment', async () => {
    let profile = '';
    const srv = new Server({
      handler: (s: Session) => {
        profile = bubbletea.SessionColorProfile(s);
      },
    });
    const sess = await testsession.New(srv);
    sess.requestPty('xterm', 24, 80);
    await sess.run('');
    expect(profile).toBe('ansi');
  });
});

test('MiddlewareWithProgramHandler can send to programs from outside', async () => {
  const programs = new Set<ReturnType<typeof NewProgram>>();
  const srv = new Server({
    handler: bubbletea.MiddlewareWithProgramHandler((s) => {
      const p = NewProgram(new Probe(s.user()), ...bubbletea.MakeOptions(s));
      programs.add(p);
      return p;
    })(() => {}),
  });
  const addr = await testsession.Listen(srv);
  const a = await connect(addr);
  const b = await connect(addr);
  await a.waitFor('size=80x24');
  await b.waitFor('size=80x24');
  for (const p of programs) p.send({ _tag: 'Broadcast', text: 'hi' });
  await a.waitFor('keys=bc:hi');
  await b.waitFor('keys=bc:hi');
});
