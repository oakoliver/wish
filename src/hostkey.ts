/**
 * Host key generation and loading, as charmbracelet/keygen and ssh.HostKeyFile.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import ssh2 from 'ssh2';

const { utils } = ssh2;

function sshString(data: string | Buffer): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/**
 * Generates an ed25519 key pair in OpenSSH format with node:crypto.
 *
 * ssh2's utils.generateKeyPairSync('ed25519') drops a leading zero byte of
 * the public key, so about 1 key in 256 it writes a private key that ssh2
 * itself then refuses to parse ("Malformed OpenSSH private key"). This
 * encoder writes the 32-byte key as is.
 */
export function generateEd25519(comment = ''): { private: string; public: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const seed = Buffer.from(jwk.d!, 'base64url');
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const nkeys = Buffer.alloc(4);
  nkeys.writeUInt32BE(1);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    nkeys,
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n');
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${pubBlob.toString('base64')}${comment ? ` ${comment}` : ''}`,
  };
}

/** Checks that a host key parses and is a usable, unencrypted private key. */
export function parseHostKey(pem: string | Buffer, source = 'host key'): Buffer {
  const data = Buffer.isBuffer(pem) ? pem : Buffer.from(pem);
  const parsed = utils.parseKey(data);
  if (parsed instanceof Error) throw new Error(`ssh: failed to parse ${source}: ${parsed.message}`);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || typeof (key as { isPrivateKey?: () => boolean }).isPrivateKey !== 'function' || !key.isPrivateKey()) {
    throw new Error(`ssh: ${source} is not a private key`);
  }
  return data;
}

/**
 * Generates an ed25519 key pair and writes it to `path` (private key, mode
 * 0600) and `path.pub` (public key), creating the directory with mode 0700.
 * Returns the private key.
 */
export function generateHostKey(path: string): Buffer {
  const pair = generateEd25519();
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, pair.private, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  writeFileSync(`${path}.pub`, `${pair.public}\n`, { mode: 0o644 });
  return Buffer.from(pair.private);
}

/** Reads the key at `path`, generating an ed25519 key there first if it is missing. */
export function loadOrGenerateHostKey(path: string): Buffer {
  if (!existsSync(path)) return generateHostKey(path);
  return parseHostKey(readFileSync(path), path);
}
