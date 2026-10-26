// Web storage that never throws. Storage access can raise SecurityError (blocked site
// data, some privacy modes, sandboxed frames); FileSync must still boot without it.

function wrap(getArea) {
  const area = () => {
    try { return getArea(); } catch { return null; }
  };
  return {
    get(key) {
      try { return area()?.getItem(key) ?? null; } catch { return null; }
    },
    set(key, value) {
      try { area()?.setItem(key, value); } catch { /* not persisted; fine */ }
    },
    remove(key) {
      try { area()?.removeItem(key); } catch { /* ignore */ }
    },
    getJSON(key) {
      const raw = this.get(key);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    setJSON(key, value) {
      this.set(key, JSON.stringify(value));
    },
  };
}

export const local = wrap(() => window.localStorage);
export const session = wrap(() => window.sessionStorage);
