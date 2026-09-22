# 🏈 Football Master

A single-page football site built around one question: **who holds the Football Master spot tonight?**

The site tracks two games at once:

- **The crown** — the settled game that decided who rules. Right now: Giants at Rams (Mon Sep 21 2026), won 28–6 by the Rams, so **MW** is Football Master and **DrJ** is the Peon who sang.
- **The next game** — what gets picked and voted on. Right now: **Atlanta Falcons at Green Bay Packers**, Thursday Sep 24 2026, 5:15 PM PT, Lambeau Field, Prime Video.

The house rule drives the whole UI:

| Scoreboard | Football Master (left) | Football Peon (right) |
| --- | --- | --- |
| Your team wins | **you** | the other guy |
| Tied or pregame | TBD | TBD |

## What's in it

- **Throne header** — big left/right pillars for Football Master and Football Peon, with the center verdict panel that reads *"MW is currently ahead for the Football Master spot"* (or DrJ) straight off the live score.
- **Live scoreboard** — team logos, records, score, quarter and clock, refreshed every 30 seconds and whenever the tab regains focus.
- **Real links** — ESPN Gamecast, box score, play-by-play, NFL.com scores, Rams broadcast/stream info, league scoreboard.
- **The Peon's Anthem** — a gold plaque above the thrones where the loser's tribute song plays. It names the singer and the crown off the final score ("DrJ sings for MW"), and finds the recording whatever format it arrives in. See [assets/audio/README.md](assets/audio/README.md).
- **The Pick** — whoever's turn it is logs in, marks a paper ballot, signs it, and sends it through a pneumatic tube that delivers to the vault and zooms in on the selection. The rival automatically inherits the other team. Sealed two hours before kickoff.
- **Ballot ledger** — every cast and every change, in order, with timestamps. Copyable.
- **Fan Poll** — non-binding crowd vote on the same game.
- **Voting Floor** — upvote/downvote feed of hot takes with Hot / Top / New sorting, plus a composer to post your own.

## Live data

Scores come from ESPN's public, CORS-enabled scoreboard API — no key, no build step, no server:

```
https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872947
```

If that request fails, the page falls back to the league-wide scoreboard endpoint, then to the last score cached in the browser, and always surfaces the ESPN/NFL.com links so the score is one click away.

To point the site at a different game, change `CONFIG.eventId`, `CONFIG.summaryUrl`, `CONFIG.gameLinks` and the `CONFIG.people` map at the top of `assets/js/app.js`.

## Voting data

Votes, ballot tallies and your own takes are stored in `localStorage` (keys prefixed `fm.`), so the demo works with zero backend. The seeded takes ship with starting scores so the feed isn't empty; real votes stack on top of them. Swap the `load`/`save` helpers in `app.js` for API calls and the UI doesn't change.

## Running it

It's a static site — no dependencies, no build.

```bash
# any static server works
python -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk also works.

## Deploying to GitHub Pages

Push to `main`, then in the repo go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, **Branch: `main` / `/ (root)`**, and save. The site publishes at `https://<user>.github.io/football-master/`.

## Add to Home Screen (iPhone)

The page installs like an app on iOS. In Safari, tap **Share → Add to Home Screen**.

- iPhone/iPad visitors in Safari who haven't installed it yet get a dismissable banner at the bottom with those instructions. It hides itself for desktop, for in-app browsers, for anyone already running it standalone, and for anyone who taps the ✕ (remembered via `fmInstallBannerDismissed` in `localStorage`).
- The home-screen icon is `assets/icons/apple-touch-icon.png` (180×180).
- Launched from the Home Screen it runs full-screen with no Safari chrome, so the layout honors `env(safe-area-inset-*)` — the nav clears the notch and the footer and banner clear the home indicator.

Android/Chrome gets a normal bookmark; add a `manifest.webmanifest` if you want an installable PWA there too.

## The Pick: how it works

`CONFIG.upcoming.picker` names whose turn it is (currently `DrJ`); `CONFIG.upcoming.rival` gets the other
team automatically. Logins live in `CONFIG.users` at the top of `assets/js/app.js`.

**The login is a name tag, not a lock.** `app.js` is public, so anyone who opens developer tools can read
the credentials or write a pick straight into storage. It stops the wrong person from wandering in; it does
not stop anyone who is trying. Do not reuse a password here that protects anything real.

**Persistence is per browser.** Picks, ledger entries, fan-poll tallies and takes are kept in `localStorage`,
so they survive refreshes, restarts and Home Screen launches on *that device*. They do not travel: a pick DrJ
files on his phone is not visible on MW's laptop. GitHub Pages serves static files and has nowhere to keep
shared state.

To make picks shared and tamper-resistant, the site needs a backend. The three usual routes:

1. **A tiny serverless function** (Cloudflare Workers + KV, Netlify, Vercel) holding the pick behind a real
   password check. Free tier, ~50 lines.
2. **A hosted database with a client SDK** (Firebase, Supabase). Fastest to stand up; rules do the auth.
3. **A form-backend service** (e.g. a private Gist via a token-scoped worker) if you only ever need append.

Everything in the UI already goes through `load()` / `save()` helpers, so swapping the store for `fetch` calls
is contained to those two functions plus the pick module.

## Rolling to next week's game

In `assets/js/app.js`:

1. Move the finished game into `CONFIG.crown` (its `eventId`, `summaryUrl`, `label`, and the `people` map of
   team abbreviation → person).
2. Point `CONFIG.upcoming` at the next game: `eventId`, `summaryUrl`, `kickoffISO`, `kickoffLabel`, `network`,
   `teams`, `gameLinks`, and swap `picker` / `rival` so the turn alternates.
3. Update the team names, logos and links in `index.html`.

Storage keys are namespaced by event id, so the new week starts with an empty ballot and ledger by itself.

## Structure

```
index.html
assets/
  css/styles.css                design tokens, throne cards, scoreboard, feed
  js/app.js                     ESPN fetch + throne logic + voting store
  icons/apple-touch-icon.png    iOS Home Screen icon (180x180)
```

Unofficial fan project. Not affiliated with the NFL, the Colts, the Chiefs, ESPN or NBC.
