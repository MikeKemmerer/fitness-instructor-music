import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['testing/cloud-api.test.ts', 'testing/cosmos-documents.test.ts', 'testing/cosmos-routines.test.ts'], environment: 'node', testTimeout: 15000 },
});
