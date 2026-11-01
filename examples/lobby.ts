/**
 * Lobby — a chat room served over SSH. Everyone who connects shares one room:
 * you see people arrive and leave, see who is typing while they type, and
 * get highlighted when someone mentions you. Names come from the SSH user
 * name plus a tag and a colour derived from the client's public key, so two
 * people can both be "alice" and still be told apart.
 *
 * Usage:
 *   bun examples/lobby.ts                                listen on 127.0.0.1:23236
 *   bun examples/lobby.ts --authorized-keys ~/.ssh/authorized_keys
 *                                                        only let those keys in
 *   ssh -p 23236 alice@localhost                         join (any ed25519/RSA/ECDSA key)
 *
 * Keys: enter send · pgup/pgdn scroll · /me <action> · /who · ctrl+c leave
 *
 * Everything people type is shown to everyone else, so it is cleaned of
 * terminal control sequences first: an SSH chat must not let one user move
 * another user's cursor or retitle their window.
 */
import {
  type Cmd,
  KeyPressMsg,
  type Model,
  type Msg,
  NewProgram,
  type Program,
  Quit,
  Tick,
  View,
  WindowSizeMsg,
} from '@oakoliver/bubbletea';
import { newTextInput, newViewport } from '@oakoliver/bubbles';
import { Center, Left, Top, joinHorizontal, joinVertical, newStyle, place, roundedBorder, stringWidth, truncate, wrap } from '@oakoliver/lipgloss';
import { createHash } from 'node:crypto';
import {
  ErrServerClosed,
  NewServer,
  type Option,
  type Session,
  WithAddress,
  WithAuthorizedKeys,
  WithHostKeyPath,
  WithIdleTimeout,
  WithMiddleware,
  WithPublicKeyAuth,
  activeterm,
  log,
  logging,
  ratelimiter,
} from '../src/index.ts';
import * as bubbletea from '../src/bubbletea.ts';

// ── flags ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: bun examples/lobby.ts [--host 127.0.0.1] [--port 23236] [--authorized-keys FILE]');
  process.exit(0);
}
const host = flag('--host') ?? '127.0.0.1';
const port = Number(flag('--port') ?? 23236);
const authorizedKeys = flag('--authorized-keys');

// ── palette (Catppuccin Mocha) ─────────────────────────────────────────────
const C = {
  text: '#cdd6f4', sub: '#a6adc8', dim: '#6c7086', faint: '#45475a', base: '#1e1e2e', mantle: '#181825',
  mauve: '#cba6f7', green: '#a6e3a1', yellow: '#f9e2af', red: '#f38ba8', peach: '#fab387',
};
const NAME_COLORS = ['#f5c2e7', '#cba6f7', '#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#89dceb', '#74c7ec', '#89b4fa', '#b4befe', '#f2cdcd'];
const st = () => newStyle();
const fg = (color: string, s: string, bold = false) => st().foreground(color).bold(bold).render(s);

// ── the room: state shared by every session ────────────────────────────────
interface Member {
  id: number;
  name: string;
  tag: string; // four hex digits of the key fingerprint
  color: string;
  joined: number;
  lastActive: number;
  typingUntil: number;
  sent: number[]; // send times, for the flood limit
  program: Program | null;
}

type Entry =
  | { kind: 'chat'; at: number; from: Member; text: string; action: boolean }
  | { kind: 'system'; at: number; text: string };

/** Tells every program the room changed, so it renders again. */
class RoomChangedMsg {
  readonly _tag = 'RoomChangedMsg';
}

const TYPING_MS = 3000;
const IDLE_MS = 60_000;
const HISTORY = 300;
const MAX_LEN = 500;
const FLOOD_WINDOW_MS = 5000;
const FLOOD_MAX = 5;

class Room {
  readonly started = Date.now();
  readonly members = new Map<number, Member>();
  readonly history: Entry[] = [];
  private nextId = 1;
  private pending = false;

  join(name: string, fingerprint: string): Member {
    const digest = createHash('sha256').update(fingerprint).digest();
    const m: Member = {
      id: this.nextId++,
      name,
      tag: digest.toString('hex').slice(0, 4),
      color: NAME_COLORS[digest[4] % NAME_COLORS.length],
      joined: Date.now(),
      lastActive: Date.now(),
      typingUntil: 0,
      sent: [],
      program: null,
    };
    this.members.set(m.id, m);
    this.post({ kind: 'system', at: Date.now(), text: `→ ${m.name} #${m.tag} joined` });
    return m;
  }

  leave(m: Member): void {
    if (!this.members.delete(m.id)) return;
    this.post({ kind: 'system', at: Date.now(), text: `← ${m.name} #${m.tag} left` });
  }

  /** Records a message; returns an error to show the sender, or null. */
  say(m: Member, raw: string): string | null {
    const now = Date.now();
    m.sent = m.sent.filter((t) => now - t < FLOOD_WINDOW_MS);
    if (m.sent.length >= FLOOD_MAX) return `slow down: at most ${FLOOD_MAX} messages every ${FLOOD_WINDOW_MS / 1000} seconds`;
    let text = clean(raw).slice(0, MAX_LEN).trim();
    if (!text) return null;
    let action = false;
    if (text === '/who') return `here: ${[...this.members.values()].map((x) => `${x.name}#${x.tag}`).join(', ')}`;
    if (text.startsWith('/me ')) {
      action = true;
      text = text.slice(4).trim();
    } else if (text.startsWith('/')) return `unknown command ${text.split(' ')[0]} (try /me or /who)`;
    m.sent.push(now);
    m.typingUntil = 0;
    m.lastActive = now;
    this.post({ kind: 'chat', at: now, from: m, text, action });
    return null;
  }

  typing(m: Member, active: boolean): void {
    const until = active ? Date.now() + TYPING_MS : 0;
    const was = m.typingUntil > Date.now();
    m.typingUntil = until;
    m.lastActive = Date.now();
    if (was !== active) this.changed();
  }

  private post(e: Entry): void {
    this.history.push(e);
    if (this.history.length > HISTORY) this.history.shift();
    this.changed();
  }

  /** Coalesces bursts of changes into one broadcast per tick. */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const m of this.members.values()) m.program?.send(new RoomChangedMsg());
    });
  }
}

const room = new Room();

// Typing indicators and idle markers expire on their own; nudge everyone
// once a second so the member list catches up.
setInterval(() => {
  if (room.members.size) room.changed();
}, 1000).unref();

/**
 * Removes everything that could steer another user's terminal: escape
 * sequences, C0/C1 controls, and bidi overrides. Tabs become spaces.
 */
function clean(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '')
    .replace(/\t/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '');
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const ago = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`);

// ── the per-session model ──────────────────────────────────────────────────
const SIDEBAR = 26;

class Lobby implements Model {
  width = 0;
  height = 0;
  input = newTextInput();
  vp = newViewport();
  follow = true;
  notice = '';
  lastRendered = -1;

  constructor(readonly me: Member) {
    this.input.prompt = '❯ ';
    this.input.placeholder = 'say something…  (/me waves, /who)';
    this.input.charLimit = MAX_LEN;
    const styles = this.input.styles();
    styles.focused.prompt = st().foreground(me.color).bold(true);
    styles.focused.text = st().foreground(C.text);
    styles.focused.placeholder = st().foreground(C.dim);
    styles.cursor.color = me.color;
    this.input.setStyles(styles);
    this.input.focus();
  }

  init(): Cmd {
    return null;
  }

  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof WindowSizeMsg) {
      this.width = msg.width;
      this.height = msg.height;
      this.layout();
      return [this, null];
    }
    if (msg instanceof RoomChangedMsg) {
      this.refresh();
      return [this, null];
    }
    if ((msg as { _tag?: string })?._tag === 'ClearNotice') {
      this.notice = '';
      return [this, null];
    }
    if (msg instanceof KeyPressMsg) {
      const key = msg.toString();
      if (key === 'ctrl+c' || key === 'ctrl+d') return [this, Quit];
      if (key === 'pgup' || key === 'pgdown') {
        if (key === 'pgup') this.vp.pageUp();
        else this.vp.pageDown();
        this.follow = this.vp.atBottom();
        return [this, null];
      }
      if (key === 'enter') {
        const err = room.say(this.me, this.input.value());
        this.input.reset();
        this.follow = true;
        if (err) {
          this.notice = err;
          return [this, Tick(4000, () => ({ _tag: 'ClearNotice' }))];
        }
        return [this, null];
      }
      const before = this.input.value();
      const [, cmd] = this.input.update(msg);
      const after = this.input.value();
      if (after !== before) room.typing(this.me, after.trim() !== '');
      return [this, cmd];
    }
    const [, cmd] = this.input.update(msg);
    return [this, cmd];
  }

  layout(): void {
    const mainW = Math.max(20, this.width - SIDEBAR - 1);
    this.vp.setWidth(mainW);
    this.vp.setHeight(Math.max(3, this.height - 5));
    this.input.setWidth(Math.max(10, mainW - 4));
    this.lastRendered = -1;
    this.refresh();
  }

  /** Re-renders the transcript into the viewport, following the bottom if we were there. */
  refresh(): void {
    if (!this.width) return;
    const width = this.vp.width();
    const lines: string[] = [];
    const mention = new RegExp(`@${this.me.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const e of room.history) {
      const time = fg(C.faint, hhmm(e.at) + ' ');
      if (e.kind === 'system') {
        lines.push(time + fg(C.dim, e.text));
        continue;
      }
      const who = fg(e.from.color, e.from.name, true) + fg(C.faint, '#' + e.from.tag);
      const lead = e.action ? `${fg(C.dim, '* ')}${who} ` : `${who} `;
      const indent = 6 + stringWidth(lead);
      const body = wrap(e.text, Math.max(10, width - indent)).split('\n');
      // Messages that mention you get a yellow time stamp and text.
      const mentioned = e.from !== this.me && mention.test(e.text);
      const color = mentioned ? C.yellow : e.action ? C.sub : C.text;
      const stamp = mentioned ? fg(C.yellow, hhmm(e.at) + ' ', true) : time;
      body.forEach((line, i) => lines.push((i === 0 ? stamp + lead : ' '.repeat(indent)) + fg(color, line)));
    }
    this.vp.setContent(lines.join('\n'));
    if (this.follow) this.vp.gotoBottom();
  }

  sidebar(): string {
    const now = Date.now();
    const rows = [fg(C.mauve, `HERE (${room.members.size})`, true), ''];
    const members = [...room.members.values()].sort((a, b) => a.joined - b.joined);
    for (const m of members.slice(0, Math.max(1, this.height - 8))) {
      const typing = m.typingUntil > now;
      const idle = now - m.lastActive > IDLE_MS;
      const dot = typing ? fg(C.yellow, '✎') : idle ? fg(C.faint, '○') : fg(C.green, '●');
      const name = truncate(m.name, SIDEBAR - 12);
      const self = m === this.me ? fg(C.dim, ' (you)') : '';
      const status = typing ? fg(C.yellow, ' typing') : idle ? fg(C.faint, ' ' + ago(now - m.lastActive)) : '';
      rows.push(`${dot} ${fg(m.color, name, true)}${fg(C.faint, '#' + m.tag)}${self}${status}`);
    }
    return st().width(SIDEBAR - 2).height(Math.max(3, this.height - 4)).padding(0, 1).border(roundedBorder()).borderForeground(C.faint).render(rows.join('\n'));
  }

  view(): View {
    const v = new View('');
    v.altScreen = true;
    v.windowTitle = 'Lobby';
    if (!this.width || !this.height) return v;
    if (this.width < 50 || this.height < 12) {
      v.content = place(this.width, this.height, Center, Center, fg(C.red, 'Make the window at least 50×12'));
      return v;
    }
    const now = Date.now();
    const typers = [...room.members.values()].filter((m) => m !== this.me && m.typingUntil > now);
    const typingLine =
      typers.length === 0 ? '' : typers.length === 1 ? `${typers[0].name} is typing…` : typers.length === 2 ? `${typers[0].name} and ${typers[1].name} are typing…` : `${typers.length} people are typing…`;
    const mainW = this.vp.width();
    const header =
      fg(C.mauve, ' ◆ LOBBY', true) +
      fg(C.dim, `  ${room.members.size} here · up ${ago(now - room.started)} · you are `) +
      fg(this.me.color, this.me.name, true) +
      fg(C.faint, '#' + this.me.tag);
    const status = this.notice
      ? fg(C.red, this.notice)
      : typingLine
        ? fg(C.yellow, typingLine)
        : fg(C.faint, this.follow ? 'enter send · pgup/pgdn scroll · /me · /who · ctrl+c leave' : 'scrolled up · pgdn to follow');
    const main = joinVertical(Left, this.vp.view(), ' ' + truncate(status, mainW - 1), this.input.view());
    const body = joinHorizontal(Top, main, ' ', this.sidebar());
    v.content = joinVertical(Left, truncate(header, this.width), fg(C.faint, '─'.repeat(this.width)), body);
    return v;
  }
}

// ── the server ─────────────────────────────────────────────────────────────
function programHandler(s: Session): Program | null {
  const key = s.publicKey();
  if (!key) return null;
  const me = room.join(clean(s.user()).slice(0, 16) || 'anon', key.fingerprint());
  const [pty] = s.pty();
  const model = new Lobby(me);
  model.width = pty.window.width;
  model.height = pty.window.height;
  const p = NewProgram(model, ...bubbletea.MakeOptions(s));
  me.program = p;
  void p.wait().finally(() => room.leave(me));
  return p;
}

// Who may join. With --authorized-keys only those keys get in. Without it,
// ANY public key is accepted: that is the point of an open chat room, and the
// key only serves to tell people apart. Do not copy this into a server that
// guards anything; use WithAuthorizedKeys or check the key yourself.
const auth: Option = authorizedKeys ? WithAuthorizedKeys(authorizedKeys) : WithPublicKeyAuth(() => true);

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  auth,
  // Drop connections that go quiet for 30 minutes.
  WithIdleTimeout(30 * 60_000),
  WithMiddleware(
    bubbletea.MiddlewareWithProgramHandler(programHandler),
    activeterm.Middleware(),
    // At most 1 new session per second per IP, bursts of 5.
    ratelimiter.Middleware(ratelimiter.NewRateLimiter(1, 5, 1000)),
    logging.Middleware(),
  ),
);

async function stop() {
  log.info('Stopping SSH server');
  await srv.shutdown(AbortSignal.timeout(10_000)).catch(() => srv.close());
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

log.info('Starting SSH server', 'host', host, 'port', port, 'auth', authorizedKeys ? authorizedKeys : 'any key');
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});
