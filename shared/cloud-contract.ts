import type { AudioAsset, Role, Routine } from './routine';

export interface CloudUser {
  id: string;
  username: string;
  role: Role;
  authVersion: number;
}

export interface CloudSession {
  user: CloudUser;
  expiresAt: number;
  csrfToken: string;
}

export type CloudAsset = AudioAsset;

export interface CloudRoutine {
  routine: Routine;
  media: Record<string, CloudAsset>;
}

export interface CloudRoutineSummary {
  id: string;
  name: string;
  revision: number;
  locked: boolean;
  published: boolean;
}

export type CloudAccess = 'online' | 'offline' | 'signin-required' | 'forbidden';

export function cloudAccessAfterFailure(status?: number): CloudAccess {
  if (status === 401) return 'signin-required';
  if (status === 403) return 'forbidden';
  return 'offline';
}