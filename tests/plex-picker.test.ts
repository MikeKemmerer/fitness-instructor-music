import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlexClient, PlexLink, PlexServer, PlexTrack } from '../frontend/src/plex-client';
import type { PlexSession } from '../frontend/src/plex-session';

const store = vi.hoisted(() => ({ sessions: new Map<string, PlexSession>() }));
vi.mock('../frontend/src/plex-session', () => ({
  loadPlexSession: async (owner: string) => store.sessions.get(owner) ?? null,
  savePlexSession: async (session: PlexSession) => { store.sessions.set(session.owner, structuredClone(session)); },
  clearPlexSession: async (owner: string) => { store.sessions.delete(owner); },
}));

class Node extends EventTarget {
  children: Node[] = [];
  parent: Node | null = null;
  attributes = new Map<string, string>();
  hidden = false; disabled = false; checked = false; value = ''; type = ''; title = ''; open = false; src = '';
  classList = { add: (name: string) => { this.className = `${this.className} ${name}`.trim(); } };
  constructor(public tag: string, public className = '', public textContent = '') { super(); }
  append(...nodes: Node[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  prepend(...nodes: Node[]) { this.append(...nodes); }
  replaceChildren(...nodes: Node[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap(child => [
      ...(child.tag === selector || (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) ? [child] : []),
      ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  pause() {} load() {} async play() {}
}

vi.mock('../frontend/src/ui', () => ({
  element: (tag: string, className = '', text = '') => new Node(tag, className, text),
  iconButton: (label: string, _icon: unknown, action: () => void) => {
    const button = new Node('button'); button.title = label; button.addEventListener('click', action); return button;
  },
  setButtonIcon: () => {},
  transientText: (node: Node) => ({ show: (text: string) => { node.textContent = text; }, dismiss: () => { node.textContent = ''; }, dispose: () => {} }),
}));

const { createPlexPicker } = await import('../frontend/src/plex-picker');
const { t } = await import('../frontend/src/i18n');

const link: PlexLink = { uri: 'https://1-2-3-4.abc.plex.direct:32400', token: 'server-token', sections: ['3'] };
const server: PlexServer = { id: 'srv1', name: 'kfam00', owned: true, accessToken: 'server-token', connections: [{ uri: link.uri, local: false, relay: false }] };
const song: PlexTrack = { key: '42', title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', duration: 203, container: 'mp3',
  codec: 'mp3', partKey: '/library/parts/9/file.mp3', size: 1000, file: '/music/Levitating.mp3' };

function fakeClient() {
  return {
    clientId: 'client',
    startSignIn: vi.fn(async () => ({ id: 1, code: 'abcd', url: 'https://app.plex.tv/auth#?code=abcd' })),
    waitForSignIn: vi.fn(async () => 'account-token'),
    homeUsers: vi.fn(async () => [
      { uuid: 'u1', title: 'Mom', admin: true, protected: true },
      { uuid: 'u2', title: 'Kid', admin: false, protected: false },
    ]),
    switchUser: vi.fn(async (_token: string, uuid: string) => `token-${uuid}`),
    servers: vi.fn(async () => [server]),
    connect: vi.fn(async () => link),
    search: vi.fn(async () => ({ artists: [{ key: '40', title: 'Dua Lipa' }], tracks: [song] })),
    artistTracks: vi.fn(async () => [song]),
    playlists: vi.fn(async () => [{ key: '7', title: 'Barre warmup', count: 1, duration: 203 }]),
    playlistTracks: vi.fn(async () => [song]),
    thumbUrl: vi.fn(() => 'https://thumb'),
    audioUrl: vi.fn(() => ({ url: `${link.uri}/library/parts/9/file.mp3?X-Plex-Token=server-token`, direct: true })),
    download: vi.fn(async () => new File([new Uint8Array([1])], 'Levitating.mp3', { type: 'audio/mpeg' })),
  };
}

let body: Node;
beforeEach(() => {
  store.sessions.clear();
  body = new Node('body');
  vi.stubGlobal('document', { body, createElement: (tag: string) => new Node(tag) });
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => { vi.unstubAllGlobals(); });

const button = (label: string) => body.querySelectorAll('button').find(node => node.title === label);

function picker(client: ReturnType<typeof fakeClient>, overrides: Partial<Parameters<typeof createPlexPicker>[0]> = {}) {
  const popup = { closed: false, opener: {}, location: { href: '' }, close: vi.fn() };
  const added = vi.fn();
  const instance = createPlexPicker({ owner: () => 'user-1', author: () => true, available: () => true, remaining: () => 10,
    store: vi.fn(async (file: File) => ({ id: crypto.randomUUID(), title: file.name, duration: 203, firstBeat: 0, bodyArea: '', cues: [] })),
    added, client: client as unknown as PlexClient, openWindow: () => popup as unknown as Window, ...overrides });
  return { instance, added, popup };
}

describe('plex picker', () => {
  it('signs in, asks for a protected user PIN, and remembers the chosen user per app user', async () => {
    const client = fakeClient();
    const { instance, popup } = picker(client);
    instance.element.click();
    await vi.waitFor(() => expect(button(t('plexSignIn'))).toBeDefined());
    button(t('plexSignIn'))!.click();
    await vi.waitFor(() => expect(body.querySelectorAll('.plex-user')).toHaveLength(2));
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe('https://app.plex.tv/auth#?code=abcd');
    expect(popup.close).toHaveBeenCalled();
    body.querySelectorAll('.plex-user')[0]!.click();
    const form = body.querySelector('.plex-pin')!;
    form.querySelector('input')!.value = '1234';
    form.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(store.sessions.get('user-1')).toBeDefined());
    expect(client.switchUser).toHaveBeenCalledWith('account-token', 'u1', '1234');
    expect(store.sessions.get('user-1')).toMatchObject({ accountToken: 'account-token', userToken: 'token-u1', serverId: 'srv1',
      serverName: 'kfam00', user: { uuid: 'u1', title: 'Mom' } });
    expect(instance.settings.querySelector('p')!.textContent).toBe(t('plexConnectedAs', { user: 'Mom', server: 'kfam00' }));
    instance.dispose();
  });

  it('searches, previews nothing until asked, and adds checked songs with Plex title and artist', async () => {
    store.sessions.set('user-1', { owner: 'user-1', accountToken: 'account-token', user: { uuid: 'u2', title: 'Kid', admin: false, protected: false },
      userToken: 'token-u2', serverId: 'srv1', serverName: 'kfam00' });
    const client = fakeClient();
    const { instance, added } = picker(client);
    instance.element.click();
    await vi.waitFor(() => expect(body.querySelector('input')).toBeDefined());
    const search = body.querySelectorAll('input').find(node => node.type === 'search')!;
    search.value = 'lipa'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(body.querySelectorAll('.plex-song')).toHaveLength(1));
    expect(client.search).toHaveBeenCalledWith(link, 'lipa', expect.any(AbortSignal));
    expect(body.querySelectorAll('.plex-nav')).toHaveLength(1);
    const checkbox = body.querySelector('.plex-song')!.querySelector('input')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    button(t('plexAddCount', { count: 1 }))!.click();
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(client.download).toHaveBeenCalledWith(link, song, expect.any(AbortSignal));
    expect(added.mock.calls[0]![0][0]).toMatchObject({ title: 'Levitating', artist: 'Dua Lipa' });
    expect(added.mock.calls[0]![1]).toEqual([]);
    expect(client.audioUrl).not.toHaveBeenCalled();
    instance.dispose();
  });

  it('opens playlists with every song preselected and passes the playlist name', async () => {
    store.sessions.set('user-1', { owner: 'user-1', accountToken: 'a', user: { uuid: 'u2', title: 'Kid', admin: false, protected: false },
      userToken: 'token-u2', serverId: 'srv1', serverName: 'kfam00' });
    const client = fakeClient();
    const { instance, added } = picker(client);
    instance.openPlaylists();
    await vi.waitFor(() => expect(body.querySelectorAll('.plex-nav')).toHaveLength(1));
    body.querySelector('.plex-nav')!.click();
    await vi.waitFor(() => expect(body.querySelector('.plex-song')?.querySelector('input')?.checked).toBe(true));
    button(t('plexAddCount', { count: 1 }))!.click();
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(added.mock.calls[0]![2]).toBe('Barre warmup');
    instance.dispose();
  });

  it('hides Plex from players and forgets the session on disconnect', async () => {
    store.sessions.set('user-1', { owner: 'user-1', accountToken: 'a', user: { uuid: 'u2', title: 'Kid', admin: false, protected: false },
      userToken: 'token-u2', serverId: 'srv1', serverName: 'kfam00' });
    let author = false;
    const { instance } = picker(fakeClient(), { author: () => author });
    instance.sync();
    expect(instance.element.hidden).toBe(true);
    await vi.waitFor(() => expect(instance.settings.hidden).toBe(true));
    author = true; instance.sync();
    const disconnect = () => [...instance.settings.querySelectorAll('button')].find(node => node.title === t('plexDisconnect'));
    await vi.waitFor(() => expect(disconnect()?.hidden).toBe(false));
    disconnect()!.click();
    await vi.waitFor(() => expect(store.sessions.has('user-1')).toBe(false));
    expect(instance.settings.querySelector('p')!.textContent).toBe(t('plexNotConnected'));
    instance.dispose();
  });
});
