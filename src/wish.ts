/**
 * The root of wish: NewServer, its options, and the print helpers.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Context } from './context.js';
import { sprint, sprintf, sprintln } from './format.js';
import { loadOrGenerateHostKey, parseHostKey } from './hostkey.js';
import { Certificate, CheckCert, KeysEqual, ParseAuthorizedKey, type PublicKey } from './keys.js';
import { log } from './log.js';
import {
  type BannerHandler,
  type ConnCallback,
  type Handler,
  type KeyboardInteractiveHandler,
  type Option,
  type PasswordHandler,
  type PublicKeyHandler,
  Server,
  type SubsystemHandler,
} from './server.js';
import type { Session } from './session.js';

/**
 * Middleware takes the next handler and returns a handler, as
 * wish.Middleware. Implementations should call `next`.
 */
export type Middleware = (next: Handler) => Handler;

/**
 * NewServer returns a server configured with the given options, as
 * wish.NewServer. When no host key is given, the ed25519 key at
 * `./id_ed25519` is used, and generated first if it does not exist.
 *
 * Like upstream, a server with no authentication handler accepts every
 * client: set WithPublicKeyAuth, WithPasswordAuth, WithKeyboardInteractiveAuth
 * or WithAuthorizedKeys before exposing it.
 */
export function NewServer(...options: Option[]): Server {
  const srv = new Server();
  for (const option of options) srv.setOption(option);
  if (srv.hostSigners.length === 0) {
    srv.setOption(WithHostKeyPEM(loadOrGenerateHostKey('id_ed25519')));
  }
  return srv;
}

// ── ssh options (charm.land/ssh) ──────────────────────────────────────────

/** Sets the password handler, as ssh.PasswordAuth. */
export function PasswordAuth(fn: PasswordHandler): Option {
  return (srv) => {
    srv.passwordHandler = fn;
  };
}

/** Sets the public key handler, as ssh.PublicKeyAuth. */
export function PublicKeyAuth(fn: PublicKeyHandler): Option {
  return (srv) => {
    srv.publicKeyHandler = fn;
  };
}

/** Sets the keyboard-interactive handler, as ssh.KeyboardInteractiveAuth. */
export function KeyboardInteractiveAuth(fn: KeyboardInteractiveHandler): Option {
  return (srv) => {
    srv.keyboardInteractiveHandler = fn;
  };
}

/** Adds the private key in `path` as a host key, as ssh.HostKeyFile. */
export function HostKeyFile(path: string): Option {
  return (srv) => {
    srv.hostSigners.push(parseHostKey(readFileSync(path), path));
  };
}

/** Adds a PEM or OpenSSH private key as a host key, as ssh.HostKeyPEM. */
export function HostKeyPEM(pem: string | Buffer): Option {
  return (srv) => {
    srv.hostSigners.push(parseHostKey(pem));
  };
}

/** Refuses every PTY request, as ssh.NoPty. */
export function NoPty(): Option {
  return (srv) => {
    srv.ptyCallback = () => false;
  };
}

/**
 * Accepts PTY requests and emulates them, as ssh.EmulatePty. This is the
 * default: the port cannot allocate real PTYs (see the README).
 */
export function EmulatePty(): Option {
  return (srv) => {
    srv.ptyCallback = null;
  };
}

/** Wraps or rejects (by returning null) each accepted socket, as ssh.WrapConn. */
export function WrapConn(fn: ConnCallback): Option {
  return (srv) => {
    srv.connCallback = fn;
  };
}

// ── wish options ──────────────────────────────────────────────────────────

/** Sets the address to listen on, `host:port`, as wish.WithAddress. */
export function WithAddress(addr: string): Option {
  return (srv) => {
    srv.addr = addr;
  };
}

/** Sets the server version, sent as `SSH-2.0-<version>`, as wish.WithVersion. */
export function WithVersion(version: string): Option {
  return (srv) => {
    srv.version = version;
  };
}

/** Sets the banner shown before authentication, as wish.WithBanner. */
export function WithBanner(banner: string): Option {
  return (srv) => {
    srv.banner = banner;
  };
}

/** Sets a banner handler that overrides WithBanner, as wish.WithBannerHandler. */
export function WithBannerHandler(h: BannerHandler): Option {
  return (srv) => {
    srv.bannerHandler = h;
  };
}

/**
 * Composes middleware into the server's handler, as wish.WithMiddleware.
 * Middleware is composed first to last, so the last one runs first.
 */
export function WithMiddleware(...mw: Middleware[]): Option {
  return (srv) => {
    let h: Handler = () => {};
    for (const m of mw) h = m(h);
    srv.handler = h;
  };
}

/**
 * Uses the private key at `path` as the host key, generating an ed25519 key
 * there (and the directory, mode 0700) if it does not exist, as
 * wish.WithHostKeyPath.
 */
export function WithHostKeyPath(path: string): Option {
  return (srv) => {
    srv.hostSigners.push(loadOrGenerateHostKey(path));
  };
}

/** Uses a PEM or OpenSSH private key as the host key, as wish.WithHostKeyPEM. */
export function WithHostKeyPEM(pem: string | Buffer): Option {
  return HostKeyPEM(pem);
}

/**
 * Allows exactly the keys listed in an authorized_keys file, as
 * wish.WithAuthorizedKeys. The file is read again on every attempt, so edits
 * apply without a restart. Throws if the file does not exist.
 */
export function WithAuthorizedKeys(path: string): Option {
  return (srv) => {
    statOrThrow(path);
    srv.setOption(WithPublicKeyAuth((_ctx, key) => isAuthorized(path, (k) => KeysEqual(key, k))));
  };
}

/**
 * Accepts user certificates signed by one of the CA keys in `path` and still
 * valid for the user, as wish.WithTrustedUserCAKeys (OpenSSH's
 * TrustedUserCAKeys). Plain keys are refused.
 */
export function WithTrustedUserCAKeys(path: string): Option {
  return (srv) => {
    statOrThrow(path);
    srv.setOption(
      WithPublicKeyAuth((ctx: Context, key: PublicKey) => {
        if (!(key instanceof Certificate)) return false;
        return isAuthorized(path, (ca) => {
          if (!KeysEqual(ca, key.signatureKey)) return false;
          try {
            CheckCert(key, ctx.user(), ctx.remoteAddr().ip);
            return true;
          } catch {
            return false;
          }
        });
      }),
    );
  };
}

function statOrThrow(path: string): void {
  try {
    statSync(path);
  } catch (err) {
    throw new Error(`stat ${path}: ${(err as Error).message}`);
  }
}

/**
 * Reports whether `checker` accepts one of the keys in an authorized_keys
 * file. A missing or malformed file authorizes nobody.
 * @internal exported for tests
 */
export function isAuthorized(path: string, checker: (k: PublicKey) => boolean): boolean {
  let text: string;
  try {
    if (!existsSync(path)) throw new Error('no such file or directory');
    text = readFileSync(path, 'utf8');
  } catch (err) {
    log.warn('failed to parse', 'path', path, 'error', err);
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    let key: PublicKey;
    try {
      [key] = ParseAuthorizedKey(trimmed);
    } catch (err) {
      log.warn('failed to parse', 'path', path, 'error', err);
      return false;
    }
    if (checker(key)) return true;
  }
  return false;
}

/** Sets the public key handler, as wish.WithPublicKeyAuth. */
export function WithPublicKeyAuth(h: PublicKeyHandler): Option {
  return PublicKeyAuth(h);
}

/** Sets the password handler, as wish.WithPasswordAuth. */
export function WithPasswordAuth(h: PasswordHandler): Option {
  return PasswordAuth(h);
}

/** Sets the keyboard-interactive handler, as wish.WithKeyboardInteractiveAuth. */
export function WithKeyboardInteractiveAuth(h: KeyboardInteractiveHandler): Option {
  return KeyboardInteractiveAuth(h);
}

/** Closes connections with no traffic for `ms` milliseconds, as wish.WithIdleTimeout. */
export function WithIdleTimeout(ms: number): Option {
  return (srv) => {
    srv.idleTimeout = ms;
  };
}

/** Closes connections `ms` milliseconds after they were accepted, as wish.WithMaxTimeout. */
export function WithMaxTimeout(ms: number): Option {
  return (srv) => {
    srv.maxTimeout = ms;
  };
}

/** Sets the handler for a subsystem such as `sftp`, as wish.WithSubsystem. */
export function WithSubsystem(key: string, h: SubsystemHandler): Option {
  return (srv) => {
    srv.subsystemHandlers[key] = h;
  };
}

// ── TypeScript-only options ───────────────────────────────────────────────

/**
 * Closes connections that have not authenticated `ms` milliseconds after
 * they were accepted (the Server.HandshakeTimeout field of charm.land/ssh,
 * which wish has no option for).
 */
export function WithHandshakeTimeout(ms: number): Option {
  return (srv) => {
    srv.handshakeTimeout = ms;
  };
}

/**
 * Disconnects a client after `n` failed authentication attempts (default 6,
 * as golang.org/x/crypto/ssh). 0 disables the limit.
 */
export function WithMaxAuthTries(n: number): Option {
  return (srv) => {
    srv.maxAuthTries = n;
  };
}

/**
 * Sends an SSH keepalive every `intervalMs` and drops the client after
 * `countMax` unanswered ones. Off by default, as in Go. Keepalive traffic
 * counts as activity for WithIdleTimeout.
 */
export function WithKeepAlive(intervalMs: number, countMax = 3): Option {
  return (srv) => {
    srv.keepAliveInterval = intervalMs;
    srv.keepAliveCountMax = countMax;
  };
}

// ── Printing ──────────────────────────────────────────────────────────────

/** Prints to the session's stderr and exits with status 1, as wish.Fatal. */
export function Fatal(s: Session, ...v: unknown[]): Promise<void> {
  printError(s, ...v);
  return s.exit(1).catch(() => {});
}

/** Formats to the session's stderr and exits with status 1, as wish.Fatalf. */
export function Fatalf(s: Session, f: string, ...v: unknown[]): Promise<void> {
  Errorf(s, f, ...v);
  return s.exit(1).catch(() => {});
}

/** Prints a line to the session's stderr and exits with status 1, as wish.Fatalln. */
export function Fatalln(s: Session, ...v: unknown[]): Promise<void> {
  Errorln(s, ...v);
  Errorf(s, '\r');
  return s.exit(1).catch(() => {});
}

/** Prints to the session's stderr, as wish.Error. */
function printError(s: Session, ...v: unknown[]): void {
  s.stderr().write(sprint(...v));
}

/** Formats to the session's stderr, as wish.Errorf. */
export function Errorf(s: Session, f: string, ...v: unknown[]): void {
  s.stderr().write(sprintf(f, ...v));
}

/** Prints a line to the session's stderr, as wish.Errorln. */
export function Errorln(s: Session, ...v: unknown[]): void {
  s.stderr().write(sprintln(...v));
}

/** Prints to the session, as wish.Print. */
export function Print(s: Session, ...v: unknown[]): void {
  s.write(sprint(...v));
}

/** Formats to the session, as wish.Printf. */
export function Printf(s: Session, f: string, ...v: unknown[]): void {
  s.write(sprintf(f, ...v));
}

/** Prints a line to the session, as wish.Println. */
export function Println(s: Session, ...v: unknown[]): void {
  s.write(sprintln(...v));
}

/** Writes a string to the session and returns its length in bytes, as wish.WriteString. */
export function WriteString(s: Session, v: string): number {
  s.write(v);
  return Buffer.byteLength(v);
}

export { printError as Error };
