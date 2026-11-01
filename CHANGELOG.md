# Changelog

## 1.0.0 — port of wish v2.0.5

First release. Ports [wish v2.0.5](https://github.com/charmbracelet/wish/releases/tag/v2.0.5), the release for Bubble Tea v2, on top of the `ssh2` package.

### Added

- `NewServer` and the wish options: address, version, banner and banner handler, host key path and PEM (ed25519 keys generated and kept on first use), public key, password and keyboard-interactive auth, `authorized_keys`, trusted user CA keys, idle and max timeouts, subsystems, middleware.
- A `Server` shaped like `charm.land/ssh`'s, with `listen`, `listenAndServe`, `serve`, `shutdown` and `close`, a `Session` that is a Node.js `Duplex`, a `Context` with an `AbortSignal`, `PublicKey`, `Certificate`, `ParseAuthorizedKey` and `KeysEqual`.
- Middleware: `bubbletea` (with per-session colour profile and Lip Gloss downsampling), `logging`, `activeterm`, `accesscontrol`, `ratelimiter`, `recover`, `elapsed`, `comment`, `git`, `scp`, and the `testsession` helpers.
- `Command` / `Cmd`, usable as a Bubble Tea `ExecCommand`.
- TypeScript-only options: `WithHandshakeTimeout`, `WithMaxAuthTries`, `WithKeepAlive`.
- Upstream's tests ported to `bun test`, plus new tests for limits, timeouts, authentication, isolation and the Bubble Tea middleware: 154 tests, passing on Bun and on Node.js.
- Examples from upstream, and two larger ones: `lobby.ts` (a chat room) and `arena.ts` (a game with a shared leaderboard).

### Not ported

Real PTY allocation, SFTP, port and agent forwarding, X11, the PROXY protocol and `break` requests. See Parity in the README.
