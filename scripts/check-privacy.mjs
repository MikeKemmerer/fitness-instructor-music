import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { codecManifest, validateCodecDistribution } from '../infra/licensed-codecs.mjs';
import { readArtifact } from '../infra/deploy.mjs';

const root = resolve(import.meta.dirname, '..');
const errors = [];
const privatePath = /(^|\/)(local-media|\.env[^/]*)(\/|$)|\.local\.json$|\.(mp3|m4a|wav|flac|aac|ogg|opus|webm|mp4)$/i;
const licensed = JSON.parse(readFileSync(resolve(root, 'docs/licensed-media.json'), 'utf8')).assets;
const approvedCodecs = new Set();
try {
  const sourceFiles = new Map();
  for (const artifact of codecManifest.artifacts) sourceFiles.set(artifact.path, readFileSync(resolve(root, artifact.path)));
  for (const [name, bytes] of readArtifact(resolve(root, 'frontend/public'))) sourceFiles.set(`frontend/public/${name}`, bytes);
  for (const name of validateCodecDistribution(sourceFiles, { required: true, location: 'source' }).keys()) approvedCodecs.add(name);
  const built = resolve(root, 'frontend/dist');
  if (existsSync(built)) {
    for (const name of validateCodecDistribution(readArtifact(built)).keys()) approvedCodecs.add(`frontend/dist/${name}`);
  }
} catch (error) { errors.push(`Codec distribution validation failed: ${error.message}`); }
function licensedAudio(name) {
  const asset = licensed.find(item => name === item.path || (
    name.startsWith('frontend/dist/assets/') &&
    new RegExp(`^${item.buildName}-[a-zA-Z0-9_-]{8}\\.wav$`).test(name.split('/').at(-1))));
  if (!asset) return false;
  return createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex') === asset.sha256;
}
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (tracked.status !== 0) errors.push('Cannot inspect tracked files.');
for (const path of (tracked.stdout || '').split('\0').filter(Boolean)) {
  if (privatePath.test(path) && !path.endsWith('.env.example') && !licensedAudio(path)) errors.push(`Private path tracked: ${path}`);
}
const probes = ['local-media/incoming/probe.mp3', 'local-media/processed/probe.wav', 'local-media/manifests/probe.json'];
const ignored = spawnSync('git', ['check-ignore', '--stdin'], { cwd: root, input: probes.join('\n'), encoding: 'utf8' });
if (ignored.status !== 0 || probes.some(path => !ignored.stdout.split('\n').includes(path))) errors.push('Private intake ignore rules are incomplete.');

function inspect(directory, built = false) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { errors.push(`Symlink in public artifacts: ${name}`); continue; }
    const approvedAudio = entry.isFile() && licensedAudio(name);
    if (privatePath.test(name) && !approvedAudio) errors.push(`Private media/config in public assets: ${name}`);
    if (entry.isDirectory()) inspect(path, built);
    else if (built && !approvedAudio && !approvedCodecs.has(name) && name !== 'frontend/dist/licenses/NotoSans-LICENSE.txt' && !/\.(html|js|css|json|webmanifest|png|svg|ico|woff2?|ttf|otf)$/.test(name)) errors.push(`Unapproved build asset: ${name}`);
  }
}
inspect(resolve(root, 'frontend/public'));
inspect(resolve(root, 'frontend/dist'), true);
if (!readFileSync(resolve(root, '.dockerignore'), 'utf8').includes('**/local-media')) errors.push('Docker exclusion missing.');
if (!readFileSync(resolve(root, 'frontend/vite.config.ts'), 'utf8').includes('**/local-media/**')) errors.push('Dev-server exclusion missing.');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Privacy checks passed: intake ignored; tracked files and public/build asset paths contain no private media or configuration. Content/secret review remains required before release.');