/* ==========================================================================
   Football Master — sync API (Cloudflare Worker + KV)

   Holds the shared state the static site cannot: DrJ's pick, the ballot
   ledger, the takes on the voting floor and the votes on them.

   One KV key per game ("game:<eventId>") holds the whole record. Two people
   use this, so a read-modify-write per request is plenty; there is no
   optimistic concurrency and last write wins.

   Auth is real here, unlike the cosmetic gate in the page: passwords live in
   the USERS secret, never in the repo, and writes need a signed token.

   Routes
     GET  /state?game=<id>   public   the whole record
     POST /login             public   {user, pass} -> {token, who, exp}
     POST /pick              token    {game, team}
     POST /take              token    {game, text}
     POST /vote              token    {game, id, dir}      dir: 1 | -1 | 0
     POST /fan               token    {game, team}
   ========================================================================== */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_TAKE_LEN = 140;
const MAX_TAKES = 200;

/* ------------------------------------------------------------------ utils */

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time-ish compare so a wrong token can't be probed byte by byte. */
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mintToken(secret, who) {
  const payload = b64url(enc.encode(JSON.stringify({ who, exp: Date.now() + TOKEN_TTL_MS })));
  const sig = b64url(await hmac(secret, payload));
  return payload + '.' + sig;
}

async function readToken(secret, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expected = b64url(await hmac(secret, payload));
  if (!sameString(sig, expected)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    ...extra
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors(env, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  });
}

/* ------------------------------------------------------------------ state */

function emptyRecord() {
  return { pick: null, ledger: [], takes: [], votes: {}, fan: { counts: {}, byUser: {} }, rev: 0 };
}

async function readRecord(env, game) {
  const raw = await env.FM.get('game:' + game, 'json');
  return raw ? { ...emptyRecord(), ...raw } : emptyRecord();
}

async function writeRecord(env, game, record) {
  record.rev = (record.rev || 0) + 1;
  record.updatedAt = Date.now();
  await env.FM.put('game:' + game, JSON.stringify(record));
  return record;
}

/** Per-game rules (whose turn, when the ballot seals) come from the GAMES var. */
function gameRules(env, game) {
  let all = {};
  try { all = JSON.parse(env.GAMES || '{}'); } catch (err) { all = {}; }
  return all[game] || null;
}

/* ----------------------------------------------------------------- routes */

async function handleLogin(request, env) {
  const { user, pass } = await request.json().catch(() => ({}));
  let users = {};
  try { users = JSON.parse(env.USERS || '{}'); } catch (err) { users = {}; }

  const key = String(user || '').trim().toLowerCase();
  const entry = users[key];
  if (!entry || !sameString(String(pass || ''), String(entry.pass))) {
    return json(env, { error: 'bad_credentials' }, 401);
  }

  const token = await mintToken(env.TOKEN_SECRET, entry.who);
  return json(env, { token, who: entry.who, exp: Date.now() + TOKEN_TTL_MS });
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return readToken(env.TOKEN_SECRET, token);
}

async function handlePick(request, env, auth) {
  const { game, team } = await request.json().catch(() => ({}));
  if (!game || !team) return json(env, { error: 'bad_request' }, 400);

  const rules = gameRules(env, game);
  if (!rules) return json(env, { error: 'unknown_game' }, 400);
  if (rules.teams && rules.teams.indexOf(team) < 0) return json(env, { error: 'unknown_team' }, 400);
  if (rules.picker && auth.who !== rules.picker) {
    return json(env, { error: 'not_your_turn', picker: rules.picker }, 403);
  }
  if (rules.lockAt && Date.now() >= Date.parse(rules.lockAt)) {
    return json(env, { error: 'ballot_sealed', lockAt: rules.lockAt }, 403);
  }

  const record = await readRecord(env, game);
  const prev = record.pick;
  if (prev && prev.team === team) return json(env, { ok: true, unchanged: true, state: record });

  record.pick = {
    team,
    by: auth.who,
    at: Date.now(),
    changes: prev ? (prev.changes || 0) + 1 : 0
  };
  record.ledger.push({
    at: Date.now(), who: auth.who,
    kind: prev ? 'changed' : 'cast',
    from: prev ? prev.team : null, to: team
  });

  return json(env, { ok: true, state: await writeRecord(env, game, record) });
}

async function handleTake(request, env, auth) {
  const { game, text } = await request.json().catch(() => ({}));
  const clean = String(text || '').trim().slice(0, MAX_TAKE_LEN);
  if (!game || !clean) return json(env, { error: 'bad_request' }, 400);

  const record = await readRecord(env, game);
  record.takes.push({
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: clean,
    by: auth.who,
    createdAt: Date.now()
  });
  if (record.takes.length > MAX_TAKES) record.takes = record.takes.slice(-MAX_TAKES);

  return json(env, { ok: true, state: await writeRecord(env, game, record) });
}

async function handleVote(request, env, auth) {
  const { game, id, dir } = await request.json().catch(() => ({}));
  if (!game || !id) return json(env, { error: 'bad_request' }, 400);

  const record = await readRecord(env, game);
  const forTake = record.votes[id] || {};
  const d = Number(dir);

  if (d === 1 || d === -1) forTake[auth.who] = d;
  else delete forTake[auth.who];

  if (Object.keys(forTake).length) record.votes[id] = forTake;
  else delete record.votes[id];

  return json(env, { ok: true, state: await writeRecord(env, game, record) });
}

async function handleFan(request, env, auth) {
  const { game, team } = await request.json().catch(() => ({}));
  if (!game || !team) return json(env, { error: 'bad_request' }, 400);

  const record = await readRecord(env, game);
  record.fan = record.fan || { counts: {}, byUser: {} };
  record.fan.byUser[auth.who] = team;

  // recount from scratch so a switched vote can't double-count
  const counts = {};
  for (const t of Object.values(record.fan.byUser)) counts[t] = (counts[t] || 0) + 1;
  record.fan.counts = counts;

  return json(env, { ok: true, state: await writeRecord(env, game, record) });
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (!env.FM) return json(env, { error: 'kv_not_bound' }, 500);
    if (!env.TOKEN_SECRET) return json(env, { error: 'token_secret_missing' }, 500);

    if (path === '/' || path === '/health') {
      return json(env, { ok: true, service: 'football-master-sync' });
    }

    if (path === '/state' && request.method === 'GET') {
      const game = url.searchParams.get('game');
      if (!game) return json(env, { error: 'bad_request' }, 400);
      const record = await readRecord(env, game);
      const rules = gameRules(env, game);
      return json(env, {
        state: record,
        rules: rules ? { picker: rules.picker, rival: rules.rival, lockAt: rules.lockAt } : null,
        serverTime: Date.now()
      });
    }

    if (request.method !== 'POST') return json(env, { error: 'not_found' }, 404);
    if (path === '/login') return handleLogin(request, env);

    const auth = await requireAuth(request, env);
    if (!auth) return json(env, { error: 'unauthorized' }, 401);

    if (path === '/pick') return handlePick(request, env, auth);
    if (path === '/take') return handleTake(request, env, auth);
    if (path === '/vote') return handleVote(request, env, auth);
    if (path === '/fan')  return handleFan(request, env, auth);

    return json(env, { error: 'not_found' }, 404);
  }
};
