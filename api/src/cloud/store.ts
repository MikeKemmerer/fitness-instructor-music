import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';
import { ApiError } from './config';

export interface StoredBlob { bytes: Buffer; etag: string }
export interface BlobPage { keys: string[]; cursor?: string }
export interface BlobStore {
  get(key: string, maximum: number): Promise<StoredBlob | null>;
  put(key: string, bytes: Buffer, expected: string | null): Promise<string>;
  delete(key: string, expected: string): Promise<void>;
  list(prefix: string, limit: number, cursor?: string): Promise<BlobPage>;
}

export class BlobConflict extends Error {}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number(error.statusCode) : undefined;
}

export class AzureBlobStore implements BlobStore {
  constructor(readonly container: ContainerClient, readonly deadline: AbortSignal = AbortSignal.timeout(35000)) {}

  signal(): AbortSignal { return AbortSignal.any([this.deadline, AbortSignal.timeout(12000)]); }

  async verifyPrivate(): Promise<void> {
    try {
      const access = await this.container.getAccessPolicy({ abortSignal: this.signal() });
      if (access.blobPublicAccess) throw new Error();
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  static connect(connectionString: string, container: string): AzureBlobStore {
    return new AzureBlobStore(BlobServiceClient.fromConnectionString(connectionString, {
      retryOptions: { maxTries: 2, tryTimeoutInMs: 10000 },
    }).getContainerClient(container));
  }

  async get(key: string, maximum: number): Promise<StoredBlob | null> {
    try {
      const signal = this.signal();
      const result = await this.container.getBlobClient(key).download(0, undefined, {
        abortSignal: signal,
      });
      const stream = result.readableStreamBody as Readable | undefined;
      if (result.contentLength === undefined || result.contentLength > maximum || !result.etag || !stream) {
        stream?.destroy();
        throw new ApiError(503, 'storage_unavailable');
      }
      const parts: Buffer[] = [];
      let length = 0;
      const abort = (): void => { stream.destroy(new ApiError(503, 'storage_unavailable')); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) abort();
        for await (const part of stream) {
          const buffer = Buffer.from(part);
          length += buffer.length;
          if (length > maximum) {
            stream.destroy();
            throw new ApiError(503, 'storage_unavailable');
          }
          parts.push(buffer);
        }
      } finally { signal.removeEventListener('abort', abort); }
      if (length !== result.contentLength) throw new ApiError(503, 'storage_unavailable');
      return { bytes: Buffer.concat(parts, length), etag: result.etag };
    } catch (error) {
      if (statusOf(error) === 404 && typeof error === 'object' && error && 'code' in error && error.code === 'BlobNotFound') return null;
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  async put(key: string, bytes: Buffer, expected: string | null): Promise<string> {
    try {
      const result = await this.container.getBlockBlobClient(key).upload(bytes, bytes.length, {
        conditions: expected === null ? { ifNoneMatch: '*' } : { ifMatch: expected },
        blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' },
        abortSignal: this.signal(),
      });
      if (!result.etag) throw new Error();
      return result.etag;
    } catch (error) {
      if (statusOf(error) === 409 || statusOf(error) === 412) throw new BlobConflict();
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  async delete(key: string, expected: string): Promise<void> {
    try {
      await this.container.getBlobClient(key).delete({ conditions: { ifMatch: expected }, abortSignal: this.signal() });
    } catch (error) {
      if (statusOf(error) === 409 || statusOf(error) === 412) throw new BlobConflict();
      if (statusOf(error) !== 404) throw new ApiError(503, 'storage_unavailable');
    }
  }

  async list(prefix: string, limit: number, cursor?: string): Promise<BlobPage> {
    try {
      if (limit < 1 || limit > 513) throw new Error();
      const pages = this.container.listBlobsFlat({ prefix, abortSignal: this.signal() })
        .byPage({ maxPageSize: limit, continuationToken: cursor });
      const page = await pages.next();
      return { keys: page.value?.segment.blobItems.map((item: { name: string }) => item.name) ?? [],
        cursor: page.value?.continuationToken || undefined };
    } catch {
      throw new ApiError(503, 'storage_unavailable');
    }
  }
}

export const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

export async function readJson<Value>(store: BlobStore, key: string, maximum = 65536): Promise<{ value: Value; etag: string } | null> {
  const result = await store.get(key, maximum);
  if (!result) return null;
  try { return { value: JSON.parse(result.bytes.toString('utf8')) as Value, etag: result.etag }; }
  catch { throw new ApiError(503, 'storage_unavailable'); }
}

export async function updateJson<Value>(store: BlobStore, key: string, initial: () => Value,
  update: (value: Value) => Value): Promise<Value> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await readJson<Value>(store, key);
    const next = update(previous ? previous.value : initial());
    try { await store.put(key, encode(next), previous?.etag ?? null); return next; }
    catch (error) { if (!(error instanceof BlobConflict)) throw error; }
  }
  throw new ApiError(503, 'storage_busy');
}