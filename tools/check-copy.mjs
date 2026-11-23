/* Catches the class of bug that has bitten this site three times: a fact that
   changes every week — who picks, which teams, which event — written straight
   into the markup or the code instead of being read from CONFIG.

   None of these break the ballot, which the worker enforces. They just quietly
   say the wrong thing for weeks. "The Pick" told everyone DrJ was choosing on
   every Monday game from September to November.

   Run: node tools/check-copy.mjs                                           */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../assets/js/app.js', import.meta.url), 'utf8');

let bad = 0;
const fail = (what, where, why) => {
  bad++;
  console.log('  FAIL ' + what + '\n       ' + where + '\n       ' + why);
};
const ok = (what) => console.log('  ok   ' + what);

/* ---- 1. any copy naming a person must be driven by the JS ---------------- */

// The footer byline is about the rivalry itself, not about this week.
const BYLINE = /built for the MW vs\. DrJ rivalry/;

// Which element a bit of text sits in needs the open tags tracked properly:
// the name is usually wrapped in a <b>, and it is the <p> around it that
// carries the id the JS writes to.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

function enclosingIds(upToIndex) {
  const stack = [];
  const tag = /<(\/?)(\w+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tag.exec(html)) && m.index < upToIndex) {
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
    } else if (!selfClose && !VOID.has(name.toLowerCase())) {
      const id = /id="([A-Za-z0-9_]+)"/.exec(attrs);
      stack.push({ name, id: id ? id[1] : null });
    }
  }
  return stack.map((e) => e.id).filter(Boolean);
}

const lines = html.split('\n');
const offsets = [];
let run = 0;
for (const line of lines) { offsets.push(run); run += line.length + 1; }

const named = [];
lines.forEach((line, i) => {
  if (!/\bDrJ\b|\bMW\b/.test(line) || BYLINE.test(line)) return;
  const ids = enclosingIds(offsets[i] + line.search(/\bDrJ\b|\bMW\b/));
  // The innermost id that app.js actually writes to is the one keeping this
  // text current; failing that, report the innermost id at all.
  const driven = [...ids].reverse().find((id) => js.includes("$('" + id + "')"));
  named.push({
    n: i + 1,
    text: line.trim().slice(0, 72),
    id: driven || ids[ids.length - 1] || null,
    driven: !!driven
  });
});

for (const row of named) {
  if (row.driven) continue;
  if (!row.id) {
    fail('copy names a person but sits in no identified element',
      'index.html:' + row.n + '  ' + row.text,
      'nothing can update it, so it will be wrong the moment the pick alternates');
  } else {
    fail('copy names a person and nothing writes to its element',
      'index.html:' + row.n + '  #' + row.id + '  ' + row.text,
      "app.js never does $('" + row.id + "'), so this text is frozen");
  }
}
if (named.length && !bad) {
  ok(named.length + ' person-named line(s), all driven by app.js: ' +
     named.map((r) => '#' + r.id).join(', '));
}

/* ---- 2. no team or person reached for by abbreviation in the code -------- */

const byName = [...js.matchAll(/\.(teams|people)\.([A-Z]{2,3})\b/g)];
if (byName.length) {
  for (const m of byName) {
    const n = js.slice(0, m.index).split('\n').length;
    fail('team reached for by name', 'assets/js/app.js:' + n + '  ' + m[0],
      'that key disappears the week the matchup changes, and this throws');
  }
} else {
  ok('no team or person looked up by hardcoded abbreviation');
}

/* ---- 3. the page and the config agree on which game is next -------------- */

const evt = /eventId:\s*'(\d+)'/.exec(js.slice(js.indexOf('upcoming:')));
if (!evt) {
  fail('cannot find CONFIG.upcoming.eventId', 'assets/js/app.js', 'config shape changed?');
} else {
  const stale = [...html.matchAll(/gameId\/(\d+)/g)]
    .map((m) => m[1])
    .filter((id) => id !== evt[1]);
  if (stale.length) {
    fail('index.html links to a different game than CONFIG.upcoming',
      'gameId ' + [...new Set(stale)].join(', ') + ' vs config ' + evt[1],
      'the link cards point at last week');
  } else {
    ok('every gameId link matches CONFIG.upcoming.eventId (' + evt[1] + ')');
  }
}

/* ---- 4. the picker and the rival are two different people ---------------- */

const picker = /picker:\s*'(\w+)'/.exec(js.slice(js.indexOf('upcoming:')));
const rival = /rival:\s*'(\w+)'/.exec(js.slice(js.indexOf('upcoming:')));
if (!picker || !rival) {
  fail('cannot read picker/rival', 'assets/js/app.js', 'config shape changed?');
} else if (picker[1] === rival[1]) {
  fail('picker and rival are the same person', picker[1], 'one of them was not swapped');
} else {
  ok('picker is ' + picker[1] + ', rival is ' + rival[1]);
}

console.log(bad ? '\n' + bad + ' problem(s)\n' : '\nall copy checks passed\n');
process.exit(bad ? 1 : 0);
