/* Runs the real worker module over plain HTTP with an in-memory KV, so the
   browser can be pointed at it without Cloudflare.
   Run: node test/serve.mjs [port]                                          */
import { createServer } from 'node:http';
import worker from '../src/worker.js';

const PORT = Number(process.argv[2] || 8788);
const kv = new Map();

const env = {
  FM: {
    async get(key, type) {
      const raw = kv.get(key);
      if (!raw) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { kv.set(key, value); }
  },
  TOKEN_SECRET: 'dev-secret',
  ALLOW_ORIGIN: '*',
  USERS: JSON.stringify({
    jjw007: { pass: 'mattisgreat', who: 'DrJ' },
    matt:   { pass: 'matt1234',    who: 'MW' }
  }),
  GAMES: JSON.stringify({
    401872948: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: '2026-09-24T22:15:00Z' }
  })
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request('http://localhost' + req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
  });

  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => {
  console.log('dev sync API on http://127.0.0.1:' + PORT);
});
