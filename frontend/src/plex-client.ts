/** Browser-direct Plex client: plex.tv sign-in, Plex Home users, server discovery, music search and audio download. */
import { plexFadeProfile, type FadeProfile } from './fade-profile';
export const PLEX_PRODUCT = 'Fitness Music Player';
const PLEX_TV = 'https://plex.tv/api/v2';
const CLIENT_KEY = 'fitness-plex-client-id';
export const PLEX_DIRECT_IMPORT_BYTES = 32 * 1024 * 1024;

export interface PlexHomeUser { uuid: string; title: string; thumb?: string; admin: boolean; protected: boolean }
export interface PlexConnection { uri: string; local: boolean; relay: boolean }
export interface PlexServer { id: string; name: string; owned: boolean; accessToken: string; connections: PlexConnection[] }
export interface PlexTrack {
  key: string; title: string; artist: string; album: string; duration: number; thumb?: string;
  container: string; codec: string; partKey: string; size: number; file: string;
}
export interface PlexArtist { key: string; title: string; thumb?: string }
export interface PlexPlaylist { key: string; title: string; count: number; duration: number }
export interface PlexLink { uri: string; token: string; sections: string[] }

type Fetch = typeof fetch;

export function plexClientId(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): string {
  let id = storage?.getItem(CLIENT_KEY) ?? '';
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) {
    id = crypto.randomUUID();
    try { storage?.setItem(CLIENT_KEY, id); } catch {}
  }
  return id;
}

export function createPlexClient(options: { fetch?: Fetch; clientId?: string } = {}) {
  const request = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clientId = options.clientId ?? plexClientId();
  const identity = { 'X-Plex-Client-Identifier': clientId, 'X-Plex-Product': PLEX_PRODUCT, Accept: 'application/json' };

  const plexTv = async <Value>(path: string, token?: string, init: RequestInit = {}): Promise<Value> => {
    const response = await request(`${PLEX_TV}${path}`, { ...init, headers: { ...identity, ...(token ? { 'X-Plex-Token': token } : {}) } });
    if (response.status === 401 || response.status === 403) throw new Error(path.includes('/switch') ? 'plex_pin_invalid' : 'plex_signin_required');
    if (!response.ok) throw new Error('plex_unavailable');
    return response.json() as Promise<Value>;
  };

  // Server requests carry the token in the query so they stay CORS "simple" (no preflight).
  const server = async <Value>(link: PlexLink, path: string, signal?: AbortSignal): Promise<Value> => {
    const response = await request(withToken(`${link.uri}${path}`, link.token), { headers: { Accept: 'application/json' }, signal });
    if (response.status === 401) throw new Error('plex_signin_required');
    if (!response.ok) throw new Error('plex_unavailable');
    return response.json() as Promise<Value>;
  };

  /** Original file when the app can store it directly, otherwise a Plex-made MP3. */
  const audioUrl = (link: PlexLink, track: PlexTrack): { url: string; direct: boolean } => {
    if (directImport(track)) return { url: withToken(`${link.uri}${track.partKey}`, link.token), direct: true };
    const params = new URLSearchParams({ path: `/library/metadata/${track.key}`, mediaIndex: '0', partIndex: '0', protocol: 'http',
      directPlay: '0', directStream: '0', maxAudioBitrate: '320', session: crypto.randomUUID(),
      'X-Plex-Client-Identifier': clientId, 'X-Plex-Product': PLEX_PRODUCT, 'X-Plex-Platform': 'Chrome' });
    return { url: withToken(`${link.uri}/music/:/transcode/universal/start.mp3?${params}`, link.token), direct: false };
  };

  const metadata = (body: unknown): Record<string, unknown>[] => {
    const value = (body as { MediaContainer?: { Metadata?: unknown } })?.MediaContainer?.Metadata;
    return Array.isArray(value) ? value as Record<string, unknown>[] : [];
  };

  return {
    clientId,

    async startSignIn(): Promise<{ id: number; code: string; url: string }> {
      const pin = await plexTv<{ id: number; code: string }>('/pins?strong=true', undefined, { method: 'POST' });
      const params = new URLSearchParams({ clientID: clientId, code: pin.code, 'context[device][product]': PLEX_PRODUCT });
      return { id: pin.id, code: pin.code, url: `https://app.plex.tv/auth#?${params}` };
    },

    async waitForSignIn(pin: { id: number; code: string }, signal: AbortSignal, interval = 2000): Promise<string> {
      for (;;) {
        if (signal.aborted) throw new Error('plex_cancelled');
        const result = await plexTv<{ authToken?: string | null; expiresIn?: number }>(`/pins/${pin.id}?code=${encodeURIComponent(pin.code)}`);
        if (typeof result.authToken === 'string' && result.authToken) return result.authToken;
        if (result.expiresIn !== undefined && result.expiresIn <= 0) throw new Error('plex_signin_expired');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, interval);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('plex_cancelled')); }, { once: true });
        });
      }
    },

    async homeUsers(accountToken: string): Promise<PlexHomeUser[]> {
      const body = await plexTv<{ users?: Record<string, unknown>[] }>('/home/users', accountToken);
      return (body.users ?? []).filter(user => typeof user.uuid === 'string').map(user => ({
        uuid: String(user.uuid), title: String(user.title || user.username || 'Plex user'),
        ...(typeof user.thumb === 'string' && user.thumb.startsWith('https://') ? { thumb: user.thumb } : {}),
        admin: user.admin === true, protected: user.protected === true,
      }));
    },

    async switchUser(accountToken: string, uuid: string, pin?: string): Promise<string> {
      const query = pin ? `?pin=${encodeURIComponent(pin)}` : '';
      const body = await plexTv<{ authToken?: string }>(`/home/users/${encodeURIComponent(uuid)}/switch${query}`, accountToken, { method: 'POST' });
      if (typeof body.authToken !== 'string' || !body.authToken) throw new Error('plex_pin_invalid');
      return body.authToken;
    },

    async servers(userToken: string): Promise<PlexServer[]> {
      const resources = await plexTv<Record<string, unknown>[]>('/resources?includeHttps=1&includeRelay=1', userToken);
      return resources.filter(resource => String(resource.provides ?? '').split(',').includes('server') && resource.presence !== false
        && typeof resource.accessToken === 'string').map(resource => ({
        id: String(resource.clientIdentifier), name: String(resource.name), owned: resource.owned === true,
        accessToken: String(resource.accessToken),
        connections: (Array.isArray(resource.connections) ? resource.connections as Record<string, unknown>[] : [])
          .filter(connection => typeof connection.uri === 'string' && String(connection.uri).startsWith('https://'))
          .map(connection => ({ uri: String(connection.uri), local: connection.local === true, relay: connection.relay === true })),
      })).filter(item => item.connections.length);
    },

    /** Uses the first direct (home or remote) connection that answers, falling back to the slower Plex relay. */
    async connect(target: PlexServer, timeout = 6000): Promise<PlexLink> {
      const attempt = async (connection: PlexConnection): Promise<PlexLink> => {
        const response = await request(withToken(`${connection.uri}/library/sections`, target.accessToken),
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) throw new Error('plex_unavailable');
        const body = await response.json() as { MediaContainer?: { Directory?: { key: unknown; type: unknown }[] } };
        return { uri: connection.uri, token: target.accessToken,
          sections: (body.MediaContainer?.Directory ?? []).filter(entry => entry.type === 'artist').map(entry => String(entry.key)) };
      };
      for (const group of [target.connections.filter(item => !item.relay), target.connections.filter(item => item.relay)]) {
        if (!group.length) continue;
        try { return await Promise.any(group.map(attempt)); } catch {}
      }
      throw new Error('plex_server_unreachable');
    },

    async search(link: PlexLink, query: string, signal?: AbortSignal): Promise<{ artists: PlexArtist[]; tracks: PlexTrack[] }> {
      const body = await server<{ MediaContainer?: { Hub?: { type?: string; Metadata?: Record<string, unknown>[] }[] } }>(
        link, `/hubs/search?query=${encodeURIComponent(query)}&limit=30&includeCollections=0`, signal);
      const hubs = body.MediaContainer?.Hub ?? [];
      const music = (item: Record<string, unknown>) => link.sections.includes(String(item.librarySectionID));
      const of = (type: string) => (hubs.find(hub => hub.type === type)?.Metadata ?? []).filter(music);
      return {
        artists: of('artist').map(item => ({ key: String(item.ratingKey), title: String(item.title ?? ''),
          ...(typeof item.thumb === 'string' ? { thumb: item.thumb } : {}) })).slice(0, 6),
        tracks: of('track').map(toTrack).filter((track): track is PlexTrack => track !== null),
      };
    },

    async artistTracks(link: PlexLink, artistKey: string, signal?: AbortSignal): Promise<PlexTrack[]> {
      return metadata(await server(link, `/library/metadata/${encodeURIComponent(artistKey)}/allLeaves`, signal))
        .map(toTrack).filter((track): track is PlexTrack => track !== null);
    },

    async playlists(link: PlexLink, signal?: AbortSignal): Promise<PlexPlaylist[]> {
      return metadata(await server(link, '/playlists?playlistType=audio', signal)).filter(item => item.smart !== true || Number(item.leafCount) > 0)
        .map(item => ({ key: String(item.ratingKey), title: String(item.title ?? ''), count: Number(item.leafCount) || 0,
          duration: (Number(item.duration) || 0) / 1000 }));
    },

    async playlistTracks(link: PlexLink, playlistKey: string, signal?: AbortSignal): Promise<PlexTrack[]> {
      return metadata(await server(link, `/playlists/${encodeURIComponent(playlistKey)}/items`, signal))
        .map(toTrack).filter((track): track is PlexTrack => track !== null);
    },

    /** Plex's own loudness analysis of the song's start and end, when the server has it. */
    async fadeProfile(link: PlexLink, track: PlexTrack, signal?: AbortSignal): Promise<FadeProfile | undefined> {
      const item = metadata(await server(link, `/library/metadata/${encodeURIComponent(track.key)}?includeLoudnessRamps=1`, signal))[0];
      const media = Array.isArray(item?.Media) ? item.Media[0] as Record<string, unknown> : undefined;
      const part = media && Array.isArray(media.Part) ? media.Part[0] as Record<string, unknown> : undefined;
      const streams = part && Array.isArray(part.Stream) ? part.Stream as Record<string, unknown>[] : [];
      const audio = streams.find(stream => stream.streamType === 2);
      return audio ? plexFadeProfile(audio.startRamp, audio.endRamp) : undefined;
    },

    thumbUrl(link: PlexLink, thumb: string, size = 96): string {
      return withToken(`${link.uri}/photo/:/transcode?width=${size}&height=${size}&minSize=1&upscale=1&url=${encodeURIComponent(thumb)}`, link.token);
    },

    audioUrl,

    async download(link: PlexLink, track: PlexTrack, signal?: AbortSignal): Promise<File> {
      const { url, direct } = audioUrl(link, track);
      const response = await request(url, { signal });
      if (!response.ok) throw new Error('plex_unavailable');
      const blob = await response.blob();
      if (!blob.size) throw new Error('plex_unavailable');
      const base = (track.file.split(/[\\/]/).at(-1) || `${track.title}.mp3`).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
      const name = direct ? base : `${base.replace(/\.[^.]+$/, '')}.mp3`;
      const type = direct ? (blob.type || mediaType(track)) : 'audio/mpeg';
      return new File([blob], name, { type });
    },
  };
}

export type PlexClient = ReturnType<typeof createPlexClient>;

function withToken(url: string, token: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}`;
}

function directImport(track: PlexTrack): boolean {
  const codec = track.codec.toLowerCase();
  const container = track.container.toLowerCase();
  const storable = (container === 'mp3' && codec === 'mp3') || (['mp4', 'm4a'].includes(container) && codec === 'aac')
    || ['flac', 'vorbis', 'opus'].includes(codec) || (container === 'wav' && codec.startsWith('pcm'));
  return storable && track.size > 0 && track.size <= PLEX_DIRECT_IMPORT_BYTES;
}

function mediaType(track: PlexTrack): string {
  const codec = track.codec.toLowerCase();
  if (codec === 'mp3') return 'audio/mpeg';
  if (codec === 'aac') return 'audio/mp4';
  if (codec === 'flac') return 'audio/flac';
  if (codec === 'vorbis' || codec === 'opus') return 'audio/ogg';
  return 'audio/wav';
}

export function toTrack(item: Record<string, unknown>): PlexTrack | null {
  const media = Array.isArray(item.Media) ? item.Media[0] as Record<string, unknown> : undefined;
  const part = media && Array.isArray(media.Part) ? media.Part[0] as Record<string, unknown> : undefined;
  if (item.type !== 'track' || !part || typeof part.key !== 'string' || !part.key.startsWith('/')) return null;
  const thumb = [item.parentThumb, item.thumb, item.grandparentThumb].find(value => typeof value === 'string');
  return {
    key: String(item.ratingKey), title: String(item.title ?? ''),
    artist: String(item.originalTitle || item.grandparentTitle || ''), album: String(item.parentTitle ?? ''),
    duration: (Number(item.duration) || 0) / 1000, ...(typeof thumb === 'string' ? { thumb } : {}),
    container: String(media?.container ?? ''), codec: String(media?.audioCodec ?? ''),
    partKey: part.key, size: Number(part.size) || 0, file: String(part.file ?? ''),
  };
}
