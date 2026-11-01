/**
 * testsession starts a server on a random loopback port and opens client
 * sessions against it with ssh2's client, as wish/testsession. Use it to
 * test handlers and middleware end to end.
 *
 *   import { afterEach } from 'bun:test';
 *   afterEach(() => testsession.CloseAll());
 *   const sess = await testsession.New(server);
 *   const out = await sess.output('');
 */

import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import ssh2 from 'ssh2';
import { ErrServerClosed, type Server } from './server.js';

/** Client options; anything else is passed to ssh2's `Client.connect`. */
export interface ClientConfig extends Partial<ssh2.ConnectConfig> {
  /** Called with the server's pre-authentication banner. */
  onBanner?: (message: string) => void;
  /** Answers keyboard-interactive prompts. */
  onKeyboardInteractive?: (name: string, instructions: string, prompts: Array<{ prompt: string; echo?: boolean }>) => string[] | Promise<string[]>;
}

/** The remote command exited with a non-zero status or a signal, as gossh.ExitError. */
export class ExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: string | null,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
  ) {
    super(signal ? `Process exited with signal ${signal}` : `Process exited with status ${code}`);
  }
}

/** The channel closed without an exit status, as gossh.ExitMissingError. */
export class ExitMissingError extends Error {
  constructor(
    readonly stdout: Buffer,
    readonly stderr: Buffer,
  ) {
    super('wait: remote command exited without exit status or exit signal');
  }
}

const open = new Set<{ close(): void | Promise<void> }>();

/** Closes every client and server opened through this module. Call it in afterEach. */
export async function CloseAll(): Promise<void> {
  const items = [...open];
  open.clear();
  for (const item of items) await item.close();
}

/** A client session, as gossh.Session. Set stdin/stdout/stderr before running. */
export class ClientSession {
  /** Data sent to the remote command; its end sends EOF. */
  stdin: string | Buffer | Readable | null = null;
  /** Extra sinks for the remote output. */
  stdout: Writable | null = null;
  stderr: Writable | null = null;
  /** Environment variables to send. */
  env: Record<string, string> = {};
  private ptyRequest: ssh2.PseudoTtyOptions | null = null;
  private used = false;
  /** Set once a command ran and was given a stream. */
  stream: ssh2.ClientChannel | null = null;

  constructor(readonly client: ssh2.Client) {}

  /** Requests a PTY for the next command, as Session.RequestPty. */
  requestPty(term: string, height: number, width: number): void {
    this.ptyRequest = { term, rows: height, cols: width };
  }

  /** Sends a window-change for the running command. */
  setWindow(height: number, width: number): void {
    this.stream?.setWindow(height, width, 0, 0);
  }

  private exec(cmd: string): Promise<{ stdout: Buffer; stderr: Buffer; combined: Buffer }> {
    if (this.used) return Promise.reject(new Error('ssh: session already used'));
    this.used = true;
    return new Promise((resolve, reject) => {
      const options: ssh2.ExecOptions = { env: this.env };
      if (this.ptyRequest) options.pty = this.ptyRequest;
      this.client.exec(cmd, options, (err, stream) => {
        if (err) return reject(err);
        this.stream = stream;
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        const combined: Buffer[] = [];
        let code: number | null = null;
        let signal: string | null = null;
        let exited = false;
        stream.on('data', (d: Buffer) => {
          out.push(d);
          combined.push(d);
          this.stdout?.write(d);
        });
        stream.stderr.on('data', (d: Buffer) => {
          errOut.push(d);
          combined.push(d);
          this.stderr?.write(d);
        });
        stream.on('exit', (c: number | null, s?: string) => {
          exited = true;
          code = c ?? null;
          signal = s ?? null;
        });
        const finish = () => {
          const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(errOut), combined: Buffer.concat(combined) };
          if (!exited) return reject(Object.assign(new ExitMissingError(result.stdout, result.stderr), { combined: result.combined }));
          if (code !== 0 || signal) {
            return reject(Object.assign(new ExitError(code, signal, result.stdout, result.stderr), { combined: result.combined }));
          }
          resolve(result);
        };
        let finished = false;
        const once = () => {
          if (finished) return;
          finished = true;
          finish();
        };
        stream.on('close', once);
        // ssh2 does not close channels when the connection drops.
        this.client.once('close', once);
        const input = this.stdin;
        if (input === null) stream.end();
        else if (typeof input === 'string' || Buffer.isBuffer(input)) stream.end(input);
        else input.pipe(stream);
      });
    });
  }

  /** Runs a command and waits for it, as Session.Run. Rejects with ExitError. */
  async run(cmd: string): Promise<void> {
    await this.exec(cmd);
  }

  /** Runs a command and resolves with its stdout, as Session.Output. */
  async output(cmd: string): Promise<Buffer> {
    return (await this.exec(cmd)).stdout;
  }

  /** Runs a command and resolves with stdout and stderr interleaved, as Session.CombinedOutput. */
  async combinedOutput(cmd: string): Promise<Buffer> {
    return (await this.exec(cmd)).combined;
  }

  /** Starts a command and resolves with its stream without waiting for it. */
  start(cmd: string): Promise<ssh2.ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.used) return reject(new Error('ssh: session already used'));
      this.used = true;
      const options: ssh2.ExecOptions = { env: this.env };
      if (this.ptyRequest) options.pty = this.ptyRequest;
      const cb = (err: Error | undefined, stream: ssh2.ClientChannel) => {
        if (err) return reject(err);
        this.stream = stream;
        resolve(stream);
      };
      if (cmd === '' && this.ptyRequest) this.client.shell(this.ptyRequest, { env: this.env }, cb);
      else this.client.exec(cmd, options, cb);
    });
  }

  close(): void {
    this.client.end();
  }
}

async function listenLoopback(): Promise<net.Server> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  return listener;
}

/** Starts the server on a random loopback port; resolves with `host:port`, as testsession.Listen. */
export async function Listen(srv: Server): Promise<string> {
  const listener = await listenLoopback();
  // serve() only settles when the server closes, or right away when it cannot
  // start (an unusable host key, say): surface that instead of leaving a
  // listener that accepts connections nobody handles.
  let failure: unknown = null;
  srv.serve(listener).catch((err) => {
    if (err !== ErrServerClosed) failure = err;
  });
  await new Promise((resolve) => setImmediate(resolve));
  if (failure) {
    listener.close();
    throw failure;
  }
  open.add({ close: () => srv.close() });
  const { address, port } = listener.address() as net.AddressInfo;
  return `${address}:${port}`;
}

/**
 * Connects to `addr` and opens a session, as testsession.NewClientSession.
 * Defaults to user `testuser` with password `testpass`; host keys are not
 * checked.
 */
export function NewClientSession(addr: string, config: ClientConfig = {}): Promise<ClientSession> {
  const i = addr.lastIndexOf(':');
  const host = addr.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(addr.slice(i + 1));
  const { onBanner, onKeyboardInteractive, ...rest } = config;
  const client = new ssh2.Client();
  return new Promise((resolve, reject) => {
    if (onBanner) client.on('banner', (message: string) => onBanner(message));
    if (onKeyboardInteractive) {
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        Promise.resolve(onKeyboardInteractive(name, instructions, prompts)).then(finish, () => finish([]));
      });
    }
    let settled = false;
    client.once('ready', () => {
      settled = true;
      const sess = new ClientSession(client);
      open.add(sess);
      resolve(sess);
    });
    // ssh2 can emit several errors for one failure; keep a listener for all of them.
    client.once('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('ssh: handshake failed: connection closed'));
    });
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    });
    const hasAuth = rest.password !== undefined || rest.privateKey !== undefined || rest.agent !== undefined || rest.tryKeyboard;
    client.connect({
      host,
      port,
      username: 'testuser',
      ...(hasAuth ? {} : { password: 'testpass' }),
      hostVerifier: () => true,
      readyTimeout: 10_000,
      ...rest,
    });
  });
}

/** Starts the server and opens a client session to it, as testsession.New. */
export async function New(srv: Server, config?: ClientConfig): Promise<ClientSession> {
  return NewClientSession(await Listen(srv), config);
}
