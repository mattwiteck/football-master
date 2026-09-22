/* ==========================================================================
   Football Master — app logic

   Two games are in play at once:
     CONFIG.crown    the settled game that decided who wears the crown
                     (drives the thrones and the peon's tribute song)
     CONFIG.upcoming the next game, which is what gets picked and voted on

   Everything else — the pick ballot, the ledger, the fan poll, the takes —
   hangs off CONFIG.upcoming and is keyed by its event id, so rolling the
   site to next week's game is a config change, not a code change.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  var CONFIG = {
    // ---- the game already in the books: Giants at Rams, Mon Sep 21 2026
    crown: {
      eventId: '401872947',
      summaryUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872947',
      label: 'Monday Night Football',
      people: {
        LAR: { who: 'MW', team: 'Los Angeles Rams' },
        NYG: { who: 'DrJ', team: 'New York Giants' }
      }
    },

    // ---- the game being picked: Falcons at Packers, Thu Sep 24 2026
    upcoming: {
      eventId: '401872948',
      summaryUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872948',
      label: 'Thursday Night Football',
      kickoffISO: '2026-09-25T00:15Z',   // 5:15 PM PT / 8:15 PM ET
      kickoffLabel: '5:15 PM PT',
      network: 'Prime Video',
      lockMinutesBefore: 120,            // ballot seals two hours before kickoff
      picker: 'DrJ',                     // whose turn it is to choose this week
      rival: 'MW',                       // who inherits the other team
      teams: {
        ATL: { city: 'Atlanta', name: 'Falcons', full: 'Atlanta Falcons',
               logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/atl.png' },
        GB:  { city: 'Green Bay', name: 'Packers', full: 'Green Bay Packers',
               logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/gb.png' }
      },
      gameLinks: {
        gamecast: 'https://www.espn.com/nfl/game/_/gameId/401872948',
        boxscore: 'https://www.espn.com/nfl/boxscore/_/gameId/401872948',
        pbp: 'https://www.espn.com/nfl/playbyplay/_/gameId/401872948'
      }
    },

    scoreboardUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    pollMs: 30000,

    // Sync service (Cloudflare Worker). Leave base empty and the whole site
    // falls back to per-browser localStorage, which is how it shipped first.
    // Set it to your deployed worker URL to share state across devices:
    //   base: 'https://football-master-sync.<your-subdomain>.workers.dev'
    api: { base: 'https://football-master-sync.mwiteck.workers.dev' },

    // Logins live in the Worker's USERS secret now and are checked server
    // side, so nothing sensitive sits in this file. These entries are only
    // consulted when api.base above is empty (offline/local mode), which
    // is why they are deliberately blank.
    users: {},

    // The peon's tribute song. Drop the recording in assets/audio/ using any
    // of these extensions — the page finds whichever one is actually there.
    anthem: {
      dir: 'assets/audio/',
      basename: 'peon-anthem',
      formats: ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus']
    }
  };

  var EVT = CONFIG.upcoming.eventId;

  var STORE = {
    takes:   'fm.takes.v1',
    votes:   'fm.votes.v1',
    session: 'fm.session.v1',
    fan:     'fm.fanpoll.' + EVT,   // per-game so next week starts clean
    pick:    'fm.pick.' + EVT,
    ledger:  'fm.ledger.' + EVT,
    crown:   'fm.game.' + CONFIG.crown.eventId,
    upcoming:'fm.game.' + EVT
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- storage */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;   // private mode / blocked storage: the UI still works, it just forgets
    }
  }

  function houseRule() {
    return Object.keys(CONFIG.crown.people).map(function (abbr) {
      var p = CONFIG.crown.people[abbr];
      return p.team + ' ahead → ' + p.who + ' is Football Master.';
    }).join(' ');
  }

  /* ============================================================ SCORE FEED */

  /** Normalize either ESPN payload shape into one flat game object. */
  function parseCompetition(comp) {
    var away = null;
    var home = null;

    comp.competitors.forEach(function (c) {
      var team = c.team || {};
      var record = '';
      if (Array.isArray(c.record) && c.record.length) record = c.record[0].summary || '';
      else if (Array.isArray(c.records) && c.records.length) record = c.records[0].summary || '';

      var logo = team.logo;
      if (!logo && Array.isArray(team.logos) && team.logos.length) logo = team.logos[0].href;

      var side = {
        abbr: team.abbreviation || '',
        location: team.location || team.displayName || '',
        name: team.name || team.shortDisplayName || '',
        displayName: team.displayName || '',
        logo: logo || '',
        record: record,
        score: parseInt(c.score, 10)
      };
      if (isNaN(side.score)) side.score = 0;

      if (c.homeAway === 'home') home = side; else away = side;
    });

    var status = comp.status || {};
    var type = status.type || {};

    return {
      away: away,
      home: home,
      date: comp.date || '',
      state: type.state || 'pre',          // 'pre' | 'in' | 'post'
      completed: !!type.completed,
      detail: type.detail || type.shortDetail || '',
      shortDetail: type.shortDetail || '',
      period: status.period || 0,
      clock: status.displayClock || '',
      fetchedAt: Date.now()
    };
  }

  function fetchGame(cfg) {
    return fetch(cfg.summaryUrl, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('summary ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var comp = data && data.header && data.header.competitions && data.header.competitions[0];
        if (!comp) throw new Error('no competition in summary');
        var game = parseCompetition(comp);
        var venue = data.gameInfo && data.gameInfo.venue;
        if (venue) {
          var addr = venue.address || {};
          game.venue = [venue.fullName, [addr.city, addr.state].filter(Boolean).join(', ')]
            .filter(Boolean).join(' · ');
        }
        var b = data.broadcasts && data.broadcasts[0];
        if (b) game.tv = (b.media && b.media.shortName) || (b.names && b.names[0]) || '';
        return game;
      })
      .catch(function () {
        // Fallback: the league-wide scoreboard, in case the summary endpoint hiccups.
        return fetch(CONFIG.scoreboardUrl, { cache: 'no-store' })
          .then(function (res) {
            if (!res.ok) throw new Error('scoreboard ' + res.status);
            return res.json();
          })
          .then(function (data) {
            var events = (data && data.events) || [];
            for (var i = 0; i < events.length; i++) {
              if (events[i].id === cfg.eventId) return parseCompetition(events[i].competitions[0]);
            }
            throw new Error('game not on the scoreboard');
          });
      });
  }

  /* ================================================== THE CROWN (settled) */

  /** Who is Master, who is Peon, and how do we say it. */
  function resolveThrone(game) {
    var people = CONFIG.crown.people;
    var away = game.away;
    var home = game.home;
    var margin = Math.abs(away.score - home.score);
    var tied = away.score === home.score;
    var leader = tied ? null : (away.score > home.score ? away : home);
    var trailer = tied ? null : (leader === away ? home : away);
    var person = leader ? people[leader.abbr] : null;
    var loser = trailer ? people[trailer.abbr] : null;

    var out = {
      state: game.state,
      margin: margin,
      leader: leader,
      trailer: trailer,
      master: person ? person.who : 'TBD',
      peon: loser ? loser.who : 'TBD',
      masterTeam: leader,
      peonTeam: trailer
    };

    var scoreLine = leader
      ? leader.location + ' ' + leader.score + '–' + trailer.score + ' ' + trailer.location
      : away.location + ' ' + away.score + '–' + home.score + ' ' + home.location;

    if (game.state === 'pre') {
      out.chip = 'Pregame';
      out.headline = 'The throne is still vacant.';
      out.detail = houseRule();
      out.masterMeta = 'Awaiting kickoff';
      out.peonMeta = 'Awaiting kickoff';
    } else if (game.state === 'post') {
      out.chip = 'Final';
      if (tied) {
        out.headline = 'It ended in a tie — nobody takes the Football Master spot.';
        out.detail = 'Final: ' + scoreLine + '. Shared custody of the throne.';
        out.masterMeta = 'Tie game';
        out.peonMeta = 'Tie game';
      } else {
        out.headline = '<b>' + out.master + '</b> holds the Football Master spot.';
        out.detail = 'Final: ' + scoreLine + '. ' + out.peon + ' takes the Peon seat.';
        out.masterMeta = 'Won by ' + margin;
        out.peonMeta = 'Lost by ' + margin;
      }
    } else {
      out.chip = 'Live';
      if (tied) {
        out.headline = 'All square — the Football Master spot is up for grabs.';
        out.detail = scoreLine + ' · ' + (game.detail || 'in progress') + '.';
        out.masterMeta = 'Tied game';
        out.peonMeta = 'Tied game';
      } else {
        out.headline = '<b>' + out.master + '</b> is currently ahead for the Football Master spot.';
        out.detail = scoreLine + ' · ' + (game.detail || 'in progress') + '.';
        out.masterMeta = 'Up ' + margin + ' · ' + (game.shortDetail || 'live');
        out.peonMeta = 'Down ' + margin + ' · ' + (game.shortDetail || 'live');
      }
    }

    return out;
  }

  function setThrone(prefix, who, meta, team) {
    var nameEl = $(prefix + 'Name');
    nameEl.textContent = who;
    nameEl.classList.toggle('is-tbd', who === 'TBD');
    $(prefix + 'Meta').textContent = meta;

    var wrap = $(prefix + 'Team');
    if (team && team.displayName) {
      $(prefix + 'Logo').src = team.logo || '';
      $(prefix + 'TeamName').textContent = team.displayName + (team.record ? ' (' + team.record + ')' : '');
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }

  function renderCrown(game) {
    var verdict = resolveThrone(game);

    setThrone('master', verdict.master, verdict.masterMeta, verdict.masterTeam);
    setThrone('peon', verdict.peon, verdict.peonMeta, verdict.peonTeam);

    $('verdictChip').textContent = verdict.chip;
    $('verdictChip').setAttribute('data-state', game.state);
    $('verdictText').innerHTML = verdict.headline;
    $('verdictDetail').textContent = verdict.detail;
    $('verdictMini').hidden = game.state === 'pre';
    $('miniAwayAbbr').textContent = game.away.abbr;
    $('miniAwayScore').textContent = game.away.score;
    $('miniHomeAbbr').textContent = game.home.abbr;
    $('miniHomeScore').textContent = game.home.score;

    if (game.state === 'post' && verdict.leader) {
      $('crownedLine').innerHTML = 'Crowned on ' + CONFIG.crown.label + ': <b>' +
        verdict.leader.location + ' ' + verdict.leader.score + '–' + verdict.trailer.score + ' ' +
        verdict.trailer.location + '</b>';
    }

    castAnthem(verdict, game);
  }

  /* ================================================ THE UPCOMING GAME */

  function kickoffMs(game) {
    var iso = (game && game.date) || CONFIG.upcoming.kickoffISO;
    var t = Date.parse(iso);
    return isNaN(t) ? Date.parse(CONFIG.upcoming.kickoffISO) : t;
  }

  function lockMs(game) {
    return kickoffMs(game) - CONFIG.upcoming.lockMinutesBefore * 60000;
  }

  var latestUpcoming = null;

  function renderUpcoming(game) {
    latestUpcoming = game;
    var board = $('board');
    board.setAttribute('data-state', game.state);

    var leader = game.away.score === game.home.score ? null
      : (game.away.score > game.home.score ? game.away : game.home);

    ['away', 'home'].forEach(function (side) {
      var team = game[side];
      var col = $(side === 'away' ? 'awayCol' : 'homeCol');
      if (team.logo) $(side + 'Logo').src = team.logo;
      $(side + 'Logo').alt = team.displayName + ' logo';
      $(side + 'City').textContent = team.location;
      $(side + 'Team').textContent = team.name;
      $(side + 'Record').textContent = team.record || ' ';
      $(side + 'Score').textContent = game.state === 'pre' ? '–' : team.score;

      var tag = $(side + 'Tag');
      var leading = leader && leader.abbr === team.abbr && game.state !== 'pre';
      tag.hidden = !leading;
      tag.textContent = game.state === 'post' ? 'Winner' : 'Leading';
      col.classList.toggle('is-trailing',
        game.state !== 'pre' && !!leader && leader.abbr !== team.abbr);
    });

    $('gameState').textContent = game.state === 'in' ? 'Live now'
      : (game.state === 'post' ? 'Final' : 'Scheduled');
    $('gameClock').textContent = game.state === 'pre'
      ? CONFIG.upcoming.kickoffLabel : (game.detail || game.shortDetail || '');
    if (game.venue) $('gameVenue').textContent = game.venue;
    if (game.tv) $('gameTv').textContent = game.tv;

    var pct = game.state === 'post' ? 100 : Math.min(100, Math.round(((game.period || 0) / 4) * 100));
    $('gameBarFill').style.width = (game.state === 'pre' ? 0 : pct) + '%';

    var pulse = $('navPulse');
    pulse.setAttribute('data-state',
      game.state === 'in' ? 'live' : (game.state === 'post' ? 'final' : 'idle'));
    $('navStatus').textContent = game.state === 'pre'
      ? 'Thu · ' + CONFIG.upcoming.kickoffLabel
      : (game.state === 'in' ? 'Live · ' : 'Final · ') +
        game.away.abbr + ' ' + game.away.score + ' – ' + game.home.abbr + ' ' + game.home.score;

    $('updatedStamp').textContent = 'Updated ' +
      new Date(game.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('boardNote').hidden = true;

    tickCountdown();
    renderPick();
  }

  function renderError(err, cached) {
    $('navPulse').setAttribute('data-state', 'error');
    $('navStatus').textContent = 'Score unavailable';

    var note = $('boardNote');
    note.hidden = false;
    note.innerHTML = 'Live feed unreachable (' + String(err.message || err) + '). ' +
      (cached ? 'Showing the last data this browser saw. ' : '') +
      'Check the <a href="' + CONFIG.upcoming.gameLinks.gamecast + '" target="_blank" rel="noopener">ESPN Gamecast</a> ' +
      'or <a href="https://www.nfl.com/scores/" target="_blank" rel="noopener">NFL.com</a>.';
  }

  function refresh() {
    var btn = $('refreshBtn');
    btn.disabled = true;

    var crownJob = fetchGame(CONFIG.crown)
      .then(function (game) { save(STORE.crown, game); renderCrown(game); })
      .catch(function () {
        var cached = load(STORE.crown, null);
        if (cached) renderCrown(cached);
      });

    var upcomingJob = fetchGame(CONFIG.upcoming)
      .then(function (game) { save(STORE.upcoming, game); renderUpcoming(game); })
      .catch(function (err) {
        var cached = load(STORE.upcoming, null);
        if (cached) renderUpcoming(cached);
        renderError(err, !!cached);
      });

    var syncJob = DB.sync().then(function () {
      // Someone else may have picked, posted or voted since the last tick.
      renderLedger();
      renderFeed();
      renderFanPoll();
      renderPick();
    });

    return Promise.all([crownJob, upcomingJob, syncJob]).then(function () { btn.disabled = false; });
  }

  /* ================================================================ CLOCK */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function tickCountdown() {
    var now = Date.now();
    var kick = kickoffMs(latestUpcoming);
    var lock = lockMs(latestUpcoming);
    var left = kick - now;
    var wrap = $('countdown');

    if (left <= 0) {
      $('cdD').textContent = '00'; $('cdH').textContent = '00';
      $('cdM').textContent = '00'; $('cdS').textContent = '00';
      wrap.setAttribute('data-state', 'locked');
      $('cdLabel').textContent = latestUpcoming && latestUpcoming.state === 'post'
        ? 'Final at Lambeau Field' : 'Kickoff has arrived';
    } else {
      var secs = Math.floor(left / 1000);
      $('cdD').textContent = pad(Math.floor(secs / 86400));
      $('cdH').textContent = pad(Math.floor(secs / 3600) % 24);
      $('cdM').textContent = pad(Math.floor(secs / 60) % 60);
      $('cdS').textContent = pad(secs % 60);
      wrap.setAttribute('data-state', 'running');

      var toLock = lock - now;
      $('cdLabel').textContent = toLock > 0
        ? 'until kickoff · ballot seals in ' + humanGap(toLock)
        : 'until kickoff · the ballot is already sealed';
    }

    // lock chip
    var chip = $('lockChip');
    var lockLeft = lock - now;
    if (lockLeft <= 0) {
      chip.setAttribute('data-state', 'closed');
      chip.textContent = 'Ballot sealed';
    } else if (lockLeft < 6 * 3600000) {
      chip.setAttribute('data-state', 'closing');
      chip.textContent = 'Closes in ' + humanGap(lockLeft);
    } else {
      chip.setAttribute('data-state', 'open');
      chip.textContent = 'Ballot open';
    }
  }

  function humanGap(ms) {
    var mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm';
    return Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h';
  }

  function isLocked() { return Date.now() >= lockMs(latestUpcoming); }

  /* ================================================================== DB

     One store with two backends.

     Offline (CONFIG.api.base empty) everything lives in localStorage, exactly
     as it did before the Worker existed: it survives refreshes but never
     leaves the device.

     Online it all lives in Cloudflare KV behind the sync Worker, so DrJ's
     pick, the ledger, the takes and the votes are the same on every device.
     Writes carry a signed token; reads are public.

     Both backends are normalised to one shape so nothing downstream cares:
       { pick, ledger, takes, votes, fan }
     ====================================================================== */

  var DB = {
    online: !!(CONFIG.api && CONFIG.api.base),
    reachable: null,          // null = not tried yet
    state: { pick: null, ledger: [], takes: [], votes: {}, fan: {} },
    rules: null,              // server-declared picker/lockAt, when online
    session: null
  };

  function apiUrl(path) {
    return String(CONFIG.api.base).replace(/\/+$/, '') + path;
  }

  function apiCall(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (DB.session && DB.session.token) headers.Authorization = 'Bearer ' + DB.session.token;

    return fetch(apiUrl(path), {
      method: opts.method || 'GET',
      headers: headers,
      cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('http_' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /** Local storage shaped like the server payload. */
  function localState() {
    var fan = load(STORE.fan, null) || {};
    var counts = {};
    fanKeys().forEach(function (k) { if (fan[k]) counts[k] = fan[k]; });

    return {
      pick: load(STORE.pick, null),
      ledger: load(STORE.ledger, []),
      takes: load(STORE.takes, []),
      votes: load(STORE.votes, {}),
      fan: { counts: counts, mine: fan.choice || null }
    };
  }

  DB.loadSession = function () {
    DB.session = load(STORE.session, null);
    // A token from a previous deploy of the Worker is no use offline, and a
    // bare offline session is no use online.
    if (DB.online && DB.session && !DB.session.token) DB.session = null;
    return DB.session;
  };

  DB.sync = function () {
    if (!DB.online) {
      DB.state = localState();
      DB.reachable = true;
      return Promise.resolve(DB.state);
    }
    return apiCall('/state?game=' + encodeURIComponent(EVT))
      .then(function (data) {
        var s = data.state || {};
        DB.state = {
          pick: s.pick || null,
          ledger: s.ledger || [],
          takes: s.takes || [],
          votes: s.votes || {},
          fan: { counts: (s.fan && s.fan.counts) || {}, byUser: (s.fan && s.fan.byUser) || {} }
        };
        DB.rules = data.rules || null;
        DB.reachable = true;
        return DB.state;
      })
      .catch(function () {
        DB.reachable = false;
        return DB.state;
      });
  };

  DB.login = function (user, pass) {
    if (!DB.online) {
      var key = String(user || '').trim().toLowerCase();
      var entry = CONFIG.users[key];
      if (!entry || entry.pass !== pass) return Promise.resolve(null);
      DB.session = { who: entry.who, at: Date.now() };
      save(STORE.session, DB.session);
      return Promise.resolve(DB.session);
    }
    return apiCall('/login', { method: 'POST', body: { user: user, pass: pass } })
      .then(function (data) {
        DB.session = { who: data.who, token: data.token, at: Date.now() };
        save(STORE.session, DB.session);
        return DB.session;
      })
      .catch(function () { return null; });
  };

  DB.logout = function () {
    DB.session = null;
    try { localStorage.removeItem(STORE.session); } catch (e) { /* ignore */ }
  };

  DB.castPick = function (team) {
    if (!DB.session) return Promise.reject(new Error('unauthorized'));

    if (!DB.online) {
      var prev = DB.state.pick;
      var record = {
        team: team, by: DB.session.who, at: Date.now(),
        changes: prev ? (prev.changes || 0) + 1 : 0
      };
      var rows = DB.state.ledger.slice();
      rows.push({
        at: Date.now(), who: DB.session.who,
        kind: prev ? 'changed' : 'cast',
        from: prev ? prev.team : null, to: team
      });
      save(STORE.pick, record);
      save(STORE.ledger, rows);
      DB.state.pick = record;
      DB.state.ledger = rows;
      return Promise.resolve(DB.state);
    }

    return apiCall('/pick', { method: 'POST', body: { game: EVT, team: team } })
      .then(function () { return DB.sync(); });
  };

  DB.addTake = function (text) {
    if (!DB.online) {
      var mine = DB.state.takes.slice();
      mine.push({ id: 'u' + Date.now(), text: text, createdAt: Date.now() });
      save(STORE.takes, mine);
      DB.state.takes = mine;
      return Promise.resolve(DB.state);
    }
    if (!DB.session) return Promise.reject(new Error('unauthorized'));
    return apiCall('/take', { method: 'POST', body: { game: EVT, text: text } })
      .then(function () { return DB.sync(); });
  };

  DB.voteTake = function (id, dir) {
    if (!DB.online) {
      var votes = load(STORE.votes, {});
      votes[id] = votes[id] === dir ? 0 : dir;
      save(STORE.votes, votes);
      DB.state.votes = votes;
      return Promise.resolve(DB.state);
    }
    if (!DB.session) return Promise.reject(new Error('unauthorized'));
    var next = DB.myVote(id) === dir ? 0 : dir;
    return apiCall('/vote', { method: 'POST', body: { game: EVT, id: id, dir: next } })
      .then(function () { return DB.sync(); });
  };

  DB.castFan = function (team) {
    if (!DB.online) {
      var fan = load(STORE.fan, null) || { choice: null };
      fanKeys().forEach(function (k) { if (typeof fan[k] !== 'number') fan[k] = 0; });
      if (fan.choice === team) return Promise.resolve(DB.state);
      if (fan.choice) fan[fan.choice] = Math.max(0, fan[fan.choice] - 1);
      fan[team] += 1;
      fan.choice = team;
      save(STORE.fan, fan);
      DB.state = localState();
      return Promise.resolve(DB.state);
    }
    if (!DB.session) return Promise.reject(new Error('unauthorized'));
    return apiCall('/fan', { method: 'POST', body: { game: EVT, team: team } })
      .then(function () { return DB.sync(); });
  };

  /* ---- shape helpers, so renderers never branch on the backend ---- */

  /** Net score contributed by stored votes for one take. */
  DB.voteSum = function (id) {
    var v = DB.state.votes[id];
    if (v == null) return 0;
    if (typeof v === 'number') return v;                 // offline: one voter
    return Object.keys(v).reduce(function (n, who) { return n + (v[who] || 0); }, 0);
  };

  /** This viewer's own direction on a take: 1, -1 or 0. */
  DB.myVote = function (id) {
    var v = DB.state.votes[id];
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (!DB.session) return 0;
    return v[DB.session.who] || 0;
  };

  DB.fanCount = function (team) {
    return (DB.state.fan.counts && DB.state.fan.counts[team]) || 0;
  };

  DB.myFan = function () {
    if (!DB.online) return DB.state.fan.mine || null;
    if (!DB.session) return null;
    return (DB.state.fan.byUser && DB.state.fan.byUser[DB.session.who]) || null;
  };

  /** Writes need an identity only when there is a server to talk to. */
  DB.needsLoginToPost = function () { return DB.online && !DB.session; };

  function syncChipText() {
    var chip = $('syncChip');
    if (!chip) return;
    if (!DB.online) {
      chip.setAttribute('data-state', 'local');
      chip.textContent = 'This device only';
      chip.title = 'No sync server configured — picks and takes stay in this browser.';
    } else if (DB.reachable === false) {
      chip.setAttribute('data-state', 'down');
      chip.textContent = 'Sync offline';
      chip.title = 'The sync service did not answer. Showing the last data this browser received.';
    } else {
      chip.setAttribute('data-state', 'synced');
      chip.textContent = 'Synced';
      chip.title = 'Picks, takes and votes are shared across devices.';
    }
  }

  /* ============================================================== THE PICK */

  function session() { return DB.session; }
  function currentPick() { return DB.state.pick; }
  function ledger() { return DB.state.ledger || []; }

  function teamOf(abbr) { return CONFIG.upcoming.teams[abbr] || { full: abbr, name: abbr, logo: '' }; }

  function otherTeam(abbr) {
    var keys = Object.keys(CONFIG.upcoming.teams);
    return keys[0] === abbr ? keys[1] : keys[0];
  }

  var marked = null;   // team marked on the ballot but not yet sealed

  function setStage(stage) { $('pickStage').setAttribute('data-stage', stage); }

  function showPanels(which) {
    ['authPanel', 'ballotPanel', 'tubePanel', 'revealPanel', 'closedPanel'].forEach(function (id) {
      $(id).hidden = (id !== which);
    });
  }

  /** One place decides what the pick section looks like. */
  function renderPick(stageOverride) {
    var s = session();
    var pick = currentPick();
    var locked = isLocked();

    if (stageOverride === 'transit') { setStage('transit'); showPanels('tubePanel'); return; }

    // Locked with no pick on file: nothing to do but say so.
    if (locked && !pick) {
      setStage('closed');
      showPanels('closedPanel');
      $('closedHint').textContent = 'Voting closed two hours before kickoff and no pick was filed.';
      return;
    }

    if (pick) {
      setStage('result');
      showPanels('revealPanel');
      renderReveal(pick, locked);
      return;
    }

    if (!s) {
      setStage('auth');
      showPanels('authPanel');
      return;
    }

    setStage('ballot');
    showPanels('ballotPanel');
    $('whoName').textContent = s.who;

    var isPicker = s.who === CONFIG.upcoming.picker;
    var note = $('spectatorNote');
    note.hidden = isPicker;
    if (!isPicker) {
      note.innerHTML = '<b>' + s.who + '</b>, this one is not yours. ' + CONFIG.upcoming.picker +
        ' picks this week and you inherit whatever is left. You can watch, but the pen stays capped.';
    }

    Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (btn) {
      btn.disabled = !isPicker;
      btn.classList.toggle('is-marked', marked === btn.getAttribute('data-team'));
    });

    var paper = $('paper');
    paper.classList.remove('is-sealing');
    paper.classList.toggle('is-signed', !!marked && isPicker);
    $('paperSig').textContent = marked && isPicker ? s.who : '';

    $('sealBtn').disabled = !isPicker || !marked;
    $('ballotHint').textContent = !isPicker
      ? 'Only ' + CONFIG.upcoming.picker + ' can file a ballot this week.'
      : (marked ? 'Signed. Send it down the tube.' : 'Mark a team to sign the ballot.');
  }

  function renderReveal(pick, locked) {
    var team = teamOf(pick.team);
    var other = teamOf(otherTeam(pick.team));

    $('revealLogo').src = team.logo;
    $('revealLogo').alt = team.full + ' logo';
    $('revealTeam').textContent = team.full;
    $('revealBy').textContent = pick.by;
    $('revealOther').textContent = CONFIG.upcoming.rival + ' gets the ' + other.full + '.';

    var when = new Date(pick.at);
    $('revealStamp').textContent = 'Filed ' + when.toLocaleString([], {
      weekday: 'short', hour: 'numeric', minute: '2-digit'
    }) + (pick.changes ? ' · changed ' + pick.changes + (pick.changes === 1 ? ' time' : ' times') : '');

    var s = session();
    var canChange = !locked && s && s.who === CONFIG.upcoming.picker;
    $('changeBtn').hidden = !canChange;
    $('changeBtn').textContent = 'Change the pick';

    // Re-run the zoom so a fresh delivery lands with impact.
    var card = $('revealCard');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

    // Mirror the decision up in the hero strip.
    $('nextUpText').innerHTML = CONFIG.upcoming.teams.ATL.name + ' at ' + CONFIG.upcoming.teams.GB.name +
      ' &middot; <b>' + pick.by + '</b> picked the <b>' + team.name + '</b>';
  }

  /* ---- the delivery animation ---- */

  var TRANSIT_MS = 3400;
  var transitTimers = [];

  function clearTransit() {
    transitTimers.forEach(clearTimeout);
    transitTimers = [];
  }

  function runDelivery(onDone) {
    clearTransit();
    var paper = $('paper');
    paper.classList.add('is-sealing');
    $('tubeStatus').textContent = 'Sealing the ballot…';

    transitTimers.push(setTimeout(function () {
      renderPick('transit');
      $('tubeStatus').textContent = 'Ballot in the tube…';

      var motion = $('podMotion');
      if (motion && typeof motion.beginElement === 'function') {
        try { motion.beginElement(); } catch (e) { /* SMIL unavailable; the timer still carries us */ }
      }

      transitTimers.push(setTimeout(function () {
        $('tubeStatus').textContent = 'Delivered to the vault';
        transitTimers.push(setTimeout(onDone, 500));
      }, TRANSIT_MS));
    }, 560));
  }

  function castPick(team) {
    var s = session();
    if (!s || s.who !== CONFIG.upcoming.picker) return;
    if (isLocked()) { renderPick(); return; }

    // Start the delivery immediately; the write rides along with it.
    var written = DB.castPick(team).then(function () { return true; }, function (err) { return err; });

    runDelivery(function () {
      written.then(function (result) {
        marked = null;
        renderLedger();
        renderPick();
        if (result !== true) {
          var why = (result && result.message) || 'write_failed';
          var note = why === 'ballot_sealed' ? 'The server sealed the ballot before that landed.'
            : why === 'not_your_turn' ? 'The server says it is not your turn this week.'
            : why === 'unauthorized' ? 'Sign in again to file this pick.'
            : 'The pick could not be saved to the sync service, so it is not shared yet.';
          $('revealStamp').textContent = note;
        }
      });
    });
  }

  /* ---- ledger ---- */

  function renderLedger() {
    var rows = ledger().slice().reverse();   // newest first
    syncChipText();
    var list = $('ledgerList');
    list.innerHTML = '';

    $('ledgerCount').textContent = rows.length + (rows.length === 1 ? ' entry' : ' entries');

    if (!rows.length) {
      var empty = document.createElement('li');
      empty.className = 'ledger__empty';
      empty.textContent = 'No ballot filed yet for this game.';
      list.appendChild(empty);
      return;
    }

    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'ledger__row';

      var badge = document.createElement('span');
      badge.className = 'ledger__badge';
      badge.setAttribute('data-kind', row.kind);
      badge.textContent = row.kind === 'changed' ? 'Changed' : 'Cast';

      var what = document.createElement('span');
      what.className = 'ledger__what';
      var toName = teamOf(row.to).full;
      what.innerHTML = row.kind === 'changed' && row.from
        ? '<b>' + row.who + '</b> moved off the ' + teamOf(row.from).name + ' to the <b>' + toName + '</b>'
        : '<b>' + row.who + '</b> picked the <b>' + toName + '</b>';

      var when = document.createElement('span');
      when.className = 'ledger__when';
      when.textContent = new Date(row.at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });

      li.appendChild(badge);
      li.appendChild(what);
      li.appendChild(when);
      list.appendChild(li);
    });
  }

  function ledgerText() {
    var rows = ledger();
    if (!rows.length) return 'Football Master ledger — no entries yet.';
    return ['Football Master — ballot ledger',
            CONFIG.upcoming.label + ' · Falcons at Packers', ''].concat(
      rows.map(function (r, i) {
        return (i + 1) + '. ' + new Date(r.at).toLocaleString() + ' — ' + r.who + ' ' +
          (r.kind === 'changed' ? 'changed to ' : 'picked ') + teamOf(r.to).full +
          (r.from ? ' (was ' + teamOf(r.from).full + ')' : '');
      })
    ).join('\n');
  }

  function copyLedger() {
    var text = ledgerText();
    var btn = $('ledgerCopy');
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* nothing else to try */ }
      document.body.removeChild(ta);
    }
  }

  /* ---- auth ---- */

  function signOut() {
    DB.logout();
    marked = null;
    renderFeed();
    renderFanPoll();
    renderPick();
  }

  /* ============================================================= FAN POLL */

  function fanKeys() { return Object.keys(CONFIG.upcoming.teams); }   // ['ATL','GB']

  function renderFanPoll() {
    var k = fanKeys();
    var mine = DB.myFan();
    var a = DB.fanCount(k[0]);
    var h = DB.fanCount(k[1]);
    var total = a + h;
    var aPct = total ? Math.round((a / total) * 100) : 50;

    $('ballotFill').style.width = aPct + '%';
    $('ballotAwayPct').textContent = aPct + '%';
    $('ballotHomePct').textContent = (total ? 100 - aPct : 50) + '%';
    $('ballotTotal').textContent = total + (total === 1 ? ' vote' : ' votes');
    $('fanHint').textContent = DB.needsLoginToPost()
      ? 'Sign in under The Pick to vote \u2014 tallies are shared between you two.'
      : (mine ? 'You picked the ' + teamOf(mine).name + '. Tap the other side to switch.'
              : (DB.online ? 'Tap a side to vote. Tallies are shared across devices.'
                           : 'Tap a side to vote. Tallies are stored in your browser.'));

    Array.prototype.forEach.call(document.querySelectorAll('[data-ballot]'), function (el) {
      var isMine = mine === el.getAttribute('data-ballot');
      el.classList.toggle('is-voted', isMine);
      el.setAttribute('aria-pressed', String(isMine));
    });
  }

  function castFanVote(choice) {
    if (DB.needsLoginToPost()) { nudgeLogin(); return; }
    DB.castFan(choice).then(renderFanPoll, function () { renderFanPoll(); });
  }

  /** Point someone at the login when a write needs an identity. */
  function nudgeLogin() {
    var target = $('pick');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var err = $('authError');
    if (err && !$('authPanel').hidden) {
      err.hidden = false;
      err.textContent = 'Sign in first \u2014 posts and votes are shared, so they need a name on them.';
    }
  }

  /* ========================================================== PEON'S ANTHEM */

  var anthemEls = {};

  function anthemCandidates() {
    return CONFIG.anthem.formats.map(function (ext) {
      return CONFIG.anthem.dir + CONFIG.anthem.basename + '.' + ext;
    });
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /**
   * Find the recording without knowing its format: HEAD each candidate over
   * http(s); off a file:// page HEAD is blocked, so let an <audio> element
   * decide by trying to read each file's metadata.
   */
  function findAnthemFile() {
    var urls = anthemCandidates();
    var overHttp = /^https?:$/.test(location.protocol);

    function viaHead(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetch(urls[i], { method: 'HEAD', cache: 'no-store' })
        .then(function (res) { return res.ok ? urls[i] : viaHead(i + 1); })
        .catch(function () { return viaHead(i + 1); });
    }

    function viaAudio(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return new Promise(function (resolve) {
        var probe = new Audio();
        probe.preload = 'metadata';
        probe.onloadedmetadata = function () { resolve(urls[i]); };
        probe.onerror = function () { resolve(null); };
        probe.src = urls[i];
      }).then(function (hit) { return hit || viaAudio(i + 1); });
    }

    return overHttp ? viaHead(0) : viaAudio(0);
  }

  function setAnthemState(state) { anthemEls.wrap.setAttribute('data-state', state); }

  function armAnthem(url) {
    var audio = anthemEls.audio;

    anthemEls.play.disabled = false;
    anthemEls.seek.disabled = false;
    anthemEls.playLabel.textContent = 'Play the anthem';
    anthemEls.note.textContent = 'Tribute delivered. Volume is the peon’s problem now.';
    anthemEls.download.href = url;
    anthemEls.download.hidden = false;
    setAnthemState('ready');

    anthemEls.play.addEventListener('click', function () {
      if (audio.paused) {
        audio.play().catch(function () {
          anthemEls.note.textContent = 'Your browser blocked playback — tap play once more.';
        });
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', function () {
      setAnthemState('playing');
      anthemEls.playLabel.textContent = 'Pause the anthem';
    });

    audio.addEventListener('pause', function () {
      setAnthemState('ready');
      anthemEls.playLabel.textContent = 'Resume the anthem';
    });

    audio.addEventListener('ended', function () {
      setAnthemState('ready');
      anthemEls.playLabel.textContent = 'Play it again';
      anthemEls.seek.value = 0;
      anthemEls.seek.style.setProperty('--progress', '0%');
      anthemEls.now.textContent = '0:00';
    });

    ['loadedmetadata', 'durationchange'].forEach(function (evt) {
      audio.addEventListener(evt, function () {
        anthemEls.dur.textContent = fmtTime(audio.duration);
      });
    });

    audio.addEventListener('timeupdate', function () {
      if (!audio.duration) return;
      var pct = (audio.currentTime / audio.duration) * 100;
      anthemEls.seek.value = pct;
      anthemEls.seek.style.setProperty('--progress', pct + '%');
      anthemEls.now.textContent = fmtTime(audio.currentTime);
    });

    audio.addEventListener('error', function () {
      setAnthemState('pending');
      anthemEls.play.disabled = true;
      anthemEls.seek.disabled = true;
      anthemEls.playLabel.textContent = 'Recording unavailable';
      anthemEls.note.textContent = 'The file is there but this browser cannot play it. Try the download link.';
    });

    anthemEls.seek.addEventListener('input', function () {
      if (!audio.duration) return;
      audio.currentTime = (anthemEls.seek.value / 100) * audio.duration;
      anthemEls.seek.style.setProperty('--progress', anthemEls.seek.value + '%');
    });

    // Listeners first, then the source, so a fast (cached) load can't slip past them.
    audio.src = url;
  }

  /** Name the singer and the crown once the game is final. */
  function castAnthem(verdict, game) {
    if (!anthemEls.wrap) return;
    var known = verdict.master !== 'TBD' && verdict.peon !== 'TBD';

    if (game.state === 'post' && known) {
      anthemEls.kicker.textContent = 'This week’s tribute';
      anthemEls.title.textContent = verdict.peon + ' sings for ' + verdict.master;
      anthemEls.sub.textContent = verdict.peon + ' lost the throne and owes the Football Master a song. ' +
        'Payment is non-negotiable.';
    } else {
      anthemEls.kicker.textContent = 'This week’s tribute';
      anthemEls.title.textContent = 'The Peon’s Anthem';
      anthemEls.sub.textContent = 'The loser sings the praises of the Football Master. Those are the rules.';
    }
  }

  function initAnthem() {
    anthemEls = {
      wrap: $('anthem'), audio: $('anthemAudio'), play: $('anthemPlay'),
      playLabel: $('anthemPlayLabel'), seek: $('anthemSeek'), now: $('anthemNow'),
      dur: $('anthemDur'), note: $('anthemNote'), kicker: $('anthemKicker'),
      title: $('anthemTitle'), sub: $('anthemSub'), download: $('anthemDownload')
    };
    if (!anthemEls.wrap) return;
    findAnthemFile().then(function (url) { if (url) armAnthem(url); });
  }

  /* ========================================================== VOTING FLOOR */

  var HOUR = 3600000;

  // Seeded debate topics. Scores are demo starting values; real votes stack on top.
  var SEED_TAKES = [
    { id: 't1', text: 'Lambeau on a short week is where visiting teams go to disappear.', side: null, base: 38, agoH: 3, link: CONFIG.upcoming.gameLinks.gamecast, linkLabel: 'Gamecast' },
    { id: 't2', text: 'Atlanta is 0-2 and desperate. Desperate teams cover on Thursday.', side: null, base: 31, agoH: 5, link: 'https://www.espn.com/nfl/team/_/name/atl/atlanta-falcons', linkLabel: 'Falcons hub' },
    { id: 't3', text: 'Green Bay at home in prime time is the safest pick on the board. DrJ takes it and sleeps fine.', side: 'DrJ', base: 27, agoH: 7, link: 'https://www.espn.com/nfl/team/_/name/gb/green-bay-packers', linkLabel: 'Packers hub' },
    { id: 't4', text: 'Whoever wins the turnover battle wins this game. It is not more complicated than that.', side: null, base: 19, agoH: 9, link: CONFIG.upcoming.gameLinks.pbp, linkLabel: 'Play-by-play' },
    { id: 't5', text: 'MW got handed the leftovers this week and will somehow still be insufferable about it.', side: 'MW', base: 16, agoH: 11, link: CONFIG.upcoming.gameLinks.boxscore, linkLabel: 'Box score' },
    { id: 't6', text: 'The real question is who is singing next Sunday. Start warming up now.', side: null, base: 13, agoH: 13, link: 'https://www.nfl.com/standings/', linkLabel: 'Standings' }
  ];

  var sortMode = 'hot';

  function allTakes() {
    var now = Date.now();
    var seeded = SEED_TAKES.map(function (t) {
      return {
        id: t.id, text: t.text, side: t.side, base: t.base,
        createdAt: now - t.agoH * HOUR, link: t.link, linkLabel: t.linkLabel
      };
    });
    var posted = (DB.state.takes || []).map(function (t) {
      return {
        id: t.id, text: t.text,
        side: t.by || 'You',            // shared takes carry their author
        base: 1, createdAt: t.createdAt, link: null, linkLabel: null
      };
    });
    return seeded.concat(posted);
  }

  function scoreOf(take) { return take.base + DB.voteSum(take.id); }

  function sortTakes(takes) {
    var now = Date.now();
    return takes.slice().sort(function (a, b) {
      if (sortMode === 'new') return b.createdAt - a.createdAt;
      if (sortMode === 'top') return scoreOf(b) - scoreOf(a);
      var hot = function (t) {
        var hours = Math.max(0.5, (now - t.createdAt) / HOUR);
        return scoreOf(t) / Math.pow(hours + 2, 0.55);
      };
      return hot(b) - hot(a);
    });
  }

  function timeAgo(ts) {
    var mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function renderFeed() {
    var list = sortTakes(allTakes());
    var feed = $('feed');
    feed.innerHTML = '';

    var composer = $('takeInput');
    var locked = DB.needsLoginToPost();
    composer.placeholder = locked
      ? 'Sign in under The Pick to post a take\u2026'
      : 'Drop your hot take on Thursday\u2019s game\u2026';

    var note = $('feedNote');
    if (note) {
      note.textContent = !DB.online
        ? 'Takes and votes are saved in this browser only.'
        : (DB.reachable === false
            ? 'The sync service is not answering, so this is the last shared copy this browser saw.'
            : 'Takes and votes are shared \u2014 you both see the same board.');
    }

    list.forEach(function (take, index) {
      var li = document.createElement('li');
      li.className = 'take' + (index === 0 ? ' is-top' : '');

      var votesWrap = document.createElement('div');
      votesWrap.className = 'take__votes';

      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'vote vote--up';
      up.innerHTML = '&#9650;';
      up.title = 'Upvote';
      up.setAttribute('aria-label', 'Upvote: ' + take.text);
      up.setAttribute('aria-pressed', String(DB.myVote(take.id) === 1));

      var scoreEl = document.createElement('span');
      scoreEl.className = 'take__score';
      scoreEl.textContent = scoreOf(take);

      var down = document.createElement('button');
      down.type = 'button';
      down.className = 'vote vote--down';
      down.innerHTML = '&#9660;';
      down.title = 'Downvote';
      down.setAttribute('aria-label', 'Downvote: ' + take.text);
      down.setAttribute('aria-pressed', String(DB.myVote(take.id) === -1));

      up.addEventListener('click', function () { vote(take.id, 1); });
      down.addEventListener('click', function () { vote(take.id, -1); });

      votesWrap.appendChild(up);
      votesWrap.appendChild(scoreEl);
      votesWrap.appendChild(down);

      var body = document.createElement('div');
      body.className = 'take__body';

      var text = document.createElement('p');
      text.className = 'take__text';
      text.textContent = take.text;

      var meta = document.createElement('div');
      meta.className = 'take__meta';

      if (take.side) {
        var badge = document.createElement('span');
        badge.className = 'take__badge';
        badge.setAttribute('data-side', take.side);
        badge.textContent = take.side === 'You' ? 'Your take'
          : (take.side === 'MW' || take.side === 'DrJ') ? take.side : 'Team ' + take.side;
        meta.appendChild(badge);
      }

      var when = document.createElement('span');
      when.textContent = timeAgo(take.createdAt);
      meta.appendChild(when);

      if (take.link) {
        var a = document.createElement('a');
        a.href = take.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = take.linkLabel + ' ↗';
        meta.appendChild(a);
      }

      body.appendChild(text);
      body.appendChild(meta);
      li.appendChild(votesWrap);
      li.appendChild(body);
      feed.appendChild(li);
    });
  }

  function vote(id, direction) {
    if (DB.needsLoginToPost()) { nudgeLogin(); return; }
    DB.voteTake(id, direction).then(renderFeed, function () { renderFeed(); });
  }

  function addTake(text) {
    if (DB.needsLoginToPost()) { nudgeLogin(); return; }
    DB.addTake(text).then(function () {
      sortMode = 'new';
      Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-sort') === 'new');
      });
      renderFeed();
    }, function () { renderFeed(); });
  }

  /* ================================================================== init */

  function wirePick() {
    $('authForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('authError');
      var btn = $('authForm').querySelector('button[type="submit"]');
      btn.disabled = true;

      DB.login($('authUser').value, $('authPass').value).then(function (s) {
        btn.disabled = false;
        if (!s) {
          err.hidden = false;
          err.textContent = DB.online && DB.reachable === false
            ? 'The sync service did not answer, so the login could not be checked.'
            : 'That login and password do not match anyone on the roster.';
          return;
        }
        err.hidden = true;
        $('authPass').value = '';
        // Signing in changes what this viewer owns, so redraw everything.
        DB.sync().then(function () {
          renderLedger();
          renderFeed();
          renderFanPoll();
          renderPick();
        });
      });
    });

    $('signOut').addEventListener('click', signOut);

    Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        marked = btn.getAttribute('data-team');
        renderPick();
      });
    });

    $('sealBtn').addEventListener('click', function () {
      if (!marked) return;
      castPick(marked);
    });

    $('changeBtn').addEventListener('click', function () {
      if (isLocked()) { renderPick(); return; }
      marked = null;
      var pick = currentPick();
      if (pick) marked = pick.team;
      setStage('ballot');
      showPanels('ballotPanel');
      renderPickBallotOnly();
    });

    $('replayBtn').addEventListener('click', function () {
      runDelivery(function () { renderPick(); });
    });

    $('ledgerCopy').addEventListener('click', copyLedger);
  }

  /** Change-the-pick reopens the ballot even though a pick already exists. */
  function renderPickBallotOnly() {
    var s = session();
    if (!s) { renderPick(); return; }
    $('whoName').textContent = s.who;
    $('spectatorNote').hidden = true;

    Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (btn) {
      btn.disabled = false;
      btn.classList.toggle('is-marked', marked === btn.getAttribute('data-team'));
    });

    var paper = $('paper');
    paper.classList.remove('is-sealing');
    paper.classList.toggle('is-signed', !!marked);
    $('paperSig').textContent = marked ? s.who : '';
    $('sealBtn').disabled = !marked;
    $('ballotHint').textContent = marked
      ? 'Mark a different team, or send this one again.'
      : 'Mark a team to sign the ballot.';
  }

  function init() {
    $('refreshBtn').addEventListener('click', refresh);

    Array.prototype.forEach.call(document.querySelectorAll('[data-ballot]'), function (el) {
      el.addEventListener('click', function () { castFanVote(el.getAttribute('data-ballot')); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (el) {
      el.addEventListener('click', function () {
        sortMode = el.getAttribute('data-sort');
        Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
          b.classList.remove('is-active');
        });
        el.classList.add('is-active');
        renderFeed();
      });
    });

    $('composer').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('takeInput');
      var text = input.value.trim();
      if (!text) return;
      addTake(text);
      input.value = '';
    });

    wirePick();

    initAnthem();
    DB.loadSession();

    DB.sync().then(function () {
      renderFanPoll();
      renderFeed();
      renderLedger();
      renderPick();
    });

    tickCountdown();
    refresh();

    setInterval(tickCountdown, 1000);
    setInterval(refresh, CONFIG.pollMs);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
