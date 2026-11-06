// Smoke Cartel — shared corkboard API (Vercel Edge Function + Vercel Blob)
// Each note is its OWN immutable blob: corkboard/notes/<ts>-<id>.json
// (append-only: no overwrites, so no note can be lost to a stale read or a race).
// A legacy single-file board (corkboard/notes.json) is merged in if present.
// GET  /api/notes -> { notes: [...] }   POST /api/notes { name, text } -> { ok, note }
export const config = { runtime: 'edge' };

const API = 'https://blob.vercel-storage.com';
const LEGACY_PATH = 'corkboard/notes.json';
const NOTES_PREFIX = 'corkboard/notes/';
const MAX_NOTES = 300;
const PALETTE = ['yellow', 'pink', 'blue', 'green', 'orange', 'lilac'];

// A poster's color is a stable hash of their connection IP — same IP, same color.
// The raw IP is never stored or returned; only the color name is saved on the note.
async function colorFor(req) {
  const ip =
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return PALETTE[new Uint8Array(digest)[0] % PALETTE.length];
}

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

async function readNotes(token) {
  const blobs = await listBlobs(token, 'corkboard/');
  const notes = [];
  await Promise.all(
    blobs.map(async (b) => {
      try {
        const res = await fetch(b.url);
        if (!res.ok) return;
        const data = await res.json();
        if (b.pathname === LEGACY_PATH && Array.isArray(data.notes)) {
          notes.push(...data.notes);
        } else if (b.pathname.startsWith(NOTES_PREFIX) && data && data.id) {
          notes.push(data);
        }
      } catch {
        /* skip unreadable blob */
      }
    })
  );
  const seen = new Set();
  return notes
    .filter((n) => n && n.id && !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_NOTES);
}

export default async function handler(req) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return json({ error: 'board storage not configured' }, 500);
  try {
    if (req.method === 'GET') {
      return json({ notes: await readNotes(token) });
    }
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || '').trim().slice(0, 40);
      const text = String(body.text || '').trim().slice(0, 500);
      if (!name || !text) return json({ error: 'name and note are both required' }, 400);
      const note = { id: crypto.randomUUID(), name, text, ts: Date.now(), color: await colorFor(req) };
      const res = await fetch(`${API}/${NOTES_PREFIX}${note.ts}-${note.id}.json`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'x-content-type': 'application/json',
          'x-add-random-suffix': '0',
        },
        body: JSON.stringify(note),
      });
      if (!res.ok) return json({ error: 'could not save the note' }, 502);
      return json({ ok: true, note });
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'board error' }, 500);
  }
}
