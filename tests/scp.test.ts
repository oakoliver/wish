// Ports scp_test.go, fs_test.go, filesystem_test.go and limit_reader_test.go,
// including the golden files.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Server, testsession, scp } from '../src/index.ts';
import { TESTDATA, cleanupDirs, tempDir } from './helpers.ts';

const { DirEntry, FileEntry, RootEntry, GetInfo, OpCopyFromClient, OpCopyToClient, NULL } = scp;

afterEach(async () => {
  await testsession.CloseAll();
  cleanupDirs();
});

const MTIME = 1323853868;
const ATIME = 1380425711;

function chtimesTree(dir: string): void {
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    utimesSync(p, ATIME, MTIME);
  };
  walk(dir);
}

function fixOutput(b: Buffer | string): string {
  return Buffer.from(b).toString('latin1').replaceAll('\r', '').replaceAll('\0', '<NULL>');
}

function requireEqualGolden(name: string, out: Buffer): void {
  const golden = readFileSync(join(TESTDATA, 'scp', `${name}.test`));
  expect(fixOutput(out)).toBe(fixOutput(golden));
}

function setup(rh: scp.CopyToClientHandler | null, wh: scp.CopyFromClientHandler | null) {
  return testsession.New(new Server({ handler: scp.Middleware(rh, wh)((s) => s.exit(0)) }));
}

async function combined(p: Promise<Buffer>): Promise<[Buffer, Error | null]> {
  try {
    return [await p, null];
  } catch (err) {
    return [(err as { combined?: Buffer }).combined ?? Buffer.alloc(0), err as Error];
  }
}

describe('GetInfo', () => {
  test('no exec', () => expect(GetInfo([]).ok).toBe(false));
  test('exec is not scp', () => expect(GetInfo(['not-scp']).ok).toBe(false));
  test('scp no recursive', () => {
    const info = GetInfo(['scp', '-f', 'file']);
    expect(info).toEqual({ ok: true, recursive: false, path: 'file', op: OpCopyToClient });
  });
  test('scp recursive', () => {
    const info = GetInfo(['scp', '-r', '--some-ignored-flag', '-f', 'file', 'ignored-arg']);
    expect(info).toEqual({ ok: true, recursive: true, path: 'file', op: OpCopyToClient });
  });
  test('scp op copy from client', () => {
    const info = GetInfo(['scp', '-t', 'file']);
    expect(info.ok).toBe(true);
    expect(info.op).toBe(OpCopyFromClient);
    expect(info.path).toBe('file');
  });
  test('missing path after -f', () => expect(GetInfo(['scp', '-f']).ok).toBe(false));
  test('missing path after -t', () => expect(GetInfo(['scp', '-t']).ok).toBe(false));
});

test('NoDirRootEntry', async () => {
  const root = new RootEntry();
  const f1 = 'hello from file f1\n';
  const f2 = 'hello from file f2\nwith multiple lines :)\n';
  const dir = new DirEntry({ children: [], name: 'dir1', filepath: 'dir1', mode: 0o755 });
  dir.append(new FileEntry({ name: 'f2', filepath: 'f2', mode: 0o600, size: f2.length, reader: Readable.from([Buffer.from(f2)]) }));
  root.append(new FileEntry({ name: 'f1', filepath: 'f1', mode: 0o644, size: f1.length, reader: Readable.from([Buffer.from(f1)]) }));
  root.append(dir);
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (d: Buffer) => chunks.push(d));
  await root.write(out);
  requireEqualGolden('TestNoDirRootEntry', Buffer.concat(chunks));
});

test('isWithin', () => {
  const cases: Array<[string, string, boolean]> = [
    ['a/foo', 'a/foo', true],
    ['a/foo', 'a/foo/nested', true],
    ['a/foo', 'a/foobar', false],
    ['a/foo', 'a/foobar/nested', false],
    ['a/foo', 'a', false],
    ['.', '.', true],
    ['.', 'a', true],
    ['.', 'a/foo', true],
    ['.', '..', false],
    ['.', '../a', false],
    ['/', '/', true],
    ['/', '/a/foo', true],
    ['C:/', 'C:/a', true],
    ['//server/share/', '//server/share/a', true],
    ['//server/share/a', '//server/share/ab', false],
  ];
  for (const [dir, path, want] of cases) expect([dir, path, scp.isWithin(dir, path)]).toEqual([dir, path, want]);
});

test('append sibling directories', () => {
  for (const base of ['.', 'a', '/']) {
    const foo = join(base, 'foo');
    const foobar = join(base, 'foobar');
    const fooFile = new FileEntry({ filepath: join(foo, 'same.txt') });
    const foobarFile = new FileEntry({ filepath: join(foobar, 'same.txt') });
    const root = new RootEntry();
    for (const e of [new DirEntry({ filepath: base }), new DirEntry({ filepath: foo }), fooFile, new DirEntry({ filepath: foobar }), foobarFile]) {
      root.append(e);
    }
    expect(root.children.length).toBe(1);
    const top = root.children[0] as scp.DirEntry;
    expect(top.filepath).toBe(base);
    expect(top.children.map((c) => c.filepath)).toEqual([foo, foobar]);
    expect((top.children[0] as scp.DirEntry).children).toEqual([fooFile]);
    expect((top.children[1] as scp.DirEntry).children).toEqual([foobarFile]);
  }
});

describe('invalid ops', () => {
  test('not scp', async () => {
    const [, err] = await combined((await setup(null, null)).combinedOutput('not-scp ign'));
    expect(err).toBeNull();
  });
  test('copy to client', async () => {
    const [, err] = await combined((await setup(null, null)).combinedOutput('scp -t .'));
    expect(err).not.toBeNull();
  });
  test('copy from client', async () => {
    const [, err] = await combined((await setup(null, null)).combinedOutput('scp -f .'));
    expect(err).not.toBeNull();
  });
});

type Factory = (dir: string) => scp.CopyToClientHandler;
const fsRead: Factory = (dir) => scp.NewFSReadHandler(scp.DirFS(dir));
const fsHandler: Factory = (dir) => scp.NewFileSystemHandler(dir);

function readCases(prefix: string, factory: Factory) {
  test('file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'a text file', { mode: 0o644 });
    chtimesTree(dir);
    const [out, err] = await combined((await setup(factory(dir), null)).combinedOutput('scp -f a.txt'));
    expect(err).toBeNull();
    requireEqualGolden(`${prefix}/file`, out);
  });

  test('glob', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'a text file', { mode: 0o644 });
    writeFileSync(join(dir, 'b.txt'), 'another text file', { mode: 0o644 });
    chtimesTree(dir);
    const [out, err] = await combined((await setup(factory(dir), null)).combinedOutput('scp -f *.txt'));
    expect(err).toBeNull();
    requireEqualGolden(`${prefix}/glob`, out);
  });

  test('invalid file', async () => {
    const [, err] = await combined((await setup(factory(tempDir()), null)).combinedOutput('scp -f a.txt'));
    expect(err).not.toBeNull();
  });

  const tree = () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'a/b/c/d/e'), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, 'a/b/c.txt'), 'c text file', { mode: 0o644 });
    writeFileSync(join(dir, 'a/b/c/d/e/e.txt'), 'e text file', { mode: 0o644 });
    chtimesTree(dir);
    return dir;
  };

  test('recursive', async () => {
    const [out, err] = await combined((await setup(factory(tree()), null)).combinedOutput('scp -r -f a'));
    expect(err).toBeNull();
    requireEqualGolden(`${prefix}/recursive`, out);
  });

  test('recursive glob', async () => {
    const [out, err] = await combined((await setup(factory(tree()), null)).combinedOutput('scp -r -f a/*'));
    expect(err).toBeNull();
    requireEqualGolden(`${prefix}/recursive_glob`, out);
  });

  test('recursive invalid file', async () => {
    const [, err] = await combined((await setup(factory(tempDir()), null)).combinedOutput('scp -r -f a'));
    expect(err).not.toBeNull();
  });

  test('recursive folder', async () => {
    const [out, err] = await combined((await setup(fsHandler(tree()), null)).combinedOutput('scp -r -f /'));
    expect(err).toBeNull();
    requireEqualGolden(`${prefix}/recursive_folder`, out);
  });
}

describe('FS', () => {
  readCases('TestFS', fsRead);

  for (const [name, path] of [
    ['recursive_sibling_prefixes', 'a'],
    ['recursive_sibling_prefixes_glob', 'a/*'],
    ['recursive_sibling_prefixes_dot', '.'],
  ]) {
    test(name, async () => {
      const dir = tempDir();
      mkdirSync(join(dir, 'a/foo'), { recursive: true, mode: 0o755 });
      mkdirSync(join(dir, 'a/foobar'), { recursive: true, mode: 0o755 });
      writeFileSync(join(dir, 'a/foo/one.txt'), 'one', { mode: 0o644 });
      writeFileSync(join(dir, 'a/foobar/two.txt'), 'two', { mode: 0o644 });
      chtimesTree(dir);
      const [out, err] = await combined((await setup(fsRead(dir), null)).combinedOutput(`scp -r -f ${path}`));
      expect(err).toBeNull();
      requireEqualGolden(`TestFS/${name}`, out);
    });
  }

  test('errors', async () => {
    const h = scp.NewFSReadHandler(scp.DirFS(tempDir()));
    await expect(h.glob(null, '[asda')).rejects.toThrow();
    await expect(h.newDirEntry(null, 'foo')).rejects.toThrow();
    await expect(h.newFileEntry(null, 'foo')).rejects.toThrow();
  });
});

describe('Filesystem', () => {
  describe('scp -f', () => readCases('TestFilesystem/scp_-f', fsHandler));

  describe('scp -t', () => {
    test('file', async () => {
      const dir = tempDir();
      const sess = await setup(null, scp.NewFileSystemHandler(dir));
      sess.stdin = Buffer.concat([Buffer.from('T1183832947 0 1183833773 0\nC0644 6 a.txt\nhello\n'), NULL]);
      const [, err] = await combined(sess.combinedOutput('scp -t .'));
      expect(err).toBeNull();
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello\n');
    });

    test('recursive', async () => {
      const dir = tempDir();
      const sess = await setup(null, scp.NewFileSystemHandler(dir));
      sess.stdin = Buffer.concat([
        Buffer.from('T1183832947 0 1183833773 0\nD0755 0 folder1\nC0644 6 file1\nhello\n'),
        NULL,
        Buffer.from('D0755 0 folder2\nT1183832947 0 1183833773 0\nC0644 6 file2\nhello\n'),
        NULL,
        Buffer.from('E\nE\n'),
      ]);
      const [, err] = await combined(sess.combinedOutput('scp -r -t .'));
      expect(err).toBeNull();
      const mtime = 1183832947;
      const st1 = statSync(join(dir, 'folder1'));
      expect(st1.isDirectory()).toBe(true);
      expect(Math.floor(st1.mtimeMs / 1000)).not.toBe(mtime);
      expect(Math.floor(statSync(join(dir, 'folder1/file1')).mtimeMs / 1000)).not.toBe(mtime);
      expect(Math.floor(statSync(join(dir, 'folder1/folder2/file2')).mtimeMs / 1000)).toBe(mtime);
    });
  });

  describe('errors', () => {
    test('chtimes', async () => {
      await expect(new scp.FileSystemHandler(tempDir()).chtimes('nope', 1212212, 323232)).rejects.toThrow();
    });
    test('invalid glob', async () => {
      await expect(new scp.FileSystemHandler(tempDir()).glob(null, '[asda')).rejects.toThrow();
    });
    test('NewDirEntry does not exist', async () => {
      await expect(new scp.FileSystemHandler(tempDir()).newDirEntry(null, 'foo')).rejects.toThrow();
    });
    test('NewFileEntry does not exist', async () => {
      await expect(new scp.FileSystemHandler(tempDir()).newFileEntry(null, 'foo')).rejects.toThrow();
    });
    test('Mkdir parent does not exist', async () => {
      const h = new scp.FileSystemHandler(tempDir());
      await expect(h.mkdir(null, new DirEntry({ name: 'foo', filepath: 'foo/bar/baz', mode: 0o755 }))).rejects.toThrow();
    });
    test('Write parent does not exist', async () => {
      const h = new scp.FileSystemHandler(tempDir());
      await expect(h.write(null, new FileEntry({ name: 'foo.txt', filepath: 'baz/foo.txt', mode: 0o644, size: 10 }))).rejects.toThrow();
    });
    test('Write reader fails', async () => {
      const h = new scp.FileSystemHandler(tempDir());
      const reader = new Readable({
        read() {
          this.destroy(new Error('fake err'));
        },
      });
      await expect(h.write(null, new FileEntry({ name: 'foo.txt', filepath: 'foo.txt', mode: 0o644, size: 10, reader }))).rejects.toThrow();
    });
  });
});

test('prefixed path traversal', async () => {
  const root = tempDir();
  const h = new scp.FileSystemHandler(root);
  writeFileSync(join(root, 'a.txt'), 'a text file');
  const cases: Array<[string, string, string, boolean]> = [
    ['relative traversal', '../../../etc/passwd', join(root, 'etc/passwd'), false],
    ['nested relative traversal', 'foo/../../etc/passwd', join(root, 'etc/passwd'), false],
    ['deep relative traversal', '../../../tmp/pwned', join(root, 'tmp/pwned'), false],
    ['absolute path outside root', '/etc/passwd', join(root, 'etc/passwd'), false],
    ['root-prefixed traversal', root + '/../../../etc/shadow', '', true],
    ['valid relative path', 'subdir/file.txt', join(root, 'subdir/file.txt'), false],
    ['valid path under root', join(root, 'file.txt'), join(root, 'file.txt'), false],
    ['glob pattern', '*.txt', join(root, '*.txt'), false],
    ['under a non-directory', 'a.txt/b', join(root, 'a.txt/b'), false],
    ['root slash', '/', root, false],
    ['dot', '.', root, false],
  ];
  for (const [name, path, want, inRoot] of cases) {
    const p = await h.prefixed(path);
    if (inRoot) expect([name, p === root || p.startsWith(root + '/')]).toEqual([name, true]);
    else expect([name, p]).toEqual([name, want]);
  }
});

test('validateName', () => {
  const cases: Array<[string, boolean]> = [
    ['normal.txt', false],
    ['file-with-dashes', false],
    ['.hidden', false],
    ['..', true],
    ['.', true],
    ['', true],
    ['../etc/passwd', true],
    ['sub/dir', true],
    ['back\\slash', true],
  ];
  for (const [name, invalid] of cases) {
    if (invalid) expect(() => scp.validateName(name)).toThrow();
    else expect(() => scp.validateName(name)).not.toThrow();
  }
});

describe('path traversal end to end', () => {
  test('write file', async () => {
    const root = tempDir();
    const secret = tempDir();
    const sess = await setup(null, scp.NewFileSystemHandler(root));
    sess.stdin = Buffer.concat([Buffer.from(`C0644 5 ../${basename(secret)}/pwned\nhello`), NULL]);
    const [, err] = await combined(sess.combinedOutput('scp -t .'));
    expect(err).not.toBeNull();
    expect(existsSync(join(secret, 'pwned'))).toBe(false);
  });

  test('write dir', async () => {
    const root = tempDir();
    const sess = await setup(null, scp.NewFileSystemHandler(root));
    sess.stdin = Buffer.concat([Buffer.from('D0755 0 ../../evil_dir\nC0644 7 payload\npayload'), NULL, Buffer.from('E\n')]);
    const [, err] = await combined(sess.combinedOutput('scp -r -t .'));
    expect(err).not.toBeNull();
    expect(existsSync(join(root, '../../evil_dir'))).toBe(false);
  });

  test('read file', async () => {
    const root = tempDir();
    const secret = tempDir();
    writeFileSync(join(secret, 'secret.txt'), 'super-secret');
    const [out, err] = await combined((await setup(scp.NewFileSystemHandler(root), null)).combinedOutput(`scp -f ../${basename(secret)}/secret.txt`));
    expect(err).not.toBeNull();
    expect(out.toString()).not.toContain('super-secret');
  });

  test('read glob', async () => {
    const root = tempDir();
    const secret = tempDir();
    writeFileSync(join(secret, 'secret.txt'), 'super-secret');
    const [, err] = await combined((await setup(scp.NewFileSystemHandler(root), null)).combinedOutput(`scp -f ../${basename(secret)}/secret*`));
    expect(err).not.toBeNull();
  });

  test('filename with slash', async () => {
    const sess = await setup(null, scp.NewFileSystemHandler(tempDir()));
    sess.stdin = Buffer.concat([Buffer.from('C0644 5 sub/file\nhello'), NULL]);
    const [, err] = await combined(sess.combinedOutput('scp -t .'));
    expect(err).not.toBeNull();
  });

  test('filename with dotdot', async () => {
    const sess = await setup(null, scp.NewFileSystemHandler(tempDir()));
    sess.stdin = Buffer.concat([Buffer.from('C0644 5 ..\nhello'), NULL]);
    const [, err] = await combined(sess.combinedOutput('scp -t .'));
    expect(err).not.toBeNull();
  });
});

describe('symlink escape end to end', () => {
  test('read through symlink', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.txt'), 'super-secret', { mode: 0o600 });
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const [out, err] = await combined((await setup(scp.NewFileSystemHandler(root), null)).combinedOutput('scp -f link.txt'));
    expect(err).not.toBeNull();
    expect(out.toString()).not.toContain('super-secret');
  });

  test('overwrite through symlink', async () => {
    const root = tempDir();
    const outside = tempDir();
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'original', { mode: 0o600 });
    symlinkSync(target, join(root, 'link.txt'));
    const sess = await setup(null, scp.NewFileSystemHandler(root));
    sess.stdin = Buffer.concat([Buffer.from('C0644 5 link.txt\npwned'), NULL]);
    const [, err] = await combined(sess.combinedOutput('scp -t .'));
    expect(err).not.toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  test('create under symlinked dir', async () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'dirlink'));
    const sess = await setup(null, scp.NewFileSystemHandler(root));
    sess.stdin = Buffer.concat([Buffer.from('C0644 5 newfile\npwned'), NULL]);
    const [, err] = await combined(sess.combinedOutput('scp -t dirlink'));
    expect(err).not.toBeNull();
    expect(existsSync(join(outside, 'newfile'))).toBe(false);
  });

  test('symlink inside root still works', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'real.txt'), 'in-root', { mode: 0o600 });
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const [out, err] = await combined((await setup(scp.NewFileSystemHandler(root), null)).combinedOutput('scp -f link.txt'));
    expect(err).toBeNull();
    expect(out.toString()).toContain('in-root');
  });
});

describe('limited reader', () => {
  const read = async (text: string, limit: number) => {
    const chunks: Buffer[] = [];
    for await (const c of scp.LimitReader(Readable.from([Buffer.from(text)]), limit)) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };
  test('partial', async () => expect(await read('writing some bytes', 7)).toBe('writing'));
  test('full', async () => expect(await read('some text', 9)).toBe('some text'));
  test('pass limit', async () => expect(await read('another text', 22)).toBe('another text'));
});

test('Match', () => {
  expect(scp.Match('*.txt', 'a.txt')).toBe(true);
  expect(scp.Match('*.txt', 'a/b.txt')).toBe(false);
  expect(scp.Match('a/*', 'a/b')).toBe(true);
  expect(scp.Match('[a-c]?', 'bz')).toBe(true);
  expect(scp.Match('[^a-c]?', 'bz')).toBe(false);
  expect(() => scp.Match('[asda', 'x')).toThrow();
});
