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
     POST /register          public   {user, pass} -> {token, who, exp}
     POST /login             public   {user, pass} -> {token, who, exp}
     POST /pick              token    {game, team}
     POST /take              token    {game, text}
     POST /vote              token    {game, id, dir}      dir: 1 | -1 | 0
     POST /fan               token    {game, team}
   ========================================================================== */

import { findProfanity, maskProfanity } from './profanity.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_TAKE_LEN = 140;
const MAX_TAKES = 200;

const NAME_MIN = 3;
const NAME_MAX = 18;
const PASS_MIN = 6;
const MAX_ACCOUNTS = 200;
const PBKDF2_ROUNDS = 100000;

// Names nobody gets to register: the founders and the usual impersonations.
const RESERVED = [
  'admin', 'administrator', 'root', 'owner', 'moderator', 'mod', 'system',
  'footballmaster', 'football master', 'master', 'peon', 'claude', 'null',
  'undefined', 'drj', 'mw'
];

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

/* Self-registered accounts live in KV, so their passwords are hashed.
   The two founder logins stay in the USERS secret and are compared directly. */

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    key, 256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { salt: b64url(salt), hash: b64url(hash) };
}

async function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const hash = await pbkdf2(password, unb64url(record.salt));
  return sameString(b64url(hash), record.hash);
}

async function readAccounts(env) {
  return (await env.FM.get('accounts', 'json')) || {};
}

async function writeAccounts(env, accounts) {
  await env.FM.put('accounts', JSON.stringify(accounts));
}

/** Shared rules for a requested display name. */
function checkName(raw) {
  const name = String(raw || '').trim();
  const key = name.toLowerCase();

  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { error: 'name_length', message: `Pick a name between ${NAME_MIN} and ${NAME_MAX} characters.` };
  }
  if (!/^[a-z0-9][a-z0-9 ._-]*$/i.test(name)) {
    return { error: 'name_charset', message: 'Letters, numbers, spaces, dots, dashes and underscores only.' };
  }
  if (RESERVED.includes(key)) {
    return { error: 'name_reserved', message: 'That name is reserved. Pick another.' };
  }
  if (findProfanity(name, true).length) {   // names use the stricter substring check
    return { error: 'name_language', message: 'That name trips the language filter. Pick another.' };
  }
  return { name, key };
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

  // Founder accounts from the secret.
  if (entry) {
    if (!sameString(String(pass || ''), String(entry.pass))) {
      return json(env, { error: 'bad_credentials' }, 401);
    }
    const token = await mintToken(env.TOKEN_SECRET, entry.who);
    return json(env, { token, who: entry.who, exp: Date.now() + TOKEN_TTL_MS });
  }

  // Self-registered accounts from KV.
  const accounts = await readAccounts(env);
  const account = accounts[key];
  if (!account || !(await verifyPassword(String(pass || ''), account))) {
    return json(env, { error: 'bad_credentials' }, 401);
  }

  const token = await mintToken(env.TOKEN_SECRET, account.who);
  return json(env, { token, who: account.who, exp: Date.now() + TOKEN_TTL_MS });
}

async function handleRegister(request, env) {
  const { user, pass } = await request.json().catch(() => ({}));

  const checked = checkName(user);
  if (checked.error) return json(env, { error: checked.error, message: checked.message }, 400);

  const password = String(pass || '');
  if (password.length < PASS_MIN) {
    return json(env, { error: 'pass_length', message: `Passwords need at least ${PASS_MIN} characters.` }, 400);
  }

  // A founder login must never be shadowed by a self-registered one.
  let founders = {};
  try { founders = JSON.parse(env.USERS || '{}'); } catch (err) { founders = {}; }
  if (founders[checked.key]) {
    return json(env, { error: 'name_taken', message: 'That name is already taken.' }, 409);
  }

  const accounts = await readAccounts(env);
  if (accounts[checked.key]) {
    return json(env, { error: 'name_taken', message: 'That name is already taken.' }, 409);
  }
  if (Object.keys(accounts).length >= MAX_ACCOUNTS) {
    return json(env, { error: 'full', message: 'The roster is full.' }, 403);
  }

  const { salt, hash } = await hashPassword(password);
  accounts[checked.key] = { who: checked.name, salt, hash, createdAt: Date.now() };
  await writeAccounts(env, accounts);

  const token = await mintToken(env.TOKEN_SECRET, checked.name);
  return json(env, { token, who: checked.name, exp: Date.now() + TOKEN_TTL_MS, created: true });
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

  const filtered = maskProfanity(clean);

  const record = await readRecord(env, game);
  record.takes.push({
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: filtered.text,
    by: auth.who,
    masked: filtered.masked.length > 0,
    createdAt: Date.now()
  });
  if (record.takes.length > MAX_TAKES) record.takes = record.takes.slice(-MAX_TAKES);

  return json(env, {
    ok: true,
    masked: filtered.masked.length > 0,
    state: await writeRecord(env, game, record)
  });
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
    if (path === '/register') return handleRegister(request, env);

    const auth = await requireAuth(request, env);
    if (!auth) return json(env, { error: 'unauthorized' }, 401);

    if (path === '/pick') return handlePick(request, env, auth);
    if (path === '/take') return handleTake(request, env, auth);
    if (path === '/vote') return handleVote(request, env, auth);
    if (path === '/fan')  return handleFan(request, env, auth);

    return json(env, { error: 'not_found' }, 404);
  }
};
