import { openDB } from 'idb';
import type { PlexHomeUser } from './plex-client';

/** Plex credentials live in their own IndexedDB (never localStorage) and are deleted on app sign-out. */
export const PLEX_DATABASE = 'fitness-plex';

export interface PlexSession {
  owner: string;
  accountToken: string;
  user: Pick<PlexHomeUser, 'uuid' | 'title' | 'admin' | 'protected'>;
  userToken: string;
  serverId?: string;
  serverName?: string;
}

const database = () => openDB(PLEX_DATABASE, 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'owner' }); } });

export async function loadPlexSession(owner: string): Promise<PlexSession | null> {
  const db = await database();
  try { return (await db.get('sessions', owner) as PlexSession | undefined) ?? null; }
  finally { db.close(); }
}

export async function savePlexSession(session: PlexSession): Promise<void> {
  const db = await database();
  try { await db.put('sessions', structuredClone(session)); }
  finally { db.close(); }
}

export async function clearPlexSession(owner: string): Promise<void> {
  const db = await database();
  try { await db.delete('sessions', owner); }
  finally { db.close(); }
}
