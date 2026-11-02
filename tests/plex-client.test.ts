import { describe, expect, it, vi } from 'vitest';
import { createPlexClient, toTrack, type PlexLink, type PlexServer } from '../frontend/src/plex-client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const link: PlexLink = { uri: 'https://10-0-0-2.abc.plex.direct:32400', token: 'server-token', sections: ['3'] };
const trackItem = (overrides: Record<string, unknown> = {}) => ({
  type: 'track', ratingKey: '42', title: 'Levitating', grandparentTitle: 'Dua Lipa', parentTitle: 'Future Nostalgia', duration: 203000,
  librarySectionID: 3, parentThumb: '/library/metadata/40/thumb/1',
  Media: [{ container: 'mp3', audioCodec: 'mp3', Part: [{ key: '/library/parts/9/file.mp3', size: 8_000_000, file: '/music/Dua Lipa/Levitating.mp3' }] }],
  ...overrides,
});

describe('plex client', () => {
  it('signs in with a PIN and sends client identity headers without a token', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ id: 7, code: 'abcd' }, 201))
      .mockResolvedValueOnce(json({ authToken: null, expiresIn: 1700 }))
      .mockResolvedValueOnce(json({ authToken: 'account-token' }));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const pin = await client.startSignIn();
    expect(pin.url).toContain('https://app.plex.tv/auth#?');
    expect(pin.url).toContain('clientID=client-0000000000000001');
    expect(pin.url).toContain('code=abcd');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://plex.tv/api/v2/pins?strong=true');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Plex-Client-Identifier']).toBe('client-0000000000000001');
    expect(init.headers['X-Plex-Token']).toBeUndefined();
    await expect(client.waitForSignIn(pin, new AbortController().signal, 1)).resolves.toBe('account-token');
  });

  it('stops waiting for sign-in when cancelled', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ authToken: null, expiresIn: 1700 }));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const controller = new AbortController();
    const waiting = client.waitForSignIn({ id: 1, code: 'x' }, controller.signal, 10_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(waiting).rejects.toThrow('plex_cancelled');
  });

  it('lists home users and switches with a PIN', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ users: [
        { uuid: 'u1', title: 'Mom', admin: true, protected: true, thumb: 'https://plex.tv/users/u1/avatar' },
        { uuid: 'u2', username: 'kid', admin: false, protected: false, thumb: 'javascript:alert(1)' },
      ] }))
      .mockResolvedValueOnce(json({ authToken: 'user-token' }, 201))
      .mockResolvedValueOnce(json({ errors: [] }, 403));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const users = await client.homeUsers('account-token');
    expect(users).toEqual([
      { uuid: 'u1', title: 'Mom', thumb: 'https://plex.tv/users/u1/avatar', admin: true, protected: true },
      { uuid: 'u2', title: 'kid', admin: false, protected: false },
    ]);
    await expect(client.switchUser('account-token', 'u1', '1234')).resolves.toBe('user-token');
    expect(fetch.mock.calls[1]![0]).toBe('https://plex.tv/api/v2/home/users/u1/switch?pin=1234');
    expect(fetch.mock.calls[1]![1].headers['X-Plex-Token']).toBe('account-token');
    await expect(client.switchUser('account-token', 'u1', '0000')).rejects.toThrow('plex_pin_invalid');
  });

  it('keeps only https server connections and prefers a direct connection over relay', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://plex.tv/api/v2/resources')) return json([
        { name: 'kfam00', clientIdentifier: 'srv1', provides: 'server', owned: true, presence: true, accessToken: 'server-token', connections: [
          { uri: 'http://192.168.1.2:32400', local: true },
          { uri: 'https://relay.plex.direct:8443', local: false, relay: true },
          { uri: 'https://1-2-3-4.abc.plex.direct:32400', local: false, relay: false },
        ] },
        { name: 'player', clientIdentifier: 'p1', provides: 'player', accessToken: 'x', connections: [{ uri: 'https://p.plex.direct' }] },
      ]);
      if (url.startsWith('https://1-2-3-4')) return json({ MediaContainer: { Directory: [{ key: '3', type: 'artist' }, { key: '1', type: 'movie' }] } });
      throw new Error('unreachable');
    });
    const client = createPlexClient({ fetch: fetch as unknown as typeof globalThis.fetch, clientId: 'client-0000000000000001' });
    const servers = await client.servers('user-token');
    expect(servers.map(server => server.name)).toEqual(['kfam00']);
    expect(servers[0]!.connections.map(connection => connection.uri)).not.toContain('http://192.168.1.2:32400');
    const connected = await client.connect(servers[0] as PlexServer);
    expect(connected).toEqual({ uri: 'https://1-2-3-4.abc.plex.direct:32400', token: 'server-token', sections: ['3'] });
    expect(fetch.mock.calls.some(([url]) => url.startsWith('https://relay'))).toBe(false);
  });

  it('searches only music sections and maps track metadata', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ MediaContainer: { Hub: [
      { type: 'artist', Metadata: [{ ratingKey: '40', title: 'Dua Lipa', librarySectionID: 3, thumb: '/a' }, { ratingKey: '99', title: 'Movie person', librarySectionID: 1 }] },
      { type: 'track', Metadata: [trackItem(), trackItem({ ratingKey: '43', librarySectionID: 1 })] },
      { type: 'movie', Metadata: [{ ratingKey: '1', title: 'Levitating movie', librarySectionID: 1 }] },
    ] } }));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const results = await client.search(link, 'lipa & co');
    expect(fetch.mock.calls[0]![0]).toBe(`${link.uri}/hubs/search?query=lipa%20%26%20co&limit=30&includeCollections=0&X-Plex-Token=server-token`);
    expect(results.artists).toEqual([{ key: '40', title: 'Dua Lipa', thumb: '/a' }]);
    expect(results.tracks).toEqual([{ key: '42', title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', duration: 203,
      thumb: '/library/metadata/40/thumb/1', container: 'mp3', codec: 'mp3', partKey: '/library/parts/9/file.mp3', size: 8_000_000,
      file: '/music/Dua Lipa/Levitating.mp3' }]);
  });

  it('prefers the track artist over the album artist and rejects unsafe part keys', () => {
    expect(toTrack(trackItem({ originalTitle: 'Featured Artist' }))?.artist).toBe('Featured Artist');
    expect(toTrack(trackItem({ Media: [{ Part: [{ key: 'https://evil.example/file' }] }] }))).toBeNull();
    expect(toTrack({ ...trackItem(), type: 'album' })).toBeNull();
  });

  it('downloads storable originals directly and transcodes everything else to MP3', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' })));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const direct = toTrack(trackItem())!;
    const file = await client.download(link, direct);
    expect(fetch.mock.calls[0]![0]).toBe(`${link.uri}/library/parts/9/file.mp3?X-Plex-Token=server-token`);
    expect(file.name).toBe('Levitating.mp3');
    expect(file.type).toBe('audio/mpeg');
    const wma = toTrack(trackItem({ Media: [{ container: 'asf', audioCodec: 'wmav2', Part: [{ key: '/library/parts/10/file.wma', size: 4_000_000, file: '/m/Song.wma' }] }] }))!;
    const converted = await client.download(link, wma);
    const url = new URL(fetch.mock.calls[1]![0]);
    expect(url.pathname).toBe('/music/:/transcode/universal/start.mp3');
    expect(url.searchParams.get('path')).toBe('/library/metadata/42');
    expect(url.searchParams.get('X-Plex-Token')).toBe('server-token');
    expect(converted.name).toBe('Song.mp3');
    expect(converted.type).toBe('audio/mpeg');
    const large = { ...direct, size: 40 * 1024 * 1024 };
    expect(client.audioUrl(link, large).direct).toBe(false);
  });

  it('reads Plex loudness ramps from the track details when present', async () => {
    const detail = (stream: Record<string, unknown>) => json({ MediaContainer: { Metadata: [{ ...trackItem(),
      Media: [{ Part: [{ key: '/library/parts/9/file.mp3', Stream: [{ streamType: 2, ...stream }] }] }] }] } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(detail({ startRamp: '-51.00 0.00;0.61 1.00;', endRamp: '-51.00 0.11;0.66 2.61;' }))
      .mockResolvedValueOnce(detail({}));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    const track = toTrack(trackItem())!;
    const profile = await client.fadeProfile(link, track);
    expect(fetch.mock.calls[0]![0]).toBe(`${link.uri}/library/metadata/42?includeLoudnessRamps=1&X-Plex-Token=server-token`);
    expect(profile).toMatchObject({ v: 1, step: 0.1 });
    expect(profile!.end.at(-1)).toBe(0.7);
    await expect(client.fadeProfile(link, track)).resolves.toBeUndefined();
  });

  it('reports an expired Plex token as a sign-in requirement', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }));
    const client = createPlexClient({ fetch, clientId: 'client-0000000000000001' });
    await expect(client.playlists(link)).rejects.toThrow('plex_signin_required');
  });
});
