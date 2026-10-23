# "Setup next game"

The whole weekly routine, triggered by that phrase. Everything below is derived
or looked up — the only things that ever need saying out loud are a song title
and the occasional one-off note.

## The rhythm

A **week is Thursday + Monday**, in that order:

| Suffix | Game |
| --- | --- |
| `a` | that week's **Thursday** night game |
| `b` | that week's **Monday** night game |

So `W6a` is the Thursday game of week 6, and `W6b` is the Monday that follows it.
Thursday starts the week.

The site is updated **twice a week, right after each game ends**: once after the
Thursday game, once after the Monday game. Each update closes out the game that
just finished and opens the ballot for the next one.

## The pick alternates

`DrJ → MW → DrJ → MW`, every game, regardless of who won. The loser does not get
a consolation pick; it simply alternates. Whoever is not picking inherits the
other team automatically.

## What happens on each update

1. **Read the result** of the game that just finished, from the ESPN summary API
   for its event id.
2. **Read the filed pick** from the sync service:
   `GET https://football-master-sync.mwiteck.workers.dev/state?game=<eventId>`.
   The picker's team plus the result decides the crown; the other person
   inherits the remaining team.
3. **Move that game into `CONFIG.crown`** in `assets/js/app.js`, with the
   `people` map set from who ended up with which team.
4. **Point `CONFIG.tribute`** at the new song (see below).
5. **Find the next game** on the ESPN scoreboard for its date, and put it in
   `CONFIG.upcoming`: event id, summary URL, label, `navLabel`, `kickoffISO`,
   network, teams, `gameLinks`, and `picker`/`rival` swapped from last time.
6. **Update `index.html`**: hero eyebrow, next-up strip, board defaults
   (logos, cities, names, records, venue, network), the six link cards, the
   ballot choices, the fan poll sides, and the asset version query strings.
7. **Update the two team colours** in `assets/css/styles.css`: `--team-away`
   and `--team-home`. They are role-based, so only the hex values change.
8. **Refresh the seeded takes** in `SEED_TAKES` for the new matchup.
9. **Add the new game to `worker/wrangler.toml`** under `GAMES` with `picker`,
   `rival`, `teams` and `lockAt` (kickoff minus two hours), then
   `npx wrangler@4 deploy` from `worker/`.
10. **Verify**: both test suites, a headless browser load checking the crown,
    tribute, board and ballot, and the live API reporting the right `picker`.
11. **Commit and push.** GitHub Pages redeploys on its own.

## The tribute song

Files live in `assets/audio/` and are never overwritten:

```
peon-anthemW<week><a|b>.mp3          one song
peon-anthemW<week><a|b>1.mp3         several songs for one game
peon-anthemW<week><a|b>2.mp3
```

In `CONFIG.tribute`:

```js
tribute: {
  file: 'assets/audio/peon-anthemW6a.mp3',
  title: '',        // optional, shown in quotes above the play button
  aside: '',        // optional italic line under the note
  url: '', host: '' // optional "Listen on ..." credit link
}
```

For more than one song that week, swap `file`/`title` for:

```js
tracks: [
  { file: '...W5b1.mp3', title: '...', short: 'Track 1' },
  { file: '...W5b2.mp3', title: '...', short: 'Track 2' }
]
```

The card works the rest out by itself: who sings, who it is for, and the
"Week 6 · Thursday game" badge, all read from the score and the file name.

**Titles are the one thing that cannot be derived.** If no title is given, the
card shows the player without one rather than inventing a name — worth asking
for it.

## Standing history

Week numbers are the ones used in the file names. Thursday opens each week.

| Week | Game | Picker took | Result | Crown after | Song |
| --- | --- | --- | --- | --- | --- |
| — | Giants at Rams, Sep 21 | — | LAR 28-6 | MW | — |
| 3a | Falcons at Packers, Sep 24 | DrJ took GB | ATL 35-14 | MW | — |
| 3b | Eagles at Bears, Sep 28 | MW took PHI | CHI 27-7 | DrJ | `peon-anthem` "John, The King of the Ball" |
| 4a | Steelers at Browns, Oct 1 | DrJ took CLE | CLE 27-24 | DrJ | `W4a` "John is not the Peon" |
| 4b | Falcons at Saints, Oct 5 | MW took NO | ATL 45-24 | DrJ | `W4b` "John Didn't Lose" |
| 5a | Buccaneers at Cowboys, Oct 8 | DrJ took DAL | TB 24-16 | MW | `W5a` "Dallas Dizzyness" |
| 5b | Bills at Rams, Oct 12 | MW took BUF | BUF 37-34 OT | MW | `W5b1` + `W5b2` |
| 6a | Seahawks at Broncos, Oct 15 | DrJ took SEA | DEN 17-14 OT | MW | `W6a` "Mile High Tizzy" |
| 6b | Commanders at 49ers, Oct 19 | MW took SF | SF 23-17 | MW | `W6b` "Matt Is Still The Master" |
| 7a | Patriots at Bears, Oct 22 | DrJ took CHI | CHI 30-24 | DrJ | `W7a` "Patriots Horror before Halloween" |
| 7b | Cowboys at Eagles, Oct 26 | MW picks | — | — | — |

The badge on the card reads the week and the day straight off the file name, so
the file name is the source of truth for what gets displayed.
