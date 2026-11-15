import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** Never accept a secret in argv (shell history/process listings). */
export async function readPassphrase(fromStdin: boolean): Promise<string> {
  if (fromStdin) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!process.stdin.isTTY) throw new Error('Use --stdin when piping a passphrase, or run this command in a terminal.');
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    process.stdout.write('New passphrase (at least 8 characters): ');
    const first = await rl.question('');
    process.stdout.write('\nConfirm passphrase: ');
    const second = await rl.question('');
    process.stdout.write('\n');
    if (first !== second) throw new Error('Passphrases do not match');
    return first;
  } finally {
    rl.close();
    silent.end();
  }
}
