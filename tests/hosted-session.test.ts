import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReadableStream } from 'node:stream/web';
import { CloudApi } from '../api/src/cloud/http';
import { COOKIE_NAME, derivePassword } from '../api/src/cloud/auth';
import { LIMITS, type Account } from '../api/src/cloud/config';
import { BlobConflict, type BlobStore, type StoredBlob } from '../api/src/cloud/store';
import { decidePrincipal, deleteHostedDatabase, establishHostedSession, hostedDatabase, hostedDenied, hostedIdentityMarker,
  hostedInvalidationEvent, hostedResetKey, hostedSignIn, hostedUserKey, HostedSessionError,
  type HostedSessionDependencies } from '../frontend/src/hosted-session';
import { startApplication } from '../frontend/src/bootstrap';
import { preferenceKey } from '../frontend/src/theme';
import { t } from '../frontend/src/i18n';
import { CLOUD_TIMEOUT_MS, createCloudClient, parseCloudSession, type CloudContext } from '../frontend/src/cloud-client';
import type { CloudSession } from '../shared/cloud-contract';

function principal(id = 'member-a', role: CloudSession['user']['role'] = 'owner', authVersion = 1): CloudSession {
  return { user: { id, username: 'instructor', role, authVersion }, expiresAt: Date.now() + 60_000, csrfToken: 'test-csrf' };
}

const marker = (id = 'member-a', role: CloudSession['user']['role'] = 'owner', authVersion = 1) =>
  hostedIdentityMarker(principal(id, role, authVersion).user);

function response(payload: unknown = principal(), status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function memoryStorage(previous: string | null = marker()) {
  const values = new Map<string, string>();
  if (previous !== null) values.set(hostedUserKey, previous);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}

function sessionHarness(previous: string | null = marker()) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  return {
    fetch: fetcher, client: createCloudClient({ fetch: fetcher }), storage: memoryStorage(previous),
    events: new EventTarget() as unknown as HostedSessionDependencies['events'],
    replace: vi.fn<(url: string) => void>(), deleteDatabase: vi.fn<() => Promise<void>>().mockResolvedValue(),
    resetId: () => 'reset-test',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}

function storageEvent(events: HostedSessionDependencies['events'], key: string | null,
  newValue: string | null, oldValue: string | null = null, storageArea?: object) {
  events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, oldValue, storageArea }));
}

function databaseHarness(outcome: 'success' | 'error' | 'blocked' | 'pending' = 'success') {
  const request = {} as IDBOpenDBRequest;
  const database = { deleteDatabase: vi.fn((_name: string) => {
    if (outcome !== 'pending') queueMicrotask(() => {
      const handler = request[`on${outcome}`] as ((event: Event) => void) | null;
      handler?.(new Event(outcome));
    });
    return request;
  }) };
  return { database, request };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('hosted principal decisions', () => {
  it('accepts validated custom sessions without treating the role as server authorization', () => {
    expect(decidePrincipal(principal())).toEqual({ kind: 'admit', userId: 'member-a' });
    expect(decidePrincipal(principal('member-a', 'player'))).toEqual({ kind: 'admit', userId: 'member-a' });
  });

  it.each([null, {}, [], { user: null }, { user: [] }, principal(''), principal('  '),
    { ...principal(), user: { ...principal().user, authVersion: 0 } },
    { ...principal(), user: { ...principal().user, authVersion: 1.5 } },
    { ...principal(), user: { ...principal().user, role: 'household' } },
    { ...principal(), user: { ...principal().user, username: '' } },
    { ...principal(), expiresAt: 0 }, { ...principal(), expiresAt: Infinity },
    { ...principal(), csrfToken: '' },
  ])('rejects missing or malformed identity %#', payload => {
    expect(decidePrincipal(payload)).toEqual({ kind: 'signin' });
  });
});

describe('hosted session admission', () => {
  it('checks the uncached same-origin endpoint even when navigator reports offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const harness = sessionHarness();
    expect(await establishHostedSession(harness)).toBe(true);
    expect(harness.fetch).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(harness.storage.values).toEqual(new Map([[hostedUserKey, marker()]]));
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it.each([null, { user: null }])('redirects malformed session payloads without erasing data', async payload => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(payload));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it('sends a forbidden session to access denied without purging', async () => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(null, 403));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedDenied);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it.each([null, '', '   ', 'legacy-user', '{}'])('does not admit an unknown device on network failure: %s', async previous => {
    const harness = sessionHarness(previous);
    harness.fetch.mockRejectedValue(new TypeError('network unavailable'));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
  });

  it('admits the remembered local identity when the network request fails, without cloud credentials', async () => {
    const harness = sessionHarness();
    harness.fetch.mockRejectedValue(new TypeError('network unavailable'));
    expect(await establishHostedSession(harness)).toBe(true);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.client.getContext().access).toBe('offline');
    await expect(harness.client.request('/api/routines')).rejects.toMatchObject({ code: 'network_unavailable' });
  });

  it('does not use an incomplete reset as offline admission', async () => {
    const harness = sessionHarness();
    harness.storage.values.set(hostedResetKey, 'pending-reset');
    harness.fetch.mockRejectedValue(new TypeError('network unavailable'));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
  });

  it.each([403, 500])('never treats HTTP %s as offline permission', async status => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(null, status));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(status === 403 ? hostedDenied : hostedSignIn);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it('admits an existing local owner on 401 in signin-required mode without invalidating local playback', async () => {
    const harness = sessionHarness();
    const stop = vi.fn();
    harness.events.addEventListener(hostedInvalidationEvent, stop);
    harness.fetch.mockResolvedValue(response(null, 401));
    expect(await establishHostedSession(harness)).toBe(true);
    expect(harness.client.getContext()).toMatchObject({ access: 'signin-required', user: JSON.parse(marker()) });
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(harness.client.request('/api/routines')).rejects.toMatchObject({ code: 'signin_required' });
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it.each([null, 'legacy-user', '{}'])('requires sign-in on 401 without a valid marker: %s', async previous => {
    const harness = sessionHarness(previous);
    harness.fetch.mockResolvedValue(response(null, 401));
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
  });

  it('does not use malformed JSON or a body read failure as offline permission', async () => {
    for (const malformed of [new Response('<html>Sign in</html>'),
      { ok: true, redirected: false, json: () => Promise.reject(new TypeError('body failed')) } as unknown as Response]) {
      const harness = sessionHarness();
      harness.fetch.mockResolvedValue(malformed);
      expect(await establishHostedSession(harness)).toBe(false);
      expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
    }
  });

  it('rejects a followed redirect even if it contains a valid principal', async () => {
    const harness = sessionHarness();
    const redirected = response();
    Object.defineProperty(redirected, 'redirected', { value: true });
    harness.fetch.mockResolvedValue(redirected);
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
  });

  it('does not treat arbitrary fetch exceptions as network failures', async () => {
    const harness = sessionHarness();
    harness.fetch.mockRejectedValue(new Error('unexpected failure'));
    expect(await establishHostedSession(harness)).toBe(false);
  });

  it('bounds a stalled network request at forty seconds and aborts it', async () => {
    vi.useFakeTimers();
    const harness = sessionHarness();
    harness.fetch.mockReturnValue(new Promise<Response>(() => {}));
    const admission = establishHostedSession(harness);
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUT_MS);
    expect(await admission).toBe(true);
    expect(harness.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('does not fall back offline when the response body stalls after HTTP success', async () => {
    vi.useFakeTimers();
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue({ ok: true, redirected: false,
      json: () => new Promise(() => {}) } as unknown as Response);
    const admission = establishHostedSession(harness);
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUT_MS);
    expect(await admission).toBe(false);
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
  });

  it.each(['member-a', null])('purges old or unbound local data before remembering a verified user: %s', async previous => {
    const harness = sessionHarness(previous);
    harness.fetch.mockResolvedValue(response(principal('member-b')));
    const deletion = deferred<void>();
    harness.deleteDatabase.mockReturnValue(deletion.promise);
    const admission = establishHostedSession(harness);
    await vi.waitFor(() => expect(harness.deleteDatabase).toHaveBeenCalledOnce());
    expect(harness.storage.getItem(hostedUserKey)).toBe(previous);
    expect(harness.storage.getItem(hostedResetKey)).toBe('reset-test');
    deletion.resolve();
    expect(await admission).toBe(true);
    expect(harness.storage.values).toEqual(new Map([[hostedUserKey, marker('member-b')]]));
  });

  it('fails closed on switch cleanup failure without overwriting the previous identity', async () => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(principal('member-b')));
    harness.deleteDatabase.mockRejectedValue(new Error('blocked'));
    await expect(establishHostedSession(harness)).rejects.toMatchObject({ code: 'hostedCleanupFailed' });
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
    expect(harness.storage.getItem(hostedResetKey)).toBe('reset-test');
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('requires cleanup again after an interrupted reset, even for the same verified identity', async () => {
    const harness = sessionHarness();
    harness.storage.values.set(hostedResetKey, 'pending-reset');
    expect(await establishHostedSession(harness)).toBe(true);
    expect(harness.deleteDatabase).toHaveBeenCalledOnce();
    expect(harness.storage.getItem(hostedResetKey)).toBeNull();
  });

  it.each(['logout:pending', 'signin:pending'])('blocks admission during an explicit account operation: %s', async reset => {
    const harness = sessionHarness();
    harness.storage.values.set(hostedResetKey, reset);
    expect(await establishHostedSession(harness)).toBe(false);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedResetKey)).toBe(reset);
  });

  it.each([principal('member-a', 'owner', 2), principal('member-a', 'player')])('purges before admitting an altered account version or role', async session => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(session));
    expect(await establishHostedSession(harness)).toBe(true);
    expect(harness.deleteDatabase).toHaveBeenCalledOnce();
    expect(harness.storage.getItem(hostedUserKey)).toBe(hostedIdentityMarker(session.user));
    expect(harness.storage.getItem(hostedUserKey)).not.toContain('csrf');
    expect(harness.storage.getItem(hostedUserKey)).not.toContain('username');
  });

  it('fails closed when it cannot read or write the ownership marker', async () => {
    const unreadable = sessionHarness();
    unreadable.storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    await expect(establishHostedSession(unreadable)).rejects.toMatchObject({ code: 'hostedStorageFailed' });
    expect(unreadable.fetch).not.toHaveBeenCalled();
    const unwritable = sessionHarness();
    unwritable.fetch.mockResolvedValue(response(principal('member-b')));
    unwritable.storage.setItem.mockImplementation(() => { throw new Error('blocked'); });
    await expect(establishHostedSession(unwritable)).rejects.toMatchObject({ code: 'hostedStorageFailed' });
    expect(unwritable.deleteDatabase).not.toHaveBeenCalled();
  });
});

describe('hosted cross-tab invalidation', () => {
  it('registers before the pending session check and prevents a late admission', async () => {
    const harness = sessionHarness();
    const pending = deferred<Response>();
    harness.fetch.mockReturnValue(pending.promise);
    const stop = vi.fn();
    harness.events.addEventListener(hostedInvalidationEvent, stop);
    const admission = establishHostedSession(harness);
    storageEvent(harness.events, hostedResetKey, 'another-tab');
    expect(stop).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith(hostedSignIn);
    pending.resolve(response());
    expect(await admission).toBe(false);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
  });

  it.each([hostedResetKey, hostedUserKey, null])('stops an admitted tab for the session signal %s', async key => {
    const harness = sessionHarness();
    expect(await establishHostedSession(harness)).toBe(true);
    const order: string[] = [];
    harness.events.addEventListener(hostedInvalidationEvent, () => order.push('stop'));
    harness.replace.mockImplementation(() => { order.push('replace'); });
    storageEvent(harness.events, key, key === hostedResetKey ? 'reset-other' : null, 'member-a');
    expect(order).toEqual(['stop', 'replace']);
    storageEvent(harness.events, hostedUserKey, null, 'member-a');
    expect(harness.replace).toHaveBeenCalledOnce();
  });

  it('ignores unrelated preferences, other storage areas and completed reset removal', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    storageEvent(harness.events, preferenceKey, 'dark');
    storageEvent(harness.events, hostedResetKey, null, 'reset-other');
    storageEvent(harness.events, hostedUserKey, 'member-a', 'member-a');
    storageEvent(harness.events, hostedResetKey, 'reset-other', null, {});
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not commit a switched identity after another tab invalidates the deletion', async () => {
    const harness = sessionHarness();
    harness.fetch.mockResolvedValue(response(principal('member-b')));
    const deletion = deferred<void>();
    harness.deleteDatabase.mockReturnValue(deletion.promise);
    const admission = establishHostedSession(harness);
    await vi.waitFor(() => expect(harness.deleteDatabase).toHaveBeenCalledOnce());
    storageEvent(harness.events, hostedResetKey, 'other-reset');
    deletion.resolve();
    expect(await admission).toBe(false);
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it('rechecks startup on back-forward-cache restoration, including previously invalidated documents', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    storageEvent(harness.events, hostedResetKey, 'other-reset');
    harness.events.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(harness.replace).toHaveBeenCalledTimes(2);
    expect(harness.replace).toHaveBeenLastCalledWith('/');
  });
});

describe('runtime cloud session isolation', () => {
  it('keeps CSRF private, sends it only on writes, and forces bounded same-origin no-store requests', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const states: CloudContext[] = [];
    const unsubscribe = harness.client.subscribe(state => states.push(state));
    harness.fetch.mockImplementation(async () => response({ routines: [] }));
    expect(await harness.client.request('/api/routines?published=true')).toEqual({ routines: [] });
    const read = harness.fetch.mock.calls.at(-1)![1]!;
    expect(new Headers(read.headers).has('X-CSRF-Token')).toBe(false);
    await harness.client.request('/api/routines', {
      method: 'POST', body: '{}', credentials: 'omit', cache: 'force-cache', redirect: 'follow',
      headers: { 'X-CSRF-Token': 'caller-token', 'If-Match': '"1"' },
    });
    const write = harness.fetch.mock.calls.at(-1)![1]!;
    expect(write).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(new Headers(write.headers).get('X-CSRF-Token')).toBe('test-csrf');
    expect(new Headers(write.headers).get('If-Match')).toBe('"1"');
    expect(harness.client.getRole()).toBe('owner');
    expect(JSON.stringify(states)).not.toContain('test-csrf');
    expect([...harness.storage.values.values()].join()).not.toContain('test-csrf');
    states[0]!.user!.id = 'tampered';
    expect(harness.client.getUser()!.id).toBe('member-a');
    unsubscribe();
    expect(parseCloudSession(principal())?.user.id).toBe('member-a');
  });

  it.each([401, 403, 'network'] as const)('changes only cloud status on %s and keeps prepared local identity valid', async failure => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const stopAudio = vi.fn();
    harness.events.addEventListener(hostedInvalidationEvent, stopAudio);
    const assertLocal = harness.client.captureIdentity();
    const stored = new Map(harness.storage.values);
    if (failure === 'network') harness.fetch.mockRejectedValue(new TypeError('offline'));
    else harness.fetch.mockResolvedValue(response(null, failure));
    await expect(harness.client.request('/api/routines')).rejects.toThrow();
    expect(harness.client.getContext().access).toBe(failure === 401 ? 'signin-required' : failure === 403 ? 'forbidden' : 'offline');
    expect(assertLocal).not.toThrow();
    expect(stopAudio).not.toHaveBeenCalled();
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.values).toEqual(stored);
    await expect(harness.client.request('/api/routines')).rejects.toThrow();
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });

  it('reauthenticates explicitly after expiry without changing the local owner or disposing playback', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    harness.fetch.mockResolvedValueOnce(response(null, 401));
    await expect(harness.client.request('/api/routines')).rejects.toMatchObject({ status: 401 });
    harness.fetch.mockResolvedValueOnce(response({ ...principal(), csrfToken: 'refreshed-csrf' }));
    await harness.client.refreshSession();
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(harness.client.request('/api/routines/one', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(new Headers(harness.fetch.mock.calls.at(-1)![1]!.headers).get('X-CSRF-Token')).toBe('refreshed-csrf');
    expect(harness.client.getContext().access).toBe('online');
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('uses no heartbeat and gates an expired session only when a cloud request is attempted', async () => {
    vi.useFakeTimers();
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const assertLocal = harness.client.captureIdentity();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.replace).not.toHaveBeenCalled();
    await expect(harness.client.request('/api/routines')).rejects.toMatchObject({ code: 'signin_required' });
    expect(harness.client.getContext().access).toBe('signin-required');
    expect(assertLocal).not.toThrow();
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it.each(['/api/../signin.html', '/api/auth/logout', '/api/auth/session', '//external.invalid/api/routines',
    'https://external.invalid/api/routines', '/api/\\external.invalid', '/api/routines#fragment'])('rejects unsafe or auth-control helper path %s', async path => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    await expect(harness.client.request(path)).rejects.toMatchObject({ code: 'invalid_cloud_path' });
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it('aborts a caller-cancelled request without invalidating local identity', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const assertLocal = harness.client.captureIdentity();
    const controller = new AbortController();
    harness.fetch.mockReturnValue(new Promise(() => {}));
    const check = expect(harness.client.request('/api/routines', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await check;
    expect(harness.fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    expect(assertLocal).not.toThrow();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('bounds stalled cloud response bodies without navigation or a late state change', async () => {
    vi.useFakeTimers();
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const body = deferred<unknown>();
    harness.fetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: () => body.promise } as Response);
    const check = expect(harness.client.request('/api/routines')).rejects.toMatchObject({ code: 'network_unavailable' });
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUT_MS);
    await check;
    expect(harness.fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    body.resolve({ routines: [] });
    await Promise.resolve();
    expect(harness.client.getContext().access).toBe('offline');
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not revoke cloud access for a routine conflict', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    harness.fetch.mockResolvedValue(response({ error: 'routine_conflict' }, 412));
    await expect(harness.client.request('/api/routines/one', { method: 'PUT' })).rejects.toMatchObject({ status: 412 });
    expect(harness.client.getContext().access).toBe('online');
  });

  it('rejects late response bodies and download commit guards after another tab resets identity', async () => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const assertCommit = harness.client.captureIdentity();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    harness.fetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json } as unknown as Response);
    const pending = harness.client.request('/api/routines');
    const check = expect(pending).rejects.toMatchObject({ code: 'session_changed' });
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    storageEvent(harness.events, hostedResetKey, 'logout:other-tab');
    body.resolve({ routines: ['previous-account'] });
    await check;
    expect(assertCommit).toThrow('session_changed');
    expect(harness.client.getUser()).toBeNull();
  });

  it.each([principal('member-b'), principal('member-a', 'owner', 2)])('blocks another cloud identity without navigating or invalidating playback on refresh', async session => {
    const harness = sessionHarness();
    await establishHostedSession(harness);
    const stopAudio = vi.fn();
    harness.events.addEventListener(hostedInvalidationEvent, stopAudio);
    harness.fetch.mockResolvedValue(response(session));
    await expect(harness.client.refreshSession()).rejects.toMatchObject({ code: 'session_changed' });
    expect(stopAudio).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
    expect(harness.client.getUser()?.id).toBe('member-a');
    expect(harness.client.getContext().access).toBe('signin-required');
  });
});

describe('hosted IndexedDB deletion', () => {
  it('deletes only the app database and waits for success', async () => {
    const { database } = databaseHarness();
    await expect(deleteHostedDatabase(database)).resolves.toBeUndefined();
    expect(database.deleteDatabase).toHaveBeenCalledExactlyOnceWith(hostedDatabase);
  });

  it.each(['blocked', 'error'] as const)('rejects deletion on %s', async outcome => {
    const { database } = databaseHarness(outcome);
    await expect(deleteHostedDatabase(database)).rejects.toMatchObject({ code: 'hostedCleanupFailed' });
  });

  it('rejects a deletion that never settles', async () => {
    vi.useFakeTimers();
    const { database } = databaseHarness('pending');
    const check = expect(deleteHostedDatabase(database)).rejects.toMatchObject({ code: 'hostedCleanupFailed' });
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
  });
});

describe('hosted bootstrap ordering and local compatibility', () => {
  function rootElement(): HTMLElement {
    const make = () => ({ textContent: '', className: '', setAttribute: vi.fn(), removeAttribute: vi.fn(),
      replaceChildren: vi.fn(), append: vi.fn() });
    vi.stubGlobal('document', { createElement: make });
    return make() as unknown as HTMLElement;
  }

  it('keeps local builds independent of the hosted session check', async () => {
    vi.stubEnv('VITE_HOSTED_PILOT', 'false');
    const root = rootElement();
    const load = vi.fn().mockResolvedValue(undefined);
    const session = vi.fn().mockResolvedValue(false);
    await startApplication(root, true, load, undefined, session);
    expect(load).toHaveBeenCalledOnce();
    expect(session).not.toHaveBeenCalled();
  });

  it('does not load main before the hosted admission resolves', async () => {
    const root = rootElement();
    const load = vi.fn().mockResolvedValue(undefined);
    const pending = deferred<boolean>();
    const boot = startApplication(root, true, load, true, () => pending.promise);
    expect(load).not.toHaveBeenCalled();
    expect(root.textContent).toBe(t('hostedChecking'));
    pending.resolve(true);
    await boot;
    expect(load).toHaveBeenCalledOnce();
    expect(root.removeAttribute).toHaveBeenCalledWith('role');
  });

  it('does not load main for redirects, cleanup failures or insecure origins', async () => {
    const root = rootElement();
    const load = vi.fn().mockResolvedValue(undefined);
    await startApplication(root, true, load, true, async () => false);
    await startApplication(root, true, load, true, async () => { throw new HostedSessionError('hostedCleanupFailed'); });
    expect(root.replaceChildren).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ textContent: t('hostedCleanupFailed') }));
    const session = vi.fn().mockResolvedValue(true);
    await startApplication(root, false, load, true, session);
    expect(session).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

interface SignoutDependencies {
  storage: HostedSessionDependencies['storage'];
  cacheStorage: Pick<CacheStorage, 'keys' | 'delete'>;
  database: Pick<IDBFactory, 'deleteDatabase'>;
  replace: (url: string) => void;
  resetId: () => string;
  fetch: typeof fetch;
  events?: Pick<EventTarget, 'dispatchEvent'>;
  retireWorkers?: () => Promise<void>;
  timeoutMs?: number;
}
const signoutModulePath = '../frontend/public/signout.js';
const signout = await import(signoutModulePath) as {
  signoutKeys: { user: string; reset: string; preferences: string };
  logoutUrl: string;
  purgeHostedSession: (dependencies: SignoutDependencies) => Promise<void>;
  startSignOutPage: (owner: Pick<Document, 'getElementById'>) => void;
};

interface SignInDependencies {
  username: string;
  password: string;
  fetch: typeof fetch;
  storage: HostedSessionDependencies['storage'];
  replace: (url: string) => void;
  resetId: () => string;
  timeoutMs?: number;
}
const signinModulePath = '../frontend/public/signin.js';
const signin = await import(signinModulePath) as {
  createAccessFeedback: (status: { textContent: string }, owner: EventTarget, platform: EventTarget) => {
    active: boolean; show(text: string, error?: boolean): void; dispose(): void;
  };
  accessKeys: typeof signout.signoutKeys;
  signIn: (dependencies: SignInDependencies) => Promise<void>;
  startSignInPage: (owner: Pick<Document, 'getElementById'>, platform: object) => void;
};

describe('access page feedback deadlines', () => {
  afterEach(() => vi.useRealTimers());
  it('expires on background return, preserves replacement deadlines and disposes on page hide', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const owner = new EventTarget(); const platform = new EventTarget(); const status = { textContent: '' };
    const feedback = signin.createAccessFeedback(status, owner, platform);
    feedback.show('First', true); vi.setSystemTime(20000); feedback.show('Second', true);
    vi.setSystemTime(32000); owner.dispatchEvent(new Event('visibilitychange')); expect(status.textContent).toBe('Second');
    vi.setSystemTime(51000); owner.dispatchEvent(new Event('visibilitychange')); expect(status.textContent).toBe('');
    feedback.show('Third', true); platform.dispatchEvent(new Event('pagehide'));
    expect(vi.getTimerCount()).toBe(0); expect(feedback.active).toBe(false);
    feedback.show('Late rejection', true); expect(status.textContent).toBe('Third'); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears an expired error when a back-forward cached page resumes', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const owner = new EventTarget(); const platform = new EventTarget(); const status = { textContent: '' };
    const feedback = signin.createAccessFeedback(status, owner, platform); feedback.show('Error', true);
    platform.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(vi.getTimerCount()).toBe(0); vi.setSystemTime(32000); platform.dispatchEvent(new Event('pageshow'));
    expect(status.textContent).toBe(''); expect(feedback.active).toBe(true); feedback.dispose();
  });
});

function signinHarness(previous: string | null = marker()) {
  return {
    username: 'instructor', password: 'test-password', storage: memoryStorage(previous),
    fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
    replace: vi.fn<(url: string) => void>(), resetId: () => 'signin-test',
  };
}

class SigninBlobStore implements BlobStore {
  readonly blobs = new Map<string, StoredBlob>();
  private sequence = 0;
  async get(key: string, maximum: number): Promise<StoredBlob | null> {
    const blob = this.blobs.get(key);
    if (!blob) return null;
    if (blob.bytes.length > maximum) throw new Error('oversized_fixture');
    return { bytes: Buffer.from(blob.bytes), etag: blob.etag };
  }
  async put(key: string, bytes: Buffer, expected: string | null): Promise<string> {
    const old = this.blobs.get(key);
    if (expected === null ? !!old : old?.etag !== expected) throw new BlobConflict();
    const etag = `"${++this.sequence}"`;
    this.blobs.set(key, { bytes: Buffer.from(bytes), etag });
    return etag;
  }
  async delete(key: string, expected: string): Promise<void> {
    if (this.blobs.get(key)?.etag !== expected) throw new BlobConflict();
    this.blobs.delete(key);
  }
  async list(prefix: string, limit: number, cursor?: string) {
    const keys = [...this.blobs.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    return { keys: keys.slice(start, start + limit), cursor: keys.length > start + limit ? String(start + limit) : undefined };
  }
}

function cookieApi(passwordHash: string) {
  const accounts: Account[] = [
    { id: 'member-a', username: 'instructor', passwordHash, role: 'owner', enabled: true, authVersion: 1 },
    { id: 'member-b', username: 'second', passwordHash, role: 'editor', enabled: true, authVersion: 1 },
  ];
  const origin = 'https://example.invalid';
  const env = () => ({ FIM_ORIGIN: origin, FIM_ACCOUNTS_JSON: JSON.stringify(accounts),
    FIM_STORAGE_CONTAINER: 'private-media',
    FIM_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.alloc(64).toString('base64')};EndpointSuffix=core.windows.net`,
  });
  let now = Date.now();
  let cookie = '';
  const api = new CloudApi(new SigninBlobStore(), env, () => now);
  const replies: Array<{ path: string; status: number }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const path = String(input);
    const method = options?.method ?? 'GET';
    const headers = new Headers(options?.headers);
    headers.set('sec-fetch-site', 'same-origin');
    if (method !== 'GET') headers.set('origin', origin);
    if (options?.credentials !== 'omit' && cookie) headers.set('cookie', cookie);
    const bytes = options?.body === undefined ? null : Buffer.from(String(options.body));
    const result = await api.handle({ method, url: new URL(path, origin).href, headers,
      body: bytes === null ? null : new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    });
    if (result.headers['set-cookie']) cookie = result.headers['set-cookie'].split(';')[0]!;
    replies.push({ path, status: result.status });
    return new Response(typeof result.body === 'string' ? result.body : new Uint8Array(result.body), result);
  });
  return { fetch: fetcher, accounts, replies, cookie: () => cookie,
    setCookie: (value: string) => { cookie = value; }, advance: (ms: number) => { now += ms; } };
}

describe('sign-in with real CloudApi handler and synthetic cookie/Blob stores', () => {
  const password = 'synthetic-test-password';
  let passwordHash: string;
  let changedPasswordHash: string;
  beforeAll(async () => {
    const salt = Buffer.alloc(16, 7);
    passwordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword(password, salt)).toString('hex')}`;
    changedPasswordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword('changed-test-password', salt)).toString('hex')}`;
  });

  async function admittedCookie() {
    const jar = cookieApi(passwordHash);
    const login = await jar.fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'instructor', password }) });
    expect(login.status).toBe(200);
    const harness = { ...sessionHarness(), fetch: jar.fetch, client: createCloudClient({ fetch: jar.fetch }) };
    const stopAudio = vi.fn();
    harness.events.addEventListener(hostedInvalidationEvent, stopAudio);
    expect(await establishHostedSession(harness)).toBe(true);
    jar.fetch.mockClear();
    jar.replies.length = 0;
    return { ...harness, jar, stopAudio, username: 'instructor', password };
  }

  it('rejects cookie login without CSRF, then accepts GET-CSRF/login without resetting or purging the same account', async () => {
    const harness = await admittedCookie();
    const originalCookie = harness.jar.cookie();
    const rejected = await harness.fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: harness.username, password }) });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'csrf_invalid' });
    harness.jar.replies.length = 0;
    const assertLocal = harness.client.captureIdentity();
    await signin.signIn(harness);
    expect(harness.jar.replies).toEqual([{ path: '/api/auth/session', status: 200 }, { path: '/api/auth/login', status: 200 }]);
    expect(harness.jar.cookie()).not.toBe(originalCookie);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.stopAudio).not.toHaveBeenCalled();
    expect(assertLocal).not.toThrow();
    expect(await establishHostedSession({ ...harness, client: createCloudClient({ fetch: harness.fetch }),
      events: new EventTarget() as HostedSessionDependencies['events'] })).toBe(true);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.storage.values).toEqual(new Map([[hostedUserKey, marker()]]));
    const current = parseCloudSession(await (await harness.fetch('/api/auth/session', { credentials: 'same-origin' })).json())!;
    const writes = JSON.stringify(harness.storage.setItem.mock.calls);
    expect(writes).not.toContain(current.csrfToken);
    expect(writes).not.toContain(harness.jar.cookie());
  });

  it('keeps a valid cookie, active local identity and next-startup data after a wrong-password attempt', async () => {
    const harness = await admittedCookie();
    const originalCookie = harness.jar.cookie();
    const assertLocal = harness.client.captureIdentity();
    await expect(signin.signIn({ ...harness, password: 'incorrect-test-password' })).rejects.toMatchObject({ status: 401 });
    expect(harness.jar.replies).toEqual([{ path: '/api/auth/session', status: 200 }, { path: '/api/auth/login', status: 401 }]);
    expect(harness.jar.cookie()).toBe(originalCookie);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.storage.removeItem).not.toHaveBeenCalled();
    expect(harness.stopAudio).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(assertLocal).not.toThrow();
    expect(await establishHostedSession({ ...harness, events: new EventTarget() as HostedSessionDependencies['events'] })).toBe(true);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
  });

  it('stops at offline GET session without attempting login or disturbing an admitted class', async () => {
    const harness = await admittedCookie();
    const originalCookie = harness.jar.cookie();
    const assertLocal = harness.client.captureIdentity();
    harness.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await expect(signin.signIn(harness)).rejects.toThrow('offline');
    expect(harness.fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/session', expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store',
    }));
    expect(harness.jar.cookie()).toBe(originalCookie);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.stopAudio).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(assertLocal).not.toThrow();
  });

  it.each(['expired', 'unknown', 'username', 'passwordHash'] as const)(
    'reauthenticates after %s invalidates the cookie without resetting unchanged stable admission', async change => {
      const harness = await admittedCookie();
      if (change === 'expired') harness.jar.advance(LIMITS.sessionMs);
      if (change === 'unknown') harness.jar.setCookie(`${COOKIE_NAME}=${'a'.repeat(43)}`);
      if (change === 'username') harness.jar.accounts[0]!.username = harness.username = 'renamed-instructor';
      if (change === 'passwordHash') {
        harness.jar.accounts[0]!.passwordHash = changedPasswordHash;
        harness.password = 'changed-test-password';
      }
      const assertLocal = harness.client.captureIdentity();
      await signin.signIn(harness);
      expect(harness.jar.replies).toEqual([{ path: '/api/auth/session', status: 401 }, { path: '/api/auth/login', status: 200 }]);
      expect(new Headers(harness.fetch.mock.calls[1]![1]!.headers).has('X-CSRF-Token')).toBe(false);
      expect(harness.storage.setItem).not.toHaveBeenCalled();
      expect(harness.storage.removeItem).not.toHaveBeenCalled();
      expect(harness.stopAudio).not.toHaveBeenCalled();
      expect(assertLocal).not.toThrow();
      expect(await establishHostedSession({ ...harness, events: new EventTarget() as HostedSessionDependencies['events'] })).toBe(true);
      expect(harness.deleteDatabase).not.toHaveBeenCalled();
    });

  it('marks a successful switch before redirect and rejects an old offline write even before cross-tab event delivery', async () => {
    const harness = await admittedCookie();
    const originalCookie = harness.jar.cookie();
    vi.stubEnv('VITE_HOSTED_PILOT', 'true');
    vi.stubGlobal('window', Object.assign(harness.events, { localStorage: harness.storage }));
    const open = vi.fn(() => { throw new Error('old_write_opened_new_database'); });
    vi.stubGlobal('indexedDB', { open });
    vi.resetModules();
    const offline = await import('../frontend/src/offline');
    const began = deferred<void>();
    const hashed = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { began.resolve(); return hashed.promise; });
    const lateWrite = expect(offline.createDemoRoutine()).rejects.toThrow('hosted_session_invalidated');
    await began.promise;
    const assertLocal = harness.client.captureIdentity();
    harness.replace.mockImplementation(url => {
      expect(url).toBe('/');
      expect(harness.jar.cookie()).not.toBe(originalCookie);
      expect(harness.storage.getItem(hostedResetKey)).toBe('switch:reset-test');
      expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
      expect(harness.stopAudio).not.toHaveBeenCalled();
    });
    await signin.signIn({ ...harness, username: 'second' });
    const next = { ...sessionHarness(), storage: harness.storage, fetch: harness.fetch,
      client: createCloudClient({ fetch: harness.fetch }) };
    next.deleteDatabase.mockImplementation(async () => {
      expect(harness.storage.getItem(hostedResetKey)).not.toBeNull();
      expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
    });
    expect(await establishHostedSession(next)).toBe(true);
    expect(next.deleteDatabase).toHaveBeenCalledOnce();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker('member-b', 'editor'));
    expect(harness.storage.getItem(hostedResetKey)).toBeNull();
    hashed.resolve(new ArrayBuffer(32));
    await lateWrite;
    expect(open).not.toHaveBeenCalled();
    harness.replace.mockReset();
    expect(assertLocal).toThrow('session_changed');
    expect(harness.stopAudio).toHaveBeenCalledOnce();
    storageEvent(harness.events, hostedResetKey, 'switch:reset-test');
    expect(harness.stopAudio).toHaveBeenCalledOnce();
    expect(next.client.getUser()?.id).toBe('member-b');
  });
});

describe('public custom sign-in', () => {
  it('gets the current CSRF in memory before login without resetting the same admitted account', async () => {
    const harness = signinHarness();
    harness.fetch.mockImplementation(async () => {
      expect(harness.storage.getItem(hostedResetKey)).toBeNull();
      return response();
    });
    await signin.signIn(harness);
    expect(harness.fetch).toHaveBeenNthCalledWith(1, '/api/auth/session', expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(harness.fetch).toHaveBeenNthCalledWith(2, '/api/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
      body: JSON.stringify({ username: 'instructor', password: 'test-password' }),
    }));
    expect(harness.storage.values).toEqual(new Map([[hostedUserKey, marker()]]));
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.storage.removeItem).not.toHaveBeenCalled();
    expect(harness.replace).toHaveBeenCalledExactlyOnceWith('/');
    expect(signin.accessKeys).toEqual(signout.signoutKeys);
    expect(JSON.stringify(harness.storage.setItem.mock.calls)).not.toMatch(/test-password|test-csrf/);
  });

  it('allows an initial login after session 401 without inventing a CSRF token', async () => {
    const harness = signinHarness(null);
    harness.fetch.mockResolvedValueOnce(response(null, 401));
    await signin.signIn(harness);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(harness.fetch.mock.calls[1]![1]!.headers).has('X-CSRF-Token')).toBe(false);
    expect(harness.storage.getItem(hostedResetKey)).toBe('switch:signin-test');
  });

  it('preserves stable admission when reauthentication changes only username, token and expiry', async () => {
    const harness = signinHarness();
    harness.fetch.mockResolvedValueOnce(response(null, 401)).mockResolvedValueOnce(response({
      ...principal(), user: { ...principal().user, username: 'renamed-instructor' },
      csrfToken: 'new-memory-token', expiresAt: Date.now() + 120_000,
    }));
    await signin.signIn(harness);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.storage.removeItem).not.toHaveBeenCalled();
    expect(harness.replace).toHaveBeenCalledWith('/');
  });

  it.each([principal('member-b'), principal('member-a', 'player'), principal('member-a', 'owner', 2)])(
    'sets the switch guard synchronously before navigation for a changed stable identity %#', async session => {
      const harness = signinHarness();
      harness.fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(session));
      harness.replace.mockImplementation(() => {
        expect(harness.storage.getItem(hostedResetKey)).toBe('switch:signin-test');
        expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
      });
      await signin.signIn(harness);
      expect(harness.storage.setItem).toHaveBeenCalledExactlyOnceWith(hostedResetKey, 'switch:signin-test');
      expect(harness.replace).toHaveBeenCalledOnce();
    });

  it.each([null, marker('previous-account')])('leaves ownership unchanged until startup purges for a new identity: %s', async previous => {
    const harness = signinHarness(previous);
    harness.fetch.mockImplementation(async () => response());
    await signin.signIn(harness);
    expect(harness.storage.getItem(hostedUserKey)).toBe(previous);
    expect(harness.storage.getItem(hostedResetKey)).toBe('switch:signin-test');
    expect(harness.replace).toHaveBeenCalledWith('/');
  });

  it.each([401, 403, 429, 500])('does not reset the account or report success on rejected login HTTP %s', async status => {
    const harness = signinHarness();
    harness.fetch.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ error: 'do_not_display_server_detail' }, status));
    await expect(signin.signIn(harness)).rejects.toMatchObject({ status });
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.storage.removeItem).not.toHaveBeenCalled();
    expect(harness.storage.values).toEqual(new Map([[hostedUserKey, marker()]]));
  });

  it.each(['offline', 'malformed', 403, 500])('stops before login on session GET failure %s without invalidating admission', async failure => {
    const harness = signinHarness();
    if (failure === 'offline') harness.fetch.mockRejectedValue(new TypeError('offline'));
    else harness.fetch.mockResolvedValue(response(null, typeof failure === 'number' ? failure : 200));
    await expect(signin.signIn(harness)).rejects.toThrow();
    expect(harness.fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/session', expect.anything());
    expect(harness.storage.setItem).not.toHaveBeenCalled();
    expect(harness.storage.removeItem).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it.each(['logout:pending', 'signin:pending'])('does not replace the cookie during another account operation: %s', async reset => {
    const harness = signinHarness();
    harness.storage.values.set(hostedResetKey, reset);
    await expect(signin.signIn(harness)).rejects.toThrow('auth_busy');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it.each(['session', 'login'])('does not remove a newer reset or navigate after a stale %s response', async path => {
    const harness = signinHarness();
    const pending = deferred<Response>();
    if (path === 'login') harness.fetch.mockResolvedValueOnce(response());
    harness.fetch.mockReturnValue(pending.promise);
    const check = expect(signin.signIn(harness)).rejects.toThrow('session_changed');
    if (path === 'login') await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(2));
    harness.storage.values.set(hostedResetKey, 'logout:newer');
    pending.resolve(response());
    await check;
    expect(harness.storage.getItem(hostedResetKey)).toBe('logout:newer');
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it.each(['session', 'login'])('times out %s without resetting playback or admitting a late response', async path => {
    vi.useFakeTimers();
    const harness = signinHarness();
    const pending = deferred<Response>();
    if (path === 'login') harness.fetch.mockResolvedValueOnce(response());
    harness.fetch.mockReturnValue(pending.promise);
    const check = expect(signin.signIn(harness)).rejects.toThrow('auth_timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    expect(harness.fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    pending.resolve(response(principal('other-account')));
    await Promise.resolve();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
    expect(harness.storage.getItem(hostedResetKey)).toBeNull();
    expect(harness.storage.setItem).not.toHaveBeenCalled();
  });

  it('does not navigate into the new account when the successful switch cannot be marked', async () => {
    const harness = signinHarness();
    harness.fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(principal('member-b')));
    harness.storage.setItem.mockImplementation(() => { throw new Error('storage_failed'); });
    await expect(signin.signIn(harness)).rejects.toThrow('storage_failed');
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it.each([401, 429])('clears the password, prevents duplicate submissions, and announces a generic error for %s', async statusCode => {
    const harness = signinHarness();
    const element = () => Object.assign(new EventTarget(), {
      value: '', textContent: '', className: '', disabled: true, hidden: true,
      setAttribute: vi.fn(), removeAttribute: vi.fn(), reportValidity: () => true,
    });
    const elements = Object.fromEntries(['signin-form', 'signin-username', 'signin-password',
      'signin-submit', 'signin-status', 'signin-cleanup'].map(id => [id, element()]));
    elements['signin-username']!.value = 'instructor';
    elements['signin-password']!.value = 'test-password';
    const pending = deferred<Response>();
    harness.fetch.mockReturnValue(pending.promise);
    signin.startSignInPage({ getElementById: id => elements[id] as unknown as HTMLElement }, {
      fetch: harness.fetch, localStorage: harness.storage, location: { replace: harness.replace },
      crypto: { randomUUID: harness.resetId },
    });
    const form = elements['signin-form']!;
    const submit = elements['signin-submit']!;
    const status = elements['signin-status']!;
    form.dispatchEvent(new Event('submit'));
    form.dispatchEvent(new Event('submit'));
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(submit.disabled).toBe(true);
    expect(elements['signin-password']!.value).toBe('');
    pending.resolve(response({ error: '<script>private account detail</script>' }, statusCode));
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(status.setAttribute).toHaveBeenLastCalledWith('role', 'alert');
    expect(status.textContent).toBe(statusCode === 429 ? 'Unable to sign in. Please wait before trying again.'
      : 'Unable to sign in. Check your credentials and connection, then try again.');
    expect(status.textContent).not.toContain('private account detail');
    expect(form.removeAttribute).toHaveBeenCalledWith('aria-busy');
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('uses an accessible username/password form and external scripts under a restrictive CSP', () => {
    const page = readFileSync(new URL('../frontend/public/signin.html', import.meta.url), 'utf8');
    expect(page).toContain('autocomplete="username"');
    expect(page).toContain('autocomplete="current-password"');
    expect(page).toContain('type="password"');
    expect(page).toContain('for="signin-username"');
    expect(page).toContain('for="signin-password"');
    expect(page).toContain('type="submit"');
    expect(page).toContain('aria-live="polite"');
    for (const name of ['signin.html', 'signout.html', 'access-denied.html']) {
      const text = readFileSync(new URL(`../frontend/public/${name}`, import.meta.url), 'utf8');
      expect(text).toContain("script-src 'self'");
      expect(text).not.toMatch(/<script(?![^>]*\bsrc=)|\son\w+=|Microsoft|\/\.auth\//i);
    }
  });
});

function signoutHarness(outcome: 'success' | 'blocked' | 'error' | 'pending' = 'success') {
  const storage = memoryStorage();
  storage.values.set(preferenceKey, 'appearance');
  storage.values.set('unrelated-preference', 'keep');
  const names = new Set(['fitness-rehearsal-v1', 'fitness-rehearsal-v2', 'unrelated-app']);
  return {
    fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValue(new Response(null, { status: 204 })),
    storage, names, cacheStorage: {
      keys: vi.fn(async () => [...names]),
      delete: vi.fn(async (name: string) => names.delete(name)),
    },
    database: databaseHarness(outcome).database, replace: vi.fn<(url: string) => void>(),
    resetId: () => 'signout-test',
  };
}

describe('public hosted sign-out purge', () => {
  it('accepts an empty successful logout response without requiring an undocumented JSON body', async () => {
    const harness = signoutHarness();
    harness.fetch.mockReset().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await signout.purgeHostedSession(harness);
    expect(harness.replace).toHaveBeenCalledWith('/signin.html');
  });

  it('invalidates tabs and retires workers before purging, then contacts the server only after local deletion', async () => {
    const harness = signoutHarness();
    const order: string[] = [];
    const events = new EventTarget();
    events.addEventListener(hostedInvalidationEvent, () => order.push('invalidate'));
    const retireWorkers = vi.fn(async () => { order.push('workers'); });
    harness.fetch.mockReset().mockImplementation(async path => {
      expect(harness.database.deleteDatabase).toHaveBeenCalledOnce();
      expect(harness.storage.getItem(hostedUserKey)).toBeNull();
      expect(harness.names).toEqual(new Set(['unrelated-app']));
      order.push(String(path));
      return path === '/api/auth/session' ? response() : new Response(null, { status: 204 });
    });
    await signout.purgeHostedSession({ ...harness, events, retireWorkers });
    expect(order).toEqual(['invalidate', 'workers', '/api/auth/session', '/api/auth/logout']);
  });

  it('still purges when the cookie has already expired and goes only to local sign-in', async () => {
    const harness = signoutHarness();
    harness.fetch.mockReset().mockResolvedValue(response(null, 401));
    await signout.purgeHostedSession(harness);
    expect(harness.database.deleteDatabase).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith('/signin.html');
    expect(harness.storage.getItem(hostedUserKey)).toBeNull();
    expect(harness.storage.getItem(hostedResetKey)).toBeNull();
  });

  it('keeps the reset guard and reports unconfirmed logout when the server is unavailable', async () => {
    const harness = signoutHarness();
    harness.fetch.mockReset().mockRejectedValue(new TypeError('offline'));
    await expect(signout.purgeHostedSession(harness)).rejects.toThrow('server_logout_failed');
    expect(harness.database.deleteDatabase).toHaveBeenCalledOnce();
    expect(harness.storage.getItem(hostedUserKey)).toBeNull();
    expect(harness.storage.getItem(hostedResetKey)).toBe('logout:signout-test');
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not contact logout when worker retirement fails', async () => {
    const harness = signoutHarness();
    await expect(signout.purgeHostedSession({ ...harness, retireWorkers: async () => { throw new Error('worker_timeout'); } })).rejects.toThrow();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.database.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not use a late CSRF response after another account operation takes ownership', async () => {
    const harness = signoutHarness();
    const pending = deferred<Response>();
    harness.fetch.mockReset().mockReturnValue(pending.promise);
    const check = expect(signout.purgeHostedSession(harness)).rejects.toThrow();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledOnce());
    harness.storage.values.set(hostedResetKey, 'signin:other');
    pending.resolve(response());
    await check;
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('shares only the nonsecret app keys with the hosted gate and appearance module', () => {
    expect(signout.signoutKeys).toEqual({ user: hostedUserKey, reset: hostedResetKey, preferences: preferenceKey });
  });

  it('purges app caches, database and preferences before CSRF-protected logout, preserving unrelated data', async () => {
    const harness = signoutHarness();
    harness.replace.mockImplementation(url => {
      expect(url).toBe('/signin.html');
      expect(harness.storage.values).toEqual(new Map([['unrelated-preference', 'keep']]));
      expect(harness.names).toEqual(new Set(['unrelated-app']));
      expect(harness.database.deleteDatabase).toHaveBeenCalledExactlyOnceWith(hostedDatabase);
    });
    await signout.purgeHostedSession(harness);
    expect(harness.storage.setItem).toHaveBeenCalledExactlyOnceWith(hostedResetKey, 'logout:signout-test');
    expect(harness.replace).toHaveBeenCalledExactlyOnceWith(signout.logoutUrl);
    expect(harness.cacheStorage.delete.mock.calls.map(([name]) => name)).toEqual(['fitness-rehearsal-v1', 'fitness-rehearsal-v2']);
    expect(harness.fetch).toHaveBeenNthCalledWith(2, '/api/auth/logout', expect.objectContaining({
      method: 'POST', headers: { 'X-CSRF-Token': 'test-csrf' }, credentials: 'include', cache: 'no-store',
    }));
  });

  it.each(['blocked', 'error'] as const)('keeps the reset marker and never redirects on database %s', async outcome => {
    const harness = signoutHarness(outcome);
    await expect(signout.purgeHostedSession(harness)).rejects.toThrow();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedResetKey)).toBe('logout:signout-test');
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
    expect(harness.storage.getItem(preferenceKey)).toBe('appearance');
  });

  it('does not continue when app cache deletion fails', async () => {
    const harness = signoutHarness();
    harness.cacheStorage.delete.mockResolvedValue(false);
    await expect(signout.purgeHostedSession(harness)).rejects.toThrow('cleanup_failed');
    expect(harness.database.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedResetKey)).toBe('logout:signout-test');
  });

  it('fails closed when a reset broadcast cannot be stored', async () => {
    const harness = signoutHarness();
    harness.storage.setItem.mockImplementation(() => { throw new Error('storage blocked'); });
    await expect(signout.purgeHostedSession(harness)).rejects.toThrow();
    expect(harness.cacheStorage.keys).not.toHaveBeenCalled();
    expect(harness.database.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not resume a database purge after a timed-out cache operation', async () => {
    vi.useFakeTimers();
    const harness = signoutHarness();
    const listing = deferred<string[]>();
    harness.cacheStorage.keys.mockReturnValueOnce(listing.promise);
    const check = expect(signout.purgeHostedSession(harness)).rejects.toThrow('cleanup_timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    listing.resolve(['fitness-rehearsal-v1']);
    await Promise.resolve();
    expect(harness.database.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.cacheStorage.delete).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('does not finish logout if another tab changed the reset marker', async () => {
    const harness = signoutHarness();
    harness.cacheStorage.keys.mockImplementationOnce(async () => {
      harness.storage.values.set(hostedResetKey, 'new-session-reset');
      return [];
    });
    await expect(signout.purgeHostedSession(harness)).rejects.toThrow('session_changed');
    expect(harness.database.deleteDatabase).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.storage.getItem(hostedUserKey)).toBe(marker());
  });

  it('shows a blocked-purge error and retries without prematurely logging out', async () => {
    const harness = signoutHarness('blocked');
    const status = Object.assign(new EventTarget(), { textContent: '', className: '', setAttribute: vi.fn() });
    const retry = Object.assign(new EventTarget(), { hidden: true, focus: vi.fn() });
    const platform = Object.assign(new EventTarget(), {
      localStorage: harness.storage, caches: harness.cacheStorage, indexedDB: harness.database,
      location: { replace: harness.replace }, crypto: { randomUUID: harness.resetId },
      navigator: {},
      fetch: harness.fetch,
    });
    vi.stubGlobal('window', platform);
    signout.startSignOutPage({ getElementById: id =>
      (id === 'signout-status' ? status : retry) as unknown as HTMLElement });
    await vi.waitFor(() => expect(retry.hidden).toBe(false));
    expect(status.setAttribute).toHaveBeenCalledWith('role', 'alert');
    expect(status.textContent).toContain('sign-out has not continued');
    expect(retry.focus).toHaveBeenCalledOnce();
    expect(harness.replace).not.toHaveBeenCalled();
    platform.indexedDB = databaseHarness().database;
    retry.dispatchEvent(new Event('click'));
    expect(retry.hidden).toBe(true);
    await vi.waitFor(() => expect(harness.replace).toHaveBeenCalledExactlyOnceWith(signout.logoutUrl));
  });
});