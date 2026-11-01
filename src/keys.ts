/**
 * Public keys, OpenSSH certificates and authorized_keys parsing.
 *
 * Mirrors the parts of golang.org/x/crypto/ssh that wish exposes through
 * charm.land/ssh: PublicKey, Certificate, ParseAuthorizedKey, KeysEqual and
 * the certificate checks used by WithTrustedUserCAKeys.
 */

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import ssh2 from 'ssh2';

const { utils } = ssh2;

// ─── Wire format ────────────────────────────────────────────────────────────

/** Reads SSH wire-format values (RFC 4251 §5) from a buffer. */
export class WireReader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  uint32(): number {
    if (this.remaining < 4) throw new Error('ssh: short read');
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint64(): bigint {
    if (this.remaining < 8) throw new Error('ssh: short read');
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(): Buffer {
    const len = this.uint32();
    if (this.remaining < len) throw new Error('ssh: short read');
    const v = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  string(): string {
    return this.bytes().toString('utf8');
  }
}

/** Encodes values in SSH wire format. */
export function wireString(value: string | Buffer): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
}

// ─── Public keys ────────────────────────────────────────────────────────────

/**
 * PublicKey is an SSH public key in wire format, as gossh.PublicKey.
 * `type()` is the algorithm name and `marshal()` the wire encoding.
 */
export class PublicKey {
  protected readonly _blob: Buffer;
  protected readonly _type: string;

  constructor(blob: Buffer) {
    this._blob = Buffer.from(blob);
    this._type = new WireReader(this._blob).string();
  }

  /** The key's algorithm name, such as `ssh-ed25519`. */
  type(): string {
    return this._type;
  }

  /** The key in SSH wire format. */
  marshal(): Buffer {
    return Buffer.from(this._blob);
  }

  /** The key as an authorized_keys line without a comment: `<type> <base64>`. */
  toString(): string {
    return `${this._type} ${this._blob.toString('base64')}`;
  }

  /** The OpenSSH SHA256 fingerprint, as gossh.FingerprintSHA256. */
  fingerprint(): string {
    return 'SHA256:' + createHash('sha256').update(this._blob).digest('base64').replace(/=+$/, '');
  }
}

/** Certificate types, as gossh.UserCert and gossh.HostCert. */
export const UserCert = 1;
export const HostCert = 2;
/** CertTimeInfinity is the ValidBefore value of a certificate that never expires. */
export const CertTimeInfinity = 2n ** 64n - 1n;

const CERT_SUFFIX = '-cert-v01@openssh.com';

/** An OpenSSH certificate (PROTOCOL.certkeys), as gossh.Certificate. */
export class Certificate extends PublicKey {
  readonly nonce: Buffer;
  /** The certified key. */
  readonly key: PublicKey;
  readonly serial: bigint;
  readonly certType: number;
  readonly keyId: string;
  readonly validPrincipals: string[];
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly criticalOptions: Record<string, string>;
  readonly extensions: Record<string, string>;
  readonly reserved: Buffer;
  /** The CA key that signed this certificate. */
  readonly signatureKey: PublicKey;
  /** The CA's signature, in SSH signature format. */
  readonly signature: Buffer;
  private readonly _signedBytes: Buffer;

  constructor(blob: Buffer) {
    super(blob);
    if (!this._type.endsWith(CERT_SUFFIX)) throw new Error(`ssh: not a certificate: ${this._type}`);
    const plainType = this._type.slice(0, -CERT_SUFFIX.length);
    const r = new WireReader(this._blob);
    r.string();
    this.nonce = r.bytes();
    const keyStart = r.pos;
    const fields = KEY_FIELDS[plainType];
    if (fields === undefined) throw new Error(`ssh: unsupported certificate key type ${plainType}`);
    for (let i = 0; i < fields; i++) r.bytes();
    this.key = new PublicKey(Buffer.concat([wireString(plainType), this._blob.subarray(keyStart, r.pos)]));
    this.serial = r.uint64();
    this.certType = r.uint32();
    this.keyId = r.string();
    this.validPrincipals = parseStringList(r.bytes());
    this.validAfter = r.uint64();
    this.validBefore = r.uint64();
    this.criticalOptions = parseOptionMap(r.bytes());
    this.extensions = parseOptionMap(r.bytes());
    this.reserved = r.bytes();
    this.signatureKey = new PublicKey(r.bytes());
    this._signedBytes = this._blob.subarray(0, r.pos);
    this.signature = r.bytes();
  }

  /** The bytes the CA signed: the certificate without its signature. */
  bytesForSigning(): Buffer {
    return Buffer.from(this._signedBytes);
  }
}

// Number of wire fields after the type name for each plain key type.
const KEY_FIELDS: Record<string, number> = {
  'ssh-ed25519': 1,
  'ssh-rsa': 2,
  'ecdsa-sha2-nistp256': 2,
  'ecdsa-sha2-nistp384': 2,
  'ecdsa-sha2-nistp521': 2,
  'ssh-dss': 4,
  'sk-ssh-ed25519@openssh.com': 2,
  'sk-ecdsa-sha2-nistp256@openssh.com': 3,
};

function parseStringList(buf: Buffer): string[] {
  const r = new WireReader(buf);
  const out: string[] = [];
  while (r.remaining > 0) out.push(r.string());
  return out;
}

function parseOptionMap(buf: Buffer): Record<string, string> {
  const r = new WireReader(buf);
  const out: Record<string, string> = {};
  while (r.remaining > 0) {
    const name = r.string();
    const data = r.bytes();
    out[name] = data.length > 0 ? new WireReader(data).string() : '';
  }
  return out;
}

/** Parses a wire-format public key or certificate, as gossh.ParsePublicKey. */
export function ParsePublicKey(blob: Buffer): PublicKey {
  const type = new WireReader(blob).string();
  if (type.endsWith(CERT_SUFFIX)) return new Certificate(blob);
  // Make sure the key itself is well formed before handing it out.
  const parsed = utils.parseKey(Buffer.concat([Buffer.from(`${type} `), Buffer.from(blob.toString('base64'))]));
  if (parsed instanceof Error) throw new Error(`ssh: ${parsed.message}`);
  return new PublicKey(blob);
}

/**
 * KeysEqual reports whether two keys are the same, comparing their wire
 * encoding in constant time. A null key is never equal to anything.
 */
export function KeysEqual(a: PublicKey | null | undefined, b: PublicKey | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.marshal();
  const y = b.marshal();
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * ParseAuthorizedKey parses one public key from an authorized_keys line, as
 * gossh.ParseAuthorizedKey. It returns `[key, comment, options, rest]` and
 * throws when the line holds no valid key.
 */
export function ParseAuthorizedKey(input: string | Buffer): [PublicKey, string, string[], string] {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const rest = lines.slice(i + 1).join('\n');
    const direct = parseKeyFields(line);
    if (direct) return [direct[0], direct[1], [], rest];
    const [options, remainder] = splitOptions(line);
    const withOptions = parseKeyFields(remainder);
    if (withOptions) return [withOptions[0], withOptions[1], options, rest];
  }
  throw new Error('ssh: no key found');
}

function parseKeyFields(line: string): [PublicKey, string] | null {
  const match = /^(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  const blob = Buffer.from(match[2], 'base64');
  if (blob.length === 0) return null;
  try {
    const key = ParsePublicKey(blob);
    if (key.type() !== match[1]) return null;
    return [key, (match[3] ?? '').trim()];
  } catch {
    return null;
  }
}

function splitOptions(line: string): [string[], string] {
  const options: string[] = [];
  let current = '';
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && (ch === ',' || ch === ' ' || ch === '\t')) {
      if (current) options.push(current);
      current = '';
      if (ch !== ',') break;
      continue;
    }
    current += ch;
  }
  return [options, line.slice(i + 1)];
}

// ─── Signature verification ─────────────────────────────────────────────────

const CURVES: Record<string, { crv: string; hash: string; size: number }> = {
  nistp256: { crv: 'P-256', hash: 'sha256', size: 32 },
  nistp384: { crv: 'P-384', hash: 'sha384', size: 48 },
  nistp521: { crv: 'P-521', hash: 'sha512', size: 66 },
};

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function unsignedInt(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

function keyObject(key: PublicKey): KeyObject {
  const r = new WireReader(key.marshal());
  const type = r.string();
  if (type === 'ssh-ed25519') {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(r.bytes()) }, format: 'jwk' });
  }
  if (type === 'ssh-rsa') {
    const e = unsignedInt(r.bytes());
    const n = unsignedInt(r.bytes());
    return createPublicKey({ key: { kty: 'RSA', e: b64url(e), n: b64url(n) }, format: 'jwk' });
  }
  if (type.startsWith('ecdsa-sha2-')) {
    const curve = CURVES[r.string()];
    if (!curve) throw new Error('ssh: unsupported curve');
    const point = r.bytes();
    if (point[0] !== 4 || point.length !== 1 + 2 * curve.size) throw new Error('ssh: invalid curve point');
    const x = point.subarray(1, 1 + curve.size);
    const y = point.subarray(1 + curve.size);
    return createPublicKey({ key: { kty: 'EC', crv: curve.crv, x: b64url(x), y: b64url(y) }, format: 'jwk' });
  }
  throw new Error(`ssh: unsupported key type ${type}`);
}

/**
 * Verifies an SSH-format signature (`string algo, string blob`) over data with
 * the given plain public key. Returns false on any malformed input.
 */
export function verifySSHSignature(key: PublicKey, data: Buffer, signature: Buffer): boolean {
  try {
    const sr = new WireReader(signature);
    const algo = sr.string();
    const sig = sr.bytes();
    const ko = keyObject(key);
    const type = key.type();
    if (type === 'ssh-ed25519') {
      return algo === 'ssh-ed25519' && cryptoVerify(null, data, ko, sig);
    }
    if (type === 'ssh-rsa') {
      const hash = algo === 'rsa-sha2-256' ? 'sha256' : algo === 'rsa-sha2-512' ? 'sha512' : algo === 'ssh-rsa' ? 'sha1' : null;
      return hash !== null && cryptoVerify(hash, data, ko, sig);
    }
    if (type.startsWith('ecdsa-sha2-')) {
      if (algo !== type) return false;
      const curve = CURVES[type.slice('ecdsa-sha2-'.length)];
      const ir = new WireReader(sig);
      const rr = unsignedInt(ir.bytes());
      const ss = unsignedInt(ir.bytes());
      if (rr.length > curve.size || ss.length > curve.size) return false;
      const p1363 = Buffer.alloc(curve.size * 2);
      rr.copy(p1363, curve.size - rr.length);
      ss.copy(p1363, curve.size * 2 - ss.length);
      return cryptoVerify(curve.hash, data, { key: ko, dsaEncoding: 'ieee-p1363' }, p1363);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Verifies a plain (non-certificate) key's signature as delivered by ssh2,
 * which has already stripped the SSH framing and converted ECDSA signatures
 * to DER.
 */
export function verifyAuthSignature(key: PublicKey, blob: Buffer, signature: Buffer, hashAlgo?: string): boolean {
  const parsed = utils.parseKey(Buffer.from(key.toString()));
  if (parsed instanceof Error) return false;
  try {
    return parsed.verify(blob, signature, hashAlgo as string) === true;
  } catch {
    return false;
  }
}

/**
 * CheckCert validates a user certificate the way gossh.CertChecker.CheckCert
 * does: no unsupported critical options, the principal is listed (when the
 * certificate lists any), the validity window holds, and the CA signature
 * verifies. It also requires a user certificate and enforces the
 * `source-address` critical option against `remoteIP`, which upstream wish
 * leaves unchecked. Throws with the reason on failure.
 */
export function CheckCert(cert: Certificate, principal: string, remoteIP?: string, now = new Date()): void {
  if (cert.certType !== UserCert) throw new Error('ssh: certificate is not a user certificate');
  for (const option of Object.keys(cert.criticalOptions)) {
    if (option === 'source-address') continue;
    throw new Error(`ssh: unsupported critical option "${option}" in certificate`);
  }
  if (cert.validPrincipals.length > 0 && !cert.validPrincipals.includes(principal)) {
    throw new Error(`ssh: principal "${principal}" not in the set of valid principals for given certificate`);
  }
  const unixNow = BigInt(Math.floor(now.getTime() / 1000));
  if (unixNow < cert.validAfter) throw new Error('ssh: cert is not yet valid');
  if (cert.validBefore !== CertTimeInfinity && unixNow >= cert.validBefore) throw new Error('ssh: cert has expired');
  const sourceAddress = cert.criticalOptions['source-address'];
  if (sourceAddress !== undefined && !addressAllowed(sourceAddress, remoteIP)) {
    throw new Error('ssh: source address is not allowed by the certificate');
  }
  if (!verifySSHSignature(cert.signatureKey, cert.bytesForSigning(), cert.signature)) {
    throw new Error('ssh: certificate signature does not verify');
  }
}

function addressAllowed(list: string, ip: string | undefined): boolean {
  if (!ip) return false;
  const addr = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
  if (!family) return false;
  const blocks = new BlockList();
  for (const entry of list.split(',')) {
    const [base, bits] = entry.trim().split('/');
    const entryFamily = isIPv4(base) ? 'ipv4' : isIPv6(base) ? 'ipv6' : null;
    if (!entryFamily) return false;
    const prefix = bits === undefined ? (entryFamily === 'ipv4' ? 32 : 128) : Number(bits);
    blocks.addSubnet(base, prefix, entryFamily);
  }
  return blocks.check(addr, family);
}
