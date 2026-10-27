// Local dev: serves public/ and routes /api/ask to the same handler Vercel runs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import handler from './api/ask.js';

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
  if (req.url.startsWith('/api/ask')) {
    let body = '';
    for await (const c of req) body += c;
    try { req.body = JSON.parse(body || '{}'); } catch { req.body = {}; }
    return handler(req, res);
  }
  const path = normalize(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join('public', path));
    res.setHeader('content-type', TYPES[extname(path)] || 'application/octet-stream');
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(process.env.PORT || 3000, () => console.log(`http://localhost:${process.env.PORT || 3000}`));
