/* Exercises the real worker module against an in-memory KV stub.
   Run: node test/local-test.mjs                                          */
import worker from '../src/worker.js';

// Locks are relative to now so the suite cannot rot as dates pass.
const OPEN_LOCK = new Date(Date.now() + 86400000).toISOString();   // tomorrow
const PAST_LOCK = new Date(Date.now() - 86400000).toISOString();   // yesterday
const SOON     = new Date(Date.now() + 3600000).toISOString();     // in an hour
const EARLIER  = new Date(Date.now() - 3600000).toISOString();     // an hour ago

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
  TOKEN_SECRET: 'test-secret-not-the-real-one',
  ADMIN_SECRET: 'test-admin-key',
  ALLOW_ORIGIN: '*',
  USERS: JSON.stringify({
    'test-drj': { pass: 'test-pass-1', who: 'DrJ' },
    'test-mw':  { pass: 'test-pass-2', who: 'MW' }
  }),
  GAMES: JSON.stringify({
    401872948: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: OPEN_LOCK },
    999999999: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: PAST_LOCK },
    888888881: { picker: 'DrJ', rival: 'MW', teams: ['IND', 'HOU'], lockAt: PAST_LOCK, kickoffAt: SOON },
    888888882: { picker: 'DrJ', rival: 'MW', teams: ['IND', 'HOU'], lockAt: PAST_LOCK, kickoffAt: EARLIER },
    888888883: { picker: 'DrJ', rival: 'MW', teams: ['IND', 'HOU'], lockAt: PAST_LOCK }
  })
};

const GAME = '401872948';
const BASE = 'https://api.example.com';

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <- ' + extra : '')); }
}

const call = (path, opts = {}) =>
  worker.fetch(new Request(BASE + path, opts), env);

const post = (path, body, token) => call(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {})
  },
  body: JSON.stringify(body)
});

console.log('\nlogin');
let res = await post('/login', { user: 'test-drj', pass: 'wrong' });
check('wrong password rejected', res.status === 401);

res = await post('/login', { user: 'nobody', pass: 'x' });
check('unknown user rejected', res.status === 401);

res = await post('/login', { user: 'TEST-DRJ', pass: 'test-pass-1' });
const drj = await res.json();
check('DrJ logs in (case-insensitive)', res.status === 200 && drj.who === 'DrJ', JSON.stringify(drj));
check('token issued', typeof drj.token === 'string' && drj.token.includes('.'));

res = await post('/login', { user: 'test-mw', pass: 'test-pass-2' });
const mw = await res.json();
check('MW logs in', mw.who === 'MW');

console.log('\ntokens');
res = await post('/pick', { game: GAME, team: 'GB' });
check('no token rejected', res.status === 401);

res = await post('/pick', { game: GAME, team: 'GB' }, drj.token.split('.')[0] + '.tampered');
check('tampered signature rejected', res.status === 401);

console.log('\npick rules');
res = await post('/pick', { game: GAME, team: 'GB' }, mw.token);
let body = await res.json();
check('MW cannot pick this week', res.status === 403 && body.error === 'not_your_turn', JSON.stringify(body));

res = await post('/pick', { game: GAME, team: 'XYZ' }, drj.token);
check('unknown team rejected', res.status === 400);

res = await post('/pick', { game: '999999999', team: 'GB' }, drj.token);
body = await res.json();
check('sealed ballot rejected', res.status === 403 && body.error === 'ballot_sealed', JSON.stringify(body));

res = await post('/pick', { game: GAME, team: 'GB' }, drj.token);
body = await res.json();
check('DrJ picks GB', res.status === 200 && body.state.pick.team === 'GB' && body.state.pick.by === 'DrJ');
check('ledger records the cast', body.state.ledger.length === 1 && body.state.ledger[0].kind === 'cast');

res = await post('/pick', { game: GAME, team: 'ATL' }, drj.token);
body = await res.json();
check('DrJ changes to ATL', body.state.pick.team === 'ATL' && body.state.pick.changes === 1);
check('ledger records the change', body.state.ledger.length === 2 &&
  body.state.ledger[1].kind === 'changed' && body.state.ledger[1].from === 'GB');

res = await post('/pick', { game: GAME, team: 'ATL' }, drj.token);
body = await res.json();
check('re-picking the same team is a no-op', body.unchanged === true && body.state.ledger.length === 2);

console.log('\ntakes and votes');
res = await post('/take', { game: GAME, text: '  Lambeau in September is a trap game.  ' }, mw.token);
body = await res.json();
const takeId = body.state.takes[0].id;
check('MW posts a take (trimmed)', body.state.takes.length === 1 &&
  body.state.takes[0].text === 'Lambeau in September is a trap game.' && body.state.takes[0].by === 'MW');

res = await post('/take', { game: GAME, text: 'x'.repeat(400) }, drj.token);
body = await res.json();
check('long take is truncated to 140', body.state.takes[1].text.length === 140);

res = await post('/vote', { game: GAME, id: takeId, dir: 1 }, drj.token);
body = await res.json();
check('DrJ upvotes', body.state.votes[takeId].DrJ === 1);

res = await post('/vote', { game: GAME, id: takeId, dir: -1 }, mw.token);
body = await res.json();
check('MW downvotes the same take', body.state.votes[takeId].MW === -1 &&
  Object.keys(body.state.votes[takeId]).length === 2);

res = await post('/vote', { game: GAME, id: takeId, dir: 0 }, mw.token);
body = await res.json();
check('MW clears their vote', !body.state.votes[takeId].MW && body.state.votes[takeId].DrJ === 1);

console.log('\nfan poll');
res = await post('/fan', { game: GAME, team: 'GB' }, drj.token);
body = await res.json();
check('fan vote counted', body.state.fan.counts.GB === 1);

res = await post('/fan', { game: GAME, team: 'ATL' }, drj.token);
body = await res.json();
check('switching does not double count',
  body.state.fan.counts.ATL === 1 && !body.state.fan.counts.GB, JSON.stringify(body.state.fan.counts));

res = await post('/fan', { game: GAME, team: 'ATL' }, mw.token);
body = await res.json();
check('second voter adds', body.state.fan.counts.ATL === 2);

console.log('\noverride: a late ballot');
const LATE = '888888881';
const admin = (body, key) => call('/override', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Admin-Key': key } : {}) },
  body: JSON.stringify(body)
});
const REASON = 'DrJ logged in after the seal';

// the ordinary route still refuses, which is the whole reason this exists
res = await post('/pick', { game: LATE, team: 'HOU' }, drj.token);
check('sealed ballot still rejects a normal pick', res.status === 403);

res = await admin({ game: LATE, team: 'HOU', reason: REASON });
check('override without the key rejected', res.status === 403);

res = await admin({ game: LATE, team: 'HOU', reason: REASON }, 'wrong-key');
check('override with the wrong key rejected', res.status === 403);

res = await admin({ game: LATE, team: 'HOU', reason: REASON }, drj.token);
check('a session token is not an admin key', res.status === 403);

res = await admin({ game: LATE, team: 'HOU' }, 'test-admin-key');
check('override needs a reason', res.status === 400);

res = await admin({ game: LATE, team: 'HOU', reason: 'late' }, 'test-admin-key');
check('a one-word reason is too short', res.status === 400);

res = await admin({ game: LATE, team: 'DAL', reason: REASON }, 'test-admin-key');
check('override cannot invent a team', res.status === 400);

res = await admin({ game: LATE, team: 'HOU', who: 'MW', reason: REASON }, 'test-admin-key');
check('override cannot move the pick to the rival', res.status === 403);

res = await admin({ game: '888888882', team: 'HOU', reason: REASON }, 'test-admin-key');
body = await res.json();
check('override refused once the game has kicked off', res.status === 403 &&
  body.error === 'already_kicked_off', JSON.stringify(body));

res = await admin({ game: '888888883', team: 'HOU', reason: REASON }, 'test-admin-key');
body = await res.json();
check('override fails closed with no kickoff on file', res.status === 409 &&
  body.error === 'kickoff_unknown', JSON.stringify(body));

res = await admin({ game: LATE, team: 'HOU', by: 'MW', reason: REASON }, 'test-admin-key');
body = await res.json();
check('override accepted before kickoff', res.status === 200 && body.ok === true,
  JSON.stringify(body));
check('pick belongs to the picker, not the filer',
  body.state.pick.team === 'HOU' && body.state.pick.by === 'DrJ');
check('pick records who actually filed it', body.state.pick.enteredBy === 'MW');
const lateRow = body.state.ledger[body.state.ledger.length - 1];
check('ledger row is marked as an override', lateRow.kind === 'override' && lateRow.to === 'HOU');
check('ledger row explains itself',
  lateRow.note.includes('MW') && lateRow.note.includes(REASON), lateRow.note);

res = await admin({ game: LATE, team: 'IND', by: 'MW', reason: 'he changed his mind in time' },
  'test-admin-key');
body = await res.json();
check('a second override records the move', res.status === 200 &&
  body.state.pick.team === 'IND' &&
  body.state.ledger[body.state.ledger.length - 1].from === 'HOU');

res = await call('/state?game=' + LATE);
body = await res.json();
check('kickoff time is exposed to the client', !!body.rules.kickoffAt);

// with no secret configured the route is inert rather than open
const noKey = { ...env, ADMIN_SECRET: undefined };
res = await worker.fetch(new Request(BASE + '/override', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
  body: JSON.stringify({ game: LATE, team: 'HOU', reason: REASON })
}), noKey);
check('route is inert when ADMIN_SECRET is unset', res.status === 503);

console.log('\npublic read');
res = await call('/state?game=' + GAME);
body = await res.json();
check('state is readable without a token', res.status === 200 && body.state.pick.team === 'ATL');
check('rules exposed for the client', body.rules.picker === 'DrJ' && !!body.rules.lockAt);
check('CORS header present', res.headers.get('Access-Control-Allow-Origin') === '*');

res = await call('/state');
check('state without game id rejected', res.status === 400);

res = await call('/nope', { method: 'POST', headers: { Authorization: 'Bearer ' + drj.token } });
check('unknown route 404s', res.status === 404);

res = await call('/', { method: 'OPTIONS' });
check('preflight answered', res.status === 204);

console.log('\npersistence');
check('one KV key per game', kv.has('game:' + GAME) && kv.has('game:' + LATE));
const stored = JSON.parse(kv.get('game:' + GAME));
check('record survives as JSON', stored.pick.team === 'ATL' && stored.ledger.length === 2 &&
  stored.takes.length === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
