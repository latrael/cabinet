#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  defaultLibraryPath,
  exportLibrary,
  generateSampleLibrary,
  Library,
  libraryExists,
  restoreLibrary,
  setDefaultLibraryPath,
  validateExport,
} from '@cabinet/core';

const HELP = `cabinet — personal hobby, research and AI memory hub

Usage: cabinet <command> [options]

Commands:
  start                 Start the server and web app (default http://localhost:4747)
  mcp                   Run the MCP server over stdio (for Claude Code / Desktop)
  init [path]           Create a library (use --sample for the demo content)
  rebuild               Rebuild the search index from the files
  export [file.zip]     Export the library as a zip (--git to include history)
  restore <file.zip>    Restore a library from an export (current one is moved aside)
  token <name>          Create an access token for an agent (MCP over HTTP / API)
  tokens                List tokens
  passphrase            Set the library passphrase (hidden prompt, or --stdin)
  path [newPath]        Show or set the default library path

Options:
  --library, -l <path>  Library folder (default: ${defaultLibraryPath()})
  --port, -p <port>     Port for start (default 4747)
  --host <host>         Bind address (default 127.0.0.1; 0.0.0.0 for LAN, needs a passphrase)
  --no-ai               Start without the AI layer
  --no-telegram         Start without the Telegram bot
  --agent <name>        Agent name for MCP stdio (default: claude)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      library: { type: 'string', short: 'l' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      sample: { type: 'boolean' },
      git: { type: 'boolean' },
      'no-ai': { type: 'boolean' },
      'no-telegram': { type: 'boolean' },
      'no-watch': { type: 'boolean' },
      agent: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      quiet: { type: 'boolean', short: 'q' },
      stdin: { type: 'boolean' },
    },
  });
  const [cmd = 'help', ...rest] = positionals;
  const library = resolve(values.library ?? defaultLibraryPath());

  switch (cmd) {
    case 'help':
    case '--help':
      console.log(HELP);
      return;

    case 'init': {
      const target = resolve(rest[0] ?? library);
      if (values.sample) {
        if (existsSync(target) && libraryExists(target)) throw new Error(`${target} already holds a library`);
        const n = generateSampleLibrary(target);
        console.log(`Sample library created at ${target} (${n} files)`);
      } else {
        Library.initStructure(target);
        console.log(`Library ready at ${target}`);
      }
      const lib = await Library.open(target);
      await lib.close();
      return;
    }

    case 'start': {
      const { startCabinet } = await import('./start.ts');
      const running = await startCabinet({
        library,
        port: values.port ? Number(values.port) : undefined,
        host: values.host,
        ai: !values['no-ai'],
        telegram: !values['no-telegram'],
        watch: !values['no-watch'],
        quiet: values.quiet,
      });
      const shutdown = async () => {
        console.log('\nStopping Cabinet…');
        await running.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    case 'mcp': {
      const { runStdio } = await import('./mcp-stdio.ts');
      await runStdio({ library, agent: values.agent ?? process.env.CABINET_AGENT ?? 'claude', ai: !values['no-ai'] });
      return;
    }

    case 'rebuild': {
      const lib = await Library.open(library, { git: false });
      const r = lib.rebuild();
      console.log(`Rebuilt index: ${r.items} items in ${r.ms} ms`);
      await lib.close();
      return;
    }

    case 'export': {
      const out = resolve(rest[0] ?? `cabinet-${new Date().toISOString().slice(0, 10)}.zip`);
      const zip = exportLibrary(library, { includeGit: !!values.git });
      writeFileSync(out, zip);
      console.log(`Exported ${library} → ${out} (${(zip.byteLength / 1024).toFixed(0)} KB)`);
      return;
    }

    case 'restore': {
      if (!rest[0]) throw new Error('Usage: cabinet restore <file.zip>');
      const data = new Uint8Array(readFileSync(resolve(rest[0])));
      const v = validateExport(data);
      if (!v.ok) throw new Error('Invalid export:\n  ' + v.errors.join('\n  '));
      const r = restoreLibrary(library, data);
      const lib = await Library.open(library, { git: false });
      const rb = lib.rebuild();
      await lib.close();
      console.log(`Restored ${r.files} files into ${library} and indexed ${rb.items} items.`);
      if (r.backup) console.log(`Previous library moved to ${r.backup}`);
      return;
    }

    case 'token': {
      const { Auth } = await import('@cabinet/server');
      const lib = await Library.open(library, { git: false });
      const t = new Auth(lib).createToken(rest[0] ?? 'agent');
      await lib.close();
      console.log(`Token for agent "${t.name}" (shown once):\n\n  ${t.token}\n`);
      return;
    }

    case 'passphrase': {
      const { readPassphrase } = await import('./passphrase.ts');
      const { Auth } = await import('@cabinet/server');
      const passphrase = await readPassphrase(values.stdin ?? false);
      if (passphrase.length < 8) throw new Error('Use at least 8 characters');
      const lib = await Library.open(library, { git: false });
      try {
        new Auth(lib).setPassphrase(passphrase);
        console.log('Passphrase saved. Restart any running Cabinet server to use it.');
      } finally {
        await lib.close();
      }
      return;
    }

    case 'tokens': {
      const { Auth } = await import('@cabinet/server');
      const lib = await Library.open(library, { git: false });
      for (const t of new Auth(lib).listTokens()) console.log(`${t.id}  ${t.name}  created ${t.created}${t.lastUsed ? '  last used ' + t.lastUsed : ''}`);
      await lib.close();
      return;
    }

    case 'path': {
      if (rest[0]) {
        setDefaultLibraryPath(resolve(rest[0]));
        console.log(`Default library set to ${resolve(rest[0])}`);
      } else console.log(library);
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
