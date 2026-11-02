import { ArrowLeft, Check, ChevronRight, ListMusic, LockKeyhole, LogIn, Play, Plus, Search, Square, Unplug, UserRound, X } from 'lucide';
import type { Track } from '../../shared/routine';
import { createPlexClient, type PlexArtist, type PlexClient, type PlexHomeUser, type PlexLink, type PlexPlaylist, type PlexServer, type PlexTrack } from './plex-client';
import { clearPlexSession, loadPlexSession, savePlexSession, type PlexSession } from './plex-session';
import type { FadeProfile } from './fade-profile';
import { formatTime, t, type MessageKey } from './i18n';
import { element, iconButton, setButtonIcon, transientText } from './ui';

type View =
  | { name: 'connect'; waiting?: string }
  | { name: 'users'; users: PlexHomeUser[]; pinFor?: string }
  | { name: 'servers'; servers: { server: PlexServer; link: PlexLink }[] }
  | { name: 'search' }
  | { name: 'artist'; artist: PlexArtist; tracks?: PlexTrack[] }
  | { name: 'playlists'; playlists?: PlexPlaylist[] }
  | { name: 'playlist'; playlist: PlexPlaylist; tracks?: PlexTrack[] };

export function plexErrorMessage(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : '';
  const key: Record<string, MessageKey> = {
    plex_signin_required: 'plexErrorSignin', plex_pin_invalid: 'plexErrorPin', plex_server_unreachable: 'plexErrorUnreachable',
    plex_no_music: 'plexErrorNoMusic', plex_signin_expired: 'plexErrorExpired',
  };
  return t(key[code] ?? 'plexErrorUnavailable');
}

export function createPlexPicker(context: {
  owner(): string;
  author(): boolean;
  available(): boolean;
  remaining(): number;
  store(file: File, signal: AbortSignal): Promise<Track>;
  added(tracks: Track[], failures: string[], playlist?: string): void;
  keepFadeProfile?(trackId: string, profile: FadeProfile): Promise<void>;
  beforePreview?(): void;
  restoreFocus?(): void;
  client?: PlexClient;
  openWindow?(): Window | null;
}) {
  const client = context.client ?? createPlexClient();
  let session: PlexSession | null = null;
  let sessionOwner: string | null = null;
  let link: PlexLink | null = null;
  let dialog: HTMLDialogElement | null = null;
  let dismiss: (() => void) | undefined;
  let disposed = false;

  const command = iconButton(t('plexAdd'), Plus, () => open('search'), true);
  const settings = element('section', 'settings-section plex-settings');
  const settingsStatus = element('p', 'muted'); settingsStatus.setAttribute('role', 'status');
  const connectButton = iconButton(t('plexConnect'), LogIn, () => open('account'), true);
  const switchButton = iconButton(t('plexSwitchUser'), UserRound, () => open('account'), true);
  const disconnectButton = iconButton(t('plexDisconnect'), Unplug, () => { void disconnect(); }, true);
  const settingsActions = element('div', 'action-row');
  settingsActions.append(connectButton, switchButton, disconnectButton);
  settings.append(element('h2', '', t('plexTitle')), settingsStatus, settingsActions);

  async function currentSession(): Promise<PlexSession | null> {
    const owner = context.owner();
    if (sessionOwner !== owner) {
      session = null; link = null; sessionOwner = owner;
      try { session = await loadPlexSession(owner); } catch { session = null; }
      if (sessionOwner !== owner) return null;
    }
    return session;
  }

  async function remember(next: PlexSession, nextLink: PlexLink): Promise<void> {
    session = next; link = nextLink; sessionOwner = next.owner;
    await savePlexSession(next);
    renderSettings();
  }

  async function forget(): Promise<void> {
    const owner = context.owner();
    session = null; link = null; sessionOwner = owner;
    try { await clearPlexSession(owner); } catch {}
    renderSettings();
  }

  async function disconnect(): Promise<void> {
    if (!confirm(t('plexConfirmDisconnect'))) return;
    dismiss?.();
    await forget();
  }

  function renderSettings(): void {
    const connected = !!session && sessionOwner === context.owner();
    settings.hidden = !context.author();
    settingsStatus.textContent = connected
      ? t('plexConnectedAs', { user: session!.user.title, server: session!.serverName ?? t('plexTitle') }) : t('plexNotConnected');
    connectButton.hidden = connected; switchButton.hidden = !connected; disconnectButton.hidden = !connected;
  }

  /** Reaches the remembered server, reconnecting when the cached link is gone. */
  async function serverLink(signal?: AbortSignal): Promise<PlexLink> {
    if (link) return link;
    const active = await currentSession();
    if (!active?.serverId) throw new Error('plex_signin_required');
    const target = (await client.servers(active.userToken)).find(server => server.id === active.serverId);
    if (signal?.aborted) throw new Error('plex_cancelled');
    if (!target) throw new Error('plex_server_unreachable');
    link = await client.connect(target);
    return link;
  }

  function open(mode: 'search' | 'playlists' | 'account'): void {
    if (disposed || dialog || !context.author() || (mode !== 'account' && !context.available())) return;
    const owner = context.owner();
    const root = element('dialog', 'audio-library-dialog plex-dialog'); dialog = root;
    root.setAttribute('aria-label', t('plexTitle'));
    const back = iconButton(t('plexBack'), ArrowLeft, () => goBack());
    const title = element('h2', '', t('plexTitle'));
    const userChip = element('button', 'plex-user-chip'); userChip.type = 'button';
    userChip.addEventListener('click', () => { if (!busy) void chooseUser(); });
    const close = iconButton(t('plexClose'), X, () => dismiss?.());
    const header = element('div', 'plex-header'); header.append(back, title, userChip, close);
    const tabs = element('div', 'segmented plex-tabs');
    const songsTab = iconButton(t('plexSongs'), Search, () => show({ name: 'search' }), true);
    const playlistsTab = iconButton(t('plexPlaylists'), ListMusic, () => show({ name: 'playlists' }), true);
    tabs.append(songsTab, playlistsTab);
    const search = element('input'); search.type = 'search'; search.autocomplete = 'off';
    search.placeholder = t('plexSearch'); search.setAttribute('aria-label', t('plexSearch'));
    const searchBox = element('div', 'audio-library-search'); searchBox.append(search);
    const body = element('div', 'audio-library-rows plex-body');
    const feedback = element('p'); const error = transientText(feedback);
    const count = element('span', 'audio-library-count'); count.setAttribute('aria-live', 'polite');
    const cancel = iconButton(t('cancel'), X, () => dismiss?.(), true);
    const add = iconButton(t('plexAddCount', { count: 0 }), Check, () => { void addSelected(); }, true);
    add.classList.add('primary');
    const footer = element('div', 'audio-library-actions plex-footer'); footer.append(count, cancel, add);
    const audio = element('audio'); audio.preload = 'none';
    root.append(header, tabs, searchBox, body, feedback, footer, audio);

    let view: View = { name: 'connect' };
    const history: View[] = [];
    const selected = new Map<string, PlexTrack>();
    let busy = false;
    let progress = '';
    let searchResults: { artists: PlexArtist[]; tracks: PlexTrack[] } | null = null;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchController: AbortController | null = null;
    let work: AbortController | null = null;
    let previewKey = '';
    let accountToken = '';

    const current = () => { if (disposed || dialog !== root || owner !== context.owner()) throw new Error('plex_cancelled'); };
    const stopPreview = () => { previewKey = ''; audio.pause(); audio.removeAttribute('src'); audio.load?.(); };
    audio.addEventListener('ended', () => { stopPreview(); render(); });
    audio.addEventListener('error', () => { if (previewKey) { stopPreview(); error.show(t('plexErrorUnavailable')); render(); } });

    dismiss = () => {
      if (dialog !== root) return;
      dialog = null; clearTimeout(searchTimer); searchController?.abort(); work?.abort(); stopPreview();
      error.dispose(); root.close(); root.remove(); dismiss = undefined;
      if (!disposed) { if (context.restoreFocus) context.restoreFocus(); else command.focus(); }
    };

    const run = async (action: (signal: AbortSignal) => Promise<void>) => {
      if (busy) return;
      busy = true; const active = new AbortController(); work = active; error.dismiss(); render();
      try { await action(active.signal); }
      catch (reason) {
        if (dialog !== root || active.signal.aborted) return;
        if (reason instanceof Error && reason.message === 'plex_signin_required') { await forget(); history.length = 0; view = { name: 'connect' }; }
        error.show(plexErrorMessage(reason));
      } finally {
        if (work === active) work = null;
        busy = false; progress = '';
        if (dialog === root) render();
      }
    };

    function show(next: View, push = false): void {
      if (busy) return;
      stopPreview(); error.dismiss();
      if (push) history.push(view); else history.length = 0;
      view = next; render(); load();
      if (next.name === 'search') queueMicrotask(() => search.focus());
    }
    function goBack(): void {
      if (busy || !history.length) return;
      stopPreview(); view = history.pop()!; render();
    }

    function load(): void {
      const target = view;
      if (target.name === 'artist' && !target.tracks) void run(async signal => {
        const tracks = await client.artistTracks(await serverLink(signal), target.artist.key, signal); current();
        target.tracks = tracks;
      });
      if (target.name === 'playlists' && !target.playlists) void run(async signal => {
        const playlists = await client.playlists(await serverLink(signal), signal); current();
        target.playlists = playlists;
      });
      if (target.name === 'playlist' && !target.tracks) void run(async signal => {
        const tracks = await client.playlistTracks(await serverLink(signal), target.playlist.key, signal); current();
        target.tracks = tracks;
        for (const track of tracks) if (selected.size < context.remaining()) selected.set(track.key, track);
      });
    }

    const runSearch = () => {
      clearTimeout(searchTimer); searchController?.abort();
      const query = search.value.trim();
      if (!query) { searchResults = null; render(); return; }
      searchTimer = setTimeout(() => {
        const active = new AbortController(); searchController = active;
        void (async () => {
          try {
            const results = await client.search(await serverLink(active.signal), query, active.signal); current();
            if (searchController === active) { searchResults = results; render(); }
          } catch (reason) {
            if (!active.signal.aborted && dialog === root) error.show(plexErrorMessage(reason));
          }
        })();
      }, 250);
    };
    search.addEventListener('input', runSearch);

    const thumb = (value: string | undefined, round = false) => {
      const frame = element('span', round ? 'plex-thumb round' : 'plex-thumb');
      if (value && link) {
        const image = element('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
        image.src = client.thumbUrl(link, value, 96);
        image.addEventListener('error', () => image.remove());
        frame.append(image);
      }
      return frame;
    };

    const songRow = (track: PlexTrack) => {
      const row = element('div', 'plex-song');
      const pick = element('label', 'plex-song-pick');
      const checkbox = element('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(track.key); checkbox.disabled = busy;
      checkbox.setAttribute('aria-label', track.title);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked && selected.size >= context.remaining()) { checkbox.checked = false; error.show(t('tooManyTracks')); return; }
        if (checkbox.checked) selected.set(track.key, track); else selected.delete(track.key);
        render();
      });
      const text = element('span', 'plex-song-text');
      text.append(element('span', 'plex-song-title', track.title),
        element('span', 'plex-song-sub', [track.artist, track.album].filter(Boolean).join(' · ')));
      pick.append(checkbox, thumb(track.thumb), text, element('span', 'plex-song-time', formatTime(track.duration)));
      const playing = previewKey === track.key;
      const preview = iconButton(t(playing ? 'stop' : 'playPreview'), playing ? Square : Play, () => {
        if (previewKey === track.key) { stopPreview(); render(); return; }
        void (async () => {
          try {
            const active = await serverLink(); current();
            context.beforePreview?.(); stopPreview();
            previewKey = track.key; audio.src = client.audioUrl(active, track).url; render();
            await audio.play();
          } catch (reason) {
            if (dialog === root && previewKey === track.key) { stopPreview(); error.show(plexErrorMessage(reason)); render(); }
          }
        })();
      });
      preview.classList.add('plex-preview');
      row.append(pick, preview);
      return row;
    };

    const navRow = (label: string, meta: string, image: HTMLElement, action: () => void) => {
      const button = element('button', 'plex-nav'); button.type = 'button'; button.disabled = busy;
      const text = element('span', 'plex-song-text');
      text.append(element('span', 'plex-song-title', label));
      if (meta) text.append(element('span', 'plex-song-sub', meta));
      const chevron = element('span', 'plex-chevron'); setButtonIcon(chevron, ChevronRight);
      button.append(image, text, chevron);
      button.addEventListener('click', action);
      return button;
    };

    const section = (label: string) => element('h3', 'plex-section', label);
    const empty = (key: MessageKey) => element('p', 'audio-library-empty', t(key));

    function renderConnect(target: Extract<View, { name: 'connect' }>): void {
      const panel = element('div', 'plex-connect');
      panel.append(element('p', '', t('plexConnectIntro')));
      if (target.waiting) {
        const anchor = element('a', 'button', t('plexOpenSignIn'));
        anchor.href = target.waiting; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        panel.append(element('p', 'muted', t('plexWaiting')), anchor);
      } else {
        const signIn = iconButton(t('plexSignIn'), LogIn, () => signInWithPlex(), true);
        signIn.classList.add('primary'); signIn.disabled = busy;
        panel.append(signIn);
      }
      body.append(panel);
    }

    function renderUsers(target: Extract<View, { name: 'users' }>): void {
      body.append(section(t('plexChooseUser')));
      const list = element('div', 'plex-users');
      for (const user of target.users) {
        const button = element('button', 'plex-user'); button.type = 'button'; button.disabled = busy;
        const avatar = element('span', 'plex-avatar', user.title.trim().charAt(0).toLocaleUpperCase('en-US') || '?');
        avatar.setAttribute('aria-hidden', 'true');
        button.append(avatar, element('span', 'plex-user-name', user.title));
        if (user.protected) { const lock = element('span', 'plex-lock'); setButtonIcon(lock, LockKeyhole); button.append(lock); }
        if (session?.user.uuid === user.uuid) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          if (user.protected) { target.pinFor = user.uuid; render(); return; }
          void run(signal => useUser(user, undefined, signal));
        });
        list.append(button);
        if (target.pinFor === user.uuid) {
          const form = element('form', 'plex-pin');
          const pin = element('input'); pin.type = 'password'; pin.inputMode = 'numeric'; pin.autocomplete = 'off';
          pin.maxLength = 4; pin.pattern = '[0-9]{4}'; pin.required = true; pin.setAttribute('aria-label', t('plexPin', { name: user.title }));
          pin.placeholder = '••••';
          const go = iconButton(t('continue'), Check, () => {}, true); go.type = 'submit'; go.classList.add('primary'); go.disabled = busy;
          form.append(pin, go);
          form.addEventListener('submit', event => {
            event.preventDefault();
            if (!/^[0-9]{4}$/.test(pin.value)) { pin.focus(); return; }
            const value = pin.value; pin.value = '';
            void run(signal => useUser(user, value, signal));
          });
          list.append(form);
          queueMicrotask(() => pin.focus());
        }
      }
      body.append(list);
    }

    function renderServers(target: Extract<View, { name: 'servers' }>): void {
      body.append(section(t('plexChooseServer')));
      for (const choice of target.servers) {
        body.append(navRow(choice.server.name, '', element('span', 'plex-thumb'), () => void run(async () => { await finishServer(choice.server, choice.link); })));
      }
    }

    function render(): void {
      if (dialog !== root) return;
      const connected = !!session && !['connect', 'users', 'servers'].includes(view.name);
      back.hidden = !history.length || !connected;
      back.disabled = busy;
      title.textContent = view.name === 'artist' ? view.artist.title : view.name === 'playlist' ? view.playlist.title : t('plexTitle');
      userChip.hidden = !connected;
      userChip.disabled = busy;
      if (session) {
        userChip.replaceChildren(element('span', 'plex-avatar small', session.user.title.trim().charAt(0).toLocaleUpperCase('en-US') || '?'),
          element('span', '', session.user.title));
        userChip.title = t('plexUserChip', { name: session.user.title }); userChip.setAttribute('aria-label', userChip.title);
      }
      tabs.hidden = !connected || view.name === 'artist' || view.name === 'playlist';
      songsTab.setAttribute('aria-pressed', String(view.name === 'search'));
      playlistsTab.setAttribute('aria-pressed', String(view.name === 'playlists'));
      searchBox.hidden = !connected || view.name !== 'search';
      search.disabled = busy;
      footer.hidden = !connected;
      body.replaceChildren();
      if (view.name === 'connect') renderConnect(view);
      else if (view.name === 'users') renderUsers(view);
      else if (view.name === 'servers') renderServers(view);
      else if (view.name === 'search') {
        if (!search.value.trim() || !searchResults) body.append(empty(search.value.trim() ? 'plexLoading' : 'plexSearchHint'));
        else if (!searchResults.artists.length && !searchResults.tracks.length) body.append(empty('plexNoResults'));
        else {
          if (searchResults.artists.length) {
            body.append(section(t('plexArtists')));
            for (const artist of searchResults.artists) body.append(navRow(artist.title, '', thumb(artist.thumb, true), () => show({ name: 'artist', artist }, true)));
          }
          if (searchResults.tracks.length) {
            body.append(section(t('plexSongs')));
            for (const track of searchResults.tracks) body.append(songRow(track));
          }
        }
      } else if (view.name === 'artist' || view.name === 'playlist') {
        if (!view.tracks) body.append(empty('plexLoading'));
        else if (!view.tracks.length) body.append(empty('plexNoResults'));
        else for (const track of view.tracks) body.append(songRow(track));
      } else if (view.name === 'playlists') {
        if (!view.playlists) body.append(empty('plexLoading'));
        else if (!view.playlists.length) body.append(empty('plexNoPlaylists'));
        else for (const playlist of view.playlists) {
          const icon = element('span', 'plex-thumb'); setButtonIcon(icon, ListMusic);
          body.append(navRow(playlist.title, t('plexPlaylistMeta', { count: playlist.count, duration: formatTime(playlist.duration) }), icon,
            () => show({ name: 'playlist', playlist }, true)));
        }
      }
      count.textContent = progress || (selected.size ? t('audioLibrarySelected', { count: selected.size }) : '');
      add.disabled = busy || !selected.size || selected.size > context.remaining() || !context.available();
      const label = t('plexAddCount', { count: selected.size || '' }).trim();
      add.title = label; add.setAttribute('aria-label', label);
      const addLabel = add.querySelector('span:last-child'); if (addLabel) addLabel.textContent = label;
    }

    function signInWithPlex(): void {
      if (busy) return;
      // Open the window inside the click so popup blockers allow it; navigate once the PIN exists.
      const popup = context.openWindow ? context.openWindow() : window.open('about:blank', 'plex-auth', 'popup,width=520,height=720');
      try { if (popup) popup.opener = null; } catch {}
      void run(async signal => {
        try {
          const pin = await client.startSignIn(); current();
          view = { name: 'connect', waiting: pin.url }; render();
          try { if (popup && !popup.closed) popup.location.href = pin.url; } catch {}
          accountToken = await client.waitForSignIn(pin, signal); current();
        } finally { try { popup?.close(); } catch {} }
        await listUsers(signal);
      });
    }

    async function listUsers(signal: AbortSignal): Promise<void> {
      let users: PlexHomeUser[] = [];
      try { users = await client.homeUsers(accountToken); } catch (reason) {
        if (reason instanceof Error && reason.message === 'plex_signin_required') throw reason;
      }
      current();
      if (users.length <= 1 && !users[0]?.protected) {
        await useUser(users[0] ?? { uuid: '', title: 'Plex', admin: true, protected: false }, undefined, signal);
        return;
      }
      view = { name: 'users', users };
    }

    async function chooseUser(): Promise<void> {
      const active = await currentSession(); current();
      if (!active) { show({ name: 'connect' }); return; }
      accountToken = active.accountToken;
      await run(async signal => { await listUsers(signal); });
    }

    async function useUser(user: PlexHomeUser, pin: string | undefined, signal: AbortSignal): Promise<void> {
      const userToken = !user.uuid || (user.admin && !user.protected) ? accountToken : await client.switchUser(accountToken, user.uuid, pin);
      current();
      const servers = (await client.servers(userToken)).sort((first, second) => Number(second.owned) - Number(first.owned));
      current();
      const preferred = session?.serverId;
      const reachable = (await Promise.allSettled(servers.map(async server => ({ server, link: await client.connect(server) }))))
        .flatMap(result => result.status === 'fulfilled' && result.value.link.sections.length ? [result.value] : []);
      current();
      if (signal.aborted) throw new Error('plex_cancelled');
      if (!reachable.length) throw new Error(servers.length ? 'plex_no_music' : 'plex_server_unreachable');
      pendingUser = { user, userToken };
      const remembered = reachable.find(choice => choice.server.id === preferred);
      if (remembered || reachable.length === 1) { await finishServer((remembered ?? reachable[0]!).server, (remembered ?? reachable[0]!).link); return; }
      view = { name: 'servers', servers: reachable };
    }

    let pendingUser: { user: PlexHomeUser; userToken: string } | null = null;
    async function finishServer(server: PlexServer, serverLinkValue: PlexLink): Promise<void> {
      if (!pendingUser) throw new Error('plex_signin_required');
      const { user, userToken } = pendingUser; pendingUser = null;
      await remember({ owner, accountToken, user: { uuid: user.uuid, title: user.title, admin: user.admin, protected: user.protected },
        userToken, serverId: server.id, serverName: server.name }, serverLinkValue);
      current();
      selected.clear(); searchResults = null;
      if (mode === 'account') { setTimeout(() => dismiss?.(), 0); return; }
      history.length = 0; view = { name: mode === 'playlists' ? 'playlists' : 'search' };
      // After run() settles, so the follow-up load is not rejected as busy.
      setTimeout(() => { if (dialog !== root) return; load(); runSearch(); if (view.name === 'search') search.focus(); }, 0);
    }

    async function addSelected(): Promise<void> {
      const playlist = view.name === 'playlist' ? view.playlist.title : undefined;
      await run(async signal => {
        stopPreview();
        if (!selected.size || selected.size > context.remaining() || !context.available()) throw new Error('plex_cancelled');
        const active = await serverLink(signal); current();
        const tracks: Track[] = [];
        const failures: string[] = [];
        const items = [...selected.values()];
        for (const [index, item] of items.entries()) {
          progress = t('plexAdding', { current: index + 1, total: items.length }); render();
          try {
            const file = await client.download(active, item, signal); current();
            const profile = await client.fadeProfile(active, item, signal).catch(() => undefined); current();
            const track = await context.store(file, signal); current();
            if (item.title) track.title = item.title.slice(0, 160);
            if (item.artist) track.artist = item.artist.slice(0, 300);
            // Plex's ramps are timed against its copy; only trust them when our import has the same length.
            if (profile && Math.abs(track.duration - item.duration) <= 1) {
              await context.keepFadeProfile?.(track.id, profile).catch(() => undefined); current();
            }
            tracks.push(track);
          } catch (reason) {
            current(); if (signal.aborted) throw reason;
            failures.push(`${item.title}: ${reason instanceof Error && reason.message.startsWith('plex_') ? plexErrorMessage(reason) : reason instanceof Error ? reason.message : String(reason)}`);
          }
        }
        selected.clear();
        context.added(tracks, failures, playlist);
        setTimeout(() => dismiss?.(), 0);
      });
    }

    root.addEventListener('cancel', event => { event.preventDefault(); if (busy) work?.abort(); dismiss?.(); });
    root.addEventListener('close', () => { if (dialog === root) dismiss?.(); });
    document.body.append(root); root.showModal();
    void (async () => {
      const active = await currentSession();
      if (dialog !== root) return;
      if (!active) { view = { name: 'connect' }; render(); return; }
      if (mode === 'account') { await chooseUser(); return; }
      show({ name: mode === 'playlists' ? 'playlists' : 'search' });
    })();
    render();
  }

  return {
    element: command,
    settings,
    openPlaylists() { open('playlists'); },
    leave() { dismiss?.(); },
    sync() {
      command.hidden = !context.author(); command.disabled = !context.available();
      if (sessionOwner !== context.owner()) { dismiss?.(); void currentSession().then(renderSettings); }
      renderSettings();
    },
    dispose() { disposed = true; dismiss?.(); },
  };
}
