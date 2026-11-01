/**
 * Several SSH sessions in one chat room: every program gets the messages of
 * the others through MiddlewareWithProgramHandler. A port of upstream's
 * multichat example; examples/lobby.ts is the larger version.
 *
 *   bun examples/multichat.ts
 *   ssh -p 23234 alice@localhost      (and again as bob, in another terminal)
 */
import { type Cmd, KeyPressMsg, type Model, type Msg, NewProgram, NewView, type Program, Quit, View } from '@oakoliver/bubbletea';
import { newTextarea, newViewport, textareaBlink, withViewportHeight, withViewportWidth } from '@oakoliver/bubbles';
import { newStyle } from '@oakoliver/lipgloss';
import { ErrServerClosed, NewServer, type Session, WithAddress, WithHostKeyPath, WithMiddleware, activeterm, log, logging } from '../src/index.ts';
import * as bubbletea from '../src/bubbletea.ts';

const host = '127.0.0.1';
const port = 23234;

class ChatMsg {
  readonly _tag = 'ChatMsg';
  constructor(readonly id: string, readonly text: string) {}
}

const programs = new Set<Program>();
function send(msg: ChatMsg) {
  for (const p of programs) p.send(msg);
}

class Chat implements Model {
  viewport = newViewport(withViewportWidth(30), withViewportHeight(5));
  textarea = newTextarea();
  messages: string[] = [];
  senderStyle = newStyle().foreground('5');

  constructor(readonly id: string) {
    this.textarea.placeholder = 'Send a message...';
    this.textarea.focus();
    this.textarea.prompt = '┃ ';
    this.textarea.charLimit = 280;
    this.textarea.setWidth(30);
    this.textarea.setHeight(3);
    this.textarea.showLineNumbers = false;
    this.textarea.keyMap.insertNewline.setEnabled(false);
    this.viewport.setContent('Welcome to the chat room!\nType a message and press Enter to send.');
  }

  init(): Cmd {
    return textareaBlink;
  }

  update(msg: Msg): [Model, Cmd] {
    const [, tiCmd] = this.textarea.update(msg);
    const [, vpCmd] = this.viewport.update(msg);
    if (msg instanceof KeyPressMsg) {
      const key = msg.toString();
      if (key === 'ctrl+c' || key === 'esc') return [this, Quit];
      if (key === 'enter') {
        send(new ChatMsg(this.id, this.textarea.value()));
        this.textarea.reset();
      }
    } else if (msg instanceof ChatMsg) {
      this.messages.push(this.senderStyle.render(msg.id) + ': ' + msg.text);
      this.viewport.setContent(this.messages.join('\n'));
      this.viewport.gotoBottom();
    }
    return [this, tiCmd ?? vpCmd];
  }

  view(): View {
    return NewView(`${this.viewport.view()}\n\n${this.textarea.view()}\n\n`);
  }
}

function programHandler(s: Session): Program {
  const p = NewProgram(new Chat(s.user()), ...bubbletea.MakeOptions(s));
  programs.add(p);
  void p.wait().finally(() => programs.delete(p));
  return p;
}

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(bubbletea.MiddlewareWithProgramHandler(programHandler), activeterm.Middleware(), logging.Middleware()),
);

process.once('SIGINT', () => srv.shutdown(AbortSignal.timeout(30_000)).finally(() => process.exit(0)));
log.info('Starting SSH server', 'host', host, 'port', port);
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
