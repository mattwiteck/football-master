# Football Master — sync service

A Cloudflare Worker with a KV namespace. It holds the state the static site cannot: **DrJ's pick, the ballot ledger, the takes on the voting floor, the votes on them, and the fan poll.** Deploy it once and both of you see the same board on every device.

Until it's deployed the site works exactly as before — everything falls back to `localStorage`, per browser.

## Deploy (about five minutes)

You need a Cloudflare account; the free plan covers this many times over. Run these from `worker/`, and note the `!` prefix runs a command in the Claude Code session:

```bash
cd worker

# 1. Sign in — opens a browser window
npx wrangler login

# 2. Create the KV namespace; it prints an id
npx wrangler kv namespace create FM

# 3. Paste that id into wrangler.toml, replacing REPLACE_WITH_KV_NAMESPACE_ID

# 4. Set the signing secret — any long random string. To generate one:
#      node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npx wrangler secret put TOKEN_SECRET

# 5. Set the logins (see the shape below). This never touches the repo.
npx wrangler secret put USERS

# 6. Ship it
npx wrangler deploy
```

Deploy prints a URL like `https://football-master-sync.<your-subdomain>.workers.dev`. Put it in `assets/js/app.js`:

```js
api: { base: 'https://football-master-sync.<your-subdomain>.workers.dev' },
```

Commit, push, and the site switches from "This device only" to "Synced".

### The USERS secret

When `wrangler secret put USERS` prompts, paste one line of JSON:

```json
{"jjw007":{"pass":"PICK-A-NEW-ONE","who":"DrJ"},"matt":{"pass":"PICK-A-NEW-ONE","who":"MW"}}
```

**Choose new passwords here.** The ones currently in `assets/js/app.js` are in a public repo and in git history, so treat them as burned. Secrets set this way are stored by Cloudflare and never appear in the repo or in the browser.

## Each week

Edit the `GAMES` block in `wrangler.toml` and run `npx wrangler deploy`:

```toml
GAMES = '''{
  "<espn event id>": {
    "picker": "MW",
    "rival": "DrJ",
    "teams": ["ABC", "XYZ"],
    "lockAt": "2026-10-01T22:15:00Z"
  }
}'''
```

`picker` and `lockAt` are enforced **server-side** — the browser cannot talk its way past whose turn it is or file a pick after the ballot seals. Keep the old game's entry if you want its history to stay readable.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /state?game=<id>` | public | the whole record plus the rules for that game |
| `POST /login` | public | `{user, pass}` → `{token, who, exp}` |
| `POST /pick` | token | `{game, team}` — checks turn and lock, appends to the ledger |
| `POST /take` | token | `{game, text}` — trimmed to 140 chars, capped at 200 takes |
| `POST /vote` | token | `{game, id, dir}` where dir is `1`, `-1` or `0` |
| `POST /fan` | token | `{game, team}` — recounts so a switched vote can't double-count |

Tokens are HMAC-SHA256 over `{who, exp}`, signed with `TOKEN_SECRET`, good for 30 days. Reads are public; every write needs a token.

`ALLOW_ORIGIN` in `wrangler.toml` pins which site may call the API from a browser. It ships set to the Pages origin.

## Testing without Cloudflare

Both use an in-memory KV, so nothing is written anywhere:

```bash
node test/local-test.mjs     # 31 assertions over the real handler
node test/serve.mjs 8788     # serves the real worker on http://127.0.0.1:8788
```

To drive the site against the dev server, set `api.base` to `http://127.0.0.1:8788` and serve the site with `python -m http.server 8777`.

## Cost and limits

The KV free plan allows 100k reads and 1k writes per day; Workers allow 100k requests per day. The page reads state every 30 seconds per open tab (~2,880 reads/day/tab) and writes only when someone picks, posts or votes. Two people will not come close.
