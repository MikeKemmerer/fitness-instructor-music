import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const trusted = JSON.parse(readFileSync(new URL('./licensed-codecs.json', import.meta.url), 'utf8'));
for (const artifact of trusted.artifacts) Object.freeze(artifact);
Object.freeze(trusted.artifacts);
export const codecManifest = Object.freeze(trusted);

export function validateCodecManifest(manifest) {
  assert.deepEqual(manifest, codecManifest, 'Unreviewed codec manifest metadata.');
  return codecManifest;
}

export function codecArtifact(name, location = 'build') {
  assert(['build', 'source'].includes(location), 'Invalid codec artifact location.');
  return codecManifest.artifacts.find(artifact => location === 'source' ? name === artifact.path :
    artifact.publicPath ? name === artifact.publicPath.slice(1) :
      new RegExp(`^assets/${artifact.buildName}-[a-zA-Z0-9_-]{8}\\.${artifact.extension}$`).test(name));
}

export function verifyCodecBytes(artifact, content) {
  assert(codecManifest.artifacts.includes(artifact), 'Untrusted codec artifact metadata.');
  assert.equal(content.byteLength, artifact.bytes, 'Codec artifact byte length mismatch.');
  assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256, 'Codec artifact SHA256 mismatch.');
}

function validatePath(name) {
  assert(typeof name === 'string' && !/[\\\u0000-\u0020%?#:]/.test(name) &&
    !name.split('/').some(part => !part || part === '.' || part === '..'), 'Unapproved artifact path.');
}

function reservedArtifact(name) {
  return /(^|\/)(?:sources|codecs)(?:\/|$)|ffmpeg[-_/](?:audio[-_])?core|\.(?:wasm|gz|zip|tar|tgz|bz2|tbz2?|xz|txz|7z|rar|br|zst)$/i.test(name);
}

function archiveOrWasm(content) {
  const prefix = content.subarray(0, 6).toString('hex');
  return ['0061736d', '1f8b', '504b0304', '504b0506', '504b0708', '425a68',
    'fd377a585a00', '377abcaf271c', '52617221', '28b52ffd'].some(magic => prefix.startsWith(magic)) ||
    content.subarray(257, 262).toString('ascii') === 'ustar';
}

export function validateCodecDistribution(files, { required = false, location = 'build', manifest = codecManifest } = {}) {
  validateCodecManifest(manifest);
  assert(['build', 'source'].includes(location), 'Invalid codec artifact location.');
  const approved = new Map();
  const roles = new Set();
  const references = new Set();
  let referenced = required;
  for (const [name, content] of files) {
    validatePath(name);
    const artifact = codecArtifact(name, location);
    if (artifact) {
      verifyCodecBytes(artifact, content);
      assert(!roles.has(artifact.role), 'Duplicate codec artifact role.');
      roles.add(artifact.role);
      approved.set(name, artifact);
      referenced = true;
    } else {
      assert(!reservedArtifact(name) && !archiveOrWasm(content),
        'Unapproved codec or source artifact path.');
      if (/\.(?:js|json|html|css|webmanifest)$/i.test(name)) {
        const text = content.toString('utf8');
        assert(!/@ffmpeg\/core\b|ffmpeg[-_/]core\b/i.test(text), 'Unapproved legacy codec reference.');
        if (/ffmpeg[-_/]audio[-_]core/i.test(text)) referenced = true;
        const runtimeText = location === 'build' && name === '.vite/manifest.json'
          ? JSON.stringify(Object.values(JSON.parse(text)).map(entry => ({ ...entry,
            name: undefined, names: undefined, src: undefined })))
          : text;
        for (const match of runtimeText.matchAll(/ffmpeg[-_/]audio[-_]core[-a-zA-Z0-9_.]*\.(?:json|js|wasm|gz|txt)(?:[?#][^\s"'`<>]*)?/gi)) {
          references.add(match[0]);
        }
      }
    }
  }
  if (referenced) {
    assert.equal(roles.size, codecManifest.artifacts.length, 'Incomplete licensed codec distribution.');
    const approvedNames = new Set([...approved.keys()].map(name => name.split('/').at(-1)));
    for (const reference of references) assert(approvedNames.has(reference), 'Unapproved codec content reference.');
    if (location === 'build') {
      assert(files.has('.vite/manifest.json'), 'Missing codec build manifest.');
      const build = JSON.parse(files.get('.vite/manifest.json').toString('utf8'));
      assert(build && typeof build === 'object' && !Array.isArray(build), 'Invalid codec build manifest.');
      const paths = new Set();
      for (const entry of Object.values(build)) {
        assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid codec build entry.');
        assert(typeof entry.file === 'string', 'Invalid codec build file.');
        paths.add(entry.file);
        for (const field of ['assets', 'css']) {
          assert(entry[field] === undefined || Array.isArray(entry[field]), 'Invalid codec build assets.');
          for (const path of entry[field] ?? []) {
            assert(typeof path === 'string', 'Invalid codec build asset path.');
            paths.add(path);
          }
        }
      }
      for (const [name, artifact] of approved) {
        if (artifact.buildName) assert(paths.has(name), 'Codec artifact absent from build manifest.');
      }
      for (const path of paths) {
        validatePath(path);
        assert(files.has(path), 'Missing build reference.');
        if (reservedArtifact(path)) {
          assert(approved.has(path), 'Unapproved codec build reference.');
          assert(approved.get(path).cache, 'Source archive must not enter the offline build asset list.');
        }
      }
    }
  }
  return approved;
}

export function codecCacheEntries(approved) {
  for (const [path, artifact] of approved) assert.equal(codecArtifact(path), artifact, 'Untrusted codec cache metadata.');
  return [...approved].filter(([, artifact]) => artifact.cache).map(([path, artifact]) => ({
    path, bytes: artifact.bytes, sha256: artifact.sha256, mimeType: artifact.mimeType,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function validateCodecRoutes(config, approved) {
  if (!approved.size) return;
  assert(Array.isArray(config.routes), 'Missing codec public routes.');
  assert(!config.routes.some(route => route.route.includes('*') &&
    (/^\/sources/i.test(route.route) || /\.(?:gz|zip|tar|tgz|bz2|xz|7z|rar|br|zst)$/i.test(route.route))),
    'Wildcard source routes are not approved.');
  const source = codecManifest.artifacts.find(artifact => artifact.role === 'source');
  assert(config.routes.filter(route => route.route === source.publicPath).length === 1,
    'Require one exact corresponding-source route.');
  assert(!config.routes.some(route => /^\/sources(?:\/|$)/i.test(route.route) && route.route !== source.publicPath),
    'Unapproved source route.');
  const sourceRoute = config.routes.find(route => route.route === source.publicPath);
  assert(sourceRoute, 'Missing exact corresponding-source route.');
  assert.equal(config.mimeTypes?.['.tar.gz'], source.mimeType, 'Missing compound source MIME mapping.');
  for (const [name, artifact] of approved) {
    assert.equal(codecArtifact(name), artifact, 'Untrusted codec route metadata.');
    const route = config.routes.find(candidate => candidate.route === `/${name}` ||
      (candidate.route.endsWith('*') && `/${name}`.startsWith(candidate.route.slice(0, -1))));
    assert(route, 'Missing public codec route.');
    if (artifact.role === 'source') assert.equal(route, sourceRoute, 'Source route is shadowed.');
    assert.deepEqual(route.allowedRoles, ['anonymous'], 'Codec resources must be anonymous.');
    for (const field of ['statusCode', 'redirect', 'rewrite', 'methods']) {
      assert.equal(route[field], undefined, 'Codec resource must be served directly.');
    }
    const extension = name.slice(name.lastIndexOf('.'));
    const mime = config.mimeTypes?.[extension] ?? ({ '.js': 'application/javascript', '.json': 'application/json', '.txt': 'text/plain' })[extension];
    assert.equal(mime, artifact.mimeType, 'Incorrect codec MIME mapping.');
    let nosniff = false;
    for (const headers of [config.globalHeaders, route.headers]) {
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() === 'content-type') assert.equal(value, artifact.mimeType, 'Incorrect codec MIME override.');
        if (key.toLowerCase() === 'content-encoding') assert.equal(value, 'identity', 'Codec content must not be transformed.');
        if (key.toLowerCase() === 'x-content-type-options') {
          assert.equal(value, 'nosniff', 'Codec MIME sniffing must stay disabled.');
          nosniff = true;
        }
        if (key.toLowerCase() === 'cache-control') assert(!/\bprivate\b/i.test(value) &&
          (!artifact.cache || !/\bno-store\b/i.test(value)), 'Private or uncacheable codec response.');
      }
    }
    assert(nosniff, 'Missing codec nosniff header.');
  }
}

export async function verifyCodecResponse(response, artifact, expectedUrl) {
  assert(codecManifest.artifacts.includes(artifact), 'Untrusted codec artifact metadata.');
  assert.equal(response.status, 200, 'Codec response must be HTTP 200.');
  assert(!response.redirected && !response.headers.get('location'), 'Codec response redirected.');
  assert.equal(response.url, expectedUrl, 'Codec response URL mismatch.');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', 'Missing codec nosniff header.');
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  assert(contentType === artifact.mimeType || (artifact.role === 'glue' && contentType === 'text/javascript'),
    'Invalid codec response MIME.');
  const cacheControl = response.headers.get('cache-control') ?? '';
  assert(!/\bprivate\b/i.test(cacheControl) && (!artifact.cache || !/\bno-store\b/i.test(cacheControl)),
    'Private or uncacheable codec response.');
  const encoding = response.headers.get('content-encoding');
  if (artifact.role === 'source') assert(encoding === null || encoding === 'identity', 'Source archive must not be transformed.');
  const size = response.headers.get('content-length');
  assert(size === null || (/^(?:0|[1-9][0-9]*)$/.test(size) &&
    (encoding && encoding !== 'identity' || Number(size) === artifact.bytes)),
    'Invalid codec response length.');
  assert(response.body, 'Missing codec response body.');
  const reader = response.body.getReader();
  const bytes = Buffer.alloc(artifact.bytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      assert(length + value.byteLength <= bytes.length, 'Codec response exceeds byte limit.');
      bytes.set(value, length);
      length += value.byteLength;
    }
    verifyCodecBytes(artifact, bytes.subarray(0, length));
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}