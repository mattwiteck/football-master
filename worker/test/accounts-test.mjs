/* Registration, password hashing and the language filter.
   Run: node test/accounts-test.mjs                                        */
import worker from '../src/worker.js';
import { findProfanity, maskProfanity, isClean } from '../src/profanity.js';

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
  TOKEN_SECRET: 'test-secret',
  ALLOW_ORIGIN: '*',
  USERS: JSON.stringify({ 'test-drj': { pass: 'test-pass-1', who: 'DrJ' } }),
  GAMES: JSON.stringify({
    401872948: { picker: 'DrJ', rival: 'MW', teams: ['ATL', 'GB'], lockAt: '2026-09-24T22:15:00Z' }
  })
};

const GAME = '401872948';
let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <- ' + extra : '')); }
}

const post = (path, body, token) =>
  worker.fetch(new Request('https://api.example.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  }), env);

console.log('\nlanguage filter — must NOT trip on innocent text');
for (const ok of [
  'Scunthorpe United are on the telly',
  'A classic Lambeau finish',
  'He passed the mass of grass',
  'Dick Butkus was a linebacker',
  'She graduated magna cum laude',
  'The analysis of the titans secondary',
  'Peacock has the stream',
  'That was a bass-heavy broadcast'
]) check('clean: "' + ok + '"', isClean(ok), JSON.stringify(findProfanity(ok)));

console.log('\nlanguage filter — must catch');
for (const bad of [
  'this is shit',
  'what the fuck',
  'f u c k that call',
  'f.u.c.k the refs',
  'sh1t call',
  'total BULLSHIT',
  'you are an assh0le',
  'fuuuuuck'
]) check('caught: "' + bad + '"', !isClean(bad), 'no hit');

console.log('\nmasking keeps the sentence');
const m = maskProfanity('that call was shit and the refs are assholes');
check('masked text replaces the words', !/shit|assholes?/i.test(m.text), m.text);
check('masked text keeps the rest', m.text.includes('that call was') && m.text.includes('refs are'), m.text);
check('masked list reported', m.masked.length >= 2, JSON.stringify(m.masked));

console.log('\nregistration');
let res = await post('/register', { user: 'Gridiron_Gary', pass: 'longenough' });
let body = await res.json();
check('new account created', res.status === 200 && body.who === 'Gridiron_Gary' && !!body.token, JSON.stringify(body));

res = await post('/register', { user: 'gridiron_gary', pass: 'another1' });
body = await res.json();
check('duplicate name rejected (case-insensitive)', res.status === 409 && body.error === 'name_taken');

res = await post('/register', { user: 'ab', pass: 'longenough' });
check('too-short name rejected', (await res.json()).error === 'name_length');

res = await post('/register', { user: 'ok_name', pass: 'short' });
check('too-short password rejected', (await res.json()).error === 'pass_length');

res = await post('/register', { user: 'admin', pass: 'longenough' });
check('reserved name rejected', (await res.json()).error === 'name_reserved');

res = await post('/register', { user: 'DrJ', pass: 'longenough' });
check('founder name cannot be shadowed', [409, 400].includes(res.status));

res = await post('/register', { user: 'shithead', pass: 'longenough' });
check('profane name rejected', (await res.json()).error === 'name_language');

res = await post('/register', { user: 'bad<script>', pass: 'longenough' });
check('odd characters rejected', (await res.json()).error === 'name_charset');

console.log('\nlogin for self-registered accounts');
res = await post('/login', { user: 'gridiron_gary', pass: 'longenough' });
body = await res.json();
const garyToken = body.token;
check('registered user can log in', res.status === 200 && body.who === 'Gridiron_Gary');

res = await post('/login', { user: 'gridiron_gary', pass: 'wrongpass' });
check('wrong password rejected', res.status === 401);

check('password is not stored in the clear',
  !JSON.stringify(JSON.parse(kv.get('accounts'))).includes('longenough'),
  kv.get('accounts'));

const stored = JSON.parse(kv.get('accounts')).gridiron_gary;
check('salt and hash stored', !!stored.salt && !!stored.hash && stored.hash.length > 20);

res = await post('/login', { user: 'test-drj', pass: 'test-pass-1' });
check('founder login still works', (await res.json()).who === 'DrJ');

console.log('\nposting as a registered user');
res = await post('/take', { game: GAME, text: 'Packers by ten, book it' }, garyToken);
body = await res.json();
check('take accepted', body.state.takes[0].by === 'Gridiron_Gary');

res = await post('/take', { game: GAME, text: 'the refs are assholes honestly' }, garyToken);
body = await res.json();
const posted = body.state.takes[1];
check('profanity masked, post kept', !/assholes/i.test(posted.text) && posted.text.includes('the refs are'), posted.text);
check('masked flag set', posted.masked === true && body.masked === true);

res = await post('/pick', { game: GAME, team: 'GB' }, garyToken);
check('a registered user cannot file the pick', res.status === 403);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
