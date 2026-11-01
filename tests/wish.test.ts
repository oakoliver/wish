// Ports wish_test.go and options_test.go.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Error as WishError,
  Fatal,
  NewServer,
  ParseAuthorizedKey,
  Server,
  WithAddress,
  WithAuthorizedKeys,
  WithBanner,
  WithBannerHandler,
  WithHostKeyPath,
  WithIdleTimeout,
  WithMaxTimeout,
  WithSubsystem,
  WithTrustedUserCAKeys,
  isAuthorized,
  testsession,
  Certificate,
  CheckCert,
  sprintf,
} from '../src/index.ts';
import { TESTDATA, cleanupDirs, hostPort, privateKeyFile, runSSH, tempDir } from './helpers.ts';

afterEach(async () => {
  await testsession.CloseAll();
  cleanupDirs();
});

describe('NewServer', () => {
  test('creates the host key at WithHostKeyPath', () => {
    const fp = join(tempDir(), 'sub', 'id_ed25519');
    NewServer(WithHostKeyPath(fp));
    expect(existsSync(fp)).toBe(true);
    expect(existsSync(`${fp}.pub`)).toBe(true);
    expect(statSync(fp).mode & 0o777).toBe(0o600);
    expect(statSync(join(tempDir(), '..')).isDirectory()).toBe(true);
    expect(readFileSync(fp, 'utf8')).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(readFileSync(`${fp}.pub`, 'utf8').startsWith('ssh-ed25519 ')).toBe(true);
  });

  test('reuses an existing host key', () => {
    const fp = join(tempDir(), 'id_ed25519');
    NewServer(WithHostKeyPath(fp));
    const first = readFileSync(fp, 'utf8');
    NewServer(WithHostKeyPath(fp));
    expect(readFileSync(fp, 'utf8')).toBe(first);
  });

  test('with options', () => {
    const fp = join(tempDir(), 'id_ed25519');
    const srv = NewServer(WithHostKeyPath(fp), WithMaxTimeout(1000), WithBanner('welcome'), WithAddress(':2222'));
    expect(srv.maxTimeout).toBe(1000);
    expect(srv.banner).toBe('welcome');
    expect(srv.addr).toBe(':2222');
  });
});

test('Error writes to stderr', async () => {
  const sess = await testsession.New(new Server({ handler: (s) => WishError(s, new Error('foo err')) }));
  const chunks: Buffer[] = [];
  sess.stderr = { write: (d: Buffer) => chunks.push(d) } as never;
  await sess.run('');
  expect(Buffer.concat(chunks).toString().trim()).toBe('foo err');
});

test('Fatal writes to stderr and exits 1', async () => {
  const sess = await testsession.New(new Server({ handler: (s) => Fatal(s, new Error('foo err')) }));
  const err = await sess.run('').then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err.code).toBe(1);
  expect(err.stderr.toString().trim()).toBe('foo err');
});

test('WithSubsystem', () => {
  const srv = new Server({ handler: () => {} });
  WithSubsystem('foo', () => {})(srv);
  expect(typeof srv.subsystemHandlers.foo).toBe('function');
});

test('WithBanner', async () => {
  const srv = new Server({ handler: () => {} });
  WithBanner('a banner')(srv);
  let got = '';
  await (await testsession.New(srv, { onBanner: (m) => (got = m) })).run('');
  expect(got).toBe('a banner');
});

test('WithBannerHandler', async () => {
  const srv = new Server({ handler: () => {} });
  WithBannerHandler((ctx) => `banner for ${ctx.user()}`)(srv);
  let got = '';
  await (await testsession.New(srv, { username: 'fulano', onBanner: (m) => (got = m) })).run('');
  expect(got).toBe('banner for fulano');
});

test('WithIdleTimeout', () => {
  const s = new Server();
  WithIdleTimeout(1000)(s);
  expect(s.idleTimeout).toBe(1000);
});

test('WithMaxTimeout', () => {
  const s = new Server();
  WithMaxTimeout(1000)(s);
  expect(s.maxTimeout).toBe(1000);
});

describe('isAuthorized', () => {
  test('valid', () => {
    expect(isAuthorized(join(TESTDATA, 'authorized_keys'), () => true)).toBe(true);
  });
  test('invalid', () => {
    expect(isAuthorized(join(TESTDATA, 'invalid_authorized_keys'), () => true)).toBe(false);
  });
  test('file not found', () => {
    expect(isAuthorized(join(TESTDATA, 'nope_authorized_keys'), () => true)).toBe(false);
  });
});

describe('WithAuthorizedKeys', () => {
  test('valid', async () => {
    const s = new Server();
    WithAuthorizedKeys(join(TESTDATA, 'authorized_keys'))(s);
    const cases: Array<[string, boolean]> = [
      ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMJlb/qf2B2kMNdBxfpCQqI2ctPcsOkdZGVh5zTRhKtH k3@test', true],
      ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOhsthN+zSFSJF7V2HFSO4+2OJYRghuAA43CIbVyvzF8 k7@test', false],
    ];
    for (const [line, authorize] of cases) {
      const [key] = ParseAuthorizedKey(line);
      expect(await s.publicKeyHandler!(null as never, key)).toBe(authorize);
    }
  });

  test('invalid', () => {
    const s = new Server();
    expect(() => WithAuthorizedKeys(join(TESTDATA, 'invalid_authorized_keys'))(s)).not.toThrow();
  });

  test('file not found', () => {
    const s = new Server();
    expect(() => WithAuthorizedKeys(join(TESTDATA, 'nope_authorized_keys'))(s)).toThrow();
  });
});

describe('WithTrustedUserCAKeys', () => {
  function setup(): Server {
    const s = new Server({
      handler: (sess) => {
        const cert = sess.publicKey();
        const ok = cert instanceof Certificate;
        sess.write(sprintf('cert? %v - principals: %v - type: %v', ok, ok ? cert.validPrincipals : [], ok ? cert.certType : 0));
      },
    });
    WithTrustedUserCAKeys(join(TESTDATA, 'ca.pub'))(s);
    return s;
  }

  async function connect(s: Server, user: string, cert: string | null) {
    const { port } = hostPort(await testsession.Listen(s));
    const key = privateKeyFile('foo');
    const args = ['-p', port, '-i', key, '-o', 'PreferredAuthentications=publickey'];
    if (cert) args.push('-o', `CertificateFile=${join(TESTDATA, cert)}`);
    return runSSH([...args, `${user}@127.0.0.1`, '']);
  }

  test('invalid ca key', () => {
    expect(() => WithTrustedUserCAKeys(join(TESTDATA, 'invalid-path'))(new Server())).toThrow();
  });

  test('valid', async () => {
    const res = await connect(setup(), 'foo', 'valid-cert.pub');
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('cert? true - principals: [foo] - type: 1');
  });

  test('valid wrong principal', async () => {
    const res = await connect(setup(), 'not-foo', 'valid-cert.pub');
    expect(res.code).toBe(255);
    expect(res.stderr).toContain('Permission denied');
  });

  test('expired', async () => {
    const res = await connect(setup(), 'foo', 'expired-cert.pub');
    expect(res.code).toBe(255);
    expect(res.stderr).toContain('Permission denied');
  });

  test('signed by another ca', async () => {
    const res = await connect(setup(), 'foo', 'another-ca-cert.pub');
    expect(res.code).toBe(255);
    expect(res.stderr).toContain('Permission denied');
  });

  test('not a cert', async () => {
    const res = await connect(setup(), 'foo', null);
    expect(res.code).toBe(255);
    expect(res.stderr).toContain('Permission denied');
  });

  test('CheckCert reports why a certificate fails', () => {
    const [cert] = ParseAuthorizedKey(readFileSync(join(TESTDATA, 'valid-cert.pub')));
    expect(cert).toBeInstanceOf(Certificate);
    const c = cert as Certificate;
    expect(c.keyId).toBe('id-1');
    expect(c.validPrincipals).toEqual(['foo']);
    expect(() => CheckCert(c, 'foo')).not.toThrow();
    expect(() => CheckCert(c, 'bar')).toThrow('principal');
    const [expired] = ParseAuthorizedKey(readFileSync(join(TESTDATA, 'expired-cert.pub')));
    expect(() => CheckCert(expired as Certificate, 'foo')).toThrow('expired');
  });
});
