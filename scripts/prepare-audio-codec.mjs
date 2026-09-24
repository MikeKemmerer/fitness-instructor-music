import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2]);
const inputs = JSON.parse(readFileSync(new URL('./audio-codec-inputs.json', import.meta.url), 'utf8'));
const bundlePath = resolve(root, 'source-bundle.json');
const bundled = existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : {};
const verifyOnly = process.argv.includes('--check-sources');
mkdirSync(resolve(root, 'downloads'), { recursive: true });
for (const [name, input] of Object.entries(inputs)) {
  if (verifyOnly && name === 'toolchain') continue;
  const source = bundled[name] ?? input;
  const archive = resolve(root, 'downloads', source.archive);
  if (!existsSync(archive)) {
    if (verifyOnly || bundled[name]) throw new Error(`Missing bundled source: ${name}`);
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`Download failed: ${name} ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.partial`));
    renameSync(`${archive}.partial`, archive);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== source.sha256) throw new Error(`Integrity mismatch: ${name}`);
  console.log(`Verified ${name}`);
  if (verifyOnly) continue;
  const directory = resolve(root, name === 'toolchain' ? 'compiler' : name);
  if (!existsSync(directory)) {
    const temporary = `${directory}.extracting`;
    mkdirSync(temporary, { recursive: true });
    execFileSync('tar', ['-xf', archive, `--strip-components=${source.stripComponents ?? 1}`, '-C', temporary]);
    renameSync(temporary, directory);
  }
}
if (verifyOnly) process.exit(0);
writeFileSync(resolve(root, 'emscripten-config'), [
  `LLVM_ROOT = ${JSON.stringify(resolve(root, 'compiler/bin'))}`,
  `BINARYEN_ROOT = ${JSON.stringify(resolve(root, 'compiler'))}`,
  `NODE_JS = [${JSON.stringify(process.execPath)}]`,
  `CACHE = ${JSON.stringify(resolve(root, 'compiler/emscripten/cache'))}`,
  '',
].join('\n'));