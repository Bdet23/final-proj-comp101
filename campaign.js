'use strict';

/* ==========================================================================
   Campaign mode (stage 1): one decade on a Realistic map.

   The player draws a map, then plays 2021–2030 one year at a time. Each year
   brings an event with two choices; after the choice the year passes and the
   state drifts (population, party leanings, turnout). Every even year holds a
   House election, decided by one simulated election. The score is the total
   number of seats won across the five elections. The map stays locked for
   the whole decade.

   Uses globals from game.js: game, ui, els, render, buildBoard, currentStats,
   validatePlan, openDialog, startGame, simVotes-style helpers and formatting.
   ========================================================================== */

const CAMPAIGN_FIRST_YEAR = 2021;
const CAMPAIGN_LAST_YEAR = 2030;

const isElectionYear = (y) => y % 2 === 0;
const clampLean = (x) => Math.max(3, Math.min(97, Math.round(x * 10) / 10));
const clampTurnout = (x) => Math.max(0.3, Math.min(0.92, x));
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];
// "the Democrats" / "you", "the Republicans" / "the opponent"
const youSide = () => (game.party ? `the ${youName()}` : 'you');
const oppSide = () => (game.party ? `the ${oppName()}` : 'the opponent');

// ---------- Setup ----------
function startDecade() {
  const problems = validatePlan(currentStats());
  if (problems.length) {
    openDialog(
      `<h2>Draw a legal map first</h2>
       <p>The decade starts once every district is legal:</p>
       <ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`,
      [{ label: 'Keep drawing', primary: true }]
    );
    return;
  }
  const seed = Math.floor(Math.random() * 1e9);
  const rand = mulberry32(seed);
  const n = game.cfg.districts;

  // Each tile gets a yearly trend from its type (by population density),
  // its region and a little noise. Trends are in points toward you per year.
  const pops = game.tiles.map((t) => t.pop).sort((a, b) => a - b);
  const rank = (t) => pops.indexOf(t.pop) / Math.max(1, pops.length - 1);
  const subDir = rand() < 0.5 ? 1 : -1;
  const typeTrend = {
    urban: (rand() - 0.5) * 0.4,
    suburban: subDir * (0.3 + rand() * 0.3),
    rural: -subDir * (0.15 + rand() * 0.2),
  };
  const regionTrend = game.unc.regions.map(() => (rand() - 0.5) * 0.6);
  const regionTurnout = game.unc.regions.map(() => (rand() - 0.5) * 0.01);
  const drift = game.tiles.map((t) => {
    const r = rank(t);
    const type = r > 0.8 ? 'urban' : r > 0.45 ? 'suburban' : 'rural';
    const w = game.unc.weights[t.id];
    const reg = w.reduce((s, x, k) => s + x * x * regionTrend[k], 0);
    const regT = w.reduce((s, x, k) => s + x * x * regionTurnout[k], 0);
    return {
      type,
      trend: typeTrend[type] + reg + (rand() - 0.5) * 0.2,
      growth: { urban: 0.006, suburban: 0.012, rural: -0.004 }[type] + (rand() - 0.5) * 0.006,
      turnout: regT,
    };
  });

  game.campaign = {
    seed,
    rand,
    year: CAMPAIGN_FIRST_YEAR,
    base: game.tiles.map((t) => ({ pop: t.pop, lean: t.lean, turnout: t.turnout })),
    drift,
    typeTrend,
    nextSwing: 0,                     // statewide shift at the next election (fraction)
    nextBonus: new Array(n).fill(0),  // per-district shift at the next election (fraction)
    elections: [],
    log: [],
    event: null,
    lastType: null,
    over: false,
  };
  ui.tool = 'erase';
  game.campaign.event = drawEvent(game.campaign);
  Sound.play('event');
  render();
}

// ---------- Yearly drift ----------
function driftYear(c) {
  game.tiles.forEach((t, i) => {
    const d = c.drift[i];
    t.pop = Math.max(500, Math.round(t.pop * (1 + d.growth)));
    t.lean = clampLean(t.lean + d.trend + (c.rand() - 0.5) * 0.4);
    t.turnout = clampTurnout(t.turnout + d.turnout + (c.rand() - 0.5) * 0.01);
  });
}

// ---------- Events ----------
function compass(t) {
  const xs = game.tiles.map((q) => q.x);
  const ys = game.tiles.map((q) => q.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dx = t.x - cx;
  const dy = cy - t.y;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (Math.hypot(dx, dy) < span * 0.15) return 'centre';
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const k = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 / 45) % 8;
  return names.at(k);
}
const placeName = (t) => (t.county ? t.county.name : `the ${compass(t)}`);

function cluster(center, rings) {
  const reach = SQRT3 * HEX * rings * 1.05;
  return game.tiles.filter((t) => Math.hypot(t.x - center.x, t.y - center.y) <= reach).map((t) => t.id);
}

function districtsYouLead() {
  return currentStats().map((s, d) => (s.wins ? d : -1)).filter((d) => d >= 0);
}

function weakestWinningDistrict() {
  const stats = currentStats();
  let best = -1;
  for (let d = 0; d < stats.length; d++) {
    if (stats[d].wins && (best < 0 || stats[d].share < stats[best].share)) best = d;
  }
  return best;
}

function changeTiles(ids, f) {
  for (const i of ids) {
    const t = game.tiles[i];
    if (f.pop) t.pop = Math.max(500, Math.round(t.pop * (1 + f.pop)));
    if (f.lean) t.lean = clampLean(t.lean + f.lean);
    if (f.turnout) t.turnout = clampTurnout(t.turnout * (1 + f.turnout));
  }
}

const lean = (x) => `${Math.abs(x)} point${Math.abs(x) === 1 ? '' : 's'}`;

// Each factory returns { type, title, text, tiles, choices: [{ label, detail, apply(preview) -> log text, chance? }] }
const EVENT_TYPES = {
  boom(c) {
    const center = pick(game.tiles, c.rand);
    const ids = cluster(center, 2);
    const dir = c.rand() < 0.5 ? 1 : -1;
    const who = dir > 0 ? youSide() : oppSide();
    return {
      type: 'boom',
      title: `Housing boom near ${placeName(center)}`,
      text: `A new employer is bringing about 8% more residents to ${ids.length} hexes around ${placeName(center)}. The newcomers lean toward ${who}, shifting those hexes ${lean(3)}.`,
      tiles: ids,
      choices: [
        { label: 'Register the newcomers', detail: 'Turnout in those hexes rises 5%.',
          apply: () => { changeTiles(ids, { pop: 0.08, lean: 3 * dir, turnout: 0.05 }); return 'you ran a registration drive.'; } },
        { label: 'Leave it alone', detail: 'Newcomers are slow to register: turnout there falls 4%.',
          apply: () => { changeTiles(ids, { pop: 0.08, lean: 3 * dir, turnout: -0.04 }); return 'you left the newcomers alone.'; } },
      ],
    };
  },
  closure(c) {
    const center = pick(game.tiles, c.rand);
    const ids = cluster(center, 1);
    const dir = c.rand() < 0.5 ? 1 : -1;
    const who = dir > 0 ? youSide() : oppSide();
    return {
      type: 'closure',
      title: `Factory closes near ${placeName(center)}`,
      text: `A major plant is closing. ${ids.length} hexes around ${placeName(center)} lose about 6% of their people, and anger over the closure pushes them ${lean(4)} toward ${who}.`,
      tiles: ids,
      choices: [
        { label: 'Promise a jobs program', detail: `Halves the shift there, but costs ${lean(0.5)} statewide at the next election.`,
          apply: () => { changeTiles(ids, { pop: -0.06, lean: 2 * dir }); c.nextSwing -= 0.005; return 'you promised a jobs program.'; } },
        { label: 'Keep your focus elsewhere', detail: 'The full shift happens.',
          apply: () => { changeTiles(ids, { pop: -0.06, lean: 4 * dir }); return 'you kept your focus elsewhere.'; } },
      ],
    };
  },
  wave(c) {
    const dir = c.rand() < 0.6 ? -1 : 1;
    const size = 0.025 + c.rand() * 0.015;
    const pts = Math.round(size * 1000) / 10;
    const weak = weakestWinningDistrict();
    return {
      type: 'wave',
      title: dir < 0 ? 'A wave is building against you' : 'The national mood favours you',
      text: `Polls point to a statewide shift of about ${pts} points toward ${dir < 0 ? oppSide() : youSide()} at the next election.`,
      tiles: [],
      choices: [
        { label: weak >= 0 ? `Shore up District ${weak + 1}` : 'Shore up your weakest seat',
          detail: 'Your most vulnerable winning district gets +2 points at the next election.',
          apply: () => { c.nextSwing += dir * size; if (weak >= 0) c.nextBonus[weak] += 0.02; return weak >= 0 ? `you shored up District ${weak + 1}.` : 'you had no seat to shore up.'; } },
        { label: 'Spread resources evenly', detail: 'Every district gets +0.7 points at the next election.',
          apply: () => { c.nextSwing += dir * size + 0.007; return 'you spread resources evenly.'; } },
      ],
    };
  },
  scandal(c) {
    const mine = districtsYouLead();
    if (!mine.length) return null;
    const d = pick(mine, c.rand);
    return {
      type: 'scandal',
      title: `Scandal in District ${d + 1}`,
      text: `Your candidate in District ${d + 1} is caught in a scandal. Left alone, it costs ${lean(5)} there at the next election.`,
      tiles: currentStats()[d].tiles,
      choices: [
        { label: 'Replace the candidate', detail: 'No scandal penalty, but the new candidate is less known: −1.5 points there for the rest of the decade.',
          apply: () => { changeTiles(currentStats()[d].tiles, { lean: -1.5 }); return `you replaced the District ${d + 1} candidate.`; } },
        { label: 'Ride it out', detail: '−5 points there at the next election only.',
          apply: () => { c.nextBonus[d] -= 0.05; return `you rode out the District ${d + 1} scandal.`; } },
      ],
    };
  },
  voterLaw(c) {
    const pops = game.tiles.map((t) => t.pop).sort((a, b) => b - a);
    const cutoff = pops[Math.floor(pops.length * 0.3)];
    const ids = game.tiles.filter((t) => t.pop >= cutoff).map((t) => t.id);
    return {
      type: 'voterLaw',
      title: 'New voting restrictions passed',
      text: `A new law cuts early voting. Turnout is expected to fall 6% in the ${ids.length} most crowded hexes.`,
      tiles: ids,
      choices: [
        { label: 'Challenge it in court', detail: 'A 50% chance the court blocks it.', chance: true,
          apply: (preview) => {
            if (preview) return '';
            if (c.rand() < 0.5) return 'you challenged the law and the court blocked it.';
            changeTiles(ids, { turnout: -0.06 });
            return 'you challenged the law but lost.';
          } },
        { label: 'Let it stand', detail: 'Turnout in those hexes falls 6%.',
          apply: () => { changeTiles(ids, { turnout: -0.06 }); return 'you let the law stand.'; } },
      ],
    };
  },
  retirement(c) {
    const mine = districtsYouLead();
    if (!mine.length) return null;
    const d = pick(mine, c.rand);
    return {
      type: 'retirement',
      title: `District ${d + 1}'s representative retires`,
      text: `Your long-serving representative in District ${d + 1} is stepping down, and the seat loses its incumbent advantage.`,
      tiles: currentStats()[d].tiles,
      choices: [
        { label: 'Recruit a well-known local', detail: 'A gamble: 50% chance of +1 point there for the decade, 50% chance of −2.', chance: true,
          apply: (preview) => {
            if (preview) return '';
            const good = c.rand() < 0.5;
            changeTiles(currentStats()[d].tiles, { lean: good ? 1 : -2 });
            return good ? `your star recruit in District ${d + 1} is a hit.` : `your star recruit in District ${d + 1} flopped.`;
          } },
        { label: 'Promote a party loyalist', detail: '−1 point there for the rest of the decade.',
          apply: () => { changeTiles(currentStats()[d].tiles, { lean: -1 }); return `you promoted a loyalist in District ${d + 1}.`; } },
      ],
    };
  },
};

function drawEvent(c) {
  const types = Object.keys(EVENT_TYPES).filter((k) => k !== c.lastType);
  for (let k = 0; k < 20; k++) {
    const type = pick(types, c.rand);
    const ev = EVENT_TYPES[type](c);
    if (ev) {
      c.lastType = type;
      ev.previews = ev.choices.map((ch) => (ch.chance ? null : previewChoice(c, ch)));
      return ev;
    }
  }
  return null;
}

// Expected share of each district at the next election, including modifiers.
function expectedShares(c) {
  return currentStats().map((s, d) => s.share + c.nextSwing + c.nextBonus[d]);
}

// Apply a choice to a copy of the state and report how district shares move.
function previewChoice(c, choice) {
  const snapTiles = game.tiles.map((t) => [t.pop, t.lean, t.turnout]);
  const snapSwing = c.nextSwing;
  const snapBonus = c.nextBonus.slice();
  const before = expectedShares(c);
  choice.apply(true);
  const after = expectedShares(c);
  game.tiles.forEach((t, i) => { [t.pop, t.lean, t.turnout] = snapTiles[i]; });
  c.nextSwing = snapSwing;
  c.nextBonus = snapBonus;
  return after.map((a, d) => ({ d, delta: a - before[d] }))
    .filter((x) => Math.abs(x.delta) >= 0.0005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ---------- Choosing and advancing ----------
function chooseOption(i) {
  const c = game.campaign;
  if (!c || !c.event) return;
  const ev = c.event;
  const outcome = ev.choices[i].apply(false);
  c.log.unshift(`${c.year} · ${ev.title}: ${outcome}`);
  c.event = null;
  driftYear(c);
  buildBoard();
  if (isElectionYear(c.year)) {
    const result = campaignElection(c);
    render();
    showCampaignElection(result);
  } else {
    nextCampaignYear();
  }
}

function nextCampaignYear() {
  const c = game.campaign;
  c.year++;
  if (c.year > CAMPAIGN_LAST_YEAR) {
    c.over = true;
    render();
    showDecadeSummary();
    return;
  }
  c.event = drawEvent(c);
  Sound.play('event');
  render();
}

// One simulated election with the current state and this year's modifiers.
function campaignElection(c) {
  const { tiles, unc } = game;
  const T = tiles.length;
  const n = game.cfg.districts;
  const s = Math.floor(c.rand() * unc.sims);
  const you = new Array(n).fill(0);
  const opp = new Array(n).fill(0);
  for (let i = 0; i < T; i++) {
    const d = ui.assign[i];
    if (d < 0) continue;
    const t = tiles[i];
    const share = clampShare(t.lean / 100 + unc.shift[s * T + i] + c.nextSwing + c.nextBonus[d]);
    const vt = votersOf(t) * (unc.tScale ? unc.tScale[s * T + i] : 1);
    const g = unc.gap ? unc.gap[s] : 0;
    you[d] += vt * share * (1 + g / 2);
    opp[d] += vt * (1 - share) * (1 - g / 2);
  }
  const shares = you.map((v, d) => v / (v + opp[d]));
  const seats = shares.filter((x) => x > 0.5).length;
  const result = {
    year: c.year,
    seats,
    shares,
    swing: unc.state[s] + c.nextSwing,
    turnout: unc.tState ? unc.tState[s] : 0,
    reached: seats >= game.target,
  };
  c.elections.push(result);
  c.nextSwing = 0;
  c.nextBonus.fill(0);
  return result;
}

function showCampaignElection(r) {
  const n = game.cfg.districts;
  Sound.election(r.reached);
  const rows = r.shares.map((x, d) => `
    <tr>
      <td><span class="dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}</td>
      <td class="num">${fmtPct(x)}</td>
      <td class="${x > 0.5 ? 'win' : 'lose'}">${x > 0.5 ? '✓ You' : '✗ Opponent'}</td>
    </tr>`).join('');
  const swing = Math.abs(r.swing * 100).toFixed(1);
  const dir = r.swing >= 0 ? `toward ${youSide()}` : `toward ${oppSide()}`;
  const tPct = Math.round(Math.abs(r.turnout * 100));
  const turnoutText = tPct === 0 ? 'about the same as usual' : `${tPct}% ${r.turnout >= 0 ? 'above' : 'below'} usual`;
  openDialog(`
    <h2>${r.year} election: ${r.reached ? 'target reached' : 'short of target'}</h2>
    <p>You won <strong>${r.seats} of ${n}</strong> seats (target ${game.target}). The state swung ${swing} points ${dir},
       and turnout was ${turnoutText}.</p>
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">Your vote</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  [{ label: r.year >= CAMPAIGN_LAST_YEAR ? 'See the decade' : `Continue to ${r.year + 1}`, primary: true, onClick: nextCampaignYear }]);
}

function campaignScore(c) {
  return {
    seats: c.elections.reduce((s, e) => s + e.seats, 0),
    reached: c.elections.filter((e) => e.reached).length,
  };
}

function showDecadeSummary() {
  const c = game.campaign;
  const n = game.cfg.districts;
  const sc = campaignScore(c);
  const bars = c.elections.map((e) => `
    <div class="hist-row">
      <span class="hist-label">${e.year}</span>
      <span class="hist-track"><span class="hist-bar ${e.reached ? 'enough' : ''}" style="width:${(e.seats / n) * 100}%"></span></span>
      <span class="hist-val">${e.seats} of ${n}</span>
    </div>`).join('');
  const verdict = sc.reached === c.elections.length ? 'Your map held all decade.'
    : sc.reached === 0 ? 'Your map never reached its target.'
      : `Your map reached its target in ${sc.reached} of ${c.elections.length} elections.`;
  openDialog(`
    <h2>Decade complete</h2>
    <p>${verdict} You won <strong>${sc.seats} seats</strong> across ${c.elections.length} elections
       (out of ${n * c.elections.length} possible; target ${game.target} per election).</p>
    <h3 class="dialog-sub">Seats won per election</h3>
    <div class="histogram">${bars}</div>
    <p class="small muted">Over the decade, suburbs trended ${trendWord(c.typeTrend.suburban)}, rural areas ${trendWord(c.typeTrend.rural)}
       and cities ${trendWord(c.typeTrend.urban)}. Use the <strong>Change</strong> colour view to see where your map was eroded.</p>`,
  [{ label: 'Look at the map' }, { label: 'New campaign', primary: true, onClick: () => startGame(els.size.value, randomSeed()) }]);
}

function trendWord(x) {
  if (Math.abs(x) < 0.1) return 'held steady';
  return `${x > 0 ? `toward ${youSide()}` : `toward ${oppSide()}`} (${Math.abs(x * 10).toFixed(1)} points over 10 years)`;
}

// ---------- Panel ----------
function renderCampaign() {
  const show = !!game.campaignMode;
  els.campaign.hidden = !show;
  if (!show) return;
  const c = game.campaign;
  const n = game.cfg.districts;
  const years = [];
  for (let y = CAMPAIGN_FIRST_YEAR; y <= CAMPAIGN_LAST_YEAR; y++) years.push(y);
  const timeline = years.map((y) => {
    const e = c && c.elections.find((x) => x.year === y);
    const state = !c ? '' : c.over || y < c.year ? 'done' : y === c.year ? 'current' : '';
    return `<li class="tl-year ${state} ${isElectionYear(y) ? 'election' : ''}">
      <span class="tl-label">${y}</span>
      <span class="tl-mark" aria-hidden="true">${isElectionYear(y) ? '🗳' : ''}</span>
      <span class="tl-result ${e ? (e.reached ? 'ok' : 'bad') : ''}">${e ? `${e.seats}/${n}` : ''}</span>
    </li>`;
  }).join('');

  let body;
  if (!c) {
    body = `<p class="camp-lead">Draw a legal map, then play the decade <strong>${CAMPAIGN_FIRST_YEAR}–${CAMPAIGN_LAST_YEAR}</strong>.
      Each year brings an event and a choice; populations, leanings and turnout drift; every even year holds an election.
      Your score is the total seats you win in the five elections. The map is locked once the decade starts.</p>
      <button type="button" class="primary" id="start-decade">Start the decade</button>`;
  } else if (c.over) {
    const sc = campaignScore(c);
    body = `<p class="camp-lead"><strong>Decade complete.</strong> ${sc.seats} seats won; target reached in ${sc.reached} of ${c.elections.length} elections.</p>
      <button type="button" class="primary" id="new-campaign">New campaign</button>`;
  } else if (!c.event) {
    body = `<p class="camp-lead"><strong>Election night ${c.year}.</strong> The results are in.</p>`;
  } else {
    const ev = c.event;
    const mods = [];
    if (c.nextSwing) mods.push(`statewide ${c.nextSwing > 0 ? '+' : '−'}${Math.abs(c.nextSwing * 100).toFixed(1)} pts`);
    c.nextBonus.forEach((b, d) => { if (b) mods.push(`District ${d + 1} ${b > 0 ? '+' : '−'}${Math.abs(b * 100).toFixed(1)} pts`); });
    const nextElection = isElectionYear(c.year) ? c.year : c.year + 1;
    const choices = ev.choices.map((ch, i) => {
      const pv = ev.previews[i];
      let effect = '';
      if (ch.chance) effect = '<span class="muted">Outcome depends on chance.</span>';
      else if (pv && pv.length) {
        effect = pv.slice(0, 4).map((x) => `<span class="${x.delta > 0 ? 'ok' : 'bad'}">D${x.d + 1} ${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta * 100).toFixed(1)}</span>`).join(' · ');
      } else effect = '<span class="muted">Little effect on your districts.</span>';
      return `<button type="button" class="choice" data-choice="${i}">
        <span class="choice-label">${ch.label}</span>
        <span class="choice-detail">${ch.detail}</span>
        <span class="choice-effect">${effect}</span>
      </button>`;
    }).join('');
    body = `
      <div class="event-card">
        <p class="event-year">${c.year}${isElectionYear(c.year) ? ' · election at year end' : ''}</p>
        <h3>${ev.title}</h3>
        <p>${ev.text}</p>
        <div class="choices">${choices}</div>
        <p class="small muted">Effects show the change in each district's expected vote share at the ${nextElection} election.</p>
      </div>
      ${mods.length ? `<p class="small">Next election (${nextElection}): ${mods.join(', ')}.</p>` : ''}`;
  }
  const sc = c ? campaignScore(c) : null;
  els.campaign.innerHTML = `
    <div class="camp-head">
      <h2>Campaign</h2>
      ${sc ? `<span class="camp-score">${sc.seats} seats won · target reached ${sc.reached}/${c.elections.length}</span>` : ''}
    </div>
    <ol class="timeline">${timeline}</ol>
    ${body}
    ${c && c.log.length ? `<details class="camp-log"><summary>What happened so far</summary><ul>${c.log.map((l) => `<li>${l}</li>`).join('')}</ul></details>` : ''}`;

  const start = els.campaign.querySelector('#start-decade');
  if (start) start.addEventListener('click', startDecade);
  const again = els.campaign.querySelector('#new-campaign');
  if (again) again.addEventListener('click', () => startGame(els.size.value, randomSeed()));
  els.campaign.querySelectorAll('[data-choice]').forEach((b) => {
    b.addEventListener('click', () => chooseOption(Number(b.dataset.choice)));
    b.addEventListener('mouseenter', () => highlightEventTiles(true));
    b.addEventListener('mouseleave', () => highlightEventTiles(false));
  });
  highlightEventTiles(false);
}

// Outline the hexes an event affects.
function highlightEventTiles(strong) {
  const c = game.campaign;
  const ids = new Set(c && c.event ? c.event.tiles : []);
  tileEls.forEach((el, i) => {
    el.g.classList.toggle('event-hex', ids.has(i));
    el.g.classList.toggle('event-hex-strong', strong && ids.has(i));
  });
}

// Change since the decade began, in points toward you (for the Change view and tooltip).
function leanChange(t) {
  const c = game.campaign;
  return c ? t.lean - c.base[t.id].lean : 0;
}

if (typeof module !== 'undefined') {
  module.exports = { startDecade, driftYear, campaignElection, EVENT_TYPES };
}
