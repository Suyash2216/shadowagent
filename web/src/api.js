async function call(path, body) {
  const res = await fetch(`/api${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  meta: () => call('/meta'),
  simulate: (opts) => call('/simulate', opts),
  batch: (opts) => call('/batch', opts),
  train: (opts) => call('/train', opts),
};
