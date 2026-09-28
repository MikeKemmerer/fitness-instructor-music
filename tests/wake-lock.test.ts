import { describe, expect, it, vi } from 'vitest';
import { createScreenWakeLock } from '../frontend/src/wake-lock';

class FakeSentinel extends EventTarget {
  released = false;
  release = vi.fn(async () => { this.released = true; this.dispatchEvent(new Event('release')); });
  addEventListener(type: 'release', listener: () => void) { super.addEventListener(type, listener); }
}

function setup() {
  const owner = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async (_type: 'screen') => { const lock = new FakeSentinel(); sentinels.push(lock); return lock; });
  const lock = createScreenWakeLock({ wakeLock: { request } }, owner as unknown as Document);
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const setVisibility = (state: DocumentVisibilityState) => { owner.visibilityState = state; owner.dispatchEvent(new Event('visibilitychange')); };
  return { lock, request, sentinels, flush, setVisibility };
}

describe('screen wake lock', () => {
  it('holds a screen lock only while active and releases it on exit', async () => {
    const { lock, request, sentinels, flush } = setup();
    lock.set(true); lock.set(true);
    await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('screen');
    lock.set(false);
    expect(sentinels[0]!.release).toHaveBeenCalledOnce();
  });

  it('re-acquires after the system drops the lock when the app returns to the foreground', async () => {
    const { lock, request, sentinels, flush, setVisibility } = setup();
    lock.set(true); await flush();
    setVisibility('hidden');
    await sentinels[0]!.release();
    await flush();
    expect(request).toHaveBeenCalledOnce();
    setVisibility('visible'); await flush();
    expect(request).toHaveBeenCalledTimes(2);
    lock.set(false);
    setVisibility('hidden'); setVisibility('visible'); await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases a lock that resolves after class mode already ended, and survives denial or missing support', async () => {
    const { lock, request, sentinels, flush } = setup();
    lock.set(true); lock.set(false); await flush();
    expect(sentinels[0]!.release).toHaveBeenCalledOnce();
    request.mockRejectedValueOnce(new Error('NotAllowedError'));
    lock.set(true); await flush();
    lock.dispose(); lock.set(true); await flush();
    expect(request).toHaveBeenCalledTimes(2);
    const owner = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const unsupported = createScreenWakeLock({}, owner as unknown as Document);
    expect(() => { unsupported.set(true); unsupported.set(false); unsupported.dispose(); }).not.toThrow();
  });
});
