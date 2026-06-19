
const PLAYERS = ["Padmavathi","Naveen","Sruthi Palepu","Bhayya","Eshwar Chand","Pavan Palepu","Raja","Meghana","Shruthi Raja","Sridhar","Rajdeep"];
const ADMINS = ["Eshwar Chand","Rajdeep"];

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,'0') + "-" + String(d.getDate()).padStart(2,'0');
}

// Seed fixtures: two matches today (to exercise the weekend/multi-match layout), one tomorrow
// (to confirm the date filter correctly hides matches that aren't today).
const SEED_FIXTURES = [
  { id: "f1", date: todayISO(), scheduledTime: "19:30", teamA: "Mumbai Indians", teamB: "Chennai Super Kings", stage: "league", result: null },
  { id: "f2", date: todayISO(), scheduledTime: "19:30", teamA: "Royal Challengers", teamB: "Kolkata Knight Riders", stage: "league", result: null },
  { id: "f3", date: (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,'0')+"-"+String(d.getDate()).padStart(2,'0'); })(), scheduledTime: "19:30", teamA: "Sunrisers Hyderabad", teamB: "Punjab Kings", stage: "league", result: null }
];

let state = {
  currentUser: null,
  isAdmin: false,
  view: "bid",
  fixtures: null,
  bids: null,
  wildcardCounts: null,
  wildcardActivations: null,
  pins: null,
  confirmAction: null,
  bidChangeMode: null,
  pendingLoginName: null,
  pinError: null,
  fixtureFormError: null
};

// "Today's matches" is always derived from the full fixture list by filtering on today's date --
// never stored separately, so there's no risk of it going stale relative to the fixture list.
function todaysMatches() {
  const today = todayISO();
  return state.fixtures.filter(f => f.date === today);
}

// Fixtures no longer carry a pre-built label string -- generate a display label from the
// actual fixture data (date, teams) so the admin's entered schedule is always the source of truth.
function matchLabel(m) {
  return `${m.teamA} vs ${m.teamB} (${m.date})`;
}

// Point values per Scoring Spec: league +10/-5, playoff +15/-10, final +20/-15.
// Fixtures default to "league" if stage is somehow missing (defensive fallback, not expected in practice).
function pointsForStage(stage, won) {
  if (stage === "final") return won ? 20 : -15;
  if (stage === "playoff") return won ? 15 : -10;
  return won ? 10 : -5; // league (default)
}

function defaultWildcardCounts() {
  const counts = {};
  PLAYERS.forEach(p => { counts[p] = { bidchange: 2, double: 2, steal: 2 }; });
  return counts;
}

// ---- Supabase configuration ----
const SUPABASE_URL = "https://uumnobpgdyqwlknujtqa.supabase.co";
const SUPABASE_KEY = "sb_publishable_v1GmucOvM6sAzuZBplg_Tg_8Tti-5Wj";

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase request failed (${res.status}): ${text}`);
  }
  // Some requests (e.g. DELETE) may return an empty body
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function loadMatches() {
  const rows = await sbFetch("fixtures?select=*");
  if (rows.length === 0) {
    // First-ever load: seed the database with starter fixtures.
    for (const f of SEED_FIXTURES) {
      await sbFetch("fixtures", {
        method: "POST",
        body: JSON.stringify({
          id: f.id, date: f.date, scheduled_time: f.scheduledTime,
          team_a: f.teamA, team_b: f.teamB, stage: f.stage, result: f.result
        })
      });
    }
    state.fixtures = SEED_FIXTURES.map(f => ({ ...f }));
    return;
  }
  state.fixtures = rows.map(r => ({
    id: r.id, date: r.date, scheduledTime: r.scheduled_time,
    teamA: r.team_a, teamB: r.team_b, stage: r.stage, result: r.result
  }));
}

async function saveMatches() {
  // Upsert every fixture currently in state -- simplest correct approach given our small scale.
  for (const f of state.fixtures) {
    await sbFetch("fixtures?on_conflict=id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: f.id, date: f.date, scheduled_time: f.scheduledTime,
        team_a: f.teamA, team_b: f.teamB, stage: f.stage, result: f.result
      })
    });
  }
}

async function loadBids() {
  const rows = await sbFetch("bids?select=*");
  state.bids = {};
  rows.forEach(r => {
    state.bids[bidKey(r.match_id, r.player)] = r.team;
  });
}

async function saveBids() {
  // Bids are written one at a time at the moment they're placed (see click handler), but this
  // full-sync version exists for the test-reset utility, which clears many at once.
  for (const key of Object.keys(state.bids)) {
    const [matchId, player] = key.split("::");
    await sbFetch("bids?on_conflict=match_id,player", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ match_id: matchId, player, team: state.bids[key], timestamp: Date.now() })
    });
  }
}

async function loadWildcards() {
  const countRows = await sbFetch("wildcard_counts?select=*");
  if (countRows.length === 0) {
    const defaults = defaultWildcardCounts();
    for (const p of PLAYERS) {
      await sbFetch("wildcard_counts", {
        method: "POST",
        body: JSON.stringify({ player: p, bidchange: defaults[p].bidchange, double: defaults[p].double, steal: defaults[p].steal })
      });
    }
    state.wildcardCounts = defaults;
  } else {
    state.wildcardCounts = {};
    countRows.forEach(r => {
      state.wildcardCounts[r.player] = { bidchange: r.bidchange, double: r.double, steal: r.steal };
    });
  }

  const activationRows = await sbFetch("wildcard_activations?select=*");
  state.wildcardActivations = {};
  activationRows.forEach(r => {
    state.wildcardActivations[activationKey(r.match_id, r.player)] = { type: r.type, target: r.target, timestamp: r.timestamp };
  });
}

async function saveWildcardCounts() {
  for (const p of PLAYERS) {
    const c = state.wildcardCounts[p];
    await sbFetch("wildcard_counts?on_conflict=player", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ player: p, bidchange: c.bidchange, double: c.double, steal: c.steal })
    });
  }
}

async function saveWildcardActivations() {
  for (const key of Object.keys(state.wildcardActivations)) {
    const [matchId, player] = key.split("::");
    const a = state.wildcardActivations[key];
    await sbFetch("wildcard_activations?on_conflict=match_id,player", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ match_id: matchId, player, type: a.type, target: a.target || null, timestamp: a.timestamp })
    });
  }
}

async function loadPins() {
  const rows = await sbFetch("pins?select=*");
  state.pins = {};
  rows.forEach(r => { state.pins[r.player] = r.pin; });
}

async function savePins() {
  for (const player of Object.keys(state.pins)) {
    await sbFetch("pins?on_conflict=player", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ player, pin: state.pins[player] })
    });
  }
  // Handle deletions (e.g. admin PIN reset) -- anything in PLAYERS no longer in state.pins
  // should be removed from the database too, not just left stale.
  for (const player of PLAYERS) {
    if (!state.pins[player]) {
      await sbFetch(`pins?player=eq.${encodeURIComponent(player)}`, { method: "DELETE" });
    }
  }
}

// An activation key is matchId::player -- only one wildcard per player per match (spec rule)
function activationKey(matchId, player) { return matchId + "::" + player; }

function getActivation(matchId, player) {
  return state.wildcardActivations[activationKey(matchId, player)] || null;
}

function bidKey(matchId, player) { return matchId + "::" + player; }

function getBid(matchId, player) {
  return state.bids[bidKey(matchId, player)] || null;
}

// A match "counts" toward the forfeiture tally once it has a result entered -- including
// no-result matches, per spec (forfeiture tracks "did you bid", independent of scorability).
function decidedMatches() {
  return state.fixtures.filter(m => m.result !== null);
}

function computeForfeitureStatus() {
  const status = {};
  const decided = decidedMatches();
  const total = decided.length;
  PLAYERS.forEach(p => {
    if (total === 0) { status[p] = { forfeited: false, missed: 0, total: 0 }; return; }
    const missed = decided.filter(m => !getBid(m.id, p)).length;
    const forfeited = (missed / total) > 0.20;
    status[p] = { forfeited, missed, total };
  });
  return status;
}

function computeScores() {
  const scores = {};
  PLAYERS.forEach(p => scores[p] = 0);

  // Forfeiture depends on "missed bids so far / decided matches so far", which changes as the
  // season progresses -- so we walk decided matches in order and record, per player, the index
  // of the first match at which they cross the 20% threshold. From that match onward, their
  // score is frozen (no further results count), per spec.
  const decided = decidedMatches(); // matches with a result entered, in season order
  const forfeitedFromIndex = {}; // player -> index into `decided` where forfeiture kicks in, or Infinity
  PLAYERS.forEach(p => { forfeitedFromIndex[p] = Infinity; });

  let missed = {}; PLAYERS.forEach(p => missed[p] = 0);
  decided.forEach((m, idx) => {
    PLAYERS.forEach(p => {
      if (!getBid(m.id, p)) missed[p] += 1;
      const decidedSoFar = idx + 1;
      if (forfeitedFromIndex[p] === Infinity && (missed[p] / decidedSoFar) > 0.20) {
        forfeitedFromIndex[p] = idx; // this match is where they cross the line; frozen from here on
      }
    });
  });

  state.fixtures.forEach(m => {
    if (!m.result || m.result === "noresult") return;
    const matchIndex = decided.indexOf(m);

    // Step 1: each player's raw result for this match (bid outcome, Double applied if used).
    // A player already forfeited as of this match's position gets no raw result -- frozen score.
    const rawResults = {};
    PLAYERS.forEach(p => {
      if (matchIndex >= forfeitedFromIndex[p]) { rawResults[p] = null; return; }
      const bid = getBid(m.id, p);
      if (!bid) { rawResults[p] = null; return; }
      let raw = pointsForStage(m.stage, bid === m.result);
      const activation = getActivation(m.id, p);
      if (activation && activation.type === "double") raw = raw * 2;
      rawResults[p] = raw;
    });

    // Step 2: resolve the "first activator wins" tiebreak for each Steal target.
    const stealsByTarget = {};
    PLAYERS.forEach(stealer => {
      if (rawResults[stealer] === null) return; // forfeited players' wildcards don't apply
      const activation = getActivation(m.id, stealer);
      if (activation && activation.type === "steal") {
        const target = activation.target;
        if (!stealsByTarget[target]) stealsByTarget[target] = [];
        stealsByTarget[target].push({ stealer, timestamp: activation.timestamp });
      }
    });
    const successfulStealer = {}; // target -> stealer who actually succeeds
    Object.keys(stealsByTarget).forEach(target => {
      const sorted = stealsByTarget[target].slice().sort((a, b) => a.timestamp - b.timestamp);
      successfulStealer[target] = sorted[0].stealer;
    });

    // Step 3: one pass per player, checking their specific situation. Each player ends up in
    // exactly one of these cases -- no overlap, so no double-counting risk.
    PLAYERS.forEach(p => {
      if (rawResults[p] === null) return; // no bid placed, or forfeited -- no score impact this match

      const activation = getActivation(m.id, p);
      const isSuccessfulStealer = activation && activation.type === "steal" && successfulStealer[activation.target] === p;
      const isVictimOfSuccessfulSteal = Object.prototype.hasOwnProperty.call(successfulStealer, p);

      if (isVictimOfSuccessfulSteal) {
        // p was successfully stolen from this match -- they lose their result (in full or half).
        const stealer = successfulStealer[p];
        const pUsedDouble = activation && activation.type === "double";
        if (pUsedDouble) {
          const half = rawResults[p] / 2;
          scores[p] += half;
          scores[stealer] += half;
        } else {
          scores[stealer] += rawResults[p];
          // p gets 0 from their own bid this match -- nothing added to scores[p]
        }
      } else if (isSuccessfulStealer) {
        // p successfully stole -- they keep their own raw result. The victim's contribution
        // was already credited to p above, when we processed the victim.
        scores[p] += rawResults[p];
      } else {
        // No steal involvement (or p's steal attempt was the losing/wasted one) -- p just gets
        // their own raw result. A wasted Steal wildcard has no scoring effect, as spec'd.
        scores[p] += rawResults[p];
      }
    });
  });

  return scores;
}

function render() {
  const root = document.getElementById('root');
  if (!state.currentUser) {
    if (state.pendingLoginName) {
      root.innerHTML = pinScreen();
      attachPinEvents();
    } else {
      root.innerHTML = loginScreen();
      attachLoginEvents();
    }
    return;
  }
  root.innerHTML = mainScreen();
  attachMainEvents();
}

function loginScreen() {
  return `
    <div class="login-wrap">
      <h1>IPL <span>Bidding</span> Game</h1>
      <p>Pick your name to continue</p>
      <div class="name-grid">
        ${PLAYERS.map(p => `<button class="name-btn" data-name="${p}">${p}</button>`).join('')}
      </div>
    </div>
  `;
}

function attachLoginEvents() {
  document.querySelectorAll('.name-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pendingLoginName = btn.dataset.name;
      state.pinError = null;
      render();
    });
  });
}

function pinScreen() {
  const name = state.pendingLoginName;
  const hasPin = !!state.pins[name];
  return `
    <div class="login-wrap">
      <h1>IPL <span>Bidding</span> Game</h1>
      <p>${hasPin ? `Enter your PIN, ${name}` : `Set a 4-digit PIN for ${name}`}</p>
      <div class="pin-wrap">
        ${state.pinError ? `<div class="pin-error">${state.pinError}</div>` : ''}
        <input type="password" inputmode="numeric" maxlength="4" class="pin-input ${state.pinError ? 'error' : ''}" id="pinInput" placeholder="\u2022\u2022\u2022\u2022" autofocus />
        <button class="pin-submit" id="pinSubmit">${hasPin ? 'Log in' : 'Set PIN'}</button>
        <div class="pin-back" id="pinBack">\u2190 Not ${name}? Go back</div>
      </div>
    </div>
  `;
}

function attachPinEvents() {
  const name = state.pendingLoginName;
  const hasPin = !!state.pins[name];
  const input = document.getElementById('pinInput');
  const submit = document.getElementById('pinSubmit');
  const back = document.getElementById('pinBack');

  input.focus();
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });

  back.addEventListener('click', () => {
    state.pendingLoginName = null;
    state.pinError = null;
    render();
  });

  submit.addEventListener('click', async () => {
    const value = input.value;
    if (value.length !== 4) {
      state.pinError = "PIN must be exactly 4 digits.";
      render();
      return;
    }
    if (hasPin) {
      if (state.pins[name] === value) {
        state.currentUser = name;
        state.isAdmin = ADMINS.includes(name);
        state.pendingLoginName = null;
        state.pinError = null;
        state.view = "bid";
        render();
      } else {
        state.pinError = "Incorrect PIN. Try again.";
        render();
      }
    } else {
      state.pins[name] = value;
      await savePins();
      state.currentUser = name;
      state.isAdmin = ADMINS.includes(name);
      state.pendingLoginName = null;
      state.pinError = null;
      state.view = "bid";
      render();
    }
  });
}

function mainScreen() {
  const tabs = [
    { id: "bid", label: "Bid" },
    { id: "leaderboard", label: "Leaderboard" }
  ];
  if (state.isAdmin) tabs.push({ id: "admin", label: "Admin" });

  let body = "";
  if (state.view === "bid") body = bidView();
  else if (state.view === "leaderboard") body = leaderboardView();
  else if (state.view === "admin") body = adminView();

  return `
    <div class="topbar">
      <div class="brand">IPL <span>Bidding</span></div>
      <div class="whoami">
        Logged in as <b>${state.currentUser}</b>${state.isAdmin ? ' (admin)' : ''}
        <br><button class="switchbtn" id="switchUser">Switch user</button>
      </div>
    </div>
    <div class="tabs">
      ${tabs.map(t => `<div class="tab ${state.view === t.id ? 'active' : ''}" data-view="${t.id}">${t.label}</div>`).join('')}
    </div>
    ${body}
    ${state.confirmAction ? confirmModal() : ''}
  `;
}

function bidView() {
  const myForfeiture = computeForfeitureStatus()[state.currentUser];
  if (myForfeiture.forfeited) {
    return `
      <div class="empty-state">
        <b>You've been forfeited from bidding.</b><br><br>
        You missed more than 20% of decided matches (${myForfeiture.missed} of ${myForfeiture.total}), so you can no longer place bids this season.
        Your score is frozen and you'll still appear on the leaderboard. If you think this is a mistake, talk to an admin.
      </div>
    `;
  }
  const today = todaysMatches();
  if (today.length === 0) {
    return `<div class="empty-state">No matches scheduled today. Check back when there's a fixture.</div>`;
  }
  return `
    <div class="section-label">Today's matches</div>
    ${today.map(m => {
      const myBid = getBid(m.id, state.currentUser);
      const locked = m.result !== null;
      const myActivation = getActivation(m.id, state.currentUser);
      const myCounts = state.wildcardCounts[state.currentUser];
      const changingBid = state.bidChangeMode === m.id;

      return `
        <div class="match-card">
          <div class="match-meta">
            <span>${matchLabel(m)}</span>
            <span>Locks ${m.scheduledTime}</span>
          </div>
          <div class="teams-row">
            <button class="team-btn ${myBid === m.teamA ? 'selected' : ''}" ${(locked || (myBid && !changingBid)) ? 'disabled' : ''} data-match="${m.id}" data-team="${m.teamA}">${m.teamA}</button>
            <span class="vs">VS</span>
            <button class="team-btn ${myBid === m.teamB ? 'selected' : ''}" ${(locked || (myBid && !changingBid)) ? 'disabled' : ''} data-match="${m.id}" data-team="${m.teamB}">${m.teamB}</button>
          </div>
          ${myBid ? `<div class="lock-note">Your bid: <b>${myBid}</b></div>` : `<div class="lock-note">No bid placed yet</div>`}
          ${locked ? `<div class="lock-note">Result entered &mdash; bidding closed for this match.</div>` : ''}
          ${changingBid ? `<div class="lock-note" style="color:var(--lose);">Bid Change active &mdash; pick your new team above. <span style="text-decoration:underline;cursor:pointer;" data-action="bidchange-cancel" data-match="${m.id}">Cancel</span></div>` : ''}

          <div class="wc-panel" style="margin-top:14px;margin-bottom:0;">
            <div class="wc-panel-title">Wildcards for this match</div>
            <div class="wc-row">
              <span class="wc-name">Double Points <span class="wc-count">(${myCounts.double} left)</span></span>
              ${myActivation && myActivation.type === 'double'
                ? `<span class="wc-active-tag">Active</span>`
                : `<button class="wc-btn" data-action="double" data-match="${m.id}" ${(myCounts.double < 1 || myActivation || locked || !myBid) ? 'disabled' : ''}>Use</button>`}
            </div>
            <div class="wc-row">
              <span class="wc-name">Bid Change <span class="wc-count">(${myCounts.bidchange} left)</span></span>
              ${myActivation && myActivation.type === 'bidchange'
                ? `<span class="wc-active-tag">Used</span>`
                : `<button class="wc-btn" data-action="bidchange-start" data-match="${m.id}" ${(myCounts.bidchange < 1 || myActivation || locked || !myBid || changingBid) ? 'disabled' : ''}>Use</button>`}
            </div>
            <div class="wc-row">
              <span class="wc-name">Steal <span class="wc-count">(${myCounts.steal} left)</span></span>
              ${myActivation && myActivation.type === 'steal'
                ? `<span class="wc-active-tag">Stole from ${myActivation.target}</span>`
                : `<span>
                    <select class="steal-select" data-match="${m.id}" ${(myCounts.steal < 1 || myActivation || locked || !myBid) ? 'disabled' : ''}>
                      <option value="" selected disabled>Select player</option>
                      ${PLAYERS.filter(p => p !== state.currentUser).map(p => `<option value="${p}">${p}</option>`).join('')}
                    </select>
                    <button class="wc-btn" data-action="steal" data-match="${m.id}" ${(myCounts.steal < 1 || myActivation || locked || !myBid) ? 'disabled' : ''}>Use</button>
                  </span>`}
            </div>
            ${myActivation ? `<div class="lock-note" style="margin-top:8px;">Only one wildcard per match &mdash; ${myActivation.type === 'double' ? 'Double Points' : myActivation.type === 'bidchange' ? 'Bid Change' : 'Steal'} is active for this match.</div>` : ''}
            ${!myBid ? `<div class="lock-note" style="margin-top:8px;">Place a bid first to use a wildcard on this match.</div>` : ''}
          </div>
        </div>
      `;
    }).join('')}
  `;
}

function leaderboardView() {
  const scores = computeScores();
  const forfeiture = computeForfeitureStatus();
  const ranked = PLAYERS.slice().sort((a,b) => scores[b] - scores[a]);

  return `
    <div class="section-label">Standings</div>
    <table>
      <thead>
        <tr><th>#</th><th>Player</th><th>Points</th><th>Today's bid</th></tr>
      </thead>
      <tbody>
        ${ranked.map((p, i) => {
          const pts = scores[p];
          const isMe = p === state.currentUser;
          const fStatus = forfeiture[p];

          // Per spec: league-stage bids are visible to everyone; playoff/final bids stay masked
          // until that match's result is published, even though the player can always see their
          // own pick on the bidding page itself -- this column reflects what OTHERS can see.
          const todayCells = todaysMatches().map(m => {
            const bid = getBid(m.id, p);
            if (!bid) return null;
            const isHiddenStage = (m.stage === "playoff" || m.stage === "final") && !m.result;
            if (isHiddenStage && !isMe) return `<span class="bid-pill" style="opacity:0.4;">Hidden</span>`;
            return `<span class="bid-pill">${bid}</span>`;
          }).filter(Boolean);

          return `
            <tr class="${isMe ? 'me' : ''} ${fStatus.forfeited ? 'forfeited' : ''}">
              <td class="rank-cell">${i+1}</td>
              <td>${p}${isMe ? ' (you)' : ''}${fStatus.forfeited ? ' <span class="forfeit-tag">Forfeited</span>' : ''}</td>
              <td class="pts ${pts > 0 ? 'pos' : pts < 0 ? 'neg' : ''}">${pts > 0 ? '+' : ''}${pts}</td>
              <td>${todayCells.length ? todayCells.join(' ') : '<span class="no-bid">No bid</span>'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${ranked.some(p => forfeiture[p].forfeited) ? `<div class="lock-note" style="margin-top:10px;">Forfeited players missed more than 20% of decided matches. Their score is frozen and they cannot be a top/bottom winner, but they remain visible on the board.</div>` : ''}
  `;
}

function adminView() {
  return `
    <div class="admin-banner">Admin &mdash; add a fixture</div>
    <div class="match-card">
      ${state.fixtureFormError ? `<div class="fixture-form-error">${state.fixtureFormError}</div>` : ''}
      <div class="fixture-form">
        <input type="date" id="newFixtureDate" />
        <input type="time" id="newFixtureTime" value="19:30" />
        <input type="text" id="newFixtureTeamA" placeholder="Team A" />
        <input type="text" id="newFixtureTeamB" placeholder="Team B" />
        <select id="newFixtureStage">
          <option value="league">League</option>
          <option value="playoff">Playoff</option>
          <option value="final">Final</option>
        </select>
      </div>
      <button class="fixture-add-btn" id="addFixtureBtn">Add fixture</button>
      <div class="lock-note" style="margin-top:8px;">Enter the season's schedule once, upfront. The bidding page only shows matches dated today.</div>
    </div>

    <div class="admin-banner" style="margin-top:24px;">Enter match results</div>
    ${state.fixtures.slice().sort((a,b) => a.date.localeCompare(b.date)).map(m => `
      <div class="match-card">
        <div class="match-meta">
          <span>${matchLabel(m)}</span>
          ${m.result ? '<span class="done-tag">Result entered</span>' : ''}
        </div>
        <button class="result-btn ${m.result === m.teamA ? 'chosen' : ''}" data-match="${m.id}" data-result="${m.teamA}" ${m.result ? 'disabled' : ''}>${m.teamA} won</button>
        <button class="result-btn ${m.result === m.teamB ? 'chosen' : ''}" data-match="${m.id}" data-result="${m.teamB}" ${m.result ? 'disabled' : ''}>${m.teamB} won</button>
        <button class="result-btn ${m.result === 'noresult' ? 'chosen' : ''}" data-match="${m.id}" data-result="noresult" ${m.result ? 'disabled' : ''}>No result (rain / tie / abandoned)</button>
      </div>
    `).join('')}

    <div class="admin-banner" style="margin-top:24px;">Reset a forgotten PIN</div>
    <div class="match-card">
      <div class="lock-note" style="margin-bottom:10px;">Resetting clears that player's PIN so they can set a new one next time they log in. You cannot view existing PINs.</div>
      ${PLAYERS.map(p => `
        <div class="wc-row">
          <span class="wc-name">${p} ${state.pins[p] ? '' : '<span class="wc-count">(no PIN set)</span>'}</span>
          ${state.pins[p] ? `<button class="wc-btn" data-action="resetpin" data-player="${p}">Reset PIN</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function confirmModal() {
  const { label } = state.confirmAction;
  return `
    <div class="overlay">
      <div class="modal">
        <p>${label}</p>
        <div class="modal-row">
          <button class="btn-cancel" id="confirmNo">Go back</button>
          <button class="btn-confirm" id="confirmYes">Submit</button>
        </div>
      </div>
    </div>
  `;
}

function attachMainEvents() {
  const switchBtn = document.getElementById('switchUser');
  if (switchBtn) switchBtn.addEventListener('click', async () => {
    state.currentUser = null;
    state.isAdmin = false;
    await loadMatches();
    await loadBids();
    await loadWildcards();
    await loadPins();
    render();
  });

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', async () => {
      state.view = t.dataset.view;
      await loadMatches();
      await loadBids();
      await loadWildcards();
      await loadPins();
      render();
    });
  });

  document.querySelectorAll('.team-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.match;
      const team = btn.dataset.team;
      const m = state.fixtures.find(x => x.id === matchId);
      const inChangeMode = state.bidChangeMode === matchId;

      state.confirmAction = {
        label: inChangeMode
          ? `Change your bid to ${team}? This finalizes your Bid Change for ${matchLabel(m)}.`
          : `Select ${team} for this match?`,
        run: async () => {
          state.bids[bidKey(matchId, state.currentUser)] = team;
          await saveBids();
          if (inChangeMode) {
            state.wildcardActivations[activationKey(matchId, state.currentUser)] = { type: "bidchange", timestamp: Date.now() };
            state.wildcardCounts[state.currentUser].bidchange -= 1;
            await saveWildcardActivations();
            await saveWildcardCounts();
            state.bidChangeMode = null;
          }
          state.confirmAction = null;
          render();
        }
      };
      render();
    });
  });

  document.querySelectorAll('.wc-btn[data-action="bidchange-start"]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.match;
      state.bidChangeMode = matchId;
      render();
    });
  });

  document.querySelectorAll('[data-action="bidchange-cancel"]').forEach(el => {
    el.addEventListener('click', () => {
      state.bidChangeMode = null;
      render();
    });
  });

  document.querySelectorAll('.wc-btn[data-action="steal"]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.match;
      const m = state.fixtures.find(x => x.id === matchId);
      const select = document.querySelector(`.steal-select[data-match="${matchId}"]`);
      const target = select.value;
      if (!target) {
        select.style.borderColor = 'var(--lose)';
        select.focus();
        return; // no target chosen yet -- don't open a confirmation for an empty steal
      }
      state.confirmAction = {
        label: `Activate Steal on ${target} for ${matchLabel(m)}? This uses 1 of your remaining Steal wildcards and cannot be undone.`,
        run: async () => {
          state.wildcardActivations[activationKey(matchId, state.currentUser)] = { type: "steal", target: target, timestamp: Date.now() };
          state.wildcardCounts[state.currentUser].steal -= 1;
          await saveWildcardActivations();
          await saveWildcardCounts();
          state.confirmAction = null;
          render();
        }
      };
      render();
    });
  });

  document.querySelectorAll('.wc-btn[data-action="double"]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.match;
      const m = state.fixtures.find(x => x.id === matchId);
      state.confirmAction = {
        label: `Activate Double Points for ${matchLabel(m)}? This uses 1 of your remaining Double Points wildcards and cannot be undone.`,
        run: async () => {
          state.wildcardActivations[activationKey(matchId, state.currentUser)] = { type: "double", timestamp: Date.now() };
          state.wildcardCounts[state.currentUser].double -= 1;
          await saveWildcardActivations();
          await saveWildcardCounts();
          state.confirmAction = null;
          render();
        }
      };
      render();
    });
  });

  document.querySelectorAll('.result-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.match;
      const result = btn.dataset.result;
      const m = state.fixtures.find(x => x.id === matchId);
      state.confirmAction = {
        label: `Confirm result: ${result === 'noresult' ? 'No result' : result + ' won'}? This cannot be edited later.`,
        run: async () => {
          m.result = result;
          await saveMatches();
          state.confirmAction = null;
          render();
        }
      };
      render();
    });
  });

  document.querySelectorAll('[data-action="resetpin"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const player = btn.dataset.player;
      state.confirmAction = {
        label: `Reset ${player}'s PIN? They'll be asked to set a new one next time they log in. You will not see their old or new PIN.`,
        run: async () => {
          delete state.pins[player];
          await savePins();
          state.confirmAction = null;
          render();
        }
      };
      render();
    });
  });

  const addFixtureBtn = document.getElementById('addFixtureBtn');
  if (addFixtureBtn) addFixtureBtn.addEventListener('click', async () => {
    const date = document.getElementById('newFixtureDate').value;
    const time = document.getElementById('newFixtureTime').value;
    const teamA = document.getElementById('newFixtureTeamA').value.trim();
    const teamB = document.getElementById('newFixtureTeamB').value.trim();
    const stage = document.getElementById('newFixtureStage').value;

    if (!date || !time || !teamA || !teamB) {
      state.fixtureFormError = "Please fill in date, time, and both team names.";
      render();
      return;
    }
    if (teamA.toLowerCase() === teamB.toLowerCase()) {
      state.fixtureFormError = "Team A and Team B can't be the same.";
      render();
      return;
    }

    const newFixture = {
      id: "fx_" + Date.now(),
      date, scheduledTime: time, teamA, teamB, stage, result: null
    };
    state.fixtures.push(newFixture);
    await saveMatches();
    state.fixtureFormError = null;
    render();
  });

  const yes = document.getElementById('confirmYes');
  const no = document.getElementById('confirmNo');
  if (yes) yes.addEventListener('click', () => state.confirmAction.run());
  if (no) no.addEventListener('click', () => { state.confirmAction = null; render(); });
}

async function init() {
  document.getElementById('root').innerHTML = '<div class="empty-state">Loading...</div>';
  await loadMatches();
  await loadBids();
  await loadWildcards();
  await loadPins();
  render();
}

init();
