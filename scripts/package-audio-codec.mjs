import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.argv[2]);
const inputs = JSON.parse(readFileSync(new URL('./audio-codec-inputs.json', import.meta.url), 'utf8'));
const work = resolve(root, 'work');
const configuration = readFileSync(resolve(work, 'config.h'), 'utf8');
for (const feature of ['CONFIG_GPL', 'CONFIG_NONFREE', 'CONFIG_VERSION3', 'HAVE_THREADS', 'HAVE_PTHREADS', 'HAVE_W32THREADS', 'HAVE_OS2THREADS']) {
  if (!configuration.includes(`#define ${feature} 0`)) throw new Error(`Unexpected ${feature} configuration`);
}
const assets = resolve(project, 'frontend/src/assets/codecs');
const licenses = resolve(project, 'frontend/public/licenses');
const sources = resolve(project, 'frontend/public/sources');
const stage = resolve(root, 'corresponding-source-code-only');
for (const directory of [assets, licenses, sources, stage, resolve(stage, 'scripts'), resolve(stage, 'downloads')]) {
  mkdirSync(directory, { recursive: true });
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = path => ({ bytes: statSync(path).size, sha256: hash(path) });
const bundledInputs = {};
const selections = {
  wrapper: ['src', 'LICENSE', 'package.json'],
  emscripten: ['src', 'system', 'LICENSE', 'AUTHORS', 'emscripten-version.txt'],
};
for (const name of ['ffmpeg', 'wrapper', 'emscripten', 'emsdk']) {
  const input = inputs[name];
  const archive = resolve(root, 'downloads', input.archive);
  if (hash(archive) !== input.sha256) throw new Error(`Source integrity mismatch: ${name}`);
  if (selections[name]) {
    const directory = resolve(root, 'source-selection', name);
    mkdirSync(directory, { recursive: true });
    const prefix = name === 'wrapper' ? `ffmpeg.wasm-${input.commit}` : `emscripten-${input.commit}`;
    execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', directory,
      ...selections[name].map(path => `${prefix}/${path}`)]);
    if (name === 'wrapper') execFileSync('diff', ['-qr', resolve(directory, 'src'), resolve(work, 'src')]);
    const selectedName = `${name}-build-source.tar.gz`;
    const selectedArchive = resolve(stage, 'downloads', selectedName);
    execFileSync('tar', ['--sort=name', '--mtime=@1686528000', '--owner=0', '--group=0', '--numeric-owner',
      '-czf', selectedArchive, '-C', directory, '.']);
    bundledInputs[name] = { archive: selectedName, ...identity(selectedArchive), stripComponents: 0, include: selections[name] };
  } else {
    copyFileSync(archive, resolve(stage, 'downloads', input.archive));
    bundledInputs[name] = { archive: input.archive, ...identity(archive), stripComponents: 1 };
  }
}
writeFileSync(resolve(stage, 'source-bundle.json'), `${JSON.stringify(bundledInputs, null, 2)}\n`);
for (const name of ['build-audio-codec.sh', 'prepare-audio-codec.mjs', 'package-audio-codec.mjs', 'audio-codec-inputs.json']) {
  copyFileSync(resolve(project, 'scripts', name), resolve(stage, 'scripts', name));
}
copyFileSync(resolve(work, 'config.h'), resolve(stage, 'config.h'));
copyFileSync(resolve(work, 'config_components.h'), resolve(stage, 'config_components.h'));
copyFileSync(resolve(work, 'ffbuild/config.mak'), resolve(stage, 'config.mak'));
const notes = [
  'FFmpeg audio-only core v1. No application license is selected by this package.',
  'FFmpeg 5.1.4 and ffmpeg.wasm fftools changes: LGPL-2.1-or-later.',
  'ffmpeg.wasm JavaScript bindings: MIT. Emscripten runtime: MIT/NCSA, musl permissive notices and compiler-rt Apache-2.0 WITH LLVM-exception below.',
  'No GPL, nonfree, version3, video decoder/encoder, SDL or external codec library is enabled.',
  'Complete pinned sources, build scripts, overlays and generated configuration are in the same-origin source archive.',
  'No warranty. Codec patent rights are not evaluated or granted by this notice.',
];
function notice(label, path) {
  notes.push(`\n===== ${label} =====\n${readFileSync(path, 'utf8')}`);
}
notice('FFmpeg license and external code inventory', resolve(root, 'ffmpeg/LICENSE.md'));
notice('FFmpeg LGPL 2.1', resolve(root, 'ffmpeg/COPYING.LGPLv2.1'));
notice('ffmpeg.wasm MIT', resolve(root, 'wrapper/LICENSE'));
notice('Emscripten runtime and Node-derived path code', resolve(root, 'emscripten/LICENSE'));
notice('Emscripten authors', resolve(root, 'emscripten/AUTHORS'));
notice('musl libc and third-party BSD/public-domain notices', resolve(root, 'emscripten/system/lib/libc/musl/COPYRIGHT'));
for (const name of ['system/lib/compiler-rt/LICENSE.TXT', 'system/lib/dlmalloc.c']) {
  const path = resolve(root, 'emscripten', name);
  if (!existsSync(path)) throw new Error(`Missing runtime notice: ${name}`);
  const text = readFileSync(path, 'utf8');
  notes.push(`\n===== Emscripten ${name} =====\n${name.endsWith('.c') ? text.slice(0, text.indexOf('*/') + 2) : text}`);
}
const dependencies = new Set();
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.name.endsWith('.d')) {
      for (const dependency of readFileSync(path, 'utf8').replace(/\\\n/g, ' ').split(/\s+/)) {
        if (/\.[ch]$/.test(dependency) && !dependency.startsWith('/')) dependencies.add(dependency);
      }
    }
  }
}
scan(work);
for (const entry of readdirSync(resolve(work, 'src/fftools'))) {
  if (/\.[ch]$/.test(entry)) dependencies.add(`src/fftools/${entry}`);
}
for (const dependency of [...dependencies].sort()) {
  const path = resolve(work, dependency);
  if (!existsSync(path) || !path.startsWith(`${work}/`)) continue;
  const text = readFileSync(path, 'utf8');
  const header = text.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/)?.[0];
  if (header) notes.push(`\n===== FFmpeg ${dependency} =====\n${header.trim()}`);
}
const noticeName = 'ffmpeg-audio-core-v1-NOTICES.txt';
writeFileSync(resolve(licenses, noticeName), `${notes.join('\n')}\n`);
copyFileSync(resolve(root, 'ffmpeg/COPYING.LGPLv2.1'), resolve(licenses, 'ffmpeg-audio-core-v1-LGPL-2.1.txt'));
writeFileSync(resolve(stage, 'BUILD.txt'), [
  'FFmpeg audio-only core v1 corresponding source',
  'Linux x86_64; Node 22+, Python 3 (Emscripten driver), make, gcc, g++, cmake, tar, xz, bzip2 and patch.',
  'Extract this archive into a working directory. No application source is needed to rebuild the core.',
  'AUDIO_CODEC_BUILD_ROOT="$PWD" bash scripts/build-audio-codec.sh',
  'The script reuses these verified source archives and downloads the exact hash-pinned ordinary compiler binary.',
  'Emscripten 3.1.40 release c3122846bb040798aab975f61008c37eb19476de; no container used.',
  'The complete Emscripten src/ and system/ runtime source is included, with AUTHORS and LICENSE. No runtime sources were modified.',
  'Unrelated wrapper websites/fonts/images and Emscripten tests/media/site are excluded; source-bundle.json identifies each included archive.',
  'LLVM/Binaryen host compiler binaries are ordinary build tools, not part of the browser core. Their distribution is pinned in audio-codec-inputs.json.',
  'Pristine FFmpeg is combined with the pinned wrapper src/fftools and src/bind overlays without local native modifications.',
  'Output: output/ffmpeg-audio-core.js and .wasm. Replace both served codec resources together to use a modified/relinked core.',
  'Application JavaScript talks to the core in a separate worker; no proprietary application object is linked into this library.',
  'Full source headers and license texts are retained in the input archives. No source-download promise substitutes for these files.',
  '',
].join('\n'));
const sourceName = 'ffmpeg-audio-core-v1-source.zip';
// ZIP, not .tar.gz: Azure Static Web Apps splits a compound suffix into a base type plus
// Content-Encoding, so the archive would not download intact. Python 3 is already a build prerequisite.
execFileSync('python3', ['-c', `
import os, sys, zipfile
stage, target = sys.argv[1], sys.argv[2]
entries = []
for directory, subdirectories, names in os.walk(stage):
    subdirectories.sort()
    for name in sorted(subdirectories) + sorted(names):
        path = os.path.join(directory, name)
        entries.append((os.path.relpath(path, stage).replace(os.sep, '/'), path))
entries.sort()
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, path in entries:
        directory_entry = os.path.isdir(path)
        info = zipfile.ZipInfo(name + '/' if directory_entry else name, date_time=(2023, 6, 11, 17, 0, 0))
        mode = os.stat(path).st_mode & 0o7777
        info.external_attr = ((mode | (0o040000 if directory_entry else 0o100000)) & 0xFFFF) << 16
        if directory_entry:
            info.external_attr |= 0x10
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, b'')
        else:
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(path, 'rb') as handle: archive.writestr(info, handle.read())
`, stage, resolve(sources, sourceName)]);
const artifacts = {};
for (const extension of ['js', 'wasm']) {
  const name = `ffmpeg-audio-core.${extension}`;
  copyFileSync(resolve(root, 'output', name), resolve(assets, name));
  artifacts[relative(project, resolve(assets, name))] = identity(resolve(assets, name));
}
for (const path of [resolve(sources, sourceName), resolve(licenses, noticeName), resolve(licenses, 'ffmpeg-audio-core-v1-LGPL-2.1.txt')]) {
  artifacts[relative(project, path)] = identity(path);
}
const manifest = {
  name: 'ffmpeg-audio-core-v1',
  license: 'LGPL-2.1-or-later AND MIT AND NCSA AND BSD-2-Clause AND BSD-3-Clause AND IJG AND (Apache-2.0 WITH LLVM-exception)',
  inputs, bundledInputs, toolchain: { emscripten: '3.1.40', container: null },
  components: [
    { name: 'FFmpeg', version: '5.1.4', source: inputs.ffmpeg.commit, license: 'LGPL-2.1-or-later AND BSD-2-Clause AND BSD-3-Clause AND MIT AND IJG' },
    { name: 'ffmpeg.wasm bindings/fftools', version: 'v12.15', source: inputs.wrapper.commit, license: 'MIT AND LGPL-2.1-or-later' },
    { name: 'Emscripten runtime', version: '3.1.40', source: inputs.emscripten.commit, license: 'MIT OR NCSA' },
    { name: 'musl libc including iconv', source: inputs.emscripten.commit, path: 'system/lib/libc/musl', license: 'MIT AND BSD-2-Clause AND BSD-3-Clause' },
    { name: 'compiler-rt runtime', source: inputs.emscripten.commit, path: 'system/lib/compiler-rt', license: '(Apache-2.0 WITH LLVM-exception) AND NCSA' },
    { name: 'dlmalloc', source: inputs.emscripten.commit, path: 'system/lib/dlmalloc.c', license: 'LicenseRef-Public-Domain', notice: 'Full upstream statement retained in NOTICES.' },
  ],
  features: { gpl: false, nonfree: false, version3: false, threads: false, simd: true,
    maximumMemory: 536870912, initialMemory: 33554432, externalLibraries: [] },
  source: `/sources/${sourceName}`, notices: `/licenses/${noticeName}`, artifacts,
};
writeFileSync(resolve(licenses, 'ffmpeg-audio-core-v1-SBOM.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));