// Reuse an exact recovery copy, including archives written by earlier releases.
// The protected primary autosave is never a write target here.
export function archiveOriginal(storage, key, raw) {
  const prefix = key + '-original-';
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (name?.startsWith(prefix) && storage.getItem(name) === raw) return;
  }
  let stamp = Date.now();
  while (storage.getItem(prefix + stamp) !== null) stamp++;
  storage.setItem(prefix + stamp, raw);
}
