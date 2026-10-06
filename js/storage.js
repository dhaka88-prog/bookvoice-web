/* STORAGE: the app's bookshelf inside your browser (IndexedDB).
   Three drawers: books (library info), content (full text), progress (where you stopped).
   Everything stays on this device. Nothing is uploaded anywhere. */

const DB = (() => {
  let dbPromise = null;
  let memory = null;   // fallback if the browser blocks storage (private mode etc.)

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      const fail = () => { memory = { books: {}, content: {}, progress: {} }; resolve(null); };
      let req;
      try { req = indexedDB.open('bookvoice-web', 1); } catch { return fail(); }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['books', 'content', 'progress']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = fail;
      req.onblocked = fail;
    });
    return dbPromise;
  }

  async function run(store, mode, fn, memFn) {
    const db = await open();
    if (!db) return memFn(memory[store]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const s = tx.objectStore(store);
      let result;
      const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage is full or blocked.'));
    });
  }

  return {
    async isPersistent() { await open(); return !memory; },
    get: (store, id) => run(store, 'readonly', (s) => s.get(id), (m) => m[id]),
    all: (store) => run(store, 'readonly', (s) => s.getAll(), (m) => Object.values(m)),
    put: (store, value) => run(store, 'readwrite', (s) => s.put(value), (m) => { m[value.id] = value; }),
    del: (store, id) => run(store, 'readwrite', (s) => s.delete(id), (m) => { delete m[id]; })
  };
})();

/* A fingerprint of the file's bytes, used to spot the same book added twice. */
function fingerprint(bytes) {
  const data = new Uint8Array(bytes);
  let h1 = 0xdeadbeef ^ data.length, h2 = 0x41c6ce57 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'b' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + data.length.toString(16);
}

/* Small settings (speed, voice, theme) live in localStorage. */
const Settings = (() => {
  const defaults = { rate: 1.0, voiceByLang: {}, offlineOnly: false, readFootnotes: false, announceTables: true,
    textSize: 19, theme: 'auto', lastBookId: null };
  let data = { ...defaults };
  try { Object.assign(data, JSON.parse(localStorage.getItem('bookvoice.web.settings') || '{}')); } catch { /* ignore */ }
  return {
    get: (k) => data[k],
    set(k, v) { data[k] = v; try { localStorage.setItem('bookvoice.web.settings', JSON.stringify(data)); } catch { /* ignore */ } }
  };
})();
