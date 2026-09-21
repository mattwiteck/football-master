# 🏈 Football Master

A single-page football site built around one question: **who holds the Football Master spot tonight?**

Tonight's game is **Indianapolis Colts at Kansas City Chiefs** — Sunday Night Football, 5:15 PM PT (8:20 PM ET), Arrowhead Stadium, NBC & Peacock.

The house rule drives the whole UI:

| Scoreboard | Football Master (left) | Football Peon (right) |
| --- | --- | --- |
| Indianapolis leading / wins | **MW** | DrJ |
| Kansas City leading / wins | **DrJ** | MW |
| Tied or pregame | TBD | TBD |

## What's in it

- **Throne header** — big left/right pillars for Football Master and Football Peon, with the center verdict panel that reads *"MW is currently ahead for the Football Master spot"* (or DrJ) straight off the live score.
- **Live scoreboard** — team logos, records, score, quarter and clock, refreshed every 30 seconds and whenever the tab regains focus.
- **Real links** — ESPN Gamecast, box score, play-by-play, NFL.com scores, NBC broadcast info.
- **Master Ballot** — head-to-head MW vs. DrJ vote with a live percentage bar.
- **Voting Floor** — upvote/downvote feed of hot takes with Hot / Top / New sorting, plus a composer to post your own.

## Live data

Scores come from ESPN's public, CORS-enabled scoreboard API — no key, no build step, no server:

```
https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872945
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

## Structure

```
index.html
assets/
  css/styles.css    design tokens, throne cards, scoreboard, feed
  js/app.js         ESPN fetch + throne logic + voting store
```

Unofficial fan project. Not affiliated with the NFL, the Colts, the Chiefs, ESPN or NBC.
