/**
 * Session — one SSH "session" channel, as charm.land/ssh's Session.
 *
 * Go's Session is an io.ReadWriter over the channel plus accessors. Here it is
 * a Node.js Duplex stream over the ssh2 channel, so it can be piped, passed to
 * child processes, or handed to a Bubble Tea Program as input and output.
 */

import { Duplex, Writable } from 'node:stream';
import type { Context, Permissions, Pty, Signal, Window } from './context.js';
import type { PublicKey } from './keys.js';

// The parts of ssh2's ServerChannel the session relies on.
export interface ChannelLike extends Duplex {
  stderr: Writable;
  exit(status: number): void;
  close(): void;
  eof?(): void;
  outgoing?: { state: string };
}

/**
 * WindowChanges delivers the client's window sizes, as the `<-chan ssh.Window`
 * returned by Go's Session.Pty(). The first value is the size from the
 * pty-req, followed by every window-change. Consume it with `subscribe` or
 * `for await`; like a Go channel it has a single consumer.
 */
export class WindowChanges implements AsyncIterable<Window> {
  private buffer: Window[] = [];
  private listener: ((w: Window) => void) | null = null;
  private waiter: ((w: Window | null) => void) | null = null;
  private closed = false;

  /** @internal */
  push(w: Window): void {
    if (this.closed) return;
    if (this.listener) this.listener(w);
    else if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(w);
    } else this.buffer.push(w);
  }

  /** @internal */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }

  /** True once the session has ended and no more sizes will arrive. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Calls `listener` for each buffered and future window size. Returns a
   * function that stops the subscription.
   */
  subscribe(listener: (w: Window) => void): () => void {
    this.listener = listener;
    const pending = this.buffer.splice(0);
    for (const w of pending) listener(w);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Resolves with the next window size, or null once the session ended. */
  next(): Promise<Window | null> {
    const w = this.buffer.shift();
    if (w) return Promise.resolve(w);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Window> {
    for (;;) {
      const w = await this.next();
      if (!w) return;
      yield w;
    }
  }
}

/** Converts "\n" to "\r\n" as an emulated PTY must, as ssh.NewPtyWriter. */
export function ptyTranslate(chunk: Buffer): Buffer {
  if (!chunk.includes(0x0a)) return chunk;
  const out: number[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    if (b === 0x0a && !(i > 0 && chunk[i - 1] === 0x0d)) out.push(0x0d);
    out.push(b);
  }
  return Buffer.from(out);
}

/** @internal Construction data for a Session. */
export interface SessionInit {
  channel: ChannelLike;
  ctx: Context;
  env: string[];
  rawCommand: string;
  subsystem: string;
  pty: Pty | null;
  emulatedPty: boolean;
  windowChanges: WindowChanges;
}

export class Session extends Duplex {
  private readonly _channel: ChannelLike;
  private readonly _ctx: Context;
  private readonly _env: string[];
  private readonly _rawCommand: string;
  private readonly _subsystem: string;
  private readonly _pty: Pty | null;
  private readonly _emulated: boolean;
  private readonly _windows: WindowChanges;
  private readonly _stderr: Writable;
  private _exitCode: number | null = null;
  private _exited = false;
  private _channelClosed = false;
  private _exitDone: Promise<void> | null = null;
  /** @internal */
  _signalListener: ((sig: Signal) => void) | null = null;
  /** @internal */
  _signalBuffer: Signal[] = [];

  constructor(init: SessionInit) {
    super({ allowHalfOpen: true });
    this._channel = init.channel;
    this._ctx = init.ctx;
    this._env = init.env;
    this._rawCommand = init.rawCommand;
    this._subsystem = init.subsystem;
    this._pty = init.pty;
    this._emulated = init.emulatedPty;
    this._windows = init.windowChanges;

    // A session that outlives its client must not take the process down with
    // an unhandled 'error' event.
    this.on('error', () => {});
    this._channel.on('error', () => {});

    const translate = this._pty !== null && this._emulated;
    const channel = this._channel;
    this._stderr = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (this._channelClosed) return cb();
        const data = translate ? ptyTranslate(chunk) : chunk;
        if (channel.stderr.write(data)) cb();
        else channel.stderr.once('drain', () => cb());
      },
    });
    this._stderr.on('error', () => {});

    channel.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) channel.pause();
    });
    channel.on('end', () => this.push(null));
    channel.on('close', () => {
      this._channelClosed = true;
      this.push(null);
      this._windows.close();
      this.emit('session-close');
    });
  }

  // ── Duplex plumbing ──────────────────────────────────────────────────────

  override _read(): void {
    this._channel.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (this._channelClosed || this._channel.outgoing?.state !== undefined && this._channel.outgoing.state !== 'open') {
      cb();
      return;
    }
    const data = this._pty !== null && this._emulated ? ptyTranslate(chunk) : chunk;
    if (this._channel.write(data)) cb();
    else this._channel.once('drain', () => cb());
  }

  override _final(cb: (error?: Error | null) => void): void {
    if (this._exitCode !== null) {
      this._finishExit(this._exitCode).then(() => cb(), () => cb());
    } else {
      // CloseWrite: send EOF and keep the channel open for reading.
      if (!this._channelClosed) this._channel.eof?.();
      cb();
    }
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    if (!this._channelClosed) this._channel.close();
    cb(error);
  }

  override write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    if (this.writableEnded || this.destroyed) {
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') queueMicrotask(() => (callback as () => void)());
      return false;
    }
    return super.write(chunk as Buffer, encoding as BufferEncoding, cb as (error?: Error | null) => void);
  }

  private async _finishExit(code: number): Promise<void> {
    if (this._channelClosed) return;
    const stderr = this._channel.stderr;
    if (stderr.writableLength > 0) await new Promise<void>((resolve) => stderr.once('drain', () => resolve()));
    if (this._channelClosed) return;
    this._channel.exit(code);
    this._channel.end();
  }

  // ── Session API ──────────────────────────────────────────────────────────

  /** The user name the client logged in as. */
  user(): string {
    return this._ctx.user();
  }

  remoteAddr() {
    return this._ctx.remoteAddr();
  }

  localAddr() {
    return this._ctx.localAddr();
  }

  /** Environment variables the client sent, as `KEY=value` strings. */
  environ(): string[] {
    return [...this._env];
  }

  /** The command split into words, as a POSIX shell would. Empty for a shell. */
  command(): string[] {
    return shellSplit(this._rawCommand);
  }

  /** The exact command string the client sent. */
  rawCommand(): string {
    return this._rawCommand;
  }

  /** The subsystem name, for subsystem sessions. */
  subsystem(): string {
    return this._subsystem;
  }

  /** The public key the client authenticated with, or null. */
  publicKey(): PublicKey | null {
    return this._ctx.publicKey();
  }

  context(): Context {
    return this._ctx;
  }

  permissions(): Permissions {
    return this._ctx.permissions();
  }

  /** True when the PTY is emulated (always, in this port, unless NoPty). */
  emulatedPty(): boolean {
    return this._emulated;
  }

  /**
   * Returns `[pty, windowChanges, ok]`, as Go's `Pty() (Pty, <-chan Window, bool)`.
   * `ok` is false when the client did not request a PTY.
   */
  pty(): [Pty, WindowChanges, boolean] {
    if (this._pty) return [{ ...this._pty, window: { ...this._pty.window } }, this._windows, true];
    return [{ term: '', window: { width: 0, height: 0, widthPixels: 0, heightPixels: 0 }, modes: {} }, this._windows, false];
  }

  /** The stream for the client's stderr. */
  stderr(): Writable {
    return this._stderr;
  }

  /**
   * Sends the exit status and closes the channel once pending output is
   * written, as Session.Exit. Rejects when called more than once.
   */
  exit(code: number): Promise<void> {
    if (this._exited) return Promise.reject(new Error('Session.Exit called multiple times'));
    this._exited = true;
    this._exitCode = code;
    if (this.writableEnded) {
      this._exitDone = this._finishExit(code);
    } else {
      this._exitDone = new Promise<void>((resolve) => {
        this.once('finish', () => resolve());
        this.once('session-close', () => resolve());
      });
      this.end();
    }
    return this._exitDone;
  }

  /** True once exit() was called. */
  get exited(): boolean {
    return this._exited;
  }

  /** True once the SSH channel is closed. */
  channelClosed(): boolean {
    return this._channelClosed;
  }

  /** Closes the channel without an exit status, as Session.Close. */
  close(): void {
    if (!this._channelClosed) this._channel.close();
  }

  /**
   * Registers a listener for signals sent by the client, as Session.Signals.
   * Signals received before a listener exists are buffered (up to 128).
   * Pass null to stop listening.
   */
  signals(listener: ((sig: Signal) => void) | null): void {
    this._signalListener = listener;
    if (listener) for (const sig of this._signalBuffer.splice(0)) listener(sig);
  }

  // ── Terminal hints for Bubble Tea and Lip Gloss ──────────────────────────

  /** True when the client requested a PTY. */
  get isTTY(): boolean {
    return this._pty !== null;
  }

  /** Current terminal width, when a PTY was requested. */
  get columns(): number | undefined {
    return this._pty?.window.width;
  }

  /** Current terminal height, when a PTY was requested. */
  get rows(): number | undefined {
    return this._pty?.window.height;
  }
}

/**
 * Splits a command line into words with POSIX shell quoting rules, as
 * go-shlex's Split(s, true). Returns an empty list for unbalanced quotes.
 */
export function shellSplit(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1])) word += input[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\') {
      if (i + 1 < input.length) word += input[++i];
      inWord = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (ch === '#' && !inWord) {
      break;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return [];
  if (inWord) words.push(word);
  return words;
}
