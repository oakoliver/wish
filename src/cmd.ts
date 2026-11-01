/**
 * Cmd runs a program wired to a session, as wish.Cmd. It also satisfies
 * Bubble Tea's ExecCommand, so `Exec(cmd, callback)` can hand the session to
 * another program and take it back.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Session } from './session.js';

type Input = Readable | NodeJS.ReadStream | null;
type Output = Writable | NodeJS.WriteStream;

/**
 * CommandContext is like Command, but the process is killed when `signal`
 * aborts, as wish.CommandContext.
 */
export function CommandContext(signal: AbortSignal, s: Session, name: string, ...args: string[]): Cmd {
  return new Cmd(s, name, args, signal);
}

/**
 * Command returns a Cmd whose stdin, stdout and stderr are the session, as
 * wish.Command. It is killed when the connection closes.
 */
export function Command(s: Session, name: string, ...args: string[]): Cmd {
  return CommandContext(s.context().signal, s, name, ...args);
}

function currentEnviron(): string[] {
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`);
}

/** Copies src into the child's stdin until the child exits; returns a detach function. */
function pumpInput(src: Readable, child: ChildProcess): () => void {
  const stdin = child.stdin;
  if (!stdin) return () => {};
  stdin.on('error', () => {});
  const wasFlowing = src.readableFlowing;
  const onData = (chunk: Buffer) => {
    if (!stdin.write(chunk)) {
      src.pause();
      stdin.once('drain', () => src.resume());
    }
  };
  const onEnd = () => stdin.end();
  if (src.readableEnded) {
    stdin.end();
    return () => {};
  }
  src.on('data', onData);
  src.once('end', onEnd);
  return () => {
    src.off('data', onData);
    src.off('end', onEnd);
    if (wasFlowing !== true) src.pause();
  };
}

/** Copies a child's output stream into dst without ending dst. */
function pumpOutput(src: Readable | null, dst: Output): void {
  if (!src) return;
  src.on('data', (chunk: Buffer) => {
    if (!dst.write(chunk)) {
      src.pause();
      dst.once('drain', () => src.resume());
    }
  });
}

/** Cmd wraps a child process and the session it runs on. */
export class Cmd {
  private env: string[] | null = null;
  private dir: string | undefined;
  private stdin: Input = null;
  private stdout: Output | null = null;
  private stderr: Output | null = null;
  private child: ChildProcess | null = null;

  constructor(
    private readonly sess: Session,
    private readonly name: string,
    private readonly args: string[],
    private readonly signal?: AbortSignal,
  ) {}

  /** Replaces the environment of the process, as Cmd.SetEnv. */
  setEnv(env: string[]): void {
    this.env = [...env];
  }

  /** The environment the process will get, as Cmd.Environ. */
  environ(): string[] {
    return this.env ? [...this.env] : currentEnviron();
  }

  /** Sets the working directory, as Cmd.SetDir. */
  setDir(dir: string): void {
    this.dir = dir;
  }

  /** As tea.ExecCommand. Call before run(). */
  setStdin(input: Input): void {
    this.stdin = input;
  }

  /** As tea.ExecCommand. Call before run(). */
  setStdout(output: Output | null): void {
    this.stdout = output;
  }

  /** As tea.ExecCommand. Call before run(). */
  setStderr(output: Output | null): void {
    this.stderr = output;
  }

  /** Stops the process if it is running. */
  cancel(): void {
    this.child?.kill('SIGTERM');
  }

  /**
   * Runs the program and resolves when it exits, as Cmd.Run. Rejects with
   * `exit status N` on a non-zero exit, or with Go's `exec: "name":
   * executable file not found in $PATH` when the program does not exist.
   *
   * When stdin, stdout and stderr were all set (Bubble Tea's Exec does this)
   * they are used. Otherwise the process runs on the session. This port has
   * no real PTY: on a session with a PTY, stdout and stderr both go to the
   * session (translated to CRLF), as they would on a terminal.
   */
  run(): Promise<void> {
    const custom = this.stdin !== null && this.stdout !== null && this.stderr !== null;
    const [, , hasPty] = this.sess.pty();
    let input: Input;
    let output: Output;
    let errOutput: Output;
    if (custom) {
      input = this.stdin;
      output = this.stdout!;
      errOutput = this.stderr!;
    } else if (hasPty) {
      input = this.sess;
      output = this.sess;
      errOutput = this.sess;
    } else {
      input = this.stdin ?? this.sess;
      output = this.stdout ?? this.sess;
      errOutput = this.stderr ?? this.sess.stderr();
    }

    const env: Record<string, string> = {};
    for (const entry of this.environ()) {
      const i = entry.indexOf('=');
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
    }

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.name, this.args, { cwd: this.dir, env, stdio: ['pipe', 'pipe', 'pipe'], signal: this.signal });
      } catch (err) {
        reject(err);
        return;
      }
      this.child = child;
      const detach = input ? pumpInput(input as Readable, child) : (child.stdin?.end(), () => {});
      pumpOutput(child.stdout, output);
      pumpOutput(child.stderr, errOutput);
      let settled = false;
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        detach();
        if (err.code === 'ENOENT') reject(new Error(`exec: "${this.name}": executable file not found in $PATH`));
        else reject(err);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        detach();
        this.child = null;
        if (code === 0) resolve();
        else reject(new Error(signal ? `signal: ${signal}` : `exit status ${code}`));
      });
    });
  }
}
