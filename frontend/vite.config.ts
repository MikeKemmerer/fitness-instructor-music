import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readArtifact } from '../infra/deploy.mjs';
import { codecCacheEntries, validateCodecDistribution } from '../infra/licensed-codecs.mjs';

const buildId = new Date().toISOString();
const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const hostedPilot = process.env.VITE_HOSTED_PILOT === 'true';
let outputDirectory = fileURLToPath(new URL('dist', import.meta.url));
const certificate = process.env.REHEARSAL_HTTPS_CERT;
const privateKey = process.env.REHEARSAL_HTTPS_KEY;
if (Boolean(certificate) !== Boolean(privateKey)) throw new Error('Set both REHEARSAL_HTTPS_CERT and REHEARSAL_HTTPS_KEY');
const https = certificate && privateKey ? { cert: readFileSync(certificate), key: readFileSync(privateKey) } : undefined;

export default defineConfig({
  define: { 'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId), 'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion) },
  plugins: [{
    name: 'version-offline-worker',
    apply: 'build',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const worker = resolve(outputDirectory, 'sw.js');
      const codecs = validateCodecDistribution(readArtifact(outputDirectory), { required: true });
      writeFileSync(worker, `${readFileSync(worker, 'utf8')}\nself.REHEARSAL_BUILD_ID = ${JSON.stringify(buildId)};\nself.REHEARSAL_HOSTED = ${JSON.stringify(hostedPilot)};\nself.REHEARSAL_CODECS = ${JSON.stringify(codecCacheEntries(codecs))};\n`);
      // Split-origin topology (frontend on Static Web Apps, API on a standalone Function App):
      // overwrite the safe, same-origin default only when VITE_API_ORIGIN is set for this build.
      const apiOrigin = process.env.VITE_API_ORIGIN?.replace(/\/+$/, '');
      if (!apiOrigin) return;
      if (!/^https:\/\/[a-z0-9.-]+$/i.test(apiOrigin)) throw new Error(`Invalid VITE_API_ORIGIN: ${apiOrigin}`);
      const apiConfig = resolve(outputDirectory, 'api-config.js');
      const current = readFileSync(apiConfig, 'utf8');
      if (!current.includes("export const API_ORIGIN = '';")) {
        throw new Error('api-config.js does not match the expected built default; refusing to overwrite.');
      }
      writeFileSync(apiConfig, current.replace("export const API_ORIGIN = '';", `export const API_ORIGIN = '${apiOrigin}';`));
    },
  }],
  build: { manifest: true },
  server: {
    host: '0.0.0.0',
    https,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../shared', import.meta.url))],
      deny: ['**/.git/**', '**/.env*', '**/local-media/**', '**/*.local.json'],
    },
  },
  preview: { host: '0.0.0.0', https },
});