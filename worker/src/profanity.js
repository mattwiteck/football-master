/* ==========================================================================
   Language filter for account names and posted takes.

   Matching runs on a normalised copy of the text so the obvious dodges get
   through neither: leetspeak (sh1t), padding (fuuuuck), separators (f.u.c.k)
   and spacing (f u c k) all collapse onto the real word.

   Two strictnesses:
     posts  — whole-word matching with common suffixes, so ordinary English
              ("classic", "passed", "Scunthorpe") is never touched
     names  — substring matching, because a handle is short and deliberate;
              "shithead" should not sail through on a technicality

   Edit WORDS and ALLOW to taste; everything else adapts.
   ========================================================================== */

const WORDS = [
  // general profanity
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'shitty', 'bullshit',
  'bitch', 'bastard', 'asshole', 'arsehole', 'dickhead', 'prick', 'wanker',
  'cunt', 'twat', 'bollocks', 'douchebag', 'jackass', 'dumbass', 'smartass',
  'piss', 'slut', 'whore', 'skank', 'cock', 'pussy', 'tits', 'anus',
  'penis', 'vagina', 'blowjob', 'handjob', 'jizz', 'porn',
  // slurs and hate terms
  'nigger', 'nigga', 'faggot', 'fag', 'dyke', 'tranny', 'retard',
  'spic', 'chink', 'gook', 'kike', 'wetback', 'raghead', 'towelhead',
  'coon', 'paki', 'nazi',
  // violence / self-harm
  'rape', 'rapist', 'molest', 'kys'
];

/**
 * Innocent words and phrases that contain a listed word. These are removed
 * before matching, which is what lets the stricter name check stay usable.
 */
const ALLOW = [
  'magna cum laude', 'summa cum laude', 'cum laude',
  'scunthorpe', 'penistone', 'cockburn', 'hancock', 'babcock', 'peacock',
  'cocktail', 'cockpit', 'shiitake', 'dick butkus', 'dick vermeil'
];

const SUFFIX = '(?:s|es|ed|ing|er|ers|y|ies)?';

/** Squash repeated letters: fuuuuck -> fuck, bollocks -> bolocks. */
function collapse(s) {
  return s.replace(/([a-z])\1+/g, '$1');
}

/** Fold text down to bare letters so lookalikes land on the real thing. */
function normalise(input) {
  let s = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  s = s
    .replace(/[@4]/g, 'a')
    .replace(/[(<{]/g, 'c')
    .replace(/[3€]/g, 'e')
    .replace(/[6]/g, 'g')
    .replace(/[1!|]/g, 'i')
    .replace(/[0øº]/g, 'o')
    .replace(/[5$§]/g, 's')
    .replace(/[7+]/g, 't')
    .replace(/[2]/g, 'z');

  return s.replace(/[^a-z]+/g, ' ').trim();
}

/** Join runs of single letters: "f u c k off" -> "fuck off". */
function unspace(s) {
  return s.replace(/\b(?:[a-z] ){1,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
}

function escapeRe(w) {
  return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAllowed(s) {
  let out = s;
  for (const ok of ALLOW) out = out.split(collapse(ok)).join(' ');
  return out;
}

/**
 * The listed words present in the text.
 * @param {string} text
 * @param {boolean} loose  substring matching, for account names
 */
export function findProfanity(text, loose = false) {
  const base = stripAllowed(collapse(normalise(text)));
  const variants = [base, collapse(unspace(normalise(text)))];
  const hits = new Set();

  for (const word of WORDS) {
    const w = escapeRe(collapse(word));
    const re = loose ? new RegExp(w) : new RegExp('\\b' + w + SUFFIX + '\\b');
    if (variants.some((v) => re.test(v))) hits.add(word);
  }
  return [...hits];
}

export function isClean(text, loose = false) {
  return findProfanity(text, loose).length === 0;
}

/**
 * Replace listed words with asterisks, keeping the rest of the sentence and
 * its punctuation. Each letter may repeat and may be separated, so padded and
 * dotted spellings are masked too.
 */
export function maskProfanity(text) {
  let out = String(text || '');
  const hits = findProfanity(out);
  if (!hits.length) return { text: out, masked: [] };

  for (const word of hits) {
    const letters = collapse(word).split('');
    const pattern = letters.map((ch) => escapeRe(ch) + '+').join('[^a-z0-9]{0,2}');
    const re = new RegExp('\\b' + pattern + SUFFIX + '\\b', 'gi');
    out = out.replace(re, (m) => '*'.repeat(Math.max(3, m.length)));
  }
  return { text: out, masked: hits };
}
