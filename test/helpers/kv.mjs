/** Minimal stand-in for a Workers KV namespace: values plus per-key metadata. */
export function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) {
      const e = store.get(key);
      if (!e) return null;
      return type === 'json' ? JSON.parse(e.value) : e.value;
    },
    async put(key, value, opts = {}) { store.set(key, { value, metadata: opts.metadata ?? null }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, e]) => ({ name, metadata: e.metadata ?? undefined }));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const end = start + page.length;
      return { keys: page, list_complete: end >= all.length, cursor: String(end) };
    },
  };
}
