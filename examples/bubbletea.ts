/**
 * A Bubble Tea app served over SSH: each session gets its own program with
 * the client's terminal size, environment and colour profile.
 *
 *   bun examples/bubbletea.ts
 *   ssh -p 23234 localhost
 */
import {
  BackgroundColorMsg,
  type Cmd,
  ColorProfileMsg,
  KeyPressMsg,
  type Model,
  type Msg,
  NewView,
  Quit,
  RequestBackgroundColor,
  View,
  WindowSizeMsg,
} from '@oakoliver/bubbletea';
import { newStyle, type Style } from '@oakoliver/lipgloss';
import { ErrServerClosed, NewServer, type Session, WithAddress, WithHostKeyPath, WithMiddleware, activeterm, log, logging } from '../src/index.ts';
import * as bubbletea from '../src/bubbletea.ts';

const host = '127.0.0.1';
const port = 23234;

// A generic model that shows what the server knows about the client's terminal.
class TerminalInfo implements Model {
  term = '';
  profile = '';
  width = 0;
  height = 0;
  bg = 'light';
  txtStyle: Style = newStyle().foreground('10');
  quitStyle: Style = newStyle().foreground('8');

  init(): Cmd {
    return RequestBackgroundColor;
  }

  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof ColorProfileMsg) this.profile = msg.profile;
    else if (msg instanceof BackgroundColorMsg) this.bg = msg.isDark() ? 'dark' : 'light';
    else if (msg instanceof WindowSizeMsg) {
      this.width = msg.width;
      this.height = msg.height;
    } else if (msg instanceof KeyPressMsg) {
      const key = msg.toString();
      if (key === 'q' || key === 'ctrl+c') return [this, Quit];
    }
    return [this, null];
  }

  view(): View {
    const s = `Your term is ${this.term}\nYour window size is ${this.width}x${this.height}\nBackground: ${this.bg}\nColor Profile: ${this.profile}`;
    const v = NewView(this.txtStyle.render(s) + '\n\n' + this.quitStyle.render("Press 'q' to quit\n"));
    v.altScreen = true;
    return v;
  }
}

// Wire any model to the middleware with a function of the session. You can
// also return program options per session.
function teaHandler(s: Session): [Model, []] {
  const [pty] = s.pty();
  const m = new TerminalInfo();
  m.term = pty.term;
  m.width = pty.window.width;
  m.height = pty.window.height;
  return [m, []];
}

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(
    bubbletea.Middleware(teaHandler),
    activeterm.Middleware(), // Bubble Tea apps usually require a PTY.
    logging.Middleware(),
  ),
);

async function stop() {
  log.info('Stopping SSH server');
  await srv.shutdown(AbortSignal.timeout(30_000)).catch(() => srv.close());
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
