// Platform facade (architecture §2): storage, haptics, lifecycle. Web first;
// Capacitor bridges get injected here without touching sim/render/ui.

export interface Platform {
  storage: {
    get<T>(key: string): T | null;
    set<T>(key: string, value: T): void;
  };
  haptics: { impact(): void };
  lifecycle: { onPause(cb: () => void): void };
}

const web: Platform = {
  storage: {
    get<T>(key: string): T | null {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    set<T>(key: string, value: T): void {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked — ignore */
      }
    },
  },
  haptics: {
    impact(): void {
      try {
        navigator.vibrate?.(10);
      } catch {
        /* no vibrator */
      }
    },
  },
  lifecycle: {
    onPause(cb: () => void): void {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) cb();
      });
    },
  },
};

export const platform: Platform = web;
