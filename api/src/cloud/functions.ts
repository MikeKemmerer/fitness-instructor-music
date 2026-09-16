import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { loadConfig } from './config';
import { CloudApi, failure } from './http';
import { AzureBlobStore } from './store';

export async function handler(request: HttpRequest): Promise<HttpResponseInit> {
  try {
    const config = loadConfig(process.env);
    const store = AzureBlobStore.connect(config.connectionString, config.container);
    await store.verifyPrivate();
    const api = new CloudApi(store, () => process.env);
    const response = await api.handle({ method: request.method, url: request.url,
      headers: new Headers([...request.headers.entries()]), body: request.body });
    return { status: response.status, headers: response.headers, body: response.body };
  } catch {
    const response = failure(503, 'unconfigured');
    return { status: response.status, headers: response.headers, body: response.body };
  }
}

app.http('cloud', { route: '{*path}', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  authLevel: 'anonymous', handler });