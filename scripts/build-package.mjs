import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');
const rawOutfile = resolve(distDir, 'cli.raw.cjs');
const finalOutfile = resolve(distDir, 'cli.cjs');
const shebang = '#!/usr/bin/env node';

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'src/cli.tsx')],
  outfile: rawOutfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  banner: { js: shebang },
  legalComments: 'none',
  minify: true,
  sourcemap: false,
});

const raw = await readFile(rawOutfile, 'utf8');
const source = raw.startsWith(shebang) ? raw.slice(shebang.length).trimStart() : raw;
const obfuscated = JavaScriptObfuscator.obfuscate(source, {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.8,
  target: 'node',
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
}).getObfuscatedCode();

// npm bin으로 직접 실행되어야 하므로 난독화 후 shebang을 다시 붙입니다.
await writeFile(finalOutfile, `${shebang}\n${obfuscated}\n`, 'utf8');
await chmod(finalOutfile, 0o755);
await rm(rawOutfile, { force: true });

console.log(`built ${finalOutfile}`);
