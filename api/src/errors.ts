export type ErrorStatus = 400 | 401 | 403 | 404 | 412 | 423 | 428;

export class ServiceError extends Error {
  constructor(readonly status: ErrorStatus, readonly code: string) {
    super(code);
    this.name = 'ServiceError';
  }
}