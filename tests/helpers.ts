/**
 * Shared test helpers: temp dirs, key pairs and an OpenSSH client runner.
 * Test files must stay erasable TypeScript so Node can run them too.
 */
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519 } from '../src/index.ts';

export const TESTDATA = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'testdata');

const dirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wish-test-'));
  // Go's t.TempDir makes its directories with mode 0777 &^ umask.
  chmodSync(dir, 0o755);
  dirs.push(dir);
  return dir;
}

export function cleanupDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  path: string;
}

/** Generates an ed25519 key pair and writes the private key (0600) to a temp dir. */
export function keyPair(): KeyPair {
  const pair = generateEd25519();
  const path = join(tempDir(), 'id_ed25519');
  writeFileSync(path, pair.private, { mode: 0o600 });
  writeFileSync(`${path}.pub`, `${pair.public}\n`);
  return { privateKey: pair.private, publicKey: pair.public, path };
}

/** Copies a testdata private key to a temp file with mode 0600 (OpenSSH insists). */
export function privateKeyFile(name: string): string {
  const path = join(tempDir(), name);
  copyFileSync(join(TESTDATA, name), path);
  chmodSync(path, 0o600);
  return path;
}

export const SSH_OPTS = [
  '-F', '/dev/null',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'BatchMode=yes',
  '-o', 'LogLevel=ERROR',
  '-o', 'IdentitiesOnly=yes',
];

/** Runs the system `ssh` client. Resolves with exit code, stdout and stderr. */
export function runSSH(args: string[], options: { input?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('ssh', [...SSH_OPTS, ...args], { timeout: options.timeout ?? 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 255) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

export function hostPort(addr: string): { host: string; port: string } {
  const i = addr.lastIndexOf(':');
  return { host: addr.slice(0, i), port: addr.slice(i + 1) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `predicate` is true, polling every 10 ms, or rejects after `timeout`. */
export async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}
