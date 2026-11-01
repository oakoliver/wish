/**
 * A custom Bubble Tea middleware that keeps the Program, so the server can
 * send it messages: here, the time every second.
 *
 *   bun examples/bubbleteaprogram.ts
 *   ssh -p 23234 localhost
 */
import { type Cmd, KeyPressMsg, type Model, type Msg, NewProgram, NewView, type Program, type ProgramOption, Quit, View, WindowSizeMsg } from '@oakoliver/bubbletea';
import { ErrServerClosed, Fatalln, NewServer, type Session, WithAddress, WithHostKeyPath, WithMiddleware, log, logging } from '../src/index.ts';
import * as bubbletea from '../src/bubbletea.ts';

const host = '127.0.0.1';
const port = 23234;

class TimeMsg {
  readonly _tag = 'TimeMsg';
  constructor(readonly time: Date) {}
}

class Clock implements Model {
  constructor(public term: string, public width: number, public height: number, public time = new Date()) {}
  init(): Cmd {
    return null;
  }
  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof TimeMsg) this.time = msg.time;
    else if (msg instanceof WindowSizeMsg) {
      this.width = msg.width;
      this.height = msg.height;
    } else if (msg instanceof KeyPressMsg && (msg.toString() === 'q' || msg.toString() === 'ctrl+c')) return [this, Quit];
    return [this, null];
  }
  view(): View {
    const v = NewView(
      `Your term is ${this.term}\nYour window size is x: ${this.width} y: ${this.height}\nTime: ${this.time.toUTCString()}\n\nPress 'q' to quit\n`,
    );
    v.altScreen = true;
    return v;
  }
}

// Build the Program yourself and keep a handle on it. MakeOptions wires the
// program to the session (input, output, size, environment, colour profile).
function myCustomBubbleteaMiddleware() {
  const newProg = (m: Model, ...opts: ProgramOption[]): Program => {
    const p = NewProgram(m, ...opts);
    const timer = setInterval(() => p.send(new TimeMsg(new Date())), 1000);
    void p.wait().finally(() => clearInterval(timer));
    return p;
  };
  const teaHandler = (s: Session): Program | null => {
    const [pty, , active] = s.pty();
    if (!active) {
      void Fatalln(s, 'no active terminal, skipping');
      return null;
    }
    return newProg(new Clock(pty.term, pty.window.width, pty.window.height), ...bubbletea.MakeOptions(s));
  };
  return bubbletea.MiddlewareWithProgramHandler(teaHandler);
}

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(myCustomBubbleteaMiddleware(), logging.Middleware()),
);

process.once('SIGINT', () => srv.shutdown(AbortSignal.timeout(30_000)).finally(() => process.exit(0)));
log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
