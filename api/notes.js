// Smoke Cartel — shared corkboard API (Vercel Edge Function + Vercel Blob)
// Notes live in ONE JSON blob: corkboard/notes.json — server-side, shared by everyone with the link.
// GET  /api/notes -> { notes: [...] }   POST /api/notes { name, text } -> { ok, note }
export const config = { runtime: 'edge' };

const PATHNAME = 'corkboard/notes.json';
const API = 'https://blob.vercel-storage.com';
const MAX_NOTES = 300;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function readNotes(token) {
  const listRes = await fetch(`${API}?prefix=corkboard/&limit=10`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) return [];
  const list = await listRes.json();
  const blob = (list.blobs || []).find((b) => b.pathname === PATHNAME);
  if (!blob) return [];
  const res = await fetch(blob.url, { headers: { 'cache-control': 'no-store' } });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    return Array.isArray(data.notes) ? data.notes : [];
  } catch {
    return [];
  }
}

async function writeNotes(token, notes) {
  const payload = JSON.stringify({ notes });
  const put = () =>
    fetch(`${API}/${PATHNAME}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
      },
      body: payload,
    });
  let res = await put();
  if (!res.ok) {
    // Fallback for stores where overwrite needs a delete first.
    await fetch(`${API}/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [`${API}/${PATHNAME}`] }),
    }).catch(() => {});
    res = await put();
  }
  return res.ok;
}

export default async function handler(req) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return json({ error: 'board storage not configured' }, 500);
  try {
    if (req.method === 'GET') {
      const notes = await readNotes(token);
      return json({ notes });
    }
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || '').trim().slice(0, 40);
      const text = String(body.text || '').trim().slice(0, 500);
      if (!name || !text) return json({ error: 'name and note are both required' }, 400);
      const notes = await readNotes(token);
      const note = { id: crypto.randomUUID(), name, text, ts: Date.now() };
      notes.push(note);
      while (notes.length > MAX_NOTES) notes.shift();
      const ok = await writeNotes(token, notes);
      if (!ok) return json({ error: 'could not save the note' }, 502);
      return json({ ok: true, note });
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'board error' }, 500);
  }
}
