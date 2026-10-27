import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, retrieve, searchOnly } from '../lib/s1.js';

test('verbatim quotes pass, paraphrases and fabrications fail', () => {
  const [hit] = retrieve('Long-Term Benefit Trust LTBT', 1);
  const real = hit.text.split('\n\n').find((p) => p.length > 80).slice(0, 120);
  const [ok, curly, para, fake, tiny] = verify([
    { chunk: hit.id, text: real },
    { chunk: hit.id, text: real.replace(/'/g, '’').replace(/ /g, '  ') }, // quote/space style differences are fine
    { chunk: hit.id, text: real.replace(/\bthe\b/, 'a') },
    { chunk: hit.id, text: 'Anthropic guarantees investors a 20% annual return on Class A shares.' },
    { chunk: hit.id, text: 'the' },
  ]);
  assert.ok(ok.ok && curly.ok);
  assert.ok(!para.ok && !fake.ok && !tiny.ok);
});

test('a real quote cited under the wrong chunk id is re-attributed, not dropped', () => {
  const [a, b] = retrieve('Long-Term Benefit Trust', 2);
  const [q] = verify([{ chunk: b.id, text: a.text.slice(0, 100) }]);
  assert.ok(q.ok);
  assert.equal(q.chunk, a.id);
});

test('search-only fallback returns verbatim passages', () => {
  const r = searchOnly(retrieve('compute costs', 3));
  assert.equal(r.quotes.length, 3);
  assert.ok(verify(r.quotes.map((q) => ({ chunk: 'x', text: q.text }))).every((q) => q.ok));
});
