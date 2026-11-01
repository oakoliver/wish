/**
 * Arena — the falling-blocks game from examples/blocks.ts served over SSH,
 * with a shared leaderboard. Every connection plays its own game in its own
 * Program; a panel beside the well shows who is playing right now (with their
 * live score) and the ten best games so far. Log in as `autoplay` to watch the
 * AI play; its games go on the board too, marked with a robot.
 *
 * Usage:
 *   bun examples/arena.ts                         listen on 127.0.0.1:23237
 *   bun examples/arena.ts --scores scores.json    keep the leaderboard in a file
 *   ssh -p 23237 alice@localhost                  play
 *   ssh -p 23237 autoplay@localhost               watch the AI
 *
 * Needs a terminal of at least 94×25 for the game and the board side by side
 * (62×25 for the game alone).
 */
import { type Cmd, KeyPressMsg, type Model, type Msg, NewProgram, type Program, View, WindowSizeMsg } from '@oakoliver/bubbletea';
import { Center, Top, joinHorizontal, newStyle, place, roundedBorder, truncate } from '@oakoliver/lipgloss';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  ErrServerClosed,
  NewServer,
  type Session,
  WithAddress,
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
import { Blocks } from './blocks.ts';

// ── flags ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: bun examples/arena.ts [--host 127.0.0.1] [--port 23237] [--scores FILE]');
  process.exit(0);
}
const host = flag('--host') ?? '127.0.0.1';
const port = Number(flag('--port') ?? 23237);
const scoresFile = flag('--scores');

const C = {
  text: '#cdd6f4', sub: '#a6adc8', dim: '#6c7086', faint: '#45475a', mauve: '#cba6f7', yellow: '#f9e2af',
  teal: '#94e2d5', peach: '#fab387', green: '#a6e3a1', pink: '#f5c2e7',
};
const NAME_COLORS = ['#f5c2e7', '#cba6f7', '#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#89dceb', '#89b4fa', '#b4befe'];
const fg = (color: string, s: string, bold = false) => newStyle().foreground(color).bold(bold).render(s);
const grouped = (n: number) => n.toLocaleString('en-US');

// ── shared state ───────────────────────────────────────────────────────────
interface Player {
  name: string;
  tag: string;
  color: string;
  bot: boolean;
  game: Blocks;
  program: Program | null;
}

interface Score {
  name: string;
  tag: string;
  bot: boolean;
  score: number;
  lines: number;
  level: number;
  at: string;
}

class RefreshMsg {
  readonly _tag = 'RefreshMsg';
}

const players = new Set<Player>();
let board: Score[] = [];
if (scoresFile) {
  try {
    board = JSON.parse(readFileSync(scoresFile, 'utf8')) as Score[];
  } catch {
    board = [];
  }
}

function record(p: Player, score: number, lines: number, level: number): void {
  if (score <= 0) return;
  board.push({ name: p.name, tag: p.tag, bot: p.bot, score, lines, level, at: new Date().toISOString() });
  board.sort((a, b) => b.score - a.score);
  board = board.slice(0, 50);
  if (scoresFile) writeFileSync(scoresFile, JSON.stringify(board, null, 2) + '\n');
  broadcast();
}

function broadcast(): void {
  for (const p of players) p.program?.send(new RefreshMsg());
}

// Live scores change with every piece; refresh the panels twice a second.
setInterval(() => {
  if (players.size > 1) broadcast();
}, 500).unref();

/** Keeps a user name printable: letters, digits, dot, dash and underscore. */
const cleanName = (s: string) => s.replace(/[^\w.-]/g, '').slice(0, 12) || 'anon';

// ── the per-session model: the game plus the arena panel ───────────────────
const PANEL = 32;

class Arena implements Model {
  width = 0;
  height = 0;

  constructor(readonly me: Player) {}

  init(): Cmd {
    return this.me.game.init();
  }

  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof RefreshMsg) return [this, null];
    if (msg instanceof WindowSizeMsg) {
      this.width = msg.width;
      this.height = msg.height;
      const gameW = this.showPanel() ? msg.width - PANEL : msg.width;
      const [, cmd] = this.me.game.update(new WindowSizeMsg(gameW, msg.height));
      return [this, cmd];
    }
    if (msg instanceof KeyPressMsg && this.me.bot && msg.toString() !== 'q' && msg.toString() !== 'ctrl+c') {
      return [this, null]; // spectators only watch
    }
    const [, cmd] = this.me.game.update(msg);
    return [this, cmd];
  }

  showPanel(): boolean {
    return this.width >= 62 + PANEL;
  }

  panel(): string {
    const rows: string[] = [];
    const tag = (p: { name: string; tag: string; bot: boolean }, color: string) =>
      (p.bot ? '🤖 ' : '') + fg(color, truncate(p.name, 10), true) + fg(C.faint, '#' + p.tag);

    rows.push(fg(C.mauve, 'PLAYING NOW', true), '');
    const live = [...players].sort((a, b) => b.game.score - a.game.score);
    for (const p of live.slice(0, 6)) {
      const phase = p.game.phase === 'over' ? fg(C.faint, ' over') : p.game.phase === 'paused' ? fg(C.faint, ' paused') : '';
      const you = p === this.me ? fg(C.dim, ' ←') : '';
      rows.push(`${tag(p, p.color)}${you}`);
      rows.push(fg(C.sub, '  ' + grouped(p.game.score)) + fg(C.dim, ` · lvl ${p.game.level}`) + phase);
    }
    if (live.length > 6) rows.push(fg(C.dim, `  and ${live.length - 6} more`));

    rows.push('', fg(C.mauve, 'TOP 10', true), '');
    if (board.length === 0) rows.push(fg(C.dim, 'no finished games yet'));
    board.slice(0, 10).forEach((s, i) => {
      const medal = [C.yellow, C.sub, C.peach][i] ?? C.dim;
      rows.push(fg(medal, `${String(i + 1).padStart(2)}. `, true) + tag(s, C.text) + fg(C.teal, ' ' + grouped(s.score)));
    });
    rows.push('', fg(C.faint, 'user autoplay: watch the AI'));
    return newStyle()
      .width(PANEL - 4)
      .padding(0, 1)
      .border(roundedBorder())
      .borderForeground(C.faint)
      .render(rows.join('\n'));
  }

  view(): View {
    const game = this.me.game.view();
    const v = new View('');
    v.altScreen = true;
    v.windowTitle = 'Arena';
    if (!this.width || !this.height) return v;
    if (!this.showPanel()) {
      v.content = game.content;
      return v;
    }
    const panel = place(PANEL, this.height, Center, Center, this.panel());
    v.content = joinHorizontal(Top, game.content, panel);
    return v;
  }
}

// ── the server ─────────────────────────────────────────────────────────────
function programHandler(s: Session): Program | null {
  const key = s.publicKey();
  if (!key) return null;
  const digest = createHash('sha256').update(key.fingerprint()).digest();
  const bot = s.user() === 'autoplay';
  const game = new Blocks();
  game.autoplay = bot;
  const me: Player = {
    name: bot ? 'autoplay' : cleanName(s.user()),
    tag: digest.toString('hex').slice(0, 4),
    color: NAME_COLORS[digest[4] % NAME_COLORS.length],
    bot,
    game,
    program: null,
  };
  game.onGameOver = (score, lines, level) => record(me, score, lines, level);
  const p = NewProgram(new Arena(me), ...bubbletea.MakeOptions(s));
  me.program = p;
  players.add(me);
  broadcast();
  void p.wait().finally(() => {
    players.delete(me);
    broadcast();
  });
  return p;
}

const srv = NewServer(
  WithAddress(`${host}:${port}`),
  WithHostKeyPath('.ssh/id_ed25519'),
  // ANY public key may play: the key only gives each player a stable tag on
  // the leaderboard. This is fine for a game; it is not access control.
  WithPublicKeyAuth(() => true),
  WithIdleTimeout(15 * 60_000),
  WithMiddleware(
    bubbletea.MiddlewareWithProgramHandler(programHandler),
    activeterm.Middleware(),
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

log.info('Starting SSH server', 'host', host, 'port', port, 'scores', scoresFile ?? 'in memory');
srv.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) log.error('Could not start server', 'error', err);
});

