/**
 * Server — an SSH server built on the `ssh2` package, shaped like
 * charm.land/ssh's Server (the gliderlabs/ssh fork that wish uses).
 *
 * Go runs one goroutine per connection and per session; here every connection
 * and session is a set of event handlers on one event loop, and handlers may
 * return a Promise. Durations are milliseconds.
 */

import { createRequire } from 'node:module';
import net, { type AddressInfo, type Socket } from 'node:net';
import ssh2 from 'ssh2';
import {
  Addr,
  Context,
  ContextKeyClientVersion,
  ContextKeyLocalAddr,
  ContextKeyPublicKey,
  ContextKeyRemoteAddr,
  ContextKeyServerVersion,
  ContextKeySessionID,
  ContextKeyUser,
  type Permissions,
  type Pty,
  type Window,
} from './context.js';
import { Certificate, ParsePublicKey, type PublicKey, verifyAuthSignature, verifySSHSignature } from './keys.js';
import { log } from './log.js';
import { generateEd25519 } from './hostkey.js';
import { Session, WindowChanges, type ChannelLike } from './session.js';
import { Duplex } from 'node:stream';

const { utils } = ssh2;

/** Handler handles one session, as ssh.Handler. It may return a Promise. */
export type Handler = (s: Session) => void | Promise<void>;
/** Option configures a Server, as ssh.Option. Options throw on error. */
export type Option = (srv: Server) => void;
export type BannerHandler = (ctx: Context) => string;
export type PublicKeyHandler = (ctx: Context, key: PublicKey) => boolean | Promise<boolean>;
export type PasswordHandler = (ctx: Context, password: string) => boolean | Promise<boolean>;
/** Asks the client questions; resolves with one answer per question. */
export type KeyboardInteractiveChallenge = (
  name: string,
  instruction: string,
  questions: string[],
  echos: boolean[],
) => Promise<string[]>;
export type KeyboardInteractiveHandler = (
  ctx: Context,
  challenger: KeyboardInteractiveChallenge,
) => boolean | Promise<boolean>;
export type PtyCallback = (ctx: Context, pty: Pty) => boolean;
export type SessionRequestCallback = (sess: Session, requestType: string) => boolean;
export type SubsystemHandler = Handler;
export type ConnCallback = (ctx: Context, socket: Socket) => Socket | null | undefined;
export type ConnectionFailedCallback = (socket: Socket, err: Error) => void;
export type ConnectionCloseCallback = (socket: Socket) => void;

/** Returned by listenAndServe and serve after close or shutdown, as ssh.ErrServerClosed. */
export const ErrServerClosed = new Error('ssh: Server closed');
/** As ssh.ErrPermissionDenied. */
export const ErrPermissionDenied = new Error('permission denied');

// x/crypto/ssh's default.
const DEFAULT_MAX_AUTH_TRIES = 6;
// setInterval's ceiling: ssh2 has no switch to turn its keepalive off.
const NO_KEEPALIVE = 2 ** 31 - 1;

// ssh2 has no public API for a per-connection banner: reach its packet writer.
declare const require: NodeJS.Require | undefined;
const requireSSH2 = (id: string) => (typeof require === 'function' ? require : createRequire(import.meta.url))(id);

/** Sends SSH_MSG_USERAUTH_BANNER (RFC 4252 §5.4) on an ssh2 connection. */
function sendAuthBanner(client: unknown, message: string): boolean {
  try {
    const proto = (client as { _protocol?: any })._protocol;
    const { sendPacket } = requireSSH2('ssh2/lib/protocol/utils.js');
    if (!proto?._packetRW || typeof sendPacket !== 'function') return false;
    const len = Buffer.byteLength(message);
    let p = proto._packetRW.write.allocStart;
    const packet = proto._packetRW.write.alloc(1 + 4 + len + 4);
    packet[p] = 53; // SSH_MSG_USERAUTH_BANNER
    packet.writeUInt32BE(len, ++p);
    packet.write(message, (p += 4), len, 'utf8');
    packet.writeUInt32BE(0, p + len); // empty language tag
    sendPacket(proto, proto._packetRW.write.finalize(packet));
    return true;
  } catch {
    return false;
  }
}

function parseAddress(addr: string): { host: string | undefined; port: number } {
  const value = addr || ':22';
  const match = /^(?:\[([^\]]*)\]|([^:]*)):(\d+)$/.exec(value);
  if (!match) throw new Error(`listen tcp: address ${addr}: missing port in address`);
  const host = match[1] ?? match[2];
  return { host: host === '' ? undefined : host, port: Number(match[3]) };
}

function isLoopback(host: string | undefined): boolean {
  if (!host) return false;
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function windowFrom(info: { cols: number; rows: number; width: number; height: number }): Window {
  return { width: info.cols, height: info.rows, widthPixels: info.width, heightPixels: info.height };
}

/** A Duplex that discards writes: the channel given to SessionRequestCallback. */
class PendingChannel extends Duplex implements ChannelLike {
  stderr = new Duplex({ write: (_c, _e, cb) => cb(), read() {} });
  outgoing = { state: 'closed' };
  _read(): void {}
  _write(_c: unknown, _e: unknown, cb: () => void): void {
    cb();
  }
  exit(): void {}
  close(): void {}
}

export class Server {
  /** TCP address to listen on, `host:port`; `:22` when empty. */
  addr = '';
  /** The handler every session runs. */
  handler: Handler | null = null;
  /** Host private keys (OpenSSH or PEM). At least one is generated if empty. */
  hostSigners: Array<string | Buffer> = [];
  /** Server software version, sent as `SSH-2.0-<version>`. */
  version = '';
  /** Pre-authentication banner. */
  banner = '';
  bannerHandler: BannerHandler | null = null;
  keyboardInteractiveHandler: KeyboardInteractiveHandler | null = null;
  passwordHandler: PasswordHandler | null = null;
  publicKeyHandler: PublicKeyHandler | null = null;
  ptyCallback: PtyCallback | null = null;
  connCallback: ConnCallback | null = null;
  sessionRequestCallback: SessionRequestCallback | null = null;
  connectionFailedCallback: ConnectionFailedCallback | null = null;
  connectionCloseCallback: ConnectionCloseCallback | null = null;
  subsystemHandlers: Record<string, SubsystemHandler> = {};
  /** Closes connections that have not finished authenticating in time (ms). */
  handshakeTimeout = 0;
  /** Closes connections with no traffic for this long (ms). */
  idleTimeout = 0;
  /** Closes connections this long after they were accepted (ms). */
  maxTimeout = 0;
  /** Disconnects after this many failed authentication attempts. */
  maxAuthTries = DEFAULT_MAX_AUTH_TRIES;
  /** SSH-level keepalive interval (ms); 0 disables it, as in Go. */
  keepAliveInterval = 0;
  /** Unanswered keepalives before the connection is dropped. */
  keepAliveCountMax = 3;

  private _ssh: InstanceType<typeof ssh2.Server> | null = null;
  private readonly _listeners = new Set<net.Server>();
  private readonly _sockets = new Set<Socket>();
  private readonly _contexts = new WeakMap<Socket, Context>();
  private _closed = false;
  private readonly _done: { promise: Promise<void>; resolve: () => void };
  private _warnedNoAuth = false;

  constructor(init: Partial<Pick<Server, 'addr' | 'handler'>> = {}) {
    Object.assign(this, init);
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this._done = { promise, resolve };
  }

  /** Applies an option, as Server.SetOption. */
  setOption(option: Option): void {
    option(this);
  }

  /** Sets the session handler, as Server.Handle. */
  handle(fn: Handler): void {
    this.handler = fn;
  }

  /** True when no authentication handler is set and every client is let in. */
  noClientAuth(): boolean {
    return !this.passwordHandler && !this.publicKeyHandler && !this.keyboardInteractiveHandler;
  }

  // ── Listening ────────────────────────────────────────────────────────────

  /**
   * Starts listening on `addr` and resolves with the bound address once the
   * server accepts connections. Use `listenAndServe` to wait for it to close.
   */
  async listen(): Promise<AddressInfo> {
    const { host, port } = parseAddress(this.addr);
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, host, () => {
        listener.off('error', reject);
        resolve();
      });
    });
    this._serveListener(listener);
    if (this.noClientAuth() && !isLoopback(host) && !this._warnedNoAuth) {
      this._warnedNoAuth = true;
      log.warn('no authentication handler is set: every client is accepted', 'addr', this.addr || ':22');
    }
    return listener.address() as AddressInfo;
  }

  /**
   * Listens on `addr` and serves until the server is closed, as
   * Server.ListenAndServe. It always rejects: with the listen error, or with
   * ErrServerClosed after close() or shutdown().
   */
  async listenAndServe(): Promise<never> {
    await this.listen();
    await this._done.promise;
    throw ErrServerClosed;
  }

  /**
   * Serves connections from an existing net.Server, as Server.Serve. Starts
   * it listening on a random loopback port if it is not listening yet.
   * Rejects with ErrServerClosed once the server is closed.
   */
  async serve(listener: net.Server): Promise<never> {
    if (this._closed) throw ErrServerClosed;
    if (!listener.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => resolve());
      });
    }
    this._serveListener(listener);
    await this._done.promise;
    throw ErrServerClosed;
  }

  /** The address of the first listener, once listening. */
  address(): AddressInfo | null {
    for (const l of this._listeners) return l.address() as AddressInfo;
    return null;
  }

  /** Closes every listener and connection immediately, as Server.Close. */
  async close(): Promise<void> {
    this._closed = true;
    this._done.resolve();
    const sockets = [...this._sockets].map((socket) => {
      const closed = new Promise<void>((r) => (socket.closed ? r() : socket.once('close', () => r())));
      socket.destroy();
      return closed;
    });
    await Promise.all(sockets);
    const listeners = [...this._listeners];
    this._listeners.clear();
    await Promise.all(listeners.map((l) => new Promise<void>((r) => l.close(() => r()))));
  }

  /**
   * Stops accepting connections and waits for the open ones to end, as
   * Server.Shutdown. Rejects with the signal's reason if it aborts first;
   * the connections are left open in that case.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    this._closed = true;
    for (const l of this._listeners) l.close();
    this._listeners.clear();
    this._done.resolve();
    const drained = new Promise<void>((resolve) => {
      const check = () => {
        if (this._sockets.size === 0) resolve();
      };
      check();
      this._drainCheck = check;
    });
    if (!signal) return drained;
    if (signal.aborted) throw signal.reason ?? new Error('context canceled');
    await Promise.race([
      drained,
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('context canceled')), { once: true }),
      ),
    ]);
  }

  private _drainCheck: (() => void) | null = null;

  /** Number of open connections. */
  connections(): number {
    return this._sockets.size;
  }

  // ── Connection handling ──────────────────────────────────────────────────

  private _ensureSSH(): InstanceType<typeof ssh2.Server> {
    if (this._ssh) return this._ssh;
    if (this.hostSigners.length === 0) {
      this.hostSigners.push(generateEd25519().private);
    }
    const keepalive = this.keepAliveInterval > 0;
    this._ssh = new ssh2.Server(
      {
        hostKeys: this.hostSigners,
        ident: this.version || undefined,
        keepaliveInterval: keepalive ? this.keepAliveInterval : NO_KEEPALIVE,
        keepaliveCountMax: keepalive ? this.keepAliveCountMax : 0,
      },
      (client, info) => this._onClient(client, info),
    );
    return this._ssh;
  }

  private _serveListener(listener: net.Server): void {
    this._ensureSSH();
    this._listeners.add(listener);
    listener.on('connection', (socket) => {
      try {
        this.handleConn(socket);
      } catch (err) {
        log.error('failed to serve connection', 'error', err);
        socket.destroy();
      }
    });
    listener.on('close', () => this._listeners.delete(listener));
  }

  /** Serves one already-accepted connection, as Server.HandleConn. */
  handleConn(rawSocket: Socket): void {
    const ssh = this._ensureSSH();
    if (this._closed) {
      rawSocket.destroy();
      return;
    }
    const ctx = new Context(this);
    ctx.setValue(ContextKeyRemoteAddr, new Addr(rawSocket.remoteAddress ?? '', rawSocket.remotePort ?? 0));
    ctx.setValue(ContextKeyLocalAddr, new Addr(rawSocket.localAddress ?? '', rawSocket.localPort ?? 0));
    let socket: Socket = rawSocket;
    if (this.connCallback) {
      const wrapped = this.connCallback(ctx, rawSocket);
      if (!wrapped) {
        rawSocket.destroy();
        return;
      }
      socket = wrapped;
    }

    this._sockets.add(socket);
    this._contexts.set(socket, ctx);
    const timers: NodeJS.Timeout[] = [];
    if (this.maxTimeout > 0) timers.push(setTimeout(() => socket.destroy(), this.maxTimeout));
    if (this.handshakeTimeout > 0) {
      const t = setTimeout(() => {
        if (!(socket as { _wishReady?: boolean })._wishReady) socket.destroy();
      }, this.handshakeTimeout);
      timers.push(t);
    }
    if (this.idleTimeout > 0) {
      socket.setTimeout(this.idleTimeout);
      socket.on('timeout', () => socket.destroy());
    }
    socket.on('error', () => {});
    socket.once('close', () => {
      for (const t of timers) clearTimeout(t);
      this._sockets.delete(socket);
      ctx.cancel();
      const failure = (socket as { _wishFailure?: Error })._wishFailure;
      if (!(socket as { _wishReady?: boolean })._wishReady && this.connectionFailedCallback) {
        this.connectionFailedCallback(socket, failure ?? new Error('ssh: connection closed before authentication'));
      }
      this.connectionCloseCallback?.(socket);
      this._drainCheck?.();
    });
    ssh.injectSocket(socket);
  }

  private _onClient(client: ssh2.Connection, info: ssh2.ClientInfo): void {
    const socket = (client as unknown as { _sock: Socket })._sock;
    const ctx = this._contexts.get(socket);
    if (!ctx) {
      client.end();
      return;
    }
    const marks = socket as Socket & { _wishReady?: boolean; _wishFailure?: Error };
    ctx.setValue(ContextKeyClientVersion, info.header.identRaw);
    const identRaw = (client as unknown as { _protocol?: { _identRaw?: Buffer } })._protocol?._identRaw;
    ctx.setValue(ContextKeyServerVersion, identRaw ? identRaw.toString() : this.version ? `SSH-2.0-${this.version}` : '');

    client.on('error', (err: Error) => {
      marks._wishFailure ??= err;
    });
    client.once('handshake', () => {
      const kex = (client as unknown as { _protocol?: { _kex?: { sessionID?: Buffer } } })._protocol?._kex;
      if (kex?.sessionID) ctx.setValue(ContextKeySessionID, kex.sessionID.toString('hex'));
    });

    const state = { bannerSent: false, failures: 0, cache: null as null | { blob: Buffer; ok: boolean; perms: Permissions } };
    client.on('authentication', (actx) => {
      this._authenticate(client, ctx, actx, state).catch((err) => {
        log.error('authentication handler failed', 'error', err);
        try {
          actx.reject();
        } catch {
          // already answered
        }
      });
    });

    client.on('ready', () => {
      marks._wishReady = true;
      client.on('session', (accept) => this._onSession(ctx, accept()));
    });
  }

  private _methods(): Array<'publickey' | 'password' | 'keyboard-interactive'> {
    const methods: Array<'publickey' | 'password' | 'keyboard-interactive'> = [];
    if (this.publicKeyHandler) methods.push('publickey');
    if (this.passwordHandler) methods.push('password');
    if (this.keyboardInteractiveHandler) methods.push('keyboard-interactive');
    return methods;
  }

  private async _authenticate(
    client: ssh2.Connection,
    ctx: Context,
    actx: ssh2.AuthContext,
    state: { bannerSent: boolean; failures: number; cache: null | { blob: Buffer; ok: boolean; perms: Permissions } },
  ): Promise<void> {
    ctx.setValue(ContextKeyUser, actx.username);
    if (!state.bannerSent) {
      state.bannerSent = true;
      const banner = this.bannerHandler ? this.bannerHandler(ctx) : this.banner;
      if (banner) sendAuthBanner(client, banner);
    }

    const methods = this._methods();
    const resetPermissions = () => {
      const perms = ctx.permissions();
      perms.criticalOptions = {};
      perms.extensions = {};
    };
    const fail = () => {
      if (actx.method !== 'none') state.failures++;
      if (this.maxAuthTries > 0 && state.failures > this.maxAuthTries) {
        client.end();
        return;
      }
      actx.reject(methods);
    };

    switch (actx.method) {
      case 'none':
        if (methods.length === 0) actx.accept();
        else fail();
        return;

      case 'password': {
        if (!this.passwordHandler) return fail();
        resetPermissions();
        const ok = await this.passwordHandler(ctx, actx.password);
        if (ok === true) actx.accept();
        else fail();
        return;
      }

      case 'keyboard-interactive': {
        if (!this.keyboardInteractiveHandler) return fail();
        resetPermissions();
        const challenger: KeyboardInteractiveChallenge = (name, instruction, questions, echos) =>
          new Promise((resolve, reject) => {
            const prompts = questions.map((prompt, i) => ({ prompt, echo: echos[i] ?? false }));
            actx.prompt(prompts, name, instruction, (answers: string[] | Error) => {
              if (answers instanceof Error) reject(answers);
              else resolve(answers);
            });
          });
        let ok = false;
        try {
          ok = (await this.keyboardInteractiveHandler(ctx, challenger)) === true;
        } catch {
          ok = false;
        }
        if (ok) actx.accept();
        else fail();
        return;
      }

      case 'publickey': {
        if (!this.publicKeyHandler) return fail();
        let key: PublicKey;
        try {
          key = ParsePublicKey(actx.key.data);
        } catch {
          return fail();
        }
        const blob = key.marshal();
        let entry = state.cache && state.cache.blob.equals(blob) ? state.cache : null;
        if (!entry) {
          resetPermissions();
          const ok = (await this.publicKeyHandler(ctx, key)) === true;
          const perms = ctx.permissions();
          entry = { blob, ok, perms: { criticalOptions: { ...perms.criticalOptions }, extensions: { ...perms.extensions } } };
          state.cache = entry;
        }
        if (!entry.ok) return fail();
        if (!actx.signature) {
          // The client is asking whether this key would be accepted.
          actx.accept();
          return;
        }
        const verified =
          key instanceof Certificate
            ? verifySSHSignature(key.key, actx.blob!, actx.signature)
            : verifyAuthSignature(key, actx.blob!, actx.signature, actx.hashAlgo);
        if (!verified) return fail();
        const perms = ctx.permissions();
        perms.criticalOptions = { ...entry.perms.criticalOptions };
        perms.extensions = { ...entry.perms.extensions };
        ctx.setValue(ContextKeyPublicKey, key);
        actx.accept();
        return;
      }

      default:
        return fail();
    }
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  private _onSession(ctx: Context, ch: ssh2.Session): void {
    const state = {
      env: [] as string[],
      pty: null as Pty | null,
      handled: false,
      windows: new WindowChanges(),
      session: null as Session | null,
    };
    const emulated = true;

    ch.on('env', (accept, reject, info) => {
      if (state.handled) return reject?.();
      state.env.push(`${info.key}=${info.val}`);
      accept?.();
    });

    ch.on('pty', (accept, reject, info) => {
      if (state.handled || state.pty) return reject?.();
      const pty: Pty = { term: info.term, window: windowFrom(info), modes: { ...(info.modes as Record<string, number>) } };
      if (this.ptyCallback && !this.ptyCallback(ctx, pty)) return reject?.();
      state.pty = pty;
      state.windows.push({ ...pty.window });
      accept?.();
    });

    ch.on('window-change', (accept, reject, info) => {
      if (!state.pty) return reject?.();
      const w = windowFrom(info);
      state.pty.window = w;
      state.windows.push({ ...w });
      accept?.();
    });

    ch.on('signal', (accept, _reject, info) => {
      accept?.();
      const sess = state.session;
      if (!sess) return;
      if (sess._signalListener) sess._signalListener(info.name);
      else if (sess._signalBuffer.length < 128) sess._signalBuffer.push(info.name);
    });

    const makeSession = (channel: ChannelLike, raw: string, subsystem: string) =>
      new Session({
        channel,
        ctx,
        env: state.env,
        rawCommand: raw,
        subsystem,
        pty: state.pty,
        emulatedPty: emulated,
        windowChanges: state.windows,
      });

    const allowed = (raw: string, subsystem: string, type: string): boolean => {
      if (!this.sessionRequestCallback) return true;
      return this.sessionRequestCallback(makeSession(new PendingChannel(), raw, subsystem), type);
    };

    const start = (handler: Handler, channel: ChannelLike, raw: string, subsystem: string, what: string) => {
      const sess = makeSession(channel, raw, subsystem);
      state.session = sess;
      void (async () => {
        try {
          await handler(sess);
        } catch (err) {
          log.error(`panic in ${what} handler`, 'error', err, 'stack', err instanceof Error ? err.stack : '');
          if (!sess.exited) sess.exit(1).catch(() => {});
          return;
        }
        if (!sess.exited) sess.exit(0).catch(() => {});
      })();
    };

    const onCommand = (type: 'shell' | 'exec', raw: string, accept: () => ssh2.ServerChannel, reject?: () => void) => {
      if (state.handled || !allowed(raw, '', type) || !this.handler) return reject?.();
      state.handled = true;
      start(this.handler, accept() as unknown as ChannelLike, raw, '', 'session');
    };

    ch.on('shell', (accept, reject) => onCommand('shell', '', accept, reject));
    ch.on('exec', (accept, reject, info) => onCommand('exec', info.command, accept, reject));
    ch.on('subsystem', (accept, reject, info) => {
      if (state.handled || !allowed('', info.name, 'subsystem')) return reject?.();
      const handler = this.subsystemHandlers[info.name] ?? this.subsystemHandlers['default'];
      if (!handler) return reject?.();
      state.handled = true;
      start(handler, accept() as unknown as ChannelLike, '', info.name, 'subsystem');
    });
    ch.on('close', () => state.windows.close());
  }
}

/** Creates a server for a handler and options and serves it, as ssh.ListenAndServe. */
export function ListenAndServe(addr: string, handler: Handler | null, ...options: Option[]): Promise<never> {
  const srv = new Server({ addr, handler });
  for (const option of options) srv.setOption(option);
  return srv.listenAndServe();
}
