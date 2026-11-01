# Examples

Every example listens on `127.0.0.1`. Run them from the repository root with
Bun after `bun install`; they import this repository's source
(`../src/index.ts`) and the sibling ports, which are dev dependencies. Each
one creates its host key in `.ssh/id_ed25519` the first time.

We recommend following them in this order, as upstream's
[examples](https://github.com/charmbracelet/wish/tree/main/examples) do.

## Basics

```sh
bun examples/simple.ts             # ssh -p 23234 localhost
bun examples/graceful-shutdown.ts  # ctrl+c waits for open sessions
bun examples/banner.ts             # banner, password auth, elapsed time
bun examples/identity.ts           # recognise users by public key
bun examples/multi-auth.ts         # public key, password and keyboard-interactive
```

## Making SSH apps

```sh
bun examples/bubbletea.ts          # a Bubble Tea app per session
bun examples/bubbleteaprogram.ts   # keep the Program and send it messages
bun examples/multichat.ts          # sessions that talk to each other
```

## Git and SCP

```sh
bun examples/git.ts                # ssh -p 23233 localhost; git push ssh://localhost:23233/repo
bun examples/scp.ts                # scp -O -P 23235 file localhost:
```

## Larger programs

Each has a recording in `assets/`, made from its tape in `assets/tapes/`.
The tapes start the server in their hidden section, and
`assets/tapes/bots.ts` connects other users from a background process.

```sh
bun examples/lobby.ts [--authorized-keys FILE]   # chat room: ssh -p 23236 you@localhost
bun examples/arena.ts [--scores FILE]            # game + leaderboard: ssh -p 23237 you@localhost
                                                 # (user "autoplay" watches the AI)
bun examples/blocks.ts [--autoplay]              # the game alone, in your terminal
```

`blocks.ts` is copied from the
[@oakoliver/bubbletea](https://github.com/oakoliver/bubbletea) examples; the
comment at its top lists the changes.

## Not ported

Upstream's `pty`, `exec` and `bubbletea-exec` need a real pseudo-terminal,
which this port cannot allocate (see Parity in the README). `forward` needs
port forwarding, which is not implemented, and `cobra` is a Go CLI library.
The SCP example has no SFTP subsystem.
