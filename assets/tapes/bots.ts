/**
 * Scripted SSH clients for the multi-user recordings: they connect in the
 * background while the tape types in the foreground, so the GIFs show other
 * people. Not part of the package.
 *
 *   bun assets/tapes/bots.ts lobby     ana and ben chat in examples/lobby.ts
 *   bun assets/tapes/bots.ts arena     the AI plays in examples/arena.ts
 */
import ssh2 from 'ssh2';
import { generateEd25519 } from '../../src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(port: number, user: string, cols = 100, rows = 30): Promise<{ write: (s: string) => void; end: () => void }> {
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client();
    c.on('ready', () =>
      c.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', () => {});
        resolve({ write: (s) => stream.write(s), end: () => c.end() });
      }),
    );
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username: user, privateKey: generateEd25519().private, hostVerifier: () => true });
  });
}

async function type(client: { write: (s: string) => void }, text: string, ms = 70) {
  for (const ch of text) {
    client.write(ch);
    await sleep(ms);
  }
}

async function lobby() {
  await sleep(Number(process.env.BOT_DELAY ?? 5000));
  const ana = await connect(23236, 'ana');
  await sleep(1200);
  await type(ana, 'hi alice! welcome to the lobby');
  await sleep(400);
  ana.write('\r');
  await sleep(5200);
  const ben = await connect(23236, 'ben');
  await sleep(900);
  await type(ben, '/me waves from another terminal', 55);
  await sleep(300);
  ben.write('\r');
  await sleep(1000);
  await type(ana, 'the typing dots are live, @alice', 60);
  await sleep(300);
  ana.write('\r');
  await sleep(2500);
  ben.end();
  await sleep(6000);
  ana.end();
}

async function arena() {
  await sleep(Number(process.env.BOT_DELAY ?? 1000));
  const ai = await connect(23237, 'autoplay');
  await sleep(60_000);
  ai.end();
}

const which = process.argv[2];
await (which === 'lobby' ? lobby() : which === 'arena' ? arena() : Promise.reject(new Error('lobby or arena')));
process.exit(0);
