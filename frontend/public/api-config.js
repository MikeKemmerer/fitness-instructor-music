// Empty by default: same-origin '/api/...' requests (local dev, tests, SWA-managed API).
// Overwritten at build/stage time for deployments where the API is a separate origin
// (standalone Function App) from the frontend's Static Web App origin.
export const API_ORIGIN = '';
