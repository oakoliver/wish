/**
 * A small leveled logger in the format of charm.land/log, used by the server
 * and by the middleware defaults. Replace it with SetLogger.
 */

import { formatValue, sprintf } from './format.js';

export enum Level {
  Debug = -4,
  Info = 0,
  Warn = 4,
  Error = 8,
}

const LEVEL_NAMES: Record<number, string> = {
  [Level.Debug]: 'DEBU',
  [Level.Info]: 'INFO',
  [Level.Warn]: 'WARN',
  [Level.Error]: 'ERRO',
};

/** A structured logger: a message plus key/value pairs. */
export interface StructuredLogger {
  log(level: Level, msg: string, ...keyvals: unknown[]): void;
}

/** A Printf-style logger, as the `Logger` interfaces of wish's middleware. */
export interface Logger {
  printf(format: string, ...v: unknown[]): void;
}

function quote(value: string): string {
  return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value;
}

/** Formats one log line: `2026/11/01 13:37:00 INFO msg key=value`. */
export function formatLine(level: Level, msg: string, keyvals: unknown[]): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  let line = `${ts} ${LEVEL_NAMES[level] ?? 'INFO'} ${msg}`;
  for (let i = 0; i < keyvals.length; i += 2) {
    line += ` ${String(keyvals[i])}=${quote(formatValue(keyvals[i + 1]))}`;
  }
  return line;
}

class DefaultLogger implements StructuredLogger {
  level = Level.Info;
  log(level: Level, msg: string, ...keyvals: unknown[]): void {
    if (level < this.level) return;
    process.stderr.write(formatLine(level, msg, keyvals) + '\n');
  }
}

let current: StructuredLogger = new DefaultLogger();

/** Replaces the logger used by the server and the middleware defaults. */
export function SetLogger(logger: StructuredLogger): void {
  current = logger;
}

/** Returns the current default logger. */
export function DefaultStructuredLogger(): StructuredLogger {
  return current;
}

/** The default logger as a Printf logger, as log.StandardLog(). */
export function StandardLog(): Logger {
  return {
    printf(format: string, ...v: unknown[]) {
      current.log(Level.Info, sprintf(format, ...v).replace(/\n$/, ''));
    },
  };
}

export const log = {
  debug: (msg: string, ...kv: unknown[]) => current.log(Level.Debug, msg, ...kv),
  info: (msg: string, ...kv: unknown[]) => current.log(Level.Info, msg, ...kv),
  warn: (msg: string, ...kv: unknown[]) => current.log(Level.Warn, msg, ...kv),
  error: (msg: string, ...kv: unknown[]) => current.log(Level.Error, msg, ...kv),
};

