/**
 * accesscontrol restricts the commands a client may run, as
 * wish/accesscontrol.
 */

import type { Middleware } from './wish.js';

/**
 * Middleware exits with status 1 when the client runs a command that is not
 * in `cmds`. Sessions without a command (a shell) pass. With no commands
 * given, every command is refused.
 */
export function Middleware(...cmds: string[]): Middleware {
  return (next) => async (s) => {
    const command = s.command();
    if (command.length === 0) return next(s);
    if (cmds.includes(command[0])) return next(s);
    s.write(`Command is not allowed: ${command[0]}\n`);
    await s.exit(1).catch(() => {});
  };
}
