/**
 * bubbletea serves Bubble Tea programs over SSH, as wish/bubbletea.
 *
 * Every session gets its own Program with the session as input and output,
 * the session's PTY size and environment, a colour profile detected from that
 * environment, and a WindowSizeMsg each time the client's window changes.
 * Output is downsampled to the session's colour profile with Lip Gloss, so a
 * TrueColor style renders as 256 or 16 colours on clients that need it.
 *
 * Import it from `@oakoliver/wish/bubbletea`. It needs the peer packages
 * `@oakoliver/bubbletea` and `@oakoliver/lipgloss`.
 */

import {
  NewProgram,
  ResumeMsg,
  WindowSizeMsg,
  WithColorProfile,
  WithEnvironment,
  WithFilter,
  WithInput,
  WithOutput,
  WithWindowSize,
  WithoutSignalHandler,
  type ColorProfile,
  type Model,
  type Msg,
  type Program,
  type ProgramOption,
} from '@oakoliver/bubbletea';
import { ColorProfileWriter, detectColorProfile } from '@oakoliver/lipgloss';
import { Writable } from 'node:stream';
import { log } from './log.js';
import type { Session } from './session.js';
import { Fatalln, type Middleware as WishMiddleware } from './wish.js';

/**
 * Handler builds the model for a session and any extra program options, as
 * bubbletea.Handler. Return `[null, []]` to skip Bubble Tea for this session
 * and go on to the next handler.
 */
export type Handler = (sess: Session) => [Model | null, ProgramOption[]] | Promise<[Model | null, ProgramOption[]]>;

/** @deprecated use Handler, as upstream's BubbleTeaHandler. */
export type BubbleTeaHandler = Handler;

/**
 * ProgramHandler builds the whole Program for a session, as
 * bubbletea.ProgramHandler. Pass `...MakeOptions(sess)` to NewProgram so the
 * program uses the session for input and output. Return null to skip.
 */
export type ProgramHandler = (sess: Session) => Program | null | Promise<Program | null>;

/**
 * Middleware runs one Program per session, built from the handler's model,
 * as bubbletea.Middleware. Sessions without a PTY are refused.
 */
export function Middleware(handler: Handler): WishMiddleware {
  return MiddlewareWithProgramHandler(newDefaultProgramHandler(handler));
}

/**
 * MiddlewareWithProgramHandler is Middleware with access to the Program, as
 * bubbletea.MiddlewareWithProgramHandler: useful to `send` messages to it
 * from outside, for example from other sessions.
 */
export function MiddlewareWithProgramHandler(handler: ProgramHandler): WishMiddleware {
  return (next) => async (sess) => {
    const program = await handler(sess);
    if (!program) return next(sess);
    const [, windowChanges, ok] = sess.pty();
    if (!ok) {
      await Fatalln(sess, 'no active terminal, skipping');
      return;
    }

    // Quit when the client goes away, and resize on every window change. A
    // throw here runs outside the handler's promise chain, where the recover
    // middleware cannot see it, so it is caught and ends this session only.
    const quit = () => program.quit();
    const signal = sess.context().signal;
    signal.addEventListener('abort', quit, { once: true });
    sess.once('session-close', quit);
    const unsubscribe = windowChanges.subscribe((w) => {
      try {
        program.send(new WindowSizeMsg(w.width, w.height));
      } catch (err) {
        log.error('panic in window change handler', 'panic', err, 'stack', err instanceof Error ? err.stack : '');
        program.quit();
      }
    });

    try {
      await program.run();
    } catch (err) {
      log.error('app exit with error', 'error', err);
    } finally {
      // Force-stop the program if it is still running and restore the
      // terminal state in case the app crashed.
      program.kill();
      unsubscribe();
      signal.removeEventListener('abort', quit);
      sess.off('session-close', quit);
    }
    await next(sess);
  };
}

/** Maps Go's colorprofile names onto Bubble Tea's ColorProfile values. */
function teaProfile(profile: string): ColorProfile {
  switch (profile) {
    case 'truecolor':
      return 'truecolor' as ColorProfile;
    case 'ansi256':
      return 'ansi256' as ColorProfile;
    case 'ansi':
      return 'ansi' as ColorProfile;
    default:
      return 'ascii' as ColorProfile;
  }
}

function envRecord(envs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of envs) {
    const i = entry.indexOf('=');
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

/**
 * The colour profile for a session, from its environment the way Go's
 * colorprofile.Env reads it: NO_COLOR, CLICOLOR_FORCE, COLORTERM and TERM.
 */
export function SessionColorProfile(sess: Session): ColorProfile {
  const [pty, , ok] = sess.pty();
  const envs = sess.environ();
  if (ok) envs.push(`TERM=${pty.term}`);
  return teaProfile(detectColorProfile({ isTTY: true }, envRecord(envs)));
}

/** A Writable that downsamples ANSI colours to a profile before the session sees them. */
class ProfileOutput extends Writable {
  private readonly writer: ColorProfileWriter;
  private ok = true;

  constructor(private readonly sess: Session, profile: ColorProfile) {
    super({ decodeStrings: false });
    this.writer = new ColorProfileWriter(
      {
        isTTY: true,
        write: (chunk: string) => {
          this.ok = this.sess.write(chunk) && this.ok;
        },
      },
      profile,
    );
    this.on('error', () => {});
  }

  get columns(): number | undefined {
    return this.sess.columns;
  }

  get rows(): number | undefined {
    return this.sess.rows;
  }

  get isTTY(): boolean {
    return this.sess.isTTY;
  }

  override _write(chunk: string | Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.ok = true;
    this.writer.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    if (this.ok) cb();
    else this.sess.once('drain', () => cb());
  }

  override _final(cb: (error?: Error | null) => void): void {
    this.writer.close();
    cb();
  }
}

/**
 * MakeOptions returns the program options that connect a Program to a
 * session, as bubbletea.MakeOptions: input, output (downsampled to the
 * session's colour profile), environment with TERM, colour profile and
 * window size. It also turns off the process signal handlers (one server
 * serves many programs) and turns suspend (ctrl+z) into resume, since an SSH
 * session cannot be suspended.
 */
export function MakeOptions(sess: Session): ProgramOption[] {
  const [pty, , ok] = sess.pty();
  const envs = sess.environ();
  const common: ProgramOption[] = [
    WithoutSignalHandler(),
    WithFilter((_model: Model, msg: Msg) => {
      if ((msg as { _tag?: string } | null)?._tag === 'SuspendMsg') return new ResumeMsg();
      return msg;
    }),
  ];
  if (!ok) {
    return [WithInput(sess), WithOutput(sess), WithEnvironment(envs), ...common];
  }
  envs.push(`TERM=${pty.term}`);
  const profile = teaProfile(detectColorProfile({ isTTY: true }, envRecord(envs)));
  const output = profile === ('truecolor' as ColorProfile) ? sess : new ProfileOutput(sess, profile);
  return [
    WithInput(sess),
    WithOutput(output),
    WithColorProfile(profile),
    WithEnvironment(envs),
    WithWindowSize(pty.window.width, pty.window.height),
    ...common,
  ];
}

function newDefaultProgramHandler(handler: Handler): ProgramHandler {
  return async (s) => {
    const [model, opts] = await handler(s);
    if (!model) return null;
    return NewProgram(model, ...opts, ...MakeOptions(s));
  };
}
