/**
 * At most one send per key per window, the last change always included: the
 * first change for a key is sent at once (the caller sends it) and opens a
 * window of `everyMs`. Changes within the window are only noted, with what
 * they carry; if there were any, one more send goes out at the end of the
 * window (`sendTrailing`, with everything noted), and that send opens the
 * next window. So a burst costs two sends, and the state as it is at the
 * end of the burst always goes out.
 */
export class KeyedThrottle<K, T = never> {
  private windows = new Map<K, { timer: NodeJS.Timeout; pending: boolean; noted: Set<T> }>();

  constructor(
    private readonly everyMs: number,
    /** The send at the end of a window that had changes. Must not throw. */
    private readonly sendTrailing: (key: K, noted: T[]) => void
  ) {}

  /**
   * A change for `key`. Returns true when the caller is to send it now (no
   * window was open: one is now). Otherwise `items` are kept for the send at
   * the end of the window, and it returns false.
   */
  hit(key: K, items: readonly T[] = []): boolean {
    const window = this.windows.get(key);
    if (window) {
      window.pending = true;
      for (const item of items) window.noted.add(item);
      return false;
    }
    this.open(key);
    return true;
  }

  /** Drops every open window; changes noted in them are never sent. */
  stop(): void {
    for (const { timer } of this.windows.values()) clearTimeout(timer);
    this.windows.clear();
  }

  private open(key: K): void {
    const timer = setTimeout(() => {
      const window = this.windows.get(key);
      this.windows.delete(key);
      if (!window?.pending) return;
      // The trailing send opens the next window
      this.open(key);
      this.sendTrailing(key, [...window.noted]);
    }, this.everyMs);
    timer.unref();
    this.windows.set(key, { timer, pending: false, noted: new Set() });
  }
}
