import { localApi } from './local-api.js';

async function call(path, body) {
  const res = await fetch(`/api${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const serverApi = {
  meta: () => call('/meta'),
  simulate: (opts) => call('/simulate', opts),
  batch: (opts) => call('/batch', opts),
  train: (opts) => call('/train', opts),
};

// Static builds (VITE_STATIC=1) always run in the browser; otherwise use the Node
// server when it is reachable and fall back to the in-browser engine.
async function detect() {
  if (import.meta.env.VITE_STATIC === '1') return localApi;
  try {
    const res = await fetch('/api/health');
    if (res.ok && (await res.json()).ok) return serverApi;
  } catch { /* no server */ }
  return localApi;
}

const backend = detect();

export const api = {
  meta: async () => (await backend).meta(),
  simulate: async (opts) => (await backend).simulate(opts),
  batch: async (opts) => (await backend).batch(opts),
  train: async (opts) => (await backend).train(opts),
};
