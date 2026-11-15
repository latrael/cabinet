import { resolve } from 'node:path';
import { generateSampleLibrary } from '../src/sample.ts';

const target = resolve(process.argv[2] ?? new URL('../../../sample-library', import.meta.url).pathname);
const n = generateSampleLibrary(target, { clean: true });
console.log(`Sample library written to ${target} (${n} files)`);
