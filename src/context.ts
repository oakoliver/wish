/**
 * Context, addresses and the small value types shared by the server and its
 * sessions. Mirrors charm.land/ssh's Context, Window, Pty and Permissions.
 */

import type { Server } from './server.js';
import type { PublicKey } from './keys.js';

/** A network address, as Go's net.Addr. `toString()` gives `host:port`. */
export class Addr {
  constructor(
    /** The IP address, for example `127.0.0.1` or `::1`. */
    readonly ip: string,
    readonly port: number,
    readonly family: 'IPv4' | 'IPv6' | string = ip.includes(':') ? 'IPv6' : 'IPv4',
  ) {}

  network(): string {
    return 'tcp';
  }

  toString(): string {
    return this.ip.includes(':') ? `[${this.ip}]:${this.port}` : `${this.ip}:${this.port}`;
  }
}

/** Window is the size of a client's terminal, as ssh.Window. */
export interface Window {
  width: number;
  height: number;
  widthPixels: number;
  heightPixels: number;
}

/** Pty is the pseudo-terminal a client requested, as ssh.Pty. */
export interface Pty {
  /** The client's $TERM, for example `xterm-256color`. */
  term: string;
  window: Window;
  /** Terminal modes from the pty-req, keyed by name (`VINTR`, `ECHO`, ...). */
  modes: Record<string, number>;
}

/** Signal names a client can send, as ssh.Signal. */
export type Signal =
  | 'ABRT' | 'ALRM' | 'FPE' | 'HUP' | 'ILL' | 'INT' | 'KILL' | 'PIPE' | 'QUIT' | 'SEGV' | 'TERM' | 'USR1' | 'USR2'
  | (string & {});

/**
 * Permissions are passed from the authentication handlers to the session, as
 * gossh.Permissions. Handlers may set entries in `extensions` to remember
 * something about the user for later middleware.
 */
export interface Permissions {
  criticalOptions: Record<string, string>;
  extensions: Record<string, string>;
}

/** Context keys used by the server, as ssh.ContextKey*. */
export const ContextKeyUser = Symbol('user');
export const ContextKeySessionID = Symbol('session-id');
export const ContextKeyPermissions = Symbol('permissions');
export const ContextKeyClientVersion = Symbol('client-version');
export const ContextKeyServerVersion = Symbol('server-version');
export const ContextKeyLocalAddr = Symbol('local-addr');
export const ContextKeyRemoteAddr = Symbol('remote-addr');
export const ContextKeyServer = Symbol('ssh-server');
export const ContextKeyPublicKey = Symbol('public-key');

/**
 * Context is shared by every request and session of one SSH connection, as
 * ssh.Context. Go's `ctx.Done()` maps to `ctx.signal`, an AbortSignal that is
 * aborted when the connection closes.
 */
export class Context {
  private readonly values = new Map<unknown, unknown>();
  private readonly controller = new AbortController();

  constructor(server: Server) {
    this.values.set(ContextKeyServer, server);
    this.values.set(ContextKeyPermissions, { criticalOptions: {}, extensions: {} } satisfies Permissions);
  }

  /** Aborted when the connection closes. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** @internal */
  cancel(): void {
    this.controller.abort();
  }

  value<T = unknown>(key: unknown): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  setValue(key: unknown, value: unknown): void {
    this.values.set(key, value);
  }

  /** The user name the client asked for. */
  user(): string {
    return this.value<string>(ContextKeyUser) ?? '';
  }

  /** The session ID (exchange hash) as hex. Empty before the key exchange. */
  sessionID(): string {
    return this.value<string>(ContextKeySessionID) ?? '';
  }

  /** The client's version string, for example `SSH-2.0-OpenSSH_9.8`. */
  clientVersion(): string {
    return this.value<string>(ContextKeyClientVersion) ?? '';
  }

  /** The server's version string. */
  serverVersion(): string {
    return this.value<string>(ContextKeyServerVersion) ?? '';
  }

  remoteAddr(): Addr {
    return this.value<Addr>(ContextKeyRemoteAddr) ?? new Addr('', 0);
  }

  localAddr(): Addr {
    return this.value<Addr>(ContextKeyLocalAddr) ?? new Addr('', 0);
  }

  /** The permissions set by the authentication handlers. Mutable. */
  permissions(): Permissions {
    return this.value<Permissions>(ContextKeyPermissions)!;
  }

  /** The public key the client authenticated with, or null. */
  publicKey(): PublicKey | null {
    return this.value<PublicKey>(ContextKeyPublicKey) ?? null;
  }

  server(): Server {
    return this.value<Server>(ContextKeyServer)!;
  }
}
