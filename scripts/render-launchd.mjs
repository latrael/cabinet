#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultLibraryPath } from '../packages/core/src/config.ts';

const { values } = parseArgs({ options: {
  library: { type: 'string' }, output: { type: 'string' },
  'log-dir': { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help || !values.output) {
  console.log('Usage: node scripts/render-launchd.mjs --output <file.plist> [--library <folder>] [--log-dir <folder>] [--force]');
  process.exit(values.help ? 0 : 1);
}
const output = resolve(values.output);
if (existsSync(output) && !values.force) throw new Error(`${output} already exists; use --force to replace it`);
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const logs = resolve(values['log-dir'] ?? join(homedir(), 'Library', 'Logs', 'Cabinet'));
const replacements = {
  NODE: process.execPath, REPO: repo, LIBRARY: resolve(values.library ?? defaultLibraryPath()),
  HOME: homedir(), LOG_DIR: logs,
  PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
};
const escapeXml = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const template = readFileSync(join(repo, 'launchd/com.cabinet.plist'), 'utf8');
const plist = template.replace(/__([A-Z_]+)__/g, (_match, key) => escapeXml(replacements[key]));
mkdirSync(dirname(output), { recursive: true });
mkdirSync(logs, { recursive: true });
writeFileSync(output, plist);
console.log(`Rendered ${output}. This command does not install or load the service.`);
