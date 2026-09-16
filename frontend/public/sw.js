const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `fitness-rehearsal-shell-v1:${SCOPE.pathname}:`;
const CONTROL_CACHE = `fitness-rehearsal-control-v1:${SCOPE.pathname}`;
const MANIFEST_KEY = new URL('__rehearsal_shell_manifest__', SCOPE).href;
const ACTIVE_KEY = new URL('__rehearsal_active_shell__', SCOPE).href;
const PENDING_KEY = new URL('__rehearsal_pending_shell__', SCOPE).href;
const BUILD_MANIFEST = new URL('.vite/manifest.json', SCOPE).href;
const SHELL = new URL('index.html', SCOPE).href;
const LICENSED_LOOP = /^assets\/lofi-hip-hop-v1(?:-[a-zA-Z0-9_-]{8})?\.wav$/;
const LICENSED_LOOP_SHA256 = '4b4abf4e85b4887714ea58b7f96586f01cd2eeef3a11fb6953960861bb6c3379';
const LICENSED_LOOP_BYTES = 705644;
const PUBLIC_ASSETS = ['favicon.svg', 'icons.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']
  .map(path => new URL(path, SCOPE).href);

let retired = false;
const installAbort = new AbortController();
let installWork = Promise.resolve();
let activationWork = Promise.resolve();
let retirementWork;
let installCacheName;
let codecPins;
const cacheReads = new Set();

function codecAssets() {
  if (codecPins) return codecPins;
  const entries = self.REHEARSAL_CODECS === undefined ? [] : self.REHEARSAL_CODECS;
  if (!Array.isArray(entries) || (entries.length !== 0 && entries.length !== 5)) {
    throw new Error('invalid_codec_pins');
  }
  const shapes = [
    [/^assets\/ffmpeg-audio-core-[a-zA-Z0-9_-]{8}\.js$/, 'application/javascript'],
    [/^assets\/ffmpeg-audio-core-[a-zA-Z0-9_-]{8}\.wasm$/, 'application/wasm'],
    [/^licenses\/ffmpeg-audio-core-v1-LGPL-2\.1\.txt$/, 'text/plain'],
    [/^licenses\/ffmpeg-audio-core-v1-NOTICES\.txt$/, 'text/plain'],
    [/^licenses\/ffmpeg-audio-core-v1-SBOM\.json$/, 'application/json'],
  ];
  const pins = new Map();
  const roles = new Set();
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 4 ||
      !Object.keys(entry).every(key => ['path', 'bytes', 'sha256', 'mimeType'].includes(key)) ||
      typeof entry.path !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
      entry.bytes >= 4 * 1024 * 1024 || typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('invalid_codec_pins');
    }
    const role = shapes.findIndex(([pattern, mimeType]) => pattern.test(entry.path) && mimeType === entry.mimeType);
    total += entry.bytes;
    if (role < 0 || new URL(entry.path, SCOPE).href !== SCOPE.href + entry.path ||
      roles.has(role) || pins.has(entry.path) || total >= 8 * 1024 * 1024) {
      throw new Error('invalid_codec_pins');
    }
    roles.add(role);
    pins.set(entry.path, Object.freeze({ ...entry }));
  }
  codecPins = pins;
  return pins;
}

function codecAsset(url) {
  return url.startsWith(SCOPE.href) ? codecAssets().get(url.slice(SCOPE.href.length)) : undefined;
}

function requireLiveWorker() {
  if (retired) throw new Error('rehearsal_retired');
}

async function putShell(cache, key, response) {
  requireLiveWorker();
  await cache.put(key, response);
  requireLiveWorker();
}

function assetUrl(path) {
  if (typeof path !== 'string' || (!/^assets\/[a-zA-Z0-9_./-]+\.(js|css|woff2?|ttf|otf|svg|png|ico)$/.test(path) &&
    !LICENSED_LOOP.test(path) && !codecAssets().has(path))) {
    throw new Error('invalid_shell_asset');
  }
  if (path.split('/').some(part => ['..', 'local-media', 'api', 'auth', '.auth'].includes(part))) {
    throw new Error('private_shell_asset');
  }
  return new URL(path, SCOPE).href;
}

function licensedLoop(url) {
  return url.startsWith(SCOPE.href) && LICENSED_LOOP.test(url.slice(SCOPE.href.length));
}

function expectedType(url, codec) {
  if (codec?.mimeType === 'application/javascript') return /^(?:application|text)\/javascript$/i;
  if (codec?.mimeType === 'application/wasm') return /^application\/wasm$/i;
  if (codec?.mimeType === 'text/plain') return /^text\/plain$/i;
  if (codec?.mimeType === 'application/json') return /^application\/json$/i;
  if (licensedLoop(url)) return /^audio\/(?:wav|wave|x-wav|vnd\.wave)$/i;
  if (url === BUILD_MANIFEST) return /^application\/json$/i;
  if (url === SHELL) return /^text\/html$/i;
  if (url.endsWith('.webmanifest')) return /^application\/(?:manifest\+json|json)$/i;
  if (url.endsWith('.js')) return /^(?:application|text)\/(?:java|ecma)script$/i;
  if (url.endsWith('.css')) return /^text\/css$/i;
  if (/\.(woff2?|ttf|otf)$/.test(url)) return /^(?:font\/|application\/(?:font|x-font|octet-stream))/i;
  if (url.endsWith('.png')) return /^image\/png$/i;
  if (url.endsWith('.svg')) return /^image\/svg\+xml$/i;
  return /^image\/(?:x-icon|vnd\.microsoft\.icon)$/i;
}

async function publicResponse(url) {
  requireLiveWorker();
  const codec = codecAsset(url);
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: installAbort.signal,
  });
  requireLiveWorker();
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!response.ok || response.status !== 200 || response.redirected ||
    !['basic', 'default'].includes(response.type) ||
    (url === SHELL && response.url !== url) ||
    (response.url && response.url !== url) ||
    /\b(private|no-store)\b/i.test(response.headers.get('cache-control') || '') ||
    !expectedType(url, codec).test(contentType)) {
    throw new Error('invalid_public_shell_response');
  }
  if (codec) return verifiedResponse(response, codec, 'invalid_codec_asset');
  if (licensedLoop(url)) {
    return verifiedResponse(response, { bytes: LICENSED_LOOP_BYTES, sha256: LICENSED_LOOP_SHA256 }, 'invalid_licensed_loop');
  }
  return response;
}

async function verifiedResponse(response, descriptor, errorCode) {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^[0-9]+$/.test(size) || Number(size) !== descriptor.bytes)) throw new Error(errorCode);
  if (!response.body) throw new Error(errorCode);
  const bytes = new Uint8Array(descriptor.bytes);
  const reader = response.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      requireLiveWorker();
      if (done) break;
      if (length + value.length > bytes.length) throw new Error(errorCode);
      bytes.set(value, length);
      length += value.length;
    }
    if (length !== bytes.length) throw new Error(errorCode);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  requireLiveWorker();
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== descriptor.sha256) throw new Error(errorCode);
  return new Response(bytes, { status: 200, headers: response.headers });
}

async function readCachedShell(target) {
  if (retired) return undefined;
  const control = await caches.open(CONTROL_CACHE);
  if (retired) return undefined;
  const active = await control.match(ACTIVE_KEY);
  if (!active) return undefined;
  const cacheName = await active.text();
  if (retired || !cacheName.startsWith(CACHE_PREFIX)) return undefined;
  const cache = await caches.open(cacheName);
  if (retired) return undefined;
  const saved = await cache.match(MANIFEST_KEY);
  const allowed = saved ? await saved.json() : [];
  if (retired || !Array.isArray(allowed) || !allowed.includes(target)) return undefined;
  return cache.match(target);
}

function cachedShellResponse(target) {
  const work = readCachedShell(target);
  cacheReads.add(work);
  const finished = () => cacheReads.delete(work);
  void work.then(finished, finished);
  return work;
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'RETIRE_REHEARSAL') return;
  const source = event.source;
  if (!source || source.type !== 'window' || typeof source.id !== 'string' || !source.id.trim()) return;
  let url;
  try { url = new URL(source.url); } catch { return; }
  if (url.origin !== SCOPE.origin || url.pathname !== '/signout.html') return;
  retired = true;
  installAbort.abort();
  retirementWork ??= (async () => {
    await Promise.all([installWork, activationWork, ...cacheReads].map(work => work.catch(() => undefined)));
    if (installCacheName) await caches.delete(installCacheName);
  })();
  event.waitUntil(retirementWork.then(() => {
    event.ports?.[0]?.postMessage({ retired: true });
  }));
});

self.addEventListener('install', event => {
  installWork = (async () => {
    requireLiveWorker();
    const response = await publicResponse(BUILD_MANIFEST);
    const manifest = await response.json();
    requireLiveWorker();
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid_build_manifest');
    const entries = Object.values(manifest);
    if (!entries.length || entries.length > 1000 || !entries.some(entry => entry.isEntry)) throw new Error('invalid_build_manifest');
    const urls = new Set([SHELL, ...PUBLIC_ASSETS]);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error('invalid_build_manifest');
      urls.add(assetUrl(entry.file));
      for (const field of ['css', 'assets']) {
        if (entry[field] !== undefined && !Array.isArray(entry[field])) throw new Error('invalid_build_manifest');
        for (const path of entry[field] || []) urls.add(assetUrl(path));
      }
    }
    for (const path of codecAssets().keys()) urls.add(assetUrl(path));
    if (urls.size > 2000) throw new Error('invalid_build_manifest');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(manifest)));
    requireLiveWorker();
    const version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const cacheName = `${CACHE_PREFIX}${version}:${crypto.randomUUID()}`;
    const responses = [];
    for (const url of urls) responses.push([url, await publicResponse(url)]);
    requireLiveWorker();
    installCacheName = cacheName;
    const cache = await caches.open(cacheName);
    requireLiveWorker();
    for (const [url, asset] of responses) await putShell(cache, url, asset);
    await putShell(cache, MANIFEST_KEY, new Response(JSON.stringify([...urls]), {
      headers: { 'Content-Type': 'application/json' },
    }));
    requireLiveWorker();
    const control = await caches.open(CONTROL_CACHE);
    await putShell(control, PENDING_KEY, new Response(cacheName));
  })();
  event.waitUntil(installWork);
});

self.addEventListener('activate', event => {
  activationWork = (async () => {
    requireLiveWorker();
    const control = await caches.open(CONTROL_CACHE);
    requireLiveWorker();
    const pending = await control.match(PENDING_KEY);
    if (!pending) throw new Error('missing_pending_shell');
    const cacheName = await pending.text();
    requireLiveWorker();
    if (!cacheName.startsWith(CACHE_PREFIX)) throw new Error('invalid_pending_shell');
    const cache = await caches.open(cacheName);
    requireLiveWorker();
    const saved = await cache.match(MANIFEST_KEY);
    const allowed = saved ? await saved.json() : [];
    const required = [SHELL, ...PUBLIC_ASSETS, ...Array.from(codecAssets().keys(), path => assetUrl(path))];
    if (!Array.isArray(allowed) || !required.every(url => allowed.includes(url))) {
      throw new Error('incomplete_pending_shell');
    }
    for (const url of allowed) {
      requireLiveWorker();
      if (typeof url !== 'string' || !await cache.match(url)) throw new Error('incomplete_pending_shell');
    }
    await putShell(control, ACTIVE_KEY, new Response(cacheName));
  })();
  event.waitUntil(activationWork);
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || url.search || url.hash ||
    request.headers.has('authorization') || request.headers.has('range')) return;
  const navigation = request.mode === 'navigate' && (url.href === SCOPE.href || url.href === SHELL);
  if (!navigation && !PUBLIC_ASSETS.includes(url.href)) {
    if (!url.href.startsWith(SCOPE.href)) return;
    try { assetUrl(url.href.slice(SCOPE.href.length)); } catch { return; }
  }
  event.respondWith((async () => {
    if (retired) return fetch(request);
    const cached = await cachedShellResponse(navigation ? SHELL : url.href);
    return (!retired && cached) || fetch(request);
  })());
});