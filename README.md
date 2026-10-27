# S-1 with receipts

Ask Anthropic's S-1 anything. Every answer is the filing's own words, quoted exactly, with the section and page they came from. If the filing doesn't say, the site says so.

**Unofficial. Not affiliated with Anthropic. Not investment advice.**

## The rule

The model may only answer with quotes. Code then checks every quote character-for-character against the parsed filing (whitespace and curly-quote style ignored). Quotes that aren't in the filing are removed; if any are removed, the model's summary is hidden too; if none survive, the answer is "the filing doesn't say."

## How it works

1. `scripts/parse.py` turns the EDGAR HTML (443 pages, PDF-style absolute layout) into 33 sections and ~1,000 passages, each with its heading and printed page number. Tables become `|`-separated rows. Stdlib only.
2. `lib/s1.js` retrieves the top passages with BM25, asks Claude for JSON (`summary` + `quotes[]`), and verifies each quote.
3. `api/ask.js` is the Vercel function; `dev.js` runs the same handler locally.
4. `scripts/safety.js` pre-asks the AI-safety / agent-risk questions into `public/safety.json`.
5. No model available (no `ANTHROPIC_API_KEY`, quota hit, API down)? The site falls back to search-only: the three closest passages, verbatim, clearly labelled as passages rather than an answer.

The committed `public/safety.json` was drafted with Claude and every quote passed the same verbatim check; `npm run safety` regenerates it through the API.

## Run it

```sh
curl -A "your-name you@example.com" -o data/s1.htm \
  https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/anthropicpbc-sx1.htm
npm run parse        # -> data/sections.json (committed, so this is only needed to rebuild)
npm install
ANTHROPIC_API_KEY=... npm run safety   # optional: rebuild the safety view
ANTHROPIC_API_KEY=... npm run dev      # http://localhost:3000
npm test
```

`MODEL` overrides the model (default `claude-opus-5-5` at low effort).

## Limits

- Retrieval is keyword-based: if search doesn't surface the passage, the answer says the filing is silent when it isn't. The section link is always the thing to check.
- Rate limit and answer cache are in memory per serverless instance.
