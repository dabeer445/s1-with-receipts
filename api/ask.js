import { ask } from '../lib/s1.js';

// ponytail: per-instance memory, so limits and cache reset on cold start; move to Vercel KV/Firewall if abused
const hits = new Map();
const cache = new Map();
const LIMIT = 20; // questions per IP per hour

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const q = String(req.body?.question || '').trim();
  if (q.length < 3 || q.length > 300) return res.status(400).json({ error: 'Ask a question of 3-300 characters.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0];
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= LIMIT) return res.status(429).json({ error: 'Hourly limit reached. Try again later.' });
  hits.set(ip, [...recent, now]);

  const key = q.toLowerCase().replace(/\W+/g, ' ').trim();
  try {
    const r = cache.get(key) || (await ask(q));
    if (r.mode !== 'search') cache.set(key, r); // don't pin fallback answers once the model is back
    res.status(200).json(r);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'The model call failed. Try again in a moment.' });
  }
}
