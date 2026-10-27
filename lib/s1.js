// Retrieval + answering + quote verification over the parsed S-1 (data/sections.json).
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const data = JSON.parse(readFileSync(new URL('../data/sections.json', import.meta.url), 'utf8'));

export const FILING_URL =
  'https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/anthropicpbc-sx1.htm';
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const TOP_K = 14;

const sections = Object.fromEntries(data.sections.map((s) => [s.id, s]));
const chunks = data.chunks;
const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));

// ---- BM25 over chunks (section title + heading are indexed with the body) ----
const STOP = new Set(
  'a an and are as at be by for from has have how in is it its of on or that the their this to was were what when which who will with does do did our we us you'.split(' '),
);
const tokens = (s) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ies|es|s)$/, '') : t));

const docs = chunks.map((c) => tokens(`${sections[c.sec].title} ${c.head} ${c.head} ${c.text}`));
const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;
const df = new Map();
const tfs = docs.map((d) => {
  const tf = new Map();
  for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
  for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return tf;
});

export function retrieve(q, k = TOP_K) {
  const qt = [...new Set(tokens(q))];
  const scored = tfs.map((tf, i) => {
    let s = 0;
    for (const t of qt) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (chunks.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (docs[i].length / avgLen)));
    }
    return [s, i];
  });
  return scored
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => chunks[i]);
}

// ---- verification: a quote counts only if it appears verbatim in the filing text ----
const norm = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const normText = Object.fromEntries(chunks.map((c) => [c.id, norm(c.text)]));

export function verify(quotes) {
  return quotes.map((q) => {
    const t = norm(q.text);
    if (t.length < 15) return { ...q, ok: false };
    // a model citing the wrong chunk id is fine as long as the words are really in the filing
    const id = normText[q.chunk]?.includes(t) ? q.chunk : chunks.find((c) => normText[c.id].includes(t))?.id;
    return id ? { ...q, chunk: id, ok: true } : { ...q, ok: false };
  });
}

export function cite(id) {
  const c = byId[id];
  const s = sections[c.sec];
  return { section: s.title, heading: c.head, page: c.page, url: `${FILING_URL}#${s.anchor}` };
}

// ---- answering ----
const SYSTEM = `You answer questions about Anthropic, PBC's Form S-1 registration statement (filed with the SEC on October 26, 2026) using ONLY the excerpts provided.

Rules:
- Every factual claim must be backed by a quote copied character-for-character from an excerpt. Each quote is one contiguous span (no ellipses, no edits, no stitching). Use several quotes rather than one long one; 1-4 sentences each.
- "summary" is 1-3 plain sentences that restate only what your quotes say, with [1], [2] markers pointing to quotes by position. No outside knowledge, no opinions, no investment advice, no predictions.
- If the excerpts do not answer the question, set answerable=false, quotes=[], and use summary to say briefly what the excerpts do not cover. Never guess. Blank amounts in the filing (e.g. "$ ") mean the figure is not yet set; say so.
- Questions unrelated to the filing: answerable=false.`;

const SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    summary: { type: 'string' },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { chunk: { type: 'string' }, text: { type: 'string' } },
        required: ['chunk', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['answerable', 'summary', 'quotes'],
  additionalProperties: false,
};

const client = new Anthropic();

// No model (no key, quota hit, API down): show the closest passages themselves. Still all receipts.
const passage = (c) => {
  if (c.text.length <= 700) return { text: c.text, ...cite(c.id) };
  // cut at a sentence end, else a word boundary; `more` tells the page to show an ellipsis outside the quote
  const t = c.text.slice(0, c.text.lastIndexOf('. ', 700) + 1) || c.text.slice(0, c.text.lastIndexOf(' ', 700));
  return { text: t, more: true, ...cite(c.id) };
};
export const searchOnly = (hits) => ({ answerable: true, mode: 'search', summary: null, quotes: hits.slice(0, 3).map(passage), dropped: 0 });

export async function ask(question) {
  const hits = retrieve(question);
  if (!hits.length) return refusal('Nothing in the filing matches those words.');
  if (!process.env.ANTHROPIC_API_KEY) return searchOnly(hits);
  const excerpts = hits
    .map((c) => `<excerpt id="${c.id}" section="${sections[c.sec].title}" heading="${c.head}" page="${c.page}">\n${c.text}\n</excerpt>`)
    .join('\n\n');

  let res;
  try {
    res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${excerpts}\n\n<question>${question}</question>` }],
    });
  } catch (e) {
    console.error('model call failed, falling back to search:', e.status, e.message);
    return searchOnly(hits);
  }
  if (res.stop_reason === 'refusal') return refusal('The model declined this question.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return refusal('Could not read the model response. Try rephrasing.');
  }

  const checked = verify(out.answerable ? out.quotes : []);
  const quotes = checked.filter((q) => q.ok).map((q) => ({ text: q.text, ...cite(q.chunk) }));
  const dropped = checked.length - quotes.length;
  if (!quotes.length) return refusal(out.answerable ? 'No quote survived verification against the filing.' : out.summary);
  // the summary's [n] markers point at the model's quote positions; if any quote failed, hide it
  return { answerable: true, summary: dropped ? null : out.summary, quotes, dropped };
}

const refusal = (why) => ({ answerable: false, summary: why, quotes: [], dropped: 0 });
