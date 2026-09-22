/* ==========================================================================
   Football Master — app logic
   - Pulls the live Giants @ Rams score from ESPN's public scoreboard API
   - Maps the leader onto the Master / Peon thrones (LAR -> MW, NYG -> DrJ)
   - Runs the local voting floor (takes + ballot, persisted in localStorage)
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  var CONFIG = {
    eventId: '401872947', // Giants @ Rams, Mon Sep 21 2026, 5:15 PM PT
    summaryUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872947',
    scoreboardUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    pollMs: 30000,
    kickoff: '5:15 PM PT',
    network: 'ESPN & ABC',
    // The whole point of the site: which team crowns which person.
    people: {
      LAR: { who: 'MW', team: 'Los Angeles Rams' },
      NYG: { who: 'DrJ', team: 'New York Giants' }
    },
    gameLinks: {
      gamecast: 'https://www.espn.com/nfl/game/_/gameId/401872947',
      boxscore: 'https://www.espn.com/nfl/boxscore/_/gameId/401872947',
      pbp: 'https://www.espn.com/nfl/playbyplay/_/gameId/401872947'
    },
    // The peon's tribute song. Drop the recording in assets/audio/ using any
    // of these extensions — the page finds whichever one is actually there.
    anthem: {
      dir: 'assets/audio/',
      basename: 'peon-anthem',
      formats: ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus']
    }
  };

  /** "Los Angeles Rams leads -> MW is Football Master. ..." — built from the map above. */
  function houseRule() {
    return Object.keys(CONFIG.people).map(function (abbr) {
      var p = CONFIG.people[abbr];
      return p.team + ' ahead → ' + p.who + ' is Football Master.';
    }).join(' ');
  }

  var STORE = { takes: 'fm.takes.v1', votes: 'fm.votes.v1', ballot: 'fm.ballot.v1', game: 'fm.game.v1' };

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
    } catch (err) {
      /* private mode / blocked storage — the UI still works, it just forgets */
    }
  }

  /* ============================================================== LIVE GAME */

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
      state: type.state || 'pre',          // 'pre' | 'in' | 'post'
      completed: !!type.completed,
      detail: type.detail || type.shortDetail || '',
      shortDetail: type.shortDetail || '',
      period: status.period || 0,
      clock: status.displayClock || '',
      fetchedAt: Date.now()
    };
  }

  function fetchGame() {
    return fetch(CONFIG.summaryUrl, { cache: 'no-store' })
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
            var event = null;
            for (var i = 0; i < events.length; i++) {
              if (events[i].id === CONFIG.eventId) { event = events[i]; break; }
            }
            if (!event) throw new Error('game not on today’s scoreboard');
            return parseCompetition(event.competitions[0]);
          });
      });
  }

  /** Who is Master, who is Peon, and how do we say it. */
  function resolveThrone(game) {
    var away = game.away;
    var home = game.home;
    var margin = Math.abs(away.score - home.score);
    var tied = away.score === home.score;
    var leader = tied ? null : (away.score > home.score ? away : home);
    var trailer = tied ? null : (leader === away ? home : away);
    var person = leader ? CONFIG.people[leader.abbr] : null;
    var loser = trailer ? CONFIG.people[trailer.abbr] : null;

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
      out.detail = away.name + ' at ' + home.name + ' kicks off at ' + CONFIG.kickoff +
        ' on ' + CONFIG.network + '. ' + houseRule();
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
        out.headline = '<b>' + out.master + '</b> has locked in the Football Master spot.';
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

  function renderGame(game) {
    var verdict = resolveThrone(game);
    var board = $('board');

    board.setAttribute('data-state', game.state);

    // Thrones
    setThrone('master', verdict.master, verdict.masterMeta, verdict.masterTeam);
    setThrone('peon', verdict.peon, verdict.peonMeta, verdict.peonTeam);

    // Verdict panel
    $('verdictChip').textContent = verdict.chip;
    $('verdictChip').setAttribute('data-state', game.state);
    $('verdictText').innerHTML = verdict.headline;
    $('verdictDetail').textContent = verdict.detail;
    $('verdictMini').hidden = game.state === 'pre';
    $('miniAwayAbbr').textContent = game.away.abbr;
    $('miniAwayScore').textContent = game.away.score;
    $('miniHomeAbbr').textContent = game.home.abbr;
    $('miniHomeScore').textContent = game.home.score;

    // Scoreboard
    ['away', 'home'].forEach(function (side) {
      var team = game[side];
      var col = $(side === 'away' ? 'awayCol' : 'homeCol');
      $(side + 'Logo').src = team.logo || $(side + 'Logo').src;
      $(side + 'Logo').alt = team.displayName + ' logo';
      $(side + 'City').textContent = team.location;
      $(side + 'Team').textContent = team.name;
      $(side + 'Record').textContent = team.record || ' ';
      $(side + 'Score').textContent = game.state === 'pre' ? '–' : team.score;

      var leading = verdict.leader && verdict.leader.abbr === team.abbr;
      var tag = $(side + 'Tag');
      tag.hidden = !(leading && game.state !== 'pre');
      tag.textContent = game.state === 'post' ? 'Winner' : 'Leading';
      col.classList.toggle('is-trailing', game.state !== 'pre' && !!verdict.trailer && verdict.trailer.abbr === team.abbr);
    });

    $('gameState').textContent = game.state === 'in' ? 'Live now' : (game.state === 'post' ? 'Final' : 'Scheduled');
    $('gameClock').textContent = game.state === 'pre' ? CONFIG.kickoff : (game.detail || game.shortDetail || '');
    if (game.venue) $('gameVenue').textContent = game.venue;
    if (game.tv) $('gameTv').textContent = game.tv;

    var pct = game.state === 'post' ? 100 : Math.min(100, Math.round(((game.period || 0) / 4) * 100));
    $('gameBarFill').style.width = (game.state === 'pre' ? 0 : pct) + '%';

    // Nav pill
    var pulse = $('navPulse');
    var navState = game.state === 'in' ? 'live' : (game.state === 'post' ? 'final' : 'idle');
    pulse.setAttribute('data-state', navState);
    $('navStatus').textContent = game.state === 'in'
      ? 'Live · ' + game.away.abbr + ' ' + game.away.score + ' – ' + game.home.abbr + ' ' + game.home.score
      : (game.state === 'post' ? 'Final · ' + game.away.abbr + ' ' + game.away.score + ' – ' + game.home.abbr + ' ' + game.home.score
        : 'Kickoff ' + CONFIG.kickoff);

    castAnthem(verdict, game);

    $('updatedStamp').textContent = 'Updated ' + new Date(game.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('boardNote').hidden = true;
  }

  function renderError(err, cached) {
    $('navPulse').setAttribute('data-state', 'error');
    $('navStatus').textContent = 'Score unavailable';

    var note = $('boardNote');
    note.hidden = false;
    note.innerHTML = 'Live score feed unreachable (' + String(err.message || err) + '). ' +
      (cached ? 'Showing the last score this browser saw. ' : '') +
      'Check the <a href="' + CONFIG.gameLinks.gamecast + '" target="_blank" rel="noopener">ESPN Gamecast</a> ' +
      'or <a href="https://www.nfl.com/scores/" target="_blank" rel="noopener">NFL.com</a>.';

    if (!cached) {
      $('gameState').textContent = 'Unavailable';
      $('gameClock').textContent = '—';
      $('verdictText').textContent = 'Waiting on a live score.';
      $('verdictDetail').textContent = houseRule();
    }
  }

  function refresh() {
    var btn = $('refreshBtn');
    btn.disabled = true;
    return fetchGame()
      .then(function (game) {
        save(STORE.game, game);
        renderGame(game);
      })
      .catch(function (err) {
        var cached = load(STORE.game, null);
        if (cached) renderGame(cached);
        renderError(err, !!cached);
      })
      .then(function () { btn.disabled = false; });
  }

  /* ================================================================ BALLOT */

  function renderBallot() {
    var b = load(STORE.ballot, { MW: 0, DrJ: 0, choice: null });
    var total = b.MW + b.DrJ;
    var mwPct = total ? Math.round((b.MW / total) * 100) : 50;

    $('ballotFill').style.width = mwPct + '%';
    $('ballotMwPct').textContent = mwPct + '%';
    $('ballotDrjPct').textContent = (total ? 100 - mwPct : 50) + '%';
    $('ballotTotal').textContent = total + (total === 1 ? ' vote' : ' votes');
    $('ballotHint').textContent = b.choice
      ? 'You voted ' + b.choice + '. Tap the other side to switch.'
      : 'Tap a side to vote. Tallies are stored in your browser.';

    document.querySelectorAll('[data-ballot]').forEach(function (el) {
      el.classList.toggle('is-voted', b.choice === el.getAttribute('data-ballot'));
      el.setAttribute('aria-pressed', String(b.choice === el.getAttribute('data-ballot')));
    });
  }

  function castBallot(choice) {
    var b = load(STORE.ballot, { MW: 0, DrJ: 0, choice: null });
    if (b.choice === choice) return;
    if (b.choice) b[b.choice] = Math.max(0, b[b.choice] - 1);
    b[choice] += 1;
    b.choice = choice;
    save(STORE.ballot, b);
    renderBallot();
  }

  /* ========================================================== VOTING FLOOR */

  var HOUR = 3600000;

  // Seed debate topics. Scores are demo starting values; real votes stack on top.
  var SEED_TAKES = [
    { id: 'm1', text: 'Home field at SoFi in prime time is worth more than the spread says. MW sleeps fine tonight.', side: 'MW', base: 41, agoH: 3, link: CONFIG.gameLinks.gamecast, linkLabel: 'Gamecast' },
    { id: 'm2', text: 'The Giants front seven travels. Pressure up the middle is how DrJ takes this throne.', side: 'DrJ', base: 35, agoH: 4, link: CONFIG.gameLinks.boxscore, linkLabel: 'Box score' },
    { id: 'm3', text: 'Rams receivers against that secondary is the matchup the whole game turns on.', side: 'MW', base: 26, agoH: 6, link: 'https://www.espn.com/nfl/team/_/name/lar/los-angeles-rams', linkLabel: 'Rams hub' },
    { id: 'm4', text: 'New York is 1-0 and nobody is talking about it. That ends tonight on ABC.', side: 'DrJ', base: 21, agoH: 7, link: 'https://www.espn.com/nfl/team/_/name/nyg/new-york-giants', linkLabel: 'Giants hub' },
    { id: 'm5', text: 'Third-down defense decides this one. Whoever gets off the field owns the fourth quarter.', side: null, base: 17, agoH: 9, link: CONFIG.gameLinks.pbp, linkLabel: 'Play-by-play' },
    { id: 'm6', text: 'Whoever loses tonight is scrubbing helmets until the rematch. No appeals.', side: null, base: 12, agoH: 11, link: 'https://www.nfl.com/standings/', linkLabel: 'Standings' }
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
    var mine = load(STORE.takes, []).map(function (t) {
      return { id: t.id, text: t.text, side: 'You', base: 1, createdAt: t.createdAt, link: null, linkLabel: null };
    });
    return seeded.concat(mine);
  }

  function scoreOf(take, votes) {
    return take.base + (votes[take.id] || 0);
  }

  function sortTakes(takes, votes) {
    var now = Date.now();
    return takes.slice().sort(function (a, b) {
      if (sortMode === 'new') return b.createdAt - a.createdAt;
      if (sortMode === 'top') return scoreOf(b, votes) - scoreOf(a, votes);
      // hot: score decayed by age
      var hot = function (t) {
        var hours = Math.max(0.5, (now - t.createdAt) / HOUR);
        return scoreOf(t, votes) / Math.pow(hours + 2, 0.55);
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
    var votes = load(STORE.votes, {});
    var list = sortTakes(allTakes(), votes);
    var feed = $('feed');
    feed.innerHTML = '';

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
      up.setAttribute('aria-pressed', String(votes[take.id] === 1));

      var scoreEl = document.createElement('span');
      scoreEl.className = 'take__score';
      scoreEl.textContent = scoreOf(take, votes);

      var down = document.createElement('button');
      down.type = 'button';
      down.className = 'vote vote--down';
      down.innerHTML = '&#9660;';
      down.title = 'Downvote';
      down.setAttribute('aria-label', 'Downvote: ' + take.text);
      down.setAttribute('aria-pressed', String(votes[take.id] === -1));

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
        badge.textContent = take.side === 'You' ? 'Your take' : 'Team ' + take.side;
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
    var votes = load(STORE.votes, {});
    votes[id] = votes[id] === direction ? 0 : direction;
    save(STORE.votes, votes);
    renderFeed();
  }

  function addTake(text) {
    var mine = load(STORE.takes, []);
    mine.push({ id: 'u' + Date.now(), text: text, createdAt: Date.now() });
    save(STORE.takes, mine);
    sortMode = 'new';
    document.querySelectorAll('[data-sort]').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-sort') === 'new');
    });
    renderFeed();
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

  function setAnthemState(state) {
    anthemEls.wrap.setAttribute('data-state', state);
  }

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
      anthemEls.kicker.textContent = 'Tonight’s tribute';
      anthemEls.title.textContent = verdict.peon + ' sings for ' + verdict.master;
      anthemEls.sub.textContent = verdict.peon + ' lost the throne and owes the Football Master a song. ' +
        'Payment is non-negotiable.';
    } else if (game.state === 'in' && known) {
      anthemEls.kicker.textContent = 'Currently owed by';
      anthemEls.title.textContent = verdict.peon + ' is warming up';
      anthemEls.sub.textContent = 'If the scoreboard holds, ' + verdict.peon + ' sings the praises of ' +
        verdict.master + ' when the clock hits zero.';
    } else {
      anthemEls.kicker.textContent = 'Tonight’s tribute';
      anthemEls.title.textContent = 'The Peon’s Anthem';
      anthemEls.sub.textContent = 'The loser sings the praises of the Football Master. Those are the rules.';
    }
  }

  function initAnthem() {
    anthemEls = {
      wrap: $('anthem'),
      audio: $('anthemAudio'),
      play: $('anthemPlay'),
      playLabel: $('anthemPlayLabel'),
      seek: $('anthemSeek'),
      now: $('anthemNow'),
      dur: $('anthemDur'),
      note: $('anthemNote'),
      kicker: $('anthemKicker'),
      title: $('anthemTitle'),
      sub: $('anthemSub'),
      download: $('anthemDownload')
    };
    if (!anthemEls.wrap) return;

    findAnthemFile().then(function (url) {
      if (url) armAnthem(url);
    });
  }

  /* ================================================================== init */

  function init() {
    $('refreshBtn').addEventListener('click', refresh);

    document.querySelectorAll('[data-ballot]').forEach(function (el) {
      el.addEventListener('click', function () { castBallot(el.getAttribute('data-ballot')); });
    });

    document.querySelectorAll('[data-sort]').forEach(function (el) {
      el.addEventListener('click', function () {
        sortMode = el.getAttribute('data-sort');
        document.querySelectorAll('[data-sort]').forEach(function (b) { b.classList.remove('is-active'); });
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

    initAnthem();
    renderBallot();
    renderFeed();
    refresh();

    setInterval(refresh, CONFIG.pollMs);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
