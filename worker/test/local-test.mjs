/* Exercises the real worker module against an in-memory KV stub.
   Run: node test/local-test.mjs                                          */
import worker from '../src/worker.js';

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
  ALLOW_ORIGIN: '*',
  USERS: JSON.stringify({
    jjw007: { pass: 'mattisgreat', who: 'DrJ' },
    matt:   { pass: 'matt1234',    who: 'MW' }
  }),
  GAMES: JSON.stringify({
    401872948: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: '2026-09-24T22:15:00Z' },
    999999999: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: '2020-01-01T00:00:00Z' }
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
let res = await post('/login', { user: 'jjw007', pass: 'wrong' });
check('wrong password rejected', res.status === 401);

res = await post('/login', { user: 'nobody', pass: 'x' });
check('unknown user rejected', res.status === 401);

res = await post('/login', { user: 'JJW007', pass: 'mattisgreat' });
const drj = await res.json();
check('DrJ logs in (case-insensitive)', res.status === 200 && drj.who === 'DrJ', JSON.stringify(drj));
check('token issued', typeof drj.token === 'string' && drj.token.includes('.'));

res = await post('/login', { user: 'matt', pass: 'matt1234' });
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
check('one KV key holds the record', kv.size === 1 && [...kv.keys()][0] === 'game:' + GAME);
const stored = JSON.parse(kv.get('game:' + GAME));
check('record survives as JSON', stored.pick.team === 'ATL' && stored.ledger.length === 2 &&
  stored.takes.length === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
