// Small document store on top of one Supabase table (public.docs).
// Paths are "collection/id". The whole dataset is small, so it is loaded
// once and kept in memory; realtime changes from other devices are merged in.

function mapErr(error) {
  if (!error) return { code: 'unavailable', message: 'Unknown error' };
  const msg = String(error.message || '');
  if (error.code === '42501' || /row-level security|permission/i.test(msg)) {
    return { code: 'invalid_argument', message: msg };
  }
  return { code: 'unavailable', message: msg };
}

const later = (fn) => Promise.resolve().then(fn);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function createDb(supabase, email) {
  const cache = new Map();   // path -> data
  const stamps = new Map();  // path -> ISO time of the version in cache
  const listeners = new Set();

  async function loadAll() {
    const { data, error } = await supabase.from('docs').select('path,data,updated_at');
    if (error) throw mapErr(error);
    const seen = new Set();
    data.forEach((r) => { cache.set(r.path, r.data); stamps.set(r.path, r.updated_at); seen.add(r.path); });
    for (const p of [...cache.keys()]) if (!seen.has(p)) { cache.delete(p); stamps.delete(p); }
  }
  await loadAll();

  const snapDoc = (path) => {
    const d = cache.get(path);
    return { id: path.split('/')[1], exists: d !== undefined, data: () => d, metadata: {} };
  };
  const snapColl = (coll) => {
    const docs = [];
    for (const [p, d] of cache) {
      const [c, id] = p.split('/');
      if (c === coll) docs.push({ id, exists: true, data: () => d, metadata: {} });
    }
    docs.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { docs, size: docs.length, empty: !docs.length, metadata: {} };
  };
  const notify = (path) => {
    const coll = path.split('/')[0];
    listeners.forEach((l) => {
      if (l.type === 'doc' && l.key === path) l.fn(snapDoc(path));
      else if (l.type === 'coll' && l.key === coll) l.fn(snapColl(coll));
    });
  };
  const notifyAll = () => listeners.forEach((l) => l.fn(l.type === 'doc' ? snapDoc(l.key) : snapColl(l.key)));

  supabase
    .channel('docs-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const p = payload.old && payload.old.path;
        if (p && cache.has(p)) { cache.delete(p); stamps.delete(p); notify(p); }
        return;
      }
      const r = payload.new;
      if (!r || !r.path) return;
      const mine = stamps.get(r.path);
      if (mine && r.updated_at && new Date(r.updated_at) < new Date(mine)) return; // older echo
      cache.set(r.path, r.data); stamps.set(r.path, r.updated_at); notify(r.path);
    })
    .subscribe();

  // Catch up after the phone sleeps or the tab is backgrounded.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try { await loadAll(); notifyAll(); } catch { /* keep cached view */ }
  });

  async function put(path, data) {
    const [coll, doc_id] = path.split('/');
    const ts = new Date().toISOString();
    cache.set(path, data); stamps.set(path, ts); later(() => notify(path));
    const { error } = await supabase.from('docs').upsert({ path, coll, doc_id, data, updated_at: ts, updated_by: email });
    if (error) throw mapErr(error);
  }
  async function remove(path) {
    cache.delete(path); stamps.delete(path); later(() => notify(path));
    const { error } = await supabase.from('docs').delete().eq('path', path);
    if (error) throw mapErr(error);
  }

  function doc(path) {
    if (String(path).split('/').length !== 2) throw new TypeError('Document paths look like "collection/id": ' + path);
    return {
      id: path.split('/')[1],
      path,
      get: async () => snapDoc(path),
      set: (data) => put(path, JSON.parse(JSON.stringify(data))),
      update: async (data) => {
        if (!cache.has(path)) throw { code: 'invalid_argument', message: 'Document does not exist' };
        return put(path, { ...cache.get(path), ...JSON.parse(JSON.stringify(data)) });
      },
      delete: () => remove(path),
      onSnapshot(fn) {
        const l = { type: 'doc', key: path, fn };
        listeners.add(l); later(() => listeners.has(l) && fn(snapDoc(path)));
        return () => listeners.delete(l);
      },
    };
  }
  function collection(coll) {
    return {
      path: coll,
      doc: (id) => doc(coll + '/' + (id || newId())),
      add: async (data) => { const d = doc(coll + '/' + newId()); await d.set(data); return d; },
      get: async () => snapColl(coll),
      onSnapshot(fn) {
        const l = { type: 'coll', key: coll, fn };
        listeners.add(l); later(() => listeners.has(l) && fn(snapColl(coll)));
        return () => listeners.delete(l);
      },
    };
  }

  function dump() {
    return [...cache.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, data]) => ({ path, data }));
  }
  async function importDocs(docs) {
    const ts = new Date().toISOString();
    const rows = docs.map(({ path, data }) => {
      const [coll, doc_id] = path.split('/');
      return { path, coll, doc_id, data, updated_at: ts, updated_by: email };
    });
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('docs').upsert(rows.slice(i, i + 200));
      if (error) throw mapErr(error);
    }
    await loadAll(); notifyAll();
  }

  return { doc, collection, dump, importDocs };
}
