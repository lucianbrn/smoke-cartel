// Smoke Cartel — live shelf / inventory checker API (Vercel Edge Function + Vercel Blob)
// Public:  GET  /api/inventory -> { items: [{ id, name, detail, price, state }] }
//          state: "planned" (on the opening order, not stocked yet) | "in" | "out"
// Partners: POST /api/inventory { key, action: "set", id, state } | { key, action: "add", name, detail, price } | { key, action: "remove", id }
// Every change is an immutable event blob (shelf/events/<ts>-<uuid>.json) — append-only, latest event wins.
// Custom items live at shelf/items/<id>.json. Nothing ever overwrites.
export const config = { runtime: 'edge' };

const API = 'https://blob.vercel-storage.com';
const SEED = [
  { id: 'raw-organic',    name: 'RAW Organic 1¼ Papers',          detail: '24-pack display · 50 leaves per pack',        price: '$1.99 per pack' },
  { id: 'raw-connoisseur',name: 'RAW Connoisseur 1¼ Papers + Tips', detail: '24-pack display · papers with tips',        price: '$2.99 per pack' },
  { id: 'raw-tips',       name: 'RAW Original Filter Tips',       detail: '50 retail packs per display · 50 tips per pack', price: '$0.99 per pack' },
  { id: 'clipper',        name: 'Clipper Classic Large Lighter',  detail: '48-piece display · refillable',               price: '$2.00 each' },
  { id: 'grav-bodega',    name: 'GRAV Bodega Spoon · 4″',         detail: 'Single glass piece',                          price: '$9.99 each' },
  { id: 'grav-grinder',   name: 'GRAV Hemp-Plastic Grinder · 2.5″', detail: '2-piece grinder',                           price: '$4.99 each' },
];

const sha256 = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function listBlobs(token, prefix) {
  const out = [];
  let cursor;
  do {
    const url = `${API}?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json();
    out.push(...(data.blobs || []));
    cursor = data.hasMore ? data.cursor : undefined;
  } while (cursor);
  return out;
}

async function readJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function putBlob(token, pathname, obj) {
  const res = await fetch(`${API}/${pathname}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'x-content-type': 'application/json', 'x-add-random-suffix': '0' },
    body: JSON.stringify(obj),
  });
  return res.ok;
}

async function computeShelf(token) {
  const [itemBlobs, eventBlobs] = await Promise.all([
    listBlobs(token, 'shelf/items/'),
    listBlobs(token, 'shelf/events/'),
  ]);
  const custom = [];
  await Promise.all(itemBlobs.map(async (b) => {
    const it = await readJson(b.url);
    if (it && it.id && it.name) custom.push({ id: it.id, name: it.name, detail: it.detail || '', price: it.price || '', custom: true });
  }));
  const events = [];
  await Promise.all(eventBlobs.map(async (b) => {
    const ev = await readJson(b.url);
    if (ev && ev.id && ev.ts) events.push(ev);
  }));
  events.sort((a, b) => a.ts - b.ts);
  const state = new Map();   // id -> state
  const removed = new Set();
  for (const ev of events) {
    if (ev.action === 'set' && ['planned', 'in', 'out'].includes(ev.state)) state.set(ev.id, ev.state);
    if (ev.action === 'remove') removed.add(ev.id);
    if (ev.action === 'restore') removed.delete(ev.id);
  }
  const all = [...SEED, ...custom].filter((i) => !removed.has(i.id));
  return all.map((i) => ({ ...i, state: state.get(i.id) || 'planned' }));
}

export default async function handler(req) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return json({ error: 'inventory storage not configured' }, 500);
  try {
    if (req.method === 'GET') {
      return json({ items: await computeShelf(token) });
    }
    if (req.method === 'POST') {
      const expected = process.env.INVENTORY_ADMIN_KEY_SHA256;
      if (!expected) return json({ error: 'partner key not configured' }, 500);
      const body = await req.json().catch(() => ({}));
      if (!body.key || (await sha256(String(body.key))) !== expected) {
        return json({ error: 'wrong partner key' }, 403);
      }
      const ts = Date.now();
      const stamp = `${ts}-${crypto.randomUUID()}`;
      if (body.action === 'set') {
        const id = String(body.id || '');
        const state = String(body.state || '');
        if (!id || !['planned', 'in', 'out'].includes(state)) return json({ error: 'bad set request' }, 400);
        const ok = await putBlob(token, `shelf/events/${stamp}.json`, { action: 'set', id, state, ts });
        return ok ? json({ ok: true }) : json({ error: 'save failed' }, 502);
      }
      if (body.action === 'add') {
        const name = String(body.name || '').trim().slice(0, 80);
        const detail = String(body.detail || '').trim().slice(0, 120);
        const price = String(body.price || '').trim().slice(0, 30);
        if (!name) return json({ error: 'item needs a name' }, 400);
        const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
        const ok = await putBlob(token, `shelf/items/${id}.json`, { id, name, detail, price });
        if (!ok) return json({ error: 'save failed' }, 502);
        await putBlob(token, `shelf/events/${stamp}.json`, { action: 'set', id, state: 'in', ts });
        return json({ ok: true, id });
      }
      if (body.action === 'remove') {
        const id = String(body.id || '');
        if (!id) return json({ error: 'bad remove request' }, 400);
        const ok = await putBlob(token, `shelf/events/${stamp}.json`, { action: 'remove', id, ts });
        return ok ? json({ ok: true }) : json({ error: 'save failed' }, 502);
      }
      return json({ error: 'unknown action' }, 400);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'inventory error' }, 500);
  }
}
