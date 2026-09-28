interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockHost {
  readonly wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export function createScreenWakeLock(host: WakeLockHost | undefined, owner: Document) {
  let wanted = false;
  let disposed = false;
  let pending = false;
  let sentinel: WakeLockSentinelLike | null = null;
  const release = () => {
    const lock = sentinel;
    sentinel = null;
    if (lock && !lock.released) void lock.release().catch(() => {});
  };
  const acquire = async () => {
    const api = host?.wakeLock;
    if (!wanted || disposed || pending || sentinel || !api || owner.visibilityState === 'hidden') return;
    pending = true;
    try {
      const lock = await api.request('screen');
      if (!wanted || disposed) { void lock.release().catch(() => {}); return; }
      sentinel = lock;
      lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
    } catch {
      // Denied (for example iOS Low Power Mode); retried the next time the page becomes visible.
    } finally { pending = false; }
  };
  const visibility = () => { if (owner.visibilityState !== 'hidden') void acquire(); };
  owner.addEventListener('visibilitychange', visibility);
  return {
    set(active: boolean): void {
      if (disposed || wanted === active) return;
      wanted = active;
      if (active) void acquire(); else release();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; wanted = false;
      owner.removeEventListener('visibilitychange', visibility);
      release();
    },
  };
}
