import { CosmosClient, type Container } from '@azure/cosmos';
import { ApiError, type CosmosConfig } from './config';

export const COSMOS_CONTAINERS = ['documents', 'snapshots', 'fillers', 'assetStatus', 'system'] as const;
export type CosmosContainerName = typeof COSMOS_CONTAINERS[number];

export interface CosmosItem { id: string }
export interface StoredItem<T extends CosmosItem> { body: T; etag: string }
export interface CosmosParameter { name: string; value: string | number | boolean }

export interface CosmosStoreLike {
  read<T extends CosmosItem>(name: CosmosContainerName, id: string, partitionKey: string): Promise<StoredItem<T> | null>;
  create<T extends CosmosItem>(name: CosmosContainerName, body: T): Promise<string>;
  replace<T extends CosmosItem>(name: CosmosContainerName, id: string, partitionKey: string, body: T, expected: string): Promise<string>;
  put<T extends CosmosItem>(name: CosmosContainerName, body: T, expected: string | null, partitionKey?: string): Promise<string>;
  delete(name: CosmosContainerName, id: string, partitionKey: string, expected: string): Promise<void>;
  query<T>(name: CosmosContainerName, query: string, parameters: CosmosParameter[], partitionKey?: string): Promise<T[]>;
}

export class CosmosConflict extends Error {}

const SYSTEM_PROPERTIES = ['_rid', '_self', '_etag', '_attachments', '_ts'];

function stripSystemProperties<T>(body: T): T {
  if (typeof body !== 'object' || body === null) return body;
  const clone = { ...body } as Record<string, unknown>;
  for (const key of SYSTEM_PROPERTIES) delete clone[key];
  return clone as T;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'number'
    ? (error as { code: number }).code : undefined;
}

export class CosmosStore implements CosmosStoreLike {
  private readonly containers = new Map<CosmosContainerName, Container>();

  constructor(client: CosmosClient, database: string, readonly deadline: AbortSignal = AbortSignal.timeout(35000)) {
    const db = client.database(database);
    for (const name of COSMOS_CONTAINERS) this.containers.set(name, db.container(name));
  }

  static connect(config: CosmosConfig): CosmosStore {
    return new CosmosStore(new CosmosClient({ endpoint: config.endpoint, key: config.key }), config.database);
  }

  signal(): AbortSignal { return AbortSignal.any([this.deadline, AbortSignal.timeout(12000)]); }

  private container(name: CosmosContainerName): Container {
    const container = this.containers.get(name);
    if (!container) throw new ApiError(503, 'storage_unavailable');
    return container;
  }

  async read<T extends CosmosItem>(name: CosmosContainerName, id: string, partitionKey: string): Promise<StoredItem<T> | null> {
    try {
      const response = await this.container(name).item(id, partitionKey).read<T>({ abortSignal: this.signal() });
      if (!response.resource) return null;
      return { body: stripSystemProperties(response.resource), etag: response.etag };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  /** Fails closed with CosmosConflict when an item with this id already exists in its partition. */
  async create<T extends CosmosItem>(name: CosmosContainerName, body: T): Promise<string> {
    try {
      const response = await this.container(name).items.create<T>(body, { abortSignal: this.signal() });
      if (!response.resource) throw new ApiError(503, 'storage_unavailable');
      return response.etag;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (statusOf(error) === 409) throw new CosmosConflict();
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  async replace<T extends CosmosItem>(name: CosmosContainerName, id: string, partitionKey: string, body: T, expected: string): Promise<string> {
    try {
      const response = await this.container(name).item(id, partitionKey).replace<T>(body, {
        accessCondition: { type: 'IfMatch', condition: expected }, abortSignal: this.signal(),
      });
      if (!response.resource) throw new ApiError(503, 'storage_unavailable');
      return response.etag;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (statusOf(error) === 412) throw new CosmosConflict();
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  /** Blob-style convenience: expected===null creates (fails closed if the id already exists), otherwise replaces with CAS. */
  async put<T extends CosmosItem>(name: CosmosContainerName, body: T, expected: string | null, partitionKey: string = body.id): Promise<string> {
    return expected === null ? this.create(name, body) : this.replace(name, body.id, partitionKey, body, expected);
  }

  async delete(name: CosmosContainerName, id: string, partitionKey: string, expected: string): Promise<void> {
    try {
      await this.container(name).item(id, partitionKey).delete({
        accessCondition: { type: 'IfMatch', condition: expected }, abortSignal: this.signal(),
      });
    } catch (error) {
      if (statusOf(error) === 404) return;
      if (statusOf(error) === 412) throw new CosmosConflict();
      throw new ApiError(503, 'storage_unavailable');
    }
  }

  async query<T>(name: CosmosContainerName, query: string, parameters: CosmosParameter[], partitionKey?: string): Promise<T[]> {
    try {
      const iterator = this.container(name).items.query<T>({ query, parameters },
        { abortSignal: this.signal(), ...(partitionKey === undefined ? {} : { partitionKey }) });
      const { resources } = await iterator.fetchAll();
      return resources.map(stripSystemProperties);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'storage_unavailable');
    }
  }
}

