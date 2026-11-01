# @oakoliver/wish

Build SSH apps in TypeScript. A port of [charmbracelet/wish](https://github.com/charmbracelet/wish): an SSH server with sensible defaults, authentication handlers, timeouts and a set of middleware, including one that serves a [Bubble Tea](https://github.com/oakoliver/bubbletea) program to every SSH session. Version 1.0.0 ports **wish v2.0.5** (the release for Bubble Tea v2). It runs on Node.js (20+) and Bun.

<img alt="examples/lobby.ts: alice joins a chat room over SSH; ana arrives, the member list shows ana typing, ana's message lands; alice answers, ben joins and sends an action, and ana's reply that mentions alice is highlighted in yellow" src="https://raw.githubusercontent.com/oakoliver/wish/main/assets/lobby.gif" width="700">

```bash
ssh -p 23236 alice@localhost      # after: bun examples/lobby.ts
```

## Larger Examples

Two full programs in [`examples/`](examples/) serve Bubble Tea apps to several people at once. See [Running the examples](#running-the-examples).

### lobby.ts: a chat room

The recording at the top. Everyone who connects shares one room: arrivals and departures, a member list that shows who is typing while they type, `/me` actions, `/who`, mentions in yellow, a flood limit and scrollback. Names are the SSH user name plus a tag and a colour taken from the client's public key, so two people called alice can be told apart. Everything people type is stripped of escape sequences and control characters before anyone else sees it. `--authorized-keys FILE` limits the room to those keys.

### arena.ts: a game with a shared leaderboard

<img alt="examples/arena.ts: alice drops pieces until the game ends; the panel on the right lists the AI player and alice with live scores, and alice's score enters the top ten" src="https://raw.githubusercontent.com/oakoliver/wish/main/assets/arena.gif" width="760">

The falling-blocks game from the Bubble Tea examples, one game per connection, with a panel that lists who is playing right now (live scores) and the ten best games. Log in as `autoplay` to watch the AI play. `--scores FILE` keeps the leaderboard across restarts.

### Running the examples

The examples import this repository's source and the sibling ports, which are dev dependencies:

```bash
git clone https://github.com/oakoliver/wish && cd wish
bun install
bun examples/lobby.ts            # then: ssh -p 23236 you@localhost
bun examples/arena.ts            # then: ssh -p 23237 you@localhost
```

Every example listens on `127.0.0.1` only. The small ones mirror upstream's examples; [`examples/README.md`](examples/README.md) lists them all.

## Install

```bash
npm install @oakoliver/wish
# for the Bubble Tea middleware:
npm install @oakoliver/bubbletea @oakoliver/lipgloss
```

### Dependencies

This port is **not** zero-dependency, unlike the other `@oakoliver` Charm ports. SSH needs key exchange, ciphers, MACs, host-key signatures and the channel protocol, and writing those again would be a large, security-sensitive project of its own. It uses [`ssh2`](https://github.com/mscdex/ssh2) (MIT), the SSH implementation most Node.js projects use, as its only runtime dependency. `ssh2` brings `asn1` and `bcrypt-pbkdf`, and has two optional native add-ons (`cpu-features`, and its own `sshcrypto` binding) that it uses when they compile and does without when they don't. `@oakoliver/bubbletea` and `@oakoliver/lipgloss` are optional peer dependencies, needed only for `@oakoliver/wish/bubbletea`.

## Quick Start

```typescript
import { type Cmd, KeyPressMsg, type Model, type Msg, Quit, WindowSizeMsg } from '@oakoliver/bubbletea';
import { ErrServerClosed, NewServer, WithAddress, WithHostKeyPath, WithMiddleware, activeterm, logging } from '@oakoliver/wish';
import * as bubbletea from '@oakoliver/wish/bubbletea';

class Hello implements Model {
  width = 0;
  height = 0;
  user: string;
  constructor(user: string) {
    this.user = user;
  }
  init(): Cmd {
    return null;
  }
  update(msg: Msg): [Model, Cmd] {
    if (msg instanceof WindowSizeMsg) [this.width, this.height] = [msg.width, msg.height];
    if (msg instanceof KeyPressMsg) return [this, Quit];
    return [this, null];
  }
  view(): string {
    return `Hello, ${this.user}! Your terminal is ${this.width}×${this.height}.\nPress any key to leave.\n`;
  }
}

const server = NewServer(
  WithAddress('127.0.0.1:23234'),
  WithHostKeyPath('.ssh/id_ed25519'),
  WithMiddleware(
    bubbletea.Middleware((session) => [new Hello(session.user()), []]),
    activeterm.Middleware(),
    logging.Middleware(),
  ),
);

server.listenAndServe().catch((err) => {
  if (err !== ErrServerClosed) console.error(err);
});
```

```bash
ssh -p 23234 localhost
```

<img alt="examples/bubbletea.ts: an SSH session shows the client's TERM, window size, background colour and colour profile" src="https://raw.githubusercontent.com/oakoliver/wish/main/assets/bubbletea.gif" width="600">

The server above lets anyone in: like upstream, a server with no authentication handler accepts every client. That is fine on `127.0.0.1`. Read [Running one safely](#running-one-safely) before binding it to anything else.

## Middleware

A middleware takes the next handler and returns a handler. Handlers may be async. `WithMiddleware(a, b, c)` composes them first to last, so **the last one runs first** (here `c`, then `b`, then `a`).

| Middleware | Import | What it does |
| --- | --- | --- |
| `bubbletea.Middleware(handler)` | `@oakoliver/wish/bubbletea` | One Bubble Tea `Program` per session, with the session as input and output, the PTY size, the client's environment, a colour profile detected from it, and a `WindowSizeMsg` on every resize. Output is downsampled to that profile with Lip Gloss. |
| `bubbletea.MiddlewareWithProgramHandler(fn)` | same | The same, but you build the `Program` (with `MakeOptions(session)`) and keep it, for example to `send` it messages from other sessions. |
| `logging.Middleware()` / `StructuredMiddleware()` | `@oakoliver/wish` or `/logging` | Logs connects (user, address, key or not, command, TERM, size, client version) and disconnects (duration). |
| `activeterm.Middleware()` | `/activeterm` | Refuses sessions without a PTY. |
| `accesscontrol.Middleware(...commands)` | `/accesscontrol` | Refuses commands that are not listed. |
| `ratelimiter.Middleware(NewRateLimiter(rate, burst, maxEntries))` | `/ratelimiter` | Token bucket per client IP (an LRU of `maxEntries`). |
| `recover.Middleware(...mw)` | `/recover` | Catches what the wrapped chain and the next handler throw or reject with, logs it with the stack, and goes on. |
| `elapsed.Middleware()` | `/elapsed` | Prints how long the session took, as a Go duration. |
| `comment.Middleware(text)` | `/comment` | Prints a line at the end of the session. |
| `git.Middleware(repoDir, hooks)` | `/git` | A Git server (`git-upload-pack`, `git-receive-pack`, `git-upload-archive`) with per-repo access levels; needs `git` on the server. |
| `scp.Middleware(readHandler, writeHandler)` | `/scp` | SCP uploads and downloads, with a filesystem handler confined to a root (symlinks included) and a read-only handler over any `FS`. |

All of them except `bubbletea` are also exported from the main entry as namespaces (`import { logging } from '@oakoliver/wish'`). The Bubble Tea one has its own entry so that the main entry does not need the peer packages.

## Server options

| Option | Upstream | Notes |
| --- | --- | --- |
| `WithAddress('host:port')` | same | `':22'` when empty. |
| `WithHostKeyPath(path)` | same | Loads the key, or generates an ed25519 key there (mode 0600, directory 0700) and a `.pub` beside it. |
| `WithHostKeyPEM(pem)` | same | OpenSSH or PEM private key. Encrypted keys are refused. |
| `WithPublicKeyAuth(fn)` / `WithPasswordAuth(fn)` / `WithKeyboardInteractiveAuth(fn)` | same | Handlers get the `Context` and may be async. A throwing handler counts as a refusal. |
| `WithAuthorizedKeys(path)` | same | Allows exactly the keys in an `authorized_keys` file, read again on every attempt. |
| `WithTrustedUserCAKeys(path)` | same | Accepts OpenSSH user certificates signed by those CAs. |
| `WithBanner(text)` / `WithBannerHandler(fn)` | same | Sent before authentication; the handler sees the user name. |
| `WithIdleTimeout(ms)` / `WithMaxTimeout(ms)` | same | Milliseconds, not `time.Duration`. |
| `WithMiddleware(...mw)` / `WithSubsystem(name, handler)` / `WithVersion(v)` | same | |
| `PublicKeyAuth`, `PasswordAuth`, `KeyboardInteractiveAuth`, `HostKeyFile`, `HostKeyPEM`, `NoPty`, `EmulatePty`, `WrapConn` | `charm.land/ssh` | The `ssh.Option`s upstream's examples use. |
| `WithHandshakeTimeout(ms)` | — | TypeScript only: closes connections that have not authenticated in time (the `HandshakeTimeout` field of `charm.land/ssh`). |
| `WithMaxAuthTries(n)` | — | TypeScript only: disconnect after `n` failed attempts (default 6, as `golang.org/x/crypto/ssh`). |
| `WithKeepAlive(ms, count)` | — | TypeScript only: SSH keepalives, off by default as in Go. |

## How Go's concepts map

| Go (`charm.land/ssh`, `wish`) | TypeScript |
| --- | --- |
| `ssh.Server`, `ssh.Option func(*Server) error` | `Server` class; `Option = (srv: Server) => void`, which throws on error |
| `srv.ListenAndServe()` returning `ssh.ErrServerClosed` | `srv.listenAndServe()` rejects with `ErrServerClosed`; `srv.listen()` resolves with the bound address |
| `srv.Shutdown(ctx)` / `srv.Close()` | `srv.shutdown(signal?)` / `srv.close()` |
| `ssh.Handler func(Session)` | `Handler = (s: Session) => void \| Promise<void>`; the session ends with exit status 0 when it resolves, 1 when it throws |
| `wish.Middleware` | `Middleware = (next: Handler) => Handler` |
| `ssh.Session` (an `io.ReadWriter` over the channel) | `Session`, a Node.js `Duplex`: pipe it, write to it, hand it to a `Program` |
| `s.User()`, `s.Command()`, `s.Environ()`, `s.PublicKey()`, `s.Exit(1)` | `s.user()`, `s.command()`, `s.environ()`, `s.publicKey()`, `await s.exit(1)` |
| `pty, winCh, ok := s.Pty()` | `const [pty, windowChanges, ok] = s.pty()`; `windowChanges.subscribe(fn)` or `for await (const w of windowChanges)` |
| `ssh.Context` and `ctx.Done()` | `Context`, with `ctx.signal`, an `AbortSignal` aborted when the connection closes |
| `ssh.PublicKey`, `ssh.KeysEqual`, `ssh.ParseAuthorizedKey` | `PublicKey` (`type()`, `marshal()`, `fingerprint()`), `KeysEqual`, `ParseAuthorizedKey` returning `[key, comment, options, rest]` |
| `*gossh.Certificate` | `Certificate` (a `PublicKey` with `validPrincipals`, `certType`, `keyId`, ...) |
| `gossh.KeyboardInteractiveChallenge` | `(name, instruction, questions, echos) => Promise<string[]>` |
| `tea.WithInput/WithOutput/WithEnvironment/WithColorProfile/WithWindowSize` per session | `bubbletea.MakeOptions(session)` |
| goroutine per connection and per session | event handlers on one event loop |

## Running one safely

People will point real SSH clients, and real scanners, at these servers.

- **Bind to loopback until you have authentication.** With no auth handler every client gets in (as upstream). The server logs a warning when it listens on a non-loopback address without one.
- **Authenticate.** `WithAuthorizedKeys('/etc/myapp/authorized_keys')` is the simplest real policy. A handler that returns `true` for every key, as the chat and game examples do, only identifies people; it keeps nobody out.
- **Set limits.** `WithIdleTimeout`, `WithMaxTimeout` and `WithHandshakeTimeout` close connections that stall, and the `ratelimiter` middleware limits sessions per IP. Without them a client can hold a connection open forever. Failed authentication attempts are capped at 6 per connection.
- **Keep sessions apart.** The server catches what a handler throws or rejects with and ends only that session (exit status 1); `recover` does the same inside a chain. Neither can catch an error thrown later from a timer or an event listener the handler set up, which, as in any Node.js program, reaches `uncaughtException`: guard those callbacks. The Bubble Tea middleware catches errors in its own resize listener, and Bubble Tea catches errors in `update` and `view`, so a crashing model ends its own session only.
- **Clean what users type before you show it to other users**: strip escape sequences and control characters (see `clean()` in `examples/lobby.ts`).
- **Run it as an unprivileged user.** Listen on a high port and forward 22 to it, or grant `CAP_NET_BIND_SERVICE` instead of running as root. A systemd unit with `User=myapp`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes` and `ReadWritePaths=/var/lib/myapp` (where the host key lives) is a good start; so is a container running as a non-root user with the host key on a volume.
- **Keep the host key.** It is the server's identity: generate it once, back it up, keep it `0600`. A new key makes every client warn about a changed host.

## Parity

All of wish v2.0.5's Go packages are ported, and its tests are ported to `bun test` in `tests/`: they start real servers and connect with `ssh2`'s client, or with OpenSSH and Git where upstream does. **152 tests pass on Bun 1.4 and on Node.js 26** (`npm run test:node` runs the same files under Node's test runner against the built `dist/`). The 32 tests in `tests/server.test.ts` and `tests/bubbletea.test.ts` are new: limits and timeouts, signature checks, authentication edge cases, session isolation, and the Bubble Tea middleware, which has no tests upstream.

What is missing or different:

- **No real PTYs.** Go's `ssh.AllocatePty()` gives a session a kernel pseudo-terminal; Node.js has none without a native add-on, so every PTY here is emulated (as `ssh.EmulatePty()` in Go): the client's size, `TERM` and resizes are known and `\n` becomes `\r\n`, which is all Bubble Tea needs. `Command(session, ...)` therefore runs programs on pipes: line-oriented programs work, full-screen ones such as `vim` or a shell do not. Upstream's `pty`, `exec` and `bubbletea-exec` examples are not ported.
- **No SFTP, port forwarding, agent forwarding, X11, PROXY protocol or `break` requests.** `WithSubsystem('sftp', ...)` works, but no SFTP server is bundled. Forwarding requests are refused, which is also Go's default.
- **SCP** speaks the classic protocol (`scp -O` on OpenSSH 9+). As upstream, the target of an upload is treated as a directory.
- **Stricter certificate checks**: `WithTrustedUserCAKeys` also requires a *user* certificate and enforces the `source-address` critical option; upstream checks neither.
- **`MakeOptions`** also turns off Bubble Tea's process signal handlers (one process serves many programs) and, as upstream, turns suspend into resume. Like upstream it sets a `WithFilter`, which replaces one you passed earlier.
- **Logging** uses a small built-in logger in charm `log`'s format; replace it with `SetLogger`.
- **Durations** are milliseconds.
- **Bun**: `chacha20-poly1305` is not offered because Bun's `node:crypto` lacks the raw ChaCha20 cipher `ssh2` needs; clients negotiate AES-GCM instead. Everything else, including ed25519 host keys, certificates and the test suite, behaves the same on both runtimes.
- **Host keys** are generated with `node:crypto`, not with `ssh2`'s `generateKeyPairSync('ed25519')`, which drops a leading zero byte of the public key and so writes a key it cannot read back about once in every 256 keys.

## Attribution

A port of [wish](https://github.com/charmbracelet/wish) by [Charm](https://charm.sh), MIT licensed. The SSH protocol comes from [ssh2](https://github.com/mscdex/ssh2) by Brian White. `examples/blocks.ts` comes from the [@oakoliver/bubbletea](https://github.com/oakoliver/bubbletea) examples.

## License

[MIT](LICENSE)
