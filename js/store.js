let dbP = null;
function db() {
  return dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('softcam', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('media', mode); const s = t.objectStore('media'); const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); };
export const putItem = it => tx('readwrite', s => s.put(it));
export const delItem = id => tx('readwrite', s => s.delete(id));
export const getItem = id => tx('readonly', s => s.get(id));
export async function listMeta() {
  const d = await db();
  return new Promise((res, rej) => {
    const out = [], t = d.transaction('media', 'readonly');
    t.objectStore('media').openCursor().onsuccess = e => {
      const c = e.target.result; if (!c) return;
      const { id, t: ts, type, thumb, live, w, h, dur, model } = c.value;
      out.push({ id, t: ts, type, thumb, live: !!live, w, h, dur, model }); c.continue();
    };
    t.oncomplete = () => res(out.sort((a, b) => a.t - b.t)); t.onerror = () => rej(t.error);
  });
}
export async function persist() { try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { } }
