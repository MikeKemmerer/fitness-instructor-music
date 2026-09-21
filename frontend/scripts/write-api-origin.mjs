import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Overwrites the built dist/api-config.js with the real cross-origin API endpoint when
// VITE_API_ORIGIN is set (the split-origin topology: frontend on Static Web Apps, API on a
// standalone Function App). Leaves the safe, same-origin default ('') untouched otherwise
// (local dev, tests, SWA-managed API deployments).
const origin = process.env.VITE_API_ORIGIN?.replace(/\/+$/, '');
if (!origin) process.exit(0);
if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) throw new Error(`Invalid VITE_API_ORIGIN: ${origin}`);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'dist/api-config.js');
const current = readFileSync(target, 'utf8');
if (!current.includes("export const API_ORIGIN = '';")) {
  throw new Error('dist/api-config.js does not match the expected built default; refusing to overwrite.');
}
writeFileSync(target, current.replace("export const API_ORIGIN = '';", `export const API_ORIGIN = '${origin}';`));
console.log(`write-api-origin: set API_ORIGIN to ${origin}`);
