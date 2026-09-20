// Manual smoke check against the real Cosmos DB account (Phase 1). Not part of any pipeline.
// Usage: set FIM_COSMOS_CONNECTION_STRING and FIM_COSMOS_DATABASE, then `node infra/verify-cosmos-live.mjs`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(resolve(root, 'api/package.json'));
const { CosmosClient } = require('@azure/cosmos');

const PARTITION_FIELDS = { documents: 'id', snapshots: 'documentId', fillers: 'id', assetStatus: 'id', system: 'id' };

export function parseCosmosEnv(env) {
  const connectionString = env.FIM_COSMOS_CONNECTION_STRING ?? '';
  const database = env.FIM_COSMOS_DATABASE ?? '';
  assert(connectionString && database, 'Set FIM_COSMOS_CONNECTION_STRING and FIM_COSMOS_DATABASE to run this check.');
  const settings = new Map();
  for (const part of connectionString.replace(/;$/, '').split(';')) {
    const separator = part.indexOf('=');
    assert(separator > 0, 'Malformed connection string.');
    settings.set(part.slice(0, separator), part.slice(separator + 1));
  }
  const endpoint = settings.get('AccountEndpoint');
  const key = settings.get('AccountKey');
  assert(endpoint && key, 'Connection string missing AccountEndpoint/AccountKey.');
  return { endpoint, key, database };
}

async function verifyContainer(client, database, name) {
  const container = client.database(database).container(name);
  const partitionField = PARTITION_FIELDS[name];
  const id = `smoke-test-${randomUUID()}`;
  const body = { id, [partitionField]: id, probe: 'phase-1-cosmos-store' };

  const created = await container.items.create(body);
  assert.equal(created.statusCode, 201, `${name}: create should return 201`);
  assert(created.etag, `${name}: create should return an etag`);

  const read = await container.item(id, id).read();
  assert.equal(read.resource.probe, body.probe, `${name}: read back mismatch`);
  assert.equal(read.etag, created.etag, `${name}: etag mismatch after read`);

  const updated = { ...body, probe: 'phase-1-cosmos-store-updated' };
  let staleRejected = false;
  try {
    await container.item(id, id).replace(updated, { accessCondition: { type: 'IfMatch', condition: '"stale-etag"' } });
  } catch (error) {
    staleRejected = error.code === 412;
  }
  assert(staleRejected, `${name}: replace with a stale etag must fail with 412 (CAS not enforced)`);

  const replaced = await container.item(id, id).replace(updated, { accessCondition: { type: 'IfMatch', condition: read.etag } });
  assert.equal(replaced.resource.probe, 'phase-1-cosmos-store-updated', `${name}: replace did not take effect`);

  const found = await container.items.query({
    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }],
  }, { partitionKey: id }).fetchAll();
  assert.equal(found.resources[0], 1, `${name}: query should find exactly the probe item`);

  await container.item(id, id).delete({ accessCondition: { type: 'IfMatch', condition: replaced.etag } });
  const afterDelete = await container.items.query({
    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }],
  }, { partitionKey: id }).fetchAll();
  assert.equal(afterDelete.resources[0], 0, `${name}: probe item was not deleted`);

  return name;
}

export async function verifyCosmosLive(env = process.env) {
  const { endpoint, key, database } = parseCosmosEnv(env);
  const client = new CosmosClient({ endpoint, key });
  const results = [];
  for (const name of Object.keys(PARTITION_FIELDS)) results.push(await verifyContainer(client, database, name));
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyCosmosLive().then(results => {
    for (const name of results) console.log(`OK  ${name}: create -> read -> CAS-enforced replace -> query -> delete`);
    console.log(`All ${results.length} containers verified against the live Cosmos account.`);
  }).catch(error => {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  });
}
