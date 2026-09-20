import { createHash, randomInt } from 'node:crypto';
import type { ReadableStream } from 'node:stream/web';
import { ServiceError } from '../errors';
import { CloudAuth, clearCookie } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import type { CosmosStoreLike } from './cosmos-store';
import { CosmosClasses, CosmosPlaylists } from './cosmos-plans';
import { CosmosRoutines } from './cosmos-routines';
import { CloudLibrary } from './library';
import { LibraryManagement } from './library-management';
import { CloudMedia } from './media';
import { CloudClasses, CloudPlaylists } from './plans';
import { CloudRoutines } from './routines';
import { BlobConflict, updateJson, type BlobStore } from './store';

export interface ApiRequest {
  method: string;
  url: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

const responseHeaders = { 'cache-control': 'private, no-store, max-age=0', pragma: 'no-cache',
  'x-content-type-options': 'nosniff', 'content-type': 'application/json; charset=utf-8',
  'cross-origin-resource-policy': 'same-origin', vary: 'Cookie, Origin' };
export const failure = (status: number, code: string): ApiResponse => ({ status, headers: { ...responseHeaders,
  ...(status === 429 ? { 'retry-after': code === 'login_throttled' ? '900' : '60' } : {}) }, body: JSON.stringify({ error: code }) });

export async function boundedBody(request: ApiRequest, maximum: number): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum)) throw new ApiError(413, 'body_too_large');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new ApiError(415, 'unsupported_encoding');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const parts: Buffer[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(408, 'request_timeout')), 10000);
    timer.unref();
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new ApiError(413, 'body_too_large');
      parts.push(Buffer.from(next.value));
    }
    if (length !== null && bytes !== Number(length)) throw new ApiError(400, 'invalid_body');
    return Buffer.concat(parts, bytes);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

async function jsonBody(request: ApiRequest, maximum = LIMITS.jsonBytes, optional = false): Promise<unknown> {
  const bytes = await boundedBody(request, maximum);
  if (!bytes.length && optional) return undefined;
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'invalid_json'); }
}

async function emptyBody(request: ApiRequest): Promise<void> {
  if ((await boundedBody(request, 2)).length) throw new ApiError(400, 'body_not_allowed');
}

function readQuery(url: URL, parts: string[], method: string): { published: boolean; revision?: number } {
  const keys = [...url.searchParams.keys()];
  const entityRoute = ['routines', 'playlists', 'classes'].includes(parts[0]!);
  const singleRead = entityRoute && ((method === 'GET' && parts.length === 2)
    || (method === 'POST' && parts.length === 3 && parts[2] === 'duplicate')
    || (method === 'GET' && parts[0] === 'classes' && parts.length === 3 && parts[2] === 'prepare'));
  const listRead = entityRoute && method === 'GET' && parts.length === 1;
  const libraryRead = parts.join('/') === 'media/library' && method === 'GET';
  const managedRead = parts[0] === 'library' && ['songs', 'fillers'].includes(parts[1]!) && method === 'GET'
    && (parts.length === 2 || (parts.length === 4 && parts[3] === 'usage'));
  const mediaRead = !libraryRead && parts[0] === 'media' && method === 'GET' && (parts.length === 2 || (parts.length === 4 && parts[2] === 'chunks'));
  const allowed = singleRead ? ['published', 'revision'] : listRead ? ['published']
    : libraryRead || managedRead ? ['cursor'] : mediaRead ? ['routineId', 'playlistId', 'classId', 'revision'] : [];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))
    || (url.searchParams.has('published') && !['true', 'false'].includes(url.searchParams.get('published')!))) {
    throw new ApiError(400, 'invalid_query');
  }
  const rawRevision = url.searchParams.get('revision');
  let revision: number | undefined;
  if (rawRevision !== null) {
    if (!/^[1-9][0-9]{0,15}$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision))) throw new ApiError(400, 'invalid_query');
    revision = Number(rawRevision);
  }
  if (mediaRead) {
    const authorities = ['routineId', 'playlistId', 'classId'].filter(key => url.searchParams.has(key));
    if (authorities.length > 1 || authorities.some(key => !safeId(url.searchParams.get(key)))
      || (revision !== undefined && !authorities.length)
      || (authorities.some(key => key !== 'routineId') && revision === undefined)) throw new ApiError(400, 'invalid_query');
  }
  return { published: url.searchParams.get('published') === 'true', revision };
}

let activeRequests = 0;
let activeCompletions = 0;

export class CloudApi {
  readonly auth: CloudAuth;
  readonly media: CloudMedia;
  readonly routines: CloudRoutines | CosmosRoutines;
  readonly playlists: CloudPlaylists | CosmosPlaylists;
  readonly classes: CloudClasses | CosmosClasses;
  readonly library: CloudLibrary;
  readonly managed: LibraryManagement;
  constructor(readonly store: BlobStore, env: () => NodeJS.ProcessEnv, now: () => number = Date.now, cosmosStore?: CosmosStoreLike) {
    this.auth = new CloudAuth(store, env, now);
    this.media = new CloudMedia(store, this.auth);
    if (cosmosStore) {
      this.routines = new CosmosRoutines(cosmosStore, store, this.auth, this.media);
      this.playlists = new CosmosPlaylists(cosmosStore, store, this.auth, this.media);
      this.classes = new CosmosClasses(cosmosStore, store, this.auth, this.routines, this.playlists);
      // Library BROWSING (title lookups for the asset list) stays Blob-only -- CloudLibrary never
      // actually calls these two fields, see cosmos-routines.ts. Reference-checking for deletion
      // safety (LibraryManagement below) is Cosmos-aware and does not depend on these.
      const libraryRoutines = new CloudRoutines(store, this.auth, this.media);
      const libraryPlaylists = new CloudPlaylists(store, this.auth, this.media);
      this.library = new CloudLibrary(store, this.auth, this.media, libraryRoutines, libraryPlaylists);
    } else {
      this.routines = new CloudRoutines(store, this.auth, this.media);
      this.playlists = new CloudPlaylists(store, this.auth, this.media);
      this.classes = new CloudClasses(store, this.auth, this.routines, this.playlists);
      this.library = new CloudLibrary(store, this.auth, this.media, this.routines, this.playlists);
    }
    this.managed = new LibraryManagement(store, this.auth, this.media, this.routines.fillers, cosmosStore);
  }

  async traffic(bucket: string, limit: number): Promise<void> {
    const window = Math.floor(this.auth.now() / 60000);
    await updateJson<{ window: number; count: number }>(this.store, `traffic/${bucket}`, () => ({ window, count: 0 }), previous => {
      if (!Number.isSafeInteger(previous.window) || !Number.isSafeInteger(previous.count) || previous.count < 0 || previous.window > window) {
        throw new ApiError(503, 'storage_unavailable');
      }
      const count = (previous.window === window ? previous.count : 0) + 1;
      if (count > limit) throw new ApiError(429, 'request_throttled');
      return { window, count };
    });
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    if (activeRequests >= 4) return failure(503, 'server_busy');
    activeRequests++;
    try {
      const maintenance = this.auth.env().FIM_MAINTENANCE_MESSAGE;
      if (maintenance) return { status: 503, headers: { ...responseHeaders, 'retry-after': '1800' },
        body: JSON.stringify({ error: 'maintenance', message: maintenance }) };
      this.auth.config();
      await this.traffic(`global-${randomInt(8)}`, 64);
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') || /%|\\|\/\//.test(url.pathname)) throw new ApiError(404, 'route_not_found');
      const parts = url.pathname.slice(5).split('/');
      const method = request.method.toUpperCase();
      const { published, revision } = readQuery(url, parts, method);
      const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (writing) this.auth.origin(request.headers);
      const json = (value: unknown, status = 200, extra: Record<string, string> = {}): ApiResponse => {
        const entity = value && typeof value === 'object'
          ? 'metadata' in value ? value.metadata : 'setup' in value ? value.setup : 'playlist' in value ? value.playlist : 'routine' in value ? value.routine : undefined
          : undefined;
        const etag: Record<string, string> = entity && typeof entity === 'object' && 'revision' in entity && Number.isSafeInteger(entity.revision)
          ? { etag: `"${entity.revision}"` } : {};
        return { status, headers: { ...responseHeaders, ...etag, ...extra }, body: JSON.stringify(value) };
      };
      if (parts.join('/') === 'auth/login' && method === 'POST') {
        const result = await this.auth.login(request.headers, await jsonBody(request, 4096));
        return json(result.session, 200, { 'set-cookie': result.setCookie });
      }
      const actor = await this.auth.authenticate(request.headers, writing);
      const accountBucket = createHash('sha256').update(actor.account.id).digest()[0]! % 64;
      await this.traffic(`account-${accountBucket}`, 240);
      if (parts.join('/') === 'auth/session' && method === 'GET') return json(actor.session);
      if (parts.join('/') === 'auth/logout' && method === 'POST') {
        await emptyBody(request);
        await this.auth.logout(request.headers);
        return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
      }
      if (parts[0] === 'library' && ['songs', 'fillers'].includes(parts[1]!)) {
        await this.auth.authenticate(request.headers, writing, true);
        const kind = parts[1] === 'songs' ? 'song' : 'filler';
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (parts.length === 2 && method === 'GET') {
          await emptyBody(request);
          return json(await this.managed.list(request.headers, kind, cursor));
        }
        if (parts.length === 4 && parts[3] === 'metadata') {
          if (method === 'GET') {
            await emptyBody(request);
            return json(await this.managed.metadata(request.headers, kind, parts[2]!));
          }
          if (method === 'PUT') return json(await this.managed.put(request.headers, kind, parts[2]!, await jsonBody(request, 4096)));
        }
        if (parts.length === 4 && parts[3] === 'intake' && method === 'PUT') {
          return json(await this.managed.put(request.headers, kind, parts[2]!, await jsonBody(request, 4096), true));
        }
        if (parts.length === 4 && parts[3] === 'usage' && method === 'GET') {
          await emptyBody(request);
          return json(await this.managed.usage(request.headers, kind, parts[2]!, cursor));
        }
        if (parts.length === 3 && method === 'DELETE') {
          await emptyBody(request);
          const result = await this.managed.remove(request.headers, kind, parts[2]!);
          return json(result, 'pending' in result ? 202 : 200);
        }
      }
      if (parts[0] === 'fillers') {
        if (parts.length === 3 && parts[2] === 'analysis') {
          if (method === 'GET') {
            await emptyBody(request);
            return json(await this.routines.fillers.getAnalysis(request.headers, parts[1]!));
          }
          if (method === 'PUT') return json(await this.routines.fillers.putAnalysis(request.headers, parts[1]!, await jsonBody(request, 4096)));
        }
        if (parts.length === 1 && method === 'GET') return json(await this.routines.fillers.list(request.headers));
        if (parts.length === 1 && method === 'POST') return json(await this.routines.fillers.create(request.headers, await jsonBody(request, 4096)), 201);
        if (parts.length === 2 && method === 'GET') return json(await this.routines.fillers.get(request.headers, parts[1]!));
        if (parts.length === 2 && method === 'DELETE') {
          await emptyBody(request);
          const result = await this.routines.fillers.archive(request.headers, parts[1]!);
          return json(result, 'pending' in result ? 202 : 200);
        }
      }
      if (['routines', 'playlists', 'classes'].includes(parts[0]!)) {
        const documents = parts[0] === 'routines' ? this.routines : parts[0] === 'playlists' ? this.playlists : this.classes;
        if (parts.length === 1 && method === 'GET') return json(await documents.list(request.headers, published));
        if (parts.length === 1 && method === 'POST') return json(await documents.create(request.headers, await jsonBody(request)), 201);
        const id = parts[1]!;
        if (parts[0] === 'classes' && parts.length === 3 && parts[2] === 'prepare' && method === 'GET') {
          return json(await this.classes.prepare(request.headers, id, published, revision));
        }
        if (parts.length === 2 && method === 'GET') return json(await documents.get(request.headers, id, published, revision));
        if (parts.length === 2 && method === 'PUT') return json(await documents.mutate(request.headers, id, 'save', await jsonBody(request)));
        if (parts.length === 2 && method === 'DELETE') {
          await emptyBody(request);
          return json(await documents.mutate(request.headers, id, 'delete'));
        }
        if (parts.length === 3 && method === 'POST') {
          if (parts[2] === 'lock') return json(await documents.mutate(request.headers, id, 'lock', await jsonBody(request, LIMITS.jsonBytes, true)));
          await emptyBody(request);
          if (parts[2] === 'duplicate') return json(await documents.duplicate(request.headers, id, published, revision), 201);
          if (parts[2] === 'unlock' || parts[2] === 'publish') return json(await documents.mutate(request.headers, id, parts[2]));
        }
      }
      if (parts[0] === 'media') {
        if (parts.join('/') === 'media/library' && method === 'GET') {
          await emptyBody(request);
          return json(await this.library.list(request.headers, url.searchParams.get('cursor') ?? undefined));
        }
        if (parts.join('/') === 'media/uploads' && method === 'POST') return json(await this.media.initiate(request.headers, await jsonBody(request, 4096)), 201);
        if (parts.join('/') === 'media/uploads/cleanup' && method === 'POST') {
          await emptyBody(request);
          return json(await this.media.cleanup(request.headers));
        }
        if (parts[1] === 'uploads' && parts.length === 5 && parts[3] === 'chunks' && method === 'PUT') {
          if (request.headers.get('content-type') !== 'application/octet-stream') throw new ApiError(415, 'binary_required');
          return json(await this.media.putChunk(request.headers, parts[2]!, this.index(parts[4]!), await boundedBody(request, LIMITS.chunkBytes)));
        }
        if (parts[1] === 'uploads' && parts.length === 4 && method === 'POST') {
          await emptyBody(request);
          if (parts[3] === 'abort') return json(await this.media.abort(request.headers, parts[2]!));
          if (parts[3] === 'complete') {
            if (activeCompletions >= 1) throw new ApiError(503, 'server_busy');
            activeCompletions++;
            try {
              const result = await this.media.complete(request.headers, parts[2]!);
              return 'pending' in result ? json(result, 202, { 'retry-after': '0' }) : json(result);
            }
            finally { activeCompletions--; }
          }
        }
        if (method === 'GET' && (parts.length === 2 || (parts.length === 4 && parts[2] === 'chunks'))) {
          const id = parts[1]!;
          const playlistId = url.searchParams.get('playlistId');
          const classId = url.searchParams.get('classId');
          if (classId) await this.classes.authorizeAsset(request.headers, id, classId, revision!);
          else if (playlistId) await this.playlists.authorizeAsset(request.headers, id, playlistId, revision!);
          else await this.routines.authorizeAsset(request.headers, id, url.searchParams.get('routineId'), revision);
          if (parts.length === 2) {
            const record = await this.media.catalog(id);
            return json({ asset: record.asset, chunkBytes: LIMITS.chunkBytes, chunkCount: record.chunks.length });
          }
          const result = await this.media.chunk(id, this.index(parts[3]!));
          return { status: 200, headers: { ...responseHeaders, 'content-type': 'application/octet-stream',
            'content-length': String(result.bytes.length), 'content-disposition': 'attachment', 'x-content-sha256': result.hash }, body: result.bytes };
        }
      }
      throw new ApiError(404, 'route_not_found');
    } catch (error) {
      if (error instanceof ApiError || error instanceof ServiceError) return failure(error.status, error.code);
      if (error instanceof BlobConflict) return failure(409, 'storage_conflict');
      return failure(503, 'service_unavailable');
    } finally { activeRequests--; }
  }

  index(value: string): number {
    if (!/^(0|[1-9][0-9]?)$/.test(value)) throw new ApiError(400, 'invalid_chunk');
    return Number(value);
  }
}