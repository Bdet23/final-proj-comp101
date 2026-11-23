'use strict';

/* ==========================================================================
   Campaign mode: one decade on a Realistic map.

   The player draws a map, then plays 2021–2030 one year at a time. Each year
   brings an event with choices; after the choice the year passes and the
   state drifts (population, party leanings, turnout). Every even year holds a
   House election, decided by one simulated election. The score is the total
   number of seats won across the five elections.

   Stage 2 adds:
   - Political capital (⚑): starts at 3, earned at each election (+1, or +2
     when the target is reached) and spent on many choices.
   - Court challenges: each year a lawsuit may be filed, more likely when the
     map's efficiency gap favours you strongly or districts have drifted away
     from equal population. Defend it (⚑2, a win chance) or settle; losing or
     settling means redrawing the map under the court's rules before the
     year can continue.

   Uses globals from game.js: game, ui, els, render, buildBoard, currentStats,
   validatePlan, openDialog, startGame, fairnessMetrics, votersOf and
   formatting helpers; Sound from sound.js.
   ========================================================================== */

const CAMPAIGN_FIRST_YEAR = 2021;
const DECADES = 3;                                   // 2021–2050
const CAMPAIGN_LAST_YEAR = CAMPAIGN_FIRST_YEAR + 10 * DECADES - 1;
const START_CAPITAL = 3;
const MID_REDRAW_COST = 3;      // capital for an optional mid-decade redraw
const MID_REDRAW_RISK = 0.15;   // extra yearly lawsuit risk for the rest of that decade
const NATIONAL_GROWTH = 0.07;   // typical US population growth per decade
// Redraw rules: a court order is stricter than a settlement; an independent
// commission is strictest. Census and mid-decade redraws only need legal districts.
// Compactness is relative to the map: `ppShare` of a neutral benchmark (the most
// compact of several random legal maps at today's populations), because how
// compact districts can be depends on the board and where people live.
const REDRAW_RULES = {
  court: { label: 'Court-ordered redraw', ppShare: 0.9, eg: 0.07 },
  settle: { label: 'Settlement redraw', ppShare: 0.85, eg: null },
  census: { label: 'Census redraw', ppShare: null, eg: null },
  commission: { label: "Independent commission's map", ppShare: 0.95, eg: 0.04 },
  mid: { label: 'Mid-decade redraw', ppShare: null, eg: null },
};
const BENCHMARK_PLANS = 12;
const decadeStart = (c) => CAMPAIGN_FIRST_YEAR + 10 * c.decade;
const decadeEnd = (c) => decadeStart(c) + 9;
// The year the current decade's map was drawn (baseline for the Change view).
const campaignBaseYear = () => (game && game.campaign ? decadeStart(game.campaign) - 1 : CAMPAIGN_FIRST_YEAR - 1);
const totalPop = () => game.tiles.reduce((s, t) => s + t.pop, 0);

// Win chance and expected seats for the current map and state.
function measure() {
  const sim = simulatePlan(game, ui.assign);
  return { win: sim.pTarget, seats: sim.expectedSeats };
}

const isElectionYear = (y) => y % 2 === 0;
const clampLean = (x) => Math.max(3, Math.min(97, Math.round(x * 10) / 10));
const clampTurnout = (x) => Math.max(0.3, Math.min(0.92, x));
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];
const pctText = (x) => `${Math.round(x * 100)}%`;
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
    capital: START_CAPITAL,
    nextSwing: 0,                     // statewide shift at the next election (fraction)
    nextBonus: new Array(n).fill(0),  // per-district shift at the next election (fraction)
    reformPressure: 0,                // extra yearly lawsuit risk from a reform campaign
    decade: 0,
    decadeStartPop: totalPop(),
    followUps: [],                    // chained events: { year, source, make(c) }
    commission: false,                // a reform initiative passed: a commission sets the next census map's rules
    midUsed: false,
    midPenalty: 0,
    history: [{ year: CAMPAIGN_FIRST_YEAR - 1, ...measure() }],
    lastDrift: null,
    censuses: [],                     // { year, growth, national, from, to }
    lastCourtYear: -99,
    courtCases: [],                   // { year, outcome }
    redraw: null,                     // { kind, pp, eg } while a redraw is in progress
    elections: [],
    log: [],
    event: null,
    recent: [],
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

// ---------- Helpers for events ----------
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

// The k hexes that lean most toward you (side > 0) or the opponent (side < 0).
function strongestHexes(side, fraction = 0.25) {
  const sorted = game.tiles.slice().sort((a, b) => side * (b.lean - a.lean));
  return sorted.slice(0, Math.max(1, Math.round(game.tiles.length * fraction))).map((t) => t.id);
}

function changeTiles(ids, f) {
  for (const i of ids) {
    const t = game.tiles[i];
    if (f.pop) t.pop = Math.max(500, Math.round(t.pop * (1 + f.pop)));
    if (f.lean) t.lean = clampLean(t.lean + f.lean);
    if (f.turnout) t.turnout = clampTurnout(t.turnout * (1 + f.turnout));
  }
}

// A chance roll that remembers its odds and where it landed, so the
// outcome card can show it. Success when the roll lands below the chance.
function roll(c, chance, success, failure) {
  const value = c.rand();
  const ok = value < chance;
  return { chance, value, ok, label: ok ? success : failure };
}

const ptsWord = (x) => `${Math.abs(x)} point${Math.abs(x) === 1 ? '' : 's'}`;

// ---------- Court challenges ----------
function currentIdeal() {
  return game.tiles.reduce((s, t) => s + t.pop, 0) / game.cfg.districts;
}

function offBalanceDistricts() {
  const ideal = currentIdeal();
  return currentStats().filter((s) => Math.abs(s.pop - ideal) > ideal * game.tolerance).length;
}

// Yearly chance of a lawsuit, from how extreme the map is.
function lawsuitRisk(c) {
  if (c.year - c.lastCourtYear < 3) return 0;
  const eg = Math.max(0, fairnessMetrics(currentStats()).efficiencyGap);
  const risk = 0.04 + Math.max(0, eg - 0.05) * 1.5 + 0.05 * offBalanceDistricts() + c.reformPressure + c.midPenalty;
  return Math.min(0.6, risk);
}

function courtEvent(c) {
  const eg = Math.max(0, fairnessMetrics(currentStats()).efficiencyGap);
  const bad = offBalanceDistricts();
  const winChance = Math.max(0.15, Math.min(0.8, 0.8 - Math.max(0, eg - 0.05) * 3 - 0.07 * bad));
  const reasons = [];
  if (eg > 0.05) reasons.push(`an efficiency gap of ${pctText(eg)} in your favour`);
  if (bad) reasons.push(`${bad} district${bad === 1 ? '' : 's'} no longer within ±${Math.round(game.tolerance * 100)}% of equal population`);
  const why = reasons.length ? reasons.join(' and ') : 'the map as a whole';
  const court = REDRAW_RULES.court;
  const settle = REDRAW_RULES.settle;
  return {
    type: 'court',
    title: 'Lawsuit: your map is challenged in court',
    text: `Voters have sued over the map, pointing to ${why}.`,
    tiles: [],
    court: true,
    choices: [
      { label: 'Defend the map', cost: 2, chance: true, noPreview: true,
        detail: `About a ${pctText(winChance)} chance to win. If you lose, the court orders a redraw: equal populations, compactness at least ${pctText(court.ppShare)} of a neutral map's, and an efficiency gap of at most ${pctText(court.eg)} in your favour.`,
        apply: () => {
          const r = roll(c, winChance, 'The court upheld your map.', 'The court struck down your map and ordered a redraw.');
          c.courtCases.push({ year: c.year, outcome: r.ok ? 'won' : 'lost' });
          if (!r.ok) beginRedraw(c, 'court');
          return { text: r.ok ? 'you defended the map and the court upheld it.' : 'you defended the map and lost: the court ordered a redraw.', roll: r };
        } },
      { label: 'Settle and redraw it yourself', noPreview: true, effectText: 'You will redraw the map before the year continues.',
        detail: `Redraw now with equal populations and compactness at least ${pctText(settle.ppShare)} of a neutral map's.`,
        apply: () => {
          c.courtCases.push({ year: c.year, outcome: 'settled' });
          beginRedraw(c, 'settle');
          return 'you settled and redrew the map.';
        } },
    ],
  };
}

function beginRedraw(c, kind) {
  const rule = REDRAW_RULES[kind];
  game.ideal = currentIdeal(); // populations must be equal at today's numbers
  c.redraw = { kind, eg: rule.eg, pp: null, benchmark: null };
  if (rule.ppShare) {
    c.redraw.benchmark = benchmarkCompactness();
    c.redraw.pp = Math.floor(c.redraw.benchmark * rule.ppShare * 100) / 100;
  }
  ui.tool = 0;
}

// Average Polsby-Popper of a plan (same formula as the results dialog).
function planCompactness(plan) {
  const n = game.cfg.districts;
  const cells = new Array(n).fill(0);
  const edges = new Array(n).fill(0);
  for (const t of game.tiles) {
    const d = plan[t.id];
    if (d < 0) continue;
    cells[d]++;
    for (const j of t.nbrs) if (j < 0 || plan[j] !== d) edges[d]++;
  }
  let sum = 0;
  for (let d = 0; d < n; d++) sum += edges[d] ? (4 * Math.PI * cells[d] * HEX_AREA) / (edges[d] * edges[d]) : 0;
  return sum / n;
}

// The most compact of several random legal maps at today's populations.
function benchmarkCompactness() {
  const plans = sampleLegalPlans(game.tiles, game.cfg.districts, game.ideal, mulberry32(game.campaign.seed + game.campaign.year),
    game.tolerance, BENCHMARK_PLANS, 60000, 2, 0.01);
  if (!plans.length) return 0.35;
  return Math.max(...plans.map((x) => planCompactness(x.plan)));
}

// The redraw's rules, each with whether it is met now.
function redrawChecks(c) {
  const stats = currentStats();
  const n = game.cfg.districts;
  const m = fairnessMetrics(stats);
  const assigned = ui.assign.every((d) => d >= 0);
  const legal = stats.filter(isLegal).length;
  const checks = [
    { ok: assigned && legal === n, text: `Every district legal: connected, ${popRangeText()}`, value: `${legal} / ${n}` },
  ];
  if (c.redraw.pp != null) {
    checks.push({ ok: m.avgCompact >= c.redraw.pp, value: m.avgCompact.toFixed(2),
      text: `Average compactness at least ${c.redraw.pp.toFixed(2)} (a neutral map reaches ${c.redraw.benchmark.toFixed(2)})` });
  }
  if (c.redraw.eg != null) {
    checks.push({ ok: m.efficiencyGap <= c.redraw.eg, text: `Efficiency gap at most ${pctText(c.redraw.eg)} in your favour`,
      value: `${m.efficiencyGap >= 0 ? '' : '−'}${pctText(Math.abs(m.efficiencyGap))}` });
  }
  return checks;
}

function submitRedraw() {
  const c = game.campaign;
  const checks = redrawChecks(c);
  const failing = checks.filter((x) => !x.ok);
  if (failing.length) {
    Sound.play('buzz');
    openDialog(`<h2>The new map doesn't meet the rules yet</h2>
      <ul>${failing.map((x) => `<li>${x.text} (now ${x.value})</li>`).join('')}</ul>`, [{ label: 'Keep drawing', primary: true }]);
    return;
  }
  const kind = c.redraw.kind;
  c.log.unshift(`${c.year} · You submitted a new map (${REDRAW_RULES[kind].label.toLowerCase()}).`);
  c.redraw = null;
  ui.tool = 'erase';
  Sound.play('legal');
  if (kind === 'census' || kind === 'commission') {
    startNextDecade(c);
    return;
  }
  if (kind === 'mid') {
    // Back to this year's event, with previews for the new map.
    if (c.event) c.event.previews = c.event.choices.map((ch) => (ch.chance ? null : previewChoice(c, ch)));
    render();
    return;
  }
  finishYear();
}

// ---------- Optional mid-decade redraw ----------
function startMidRedraw() {
  const c = game.campaign;
  if (!c || c.midUsed || c.capital < MID_REDRAW_COST || !c.event || c.event.court) return;
  c.capital -= MID_REDRAW_COST;
  c.midUsed = true;
  c.midPenalty += MID_REDRAW_RISK;
  c.log.unshift(`${c.year} · You started a mid-decade redraw (−⚑${MID_REDRAW_COST}, lawsuit risk +${pctText(MID_REDRAW_RISK)}).`);
  beginRedraw(c, 'mid');
  Sound.play('event');
  render();
}

// ---------- Census and the next decade ----------
function runCensus(c) {
  const n0 = game.cfg.districts;
  const growth = totalPop() / c.decadeStartPop - 1;
  const national = NATIONAL_GROWTH + (c.rand() - 0.5) * 0.04;
  // The state's share of the nation's seats follows its share of the nation's growth.
  const exact = n0 * (1 + growth) / (1 + national);
  let n1 = n0;
  if (exact - n0 >= 0.35) n1 = n0 + 1;
  else if (n0 - exact >= 0.35) n1 = n0 - 1;
  n1 = Math.max(2, Math.min(DISTRICT_COLORS.length, n1));
  const year = decadeEnd(c);
  c.year = year; // the census belongs to the decade's last year; the next decade starts after the redraw
  c.censuses.push({ year, growth, national, from: n0, to: n1 });
  if (n1 !== n0) {
    game.cfg.districts = n1;
    game.target = Math.max(1, Math.round((game.target * n1) / n0));
    ui.assign = ui.assign.map((d) => (d >= n1 ? -1 : d));
    c.nextBonus = new Array(n1).fill(0);
    buildDistrictList();
  }
  c.event = null;
  beginRedraw(c, c.commission ? 'commission' : 'census');
  const seatText = n1 > n0 ? `The state <strong>gains a seat</strong>: ${n0} → ${n1} districts.`
    : n1 < n0 ? `The state <strong>loses a seat</strong>: ${n0} → ${n1} districts.`
      : `The state keeps its <strong>${n1} seats</strong>.`;
  const rules = c.commission
    ? `Because the reform initiative passed, the new map must meet an independent commission's rules:
       compactness of at least ${c.redraw.pp.toFixed(2)} (${pctText(REDRAW_RULES.commission.ppShare)} of a neutral map's) and an efficiency gap of at most ${pctText(REDRAW_RULES.commission.eg)} in your favour.`
    : 'Redraw the map so every district is legal at the new population numbers.';
  openDialog(`
    <h2>The ${year} census</h2>
    <p>The state grew <strong>${(growth * 100).toFixed(1)}%</strong> this decade, against ${(national * 100).toFixed(1)}% nationally. ${seatText}
       Your target is now ${game.target} of ${n1} seats.</p>
    <p>${rules}</p>
    <p class="small muted">Your current districts are kept as a starting point; populations must be equal at today's numbers
       (${fmtInt(game.ideal)} people per district).</p>`,
  [{ label: 'Draw the new map', primary: true }]);
  Sound.play('event');
  render();
}

function startNextDecade(c) {
  c.decade++;
  c.year = decadeStart(c);
  c.base = game.tiles.map((t) => ({ pop: t.pop, lean: t.lean, turnout: t.turnout }));
  c.decadeStartPop = totalPop();
  c.lastCourtYear = -99;
  c.reformPressure = 0;
  c.midUsed = false;
  c.midPenalty = 0;
  c.commission = false;
  c.recent = [];
  c.followUps = [];
  c.lastDrift = null;
  c.history = [{ year: c.year - 1, ...measure() }];
  c.event = drawEvent(c);
  Sound.play('event');
  render();
}

// ---------- Events ----------
// Each factory returns { type, title, text, tiles, choices: [{ label, detail,
// cost?, gain?, chance?, apply(preview) -> log text }] } or null if it can't happen now.
const EVENT_TYPES = {
  boom(c) {
    const center = pick(game.tiles, c.rand);
    const ids = cluster(center, 2);
    const dir = c.rand() < 0.5 ? 1 : -1;
    return {
      title: `Housing boom near ${placeName(center)}`,
      text: `A new employer is bringing about 8% more residents to ${ids.length} hexes around ${placeName(center)}. The newcomers lean toward ${dir > 0 ? youSide() : oppSide()}, shifting those hexes ${ptsWord(3)}.`,
      tiles: ids,
      choices: [
        { label: 'Register the newcomers', cost: 1, detail: 'Turnout in those hexes rises 5%.',
          apply: (preview) => { changeTiles(ids, { pop: 0.08, lean: 3 * dir, turnout: 0.05 }); if (!preview) followUp(c, 2, `Housing boom near ${placeName(center)}`, (cc) => CHAINS.suburb(cc, center, ids, dir)); return 'you ran a registration drive.'; } },
        { label: 'Leave it alone', detail: 'Newcomers are slow to register: turnout there falls 4%.',
          apply: (preview) => { changeTiles(ids, { pop: 0.08, lean: 3 * dir, turnout: -0.04 }); if (!preview) followUp(c, 2, `Housing boom near ${placeName(center)}`, (cc) => CHAINS.suburb(cc, center, ids, dir)); return 'you left the newcomers alone.'; } },
      ],
    };
  },
  closure(c) {
    const center = pick(game.tiles, c.rand);
    const ids = cluster(center, 1);
    const dir = c.rand() < 0.5 ? 1 : -1;
    return {
      title: `Factory closes near ${placeName(center)}`,
      text: `A major plant is closing. ${ids.length} hexes around ${placeName(center)} lose about 6% of their people, and anger over the closure pushes them ${ptsWord(4)} toward ${dir > 0 ? youSide() : oppSide()}.`,
      tiles: ids,
      choices: [
        { label: 'Promise a jobs program', cost: 1, detail: 'Halves the shift there. The promise comes due in two years.',
          apply: (preview) => { changeTiles(ids, { pop: -0.06, lean: 2 * dir }); if (!preview) followUp(c, 2, `Factory closes near ${placeName(center)}`, (cc) => CHAINS.jobs(cc, center, ids)); return 'you promised a jobs program.'; } },
        { label: 'Keep your focus elsewhere', detail: 'The full shift happens.',
          apply: () => { changeTiles(ids, { pop: -0.06, lean: 4 * dir }); return 'you kept your focus elsewhere.'; } },
      ],
    };
  },
  wave(c) {
    const dir = c.rand() < 0.6 ? -1 : 1;
    const size = 0.025 + c.rand() * 0.015;
    const weak = weakestWinningDistrict();
    return {
      title: dir < 0 ? 'A wave is building against you' : 'The national mood favours you',
      text: `Polls point to a statewide shift of about ${(size * 100).toFixed(1)} points toward ${dir < 0 ? oppSide() : youSide()} at the next election.`,
      tiles: [],
      choices: [
        { label: weak >= 0 ? `Shore up District ${weak + 1}` : 'Shore up your weakest seat', cost: 1,
          detail: 'Your most vulnerable winning district gets +2.5 points at the next election.',
          apply: () => { c.nextSwing += dir * size; if (weak >= 0) c.nextBonus[weak] += 0.025; return weak >= 0 ? `you shored up District ${weak + 1}.` : 'you had no seat to shore up.'; } },
        { label: 'Spread resources evenly', cost: 1, detail: 'Every district gets +0.8 points at the next election.',
          apply: () => { c.nextSwing += dir * size + 0.008; return 'you spread resources evenly.'; } },
        { label: 'Save your capital', detail: 'Do nothing extra.',
          apply: () => { c.nextSwing += dir * size; return 'you saved your capital.'; } },
      ],
    };
  },
  scandal(c) {
    const mine = districtsYouLead();
    if (!mine.length) return null;
    const d = pick(mine, c.rand);
    const ids = currentStats()[d].tiles;
    return {
      title: `Scandal in District ${d + 1}`,
      text: `Your candidate in District ${d + 1} is caught in a scandal. Left alone, it costs ${ptsWord(5)} there at the next election.`,
      tiles: ids,
      choices: [
        { label: 'Replace the candidate', cost: 1, detail: 'No scandal penalty, but the new candidate is less known: −1.5 points there for the rest of the decade.',
          apply: () => { changeTiles(ids, { lean: -1.5 }); return `you replaced the District ${d + 1} candidate.`; } },
        { label: 'Ride it out', detail: '−5 points there at the next election only. A primary challenger may follow.',
          apply: (preview) => { c.nextBonus[d] -= 0.05; if (!preview) followUp(c, 1, `Scandal in District ${d + 1}`, (cc) => CHAINS.primary(cc, d)); return `you rode out the District ${d + 1} scandal.`; } },
      ],
    };
  },
  voterLaw(c) {
    const pops = game.tiles.map((t) => t.pop).sort((a, b) => b - a);
    const cutoff = pops[Math.floor(pops.length * 0.3)];
    const ids = game.tiles.filter((t) => t.pop >= cutoff).map((t) => t.id);
    return {
      title: 'New voting restrictions passed',
      text: `A new law cuts early voting. Turnout is expected to fall 6% in the ${ids.length} most crowded hexes.`,
      tiles: ids,
      choices: [
        { label: 'Challenge it in court', cost: 1, detail: 'A 50% chance the court blocks it.', chance: true,
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.5, 'The court blocked the law.', 'The court let the law stand: turnout falls 6% in those hexes.');
            if (!r.ok) changeTiles(ids, { turnout: -0.06 });
            return { text: r.ok ? 'you challenged the law and the court blocked it.' : 'you challenged the law but lost.', roll: r };
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
    const ids = currentStats()[d].tiles;
    return {
      title: `District ${d + 1}'s representative retires`,
      text: `Your long-serving representative in District ${d + 1} is stepping down, and the seat loses its incumbent advantage.`,
      tiles: ids,
      choices: [
        { label: 'Recruit a well-known local', cost: 1, detail: 'A gamble: 50% chance of +1 point there for the decade, 50% chance of −2.', chance: true,
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.5, `Your recruit is a hit: +1 point in District ${d + 1}.`, `Your recruit flopped: −2 points in District ${d + 1}.`);
            changeTiles(ids, { lean: r.ok ? 1 : -2 });
            return { text: r.ok ? `your star recruit in District ${d + 1} is a hit.` : `your star recruit in District ${d + 1} flopped.`, roll: r };
          } },
        { label: 'Promote a party loyalist', detail: '−1 point there for the rest of the decade.',
          apply: () => { changeTiles(ids, { lean: -1 }); return `you promoted a loyalist in District ${d + 1}.`; } },
      ],
    };
  },
  donor(c) {
    return {
      title: 'A wealthy donor offers support',
      text: 'A donor offers a large contribution. It would fund your plans, but the donor has a controversial past.',
      tiles: [],
      choices: [
        { label: 'Accept the donation', gain: 2, chance: true, detail: '+2 capital. A 35% chance it leaks: −3 points in one of your districts at the next election.',
          apply: (preview) => {
            if (preview) return '';
            const mine = districtsYouLead();
            const r = roll(c, 0.65, 'The donation stayed quiet.', 'The donation leaked to the press.');
            if (!r.ok && mine.length) {
              const d = pick(mine, c.rand);
              c.nextBonus[d] -= 0.03;
              r.label = `The donation leaked: −3 points in District ${d + 1} at the next election.`;
              followUp(c, 1, 'A wealthy donor offers support', (cc) => CHAINS.ethics(cc));
              return { text: `you took the donation, and it leaked in District ${d + 1}.`, roll: r };
            }
            return { text: 'you took the donation quietly.', roll: r };
          } },
        { label: 'Decline politely', detail: 'No change.', apply: () => 'you declined the donation.' },
      ],
    };
  },
  project(c) {
    const weak = weakestWinningDistrict();
    if (weak < 0) return null;
    const ids = currentStats()[weak].tiles;
    return {
      title: 'Infrastructure money to spend',
      text: `New state funding can go to a road and broadband project. District ${weak + 1}, your most vulnerable seat, is asking for it.`,
      tiles: ids,
      choices: [
        { label: `Build it in District ${weak + 1}`, cost: 1, detail: '+2 points there for the rest of the decade.',
          apply: () => { changeTiles(ids, { lean: 2 }); return `you funded a project in District ${weak + 1}.`; } },
        { label: 'Bank the favour instead', gain: 1, detail: '+1 capital.',
          apply: () => 'you banked the favour.' },
      ],
    };
  },
  ballot(c) {
    const theirs = strongestHexes(-1);
    const yours = strongestHexes(1);
    return {
      title: "A ballot measure fires up the opponent's base",
      text: `A popular ballot question is expected to raise turnout 6% in the ${theirs.length} hexes that lean most toward ${oppSide()}.`,
      tiles: theirs,
      choices: [
        { label: 'Counter-mobilise', cost: 1, detail: `Turnout also rises 6% in the ${yours.length} hexes that lean most toward ${youSide()}.`,
          apply: () => { changeTiles(theirs, { turnout: 0.06 }); changeTiles(yours, { turnout: 0.06 }); return 'you counter-mobilised your base.'; } },
        { label: 'Stay quiet', detail: 'Only their turnout rises.',
          apply: () => { changeTiles(theirs, { turnout: 0.06 }); return 'you stayed quiet on the ballot measure.'; } },
      ],
    };
  },
  disaster(c) {
    const center = pick(game.tiles, c.rand);
    const ids = cluster(center, 1);
    return {
      title: `Severe storms near ${placeName(center)}`,
      text: `Storms damage ${ids.length} hexes around ${placeName(center)}: about 4% of residents move away for now, and turnout there drops 5%.`,
      tiles: ids,
      choices: [
        { label: 'Lead the relief effort', cost: 1, detail: '+2 points in those hexes for the decade.',
          apply: () => { changeTiles(ids, { pop: -0.04, turnout: -0.05, lean: 2 }); return 'you led the relief effort.'; } },
        { label: 'Leave it to local officials', detail: '−1 point in those hexes for the decade.',
          apply: () => { changeTiles(ids, { pop: -0.04, turnout: -0.05, lean: -1 }); return 'you left relief to local officials.'; } },
      ],
    };
  },
  gaffe() {
    const c = game.campaign;
    return {
      title: "Your party's leader makes a gaffe",
      text: 'A viral gaffe by your party\'s statewide leader is expected to cost about 1.5 points everywhere at the next election.',
      tiles: [],
      choices: [
        { label: 'Run damage-control ads', cost: 1, detail: 'Cuts the damage to 0.5 points.',
          apply: () => { c.nextSwing -= 0.005; return 'you ran damage-control ads.'; } },
        { label: 'Wait for it to blow over', detail: '−1.5 points statewide at the next election.',
          apply: () => { c.nextSwing -= 0.015; return 'you waited for the gaffe to blow over.'; } },
      ],
    };
  },
  independent(c) {
    const weak = weakestWinningDistrict();
    if (weak < 0) return null;
    return {
      title: `An independent candidate enters District ${weak + 1}`,
      text: `A popular independent is running in District ${weak + 1}, your narrowest seat, and will split your vote there by about ${ptsWord(3)} at the next election.`,
      tiles: currentStats()[weak].tiles,
      choices: [
        { label: 'Persuade them to drop out', cost: 2, detail: 'No effect on the race.',
          apply: () => `you persuaded the District ${weak + 1} independent to drop out.` },
        { label: 'Let them run', detail: `−3 points in District ${weak + 1} at the next election.`,
          apply: () => { c.nextBonus[weak] -= 0.03; return `you let the District ${weak + 1} independent run.`; } },
      ],
    };
  },
  reform(c) {
    if (c.reformPressure >= 0.2) return null;
    return {
      title: 'Redistricting reform campaign gathers signatures',
      text: 'Reformers are collecting signatures against gerrymandering. If they gain ground, a lawsuit against your map becomes more likely.',
      tiles: [],
      choices: [
        { label: 'Fight the campaign', cost: 2, detail: 'No change in lawsuit risk.',
          apply: () => 'you fought the reform campaign.' },
        { label: 'Ignore it', detail: 'Lawsuit risk rises by 10 percentage points for the rest of the decade, and the reformers may reach the ballot.',
          apply: (preview) => { c.reformPressure += 0.1; if (!preview) followUp(c, 1, 'Redistricting reform campaign', (cc) => CHAINS.initiative(cc)); return 'you ignored the reform campaign.'; } },
      ],
    };
  },
  economy() {
    const c = game.campaign;
    return {
      title: 'The economy is booming',
      text: 'Good economic news gives your party a moment of goodwill.',
      tiles: [],
      choices: [
        { label: 'Bank the goodwill', gain: 1, detail: '+1 capital.', apply: () => 'you banked the goodwill.' },
        { label: 'Turn it into votes', detail: '+1 point statewide at the next election.',
          apply: () => { c.nextSwing += 0.01; return 'you turned the good news into votes.'; } },
      ],
    };
  },
};

// ---------- Event chains ----------
// A follow-up event, due a few years later (only within the current decade).
function followUp(c, years, source, make) {
  const year = c.year + years;
  if (year <= decadeEnd(c)) c.followUps.push({ year, source, make });
}

const CHAINS = {
  suburb(c, center, ids, dir) {
    return {
      title: `The new suburb near ${placeName(center)} keeps growing`,
      text: `The boom is still drawing people: these hexes could grow another 6% and shift ${ptsWord(2)} more toward ${dir > 0 ? youSide() : oppSide()}.`,
      tiles: ids,
      choices: [
        { label: 'Encourage more building', detail: '+6% population there and the full shift.',
          apply: () => { changeTiles(ids, { pop: 0.06, lean: 2 * dir }); return 'you encouraged more building.'; } },
        { label: 'Slow the growth', cost: 1, detail: '+2% population there and half the shift.',
          apply: () => { changeTiles(ids, { pop: 0.02, lean: 1 * dir }); return 'you slowed the growth.'; } },
      ],
    };
  },
  jobs(c, center, ids) {
    return {
      title: `Your jobs-program promise near ${placeName(center)} comes due`,
      text: 'Voters near the closed plant want the jobs program you promised.',
      tiles: ids,
      choices: [
        { label: 'Deliver it', cost: 2, detail: '+2 points in those hexes for the decade.',
          apply: () => { changeTiles(ids, { lean: 2 }); return 'you delivered the jobs program.'; } },
        { label: 'Break the promise', detail: '−3 points in those hexes for the decade.',
          apply: () => { changeTiles(ids, { lean: -3 }); return 'you broke the jobs promise.'; } },
      ],
    };
  },
  primary(c, d) {
    if (d >= game.cfg.districts) return null;
    const ids = currentStats()[d].tiles;
    return {
      title: `A primary challenger takes on District ${d + 1}`,
      text: `After last year's scandal, a rival from your own party is challenging the District ${d + 1} incumbent.`,
      tiles: ids,
      choices: [
        { label: 'Back the incumbent', cost: 1, detail: 'The incumbent survives; no change.',
          apply: () => `you backed the District ${d + 1} incumbent.` },
        { label: 'Let the primary decide', chance: true, detail: 'A 50% chance the challenger wins and is a weaker nominee: −2 points there for the decade.',
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.5, 'The incumbent survived the primary.', `The challenger won: −2 points in District ${d + 1}.`);
            if (!r.ok) changeTiles(ids, { lean: -2 });
            return { text: r.ok ? 'the incumbent survived the primary.' : `the challenger won the District ${d + 1} primary.`, roll: r };
          } },
      ],
    };
  },
  ethics(c) {
    return {
      title: 'An ethics investigation into the donation',
      text: 'The leaked donation has prompted an ethics investigation into your party.',
      tiles: [],
      choices: [
        { label: 'Cooperate fully', cost: 1, detail: 'The story fades; no change.',
          apply: () => 'you cooperated with the investigation.' },
        { label: 'Stonewall', chance: true, detail: 'A 60% chance it fades; otherwise −2 points statewide at the next election.',
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.6, 'The investigation fizzled out.', 'The investigation dragged on: −2 points statewide at the next election.');
            if (!r.ok) c.nextSwing -= 0.02;
            return { text: r.ok ? 'you stonewalled and the story faded.' : 'you stonewalled and the story grew.', roll: r };
          } },
      ],
    };
  },
  initiative(c) {
    return {
      title: 'A reform initiative is on the ballot',
      text: 'The reformers gathered enough signatures. If the initiative passes, an independent commission will set strict rules for the map you draw after the census.',
      tiles: [],
      choices: [
        { label: 'Campaign against it', cost: 2, chance: true, detail: 'A 65% chance it is defeated.',
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.65, 'The initiative was defeated.', 'The initiative passed: a commission will set the rules for your next census map.');
            if (!r.ok) c.commission = true;
            return { text: r.ok ? 'you defeated the reform initiative.' : 'the reform initiative passed despite your campaign.', roll: r };
          } },
        { label: 'Let voters decide', chance: true, detail: 'A 30% chance it is defeated.',
          apply: (preview) => {
            if (preview) return '';
            const r = roll(c, 0.3, 'Voters rejected the initiative.', 'The initiative passed: a commission will set the rules for your next census map.');
            if (!r.ok) c.commission = true;
            return { text: r.ok ? 'voters rejected the reform initiative.' : 'the reform initiative passed.', roll: r };
          } },
      ],
    };
  },
};

function drawEvent(c) {
  // A lawsuit can replace the year's event.
  if (c.rand() < lawsuitRisk(c)) {
    c.lastCourtYear = c.year;
    const ev = courtEvent(c);
    ev.previews = ev.choices.map(() => null);
    return ev;
  }
  // A chained follow-up that is due comes before a random event.
  const due = c.followUps.findIndex((f) => f.year <= c.year);
  if (due >= 0) {
    const f = c.followUps.splice(due, 1)[0];
    const ev = f.make(c);
    if (ev) {
      ev.type = 'chain';
      ev.chain = f.source;
      ev.previews = ev.choices.map((ch) => (ch.chance ? null : previewChoice(c, ch)));
      return ev;
    }
  }
  const types = Object.keys(EVENT_TYPES).filter((k) => !c.recent.includes(k));
  for (let k = 0; k < 30; k++) {
    const type = pick(types, c.rand);
    const ev = EVENT_TYPES[type](c);
    if (ev) {
      ev.type = type;
      c.recent = [type, ...c.recent].slice(0, 3);
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
  if (choice.noPreview) return null; // e.g. court choices change more than the map
  const snapTiles = game.tiles.map((t) => [t.pop, t.lean, t.turnout]);
  const snapSwing = c.nextSwing;
  const snapBonus = c.nextBonus.slice();
  const snapReform = c.reformPressure;
  const snapFollow = c.followUps.slice();
  const snapCommission = c.commission;
  const before = expectedShares(c);
  choice.apply(true);
  const after = expectedShares(c);
  game.tiles.forEach((t, i) => { [t.pop, t.lean, t.turnout] = snapTiles[i]; });
  c.nextSwing = snapSwing;
  c.nextBonus = snapBonus;
  c.reformPressure = snapReform;
  c.followUps = snapFollow;
  c.commission = snapCommission;
  return after.map((a, d) => ({ d, delta: a - before[d] }))
    .filter((x) => Math.abs(x.delta) >= 0.0005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ---------- Choosing and advancing ----------
function chooseOption(i) {
  const c = game.campaign;
  if (!c || !c.event) return;
  const ev = c.event;
  const ch = ev.choices[i];
  if ((ch.cost || 0) > c.capital) return;

  // Snapshot, apply, then record exactly what changed for the outcome card.
  const before = {
    tiles: game.tiles.map((t) => [t.pop, t.lean, t.turnout]),
    shares: expectedShares(c),
    swing: c.nextSwing,
    bonus: c.nextBonus.slice(),
    reform: c.reformPressure,
  };
  const capitalDelta = (ch.gain || 0) - (ch.cost || 0);
  c.capital += capitalDelta;
  let result = ch.apply(false);
  if (typeof result === 'string') result = { text: result };
  c.log.unshift(`${c.year} · ${ev.title}: ${result.text}${result.roll ? ` (${pctText(result.roll.chance)} chance)` : ''}`);
  c.event = null;

  const after = expectedShares(c);
  const tiles = [];
  game.tiles.forEach((t, k) => {
    const [p0, l0, u0] = before.tiles[k];
    const dl = t.lean - l0;
    const dp = t.pop / p0 - 1;
    const du = t.turnout / u0 - 1;
    if (Math.abs(dl) >= 0.05 || Math.abs(dp) >= 0.005 || Math.abs(du) >= 0.005) tiles.push({ id: t.id, lean: dl, pop: dp, turnout: du });
  });
  const mods = [];
  if (Math.abs(c.nextSwing - before.swing) > 1e-6) mods.push(`statewide ${signedPts(c.nextSwing - before.swing)}`);
  c.nextBonus.forEach((b, d) => { if (Math.abs(b - before.bonus[d]) > 1e-6) mods.push(`District ${d + 1} ${signedPts(b - before.bonus[d])}`); });
  c.outcome = {
    title: ev.title,
    choice: ch.label,
    court: !!ev.court,
    roll: result.roll || null,
    capital: capitalDelta,
    reform: c.reformPressure - before.reform,
    districts: after.map((a, d) => ({ d, before: before.shares[d], after: a }))
      .filter((x) => Math.abs(x.after - x.before) >= 0.0005),
    tiles,
    tileMap: new Map(tiles.map((x) => [x.id, x])),
    mods,
    nextElection: isElectionYear(c.year) ? c.year : c.year + 1,
    soundDone: false,
  };
  render();
}

const signedPts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pts`;

// Leave the outcome card: start the redraw, or let the year pass.
function continueFromOutcome() {
  const c = game.campaign;
  c.outcome = null;
  if (c.redraw) {
    render();
    return;
  }
  finishYear();
}

// Label for a changed hex while the outcome card is showing.
function outcomeTileLabel(t) {
  const c = game.campaign;
  const x = c && c.outcome && c.outcome.tileMap.get(t.id);
  if (!x) return null;
  if (Math.abs(x.lean) >= 0.05) return `${x.lean > 0 ? '+' : '−'}${Math.abs(x.lean).toFixed(1)}`;
  if (Math.abs(x.turnout) >= 0.005) return `T ${x.turnout > 0 ? '+' : '−'}${Math.abs(Math.round(x.turnout * 100))}%`;
  return `P ${x.pop > 0 ? '+' : '−'}${Math.abs(Math.round(x.pop * 100))}%`;
}

// Change in a district's expected share from the last event (for the district list).
function outcomeDistrictDelta(d) {
  const c = game.campaign;
  const x = c && c.outcome && c.outcome.districts.find((y) => y.d === d);
  return x ? x.after - x.before : 0;
}

function finishYear() {
  const c = game.campaign;
  const beforeShares = currentStats().map((s) => s.share);
  const beforePop = totalPop();
  const beforeM = measure();
  driftYear(c);
  buildBoard();
  const afterM = measure();
  c.history.push({ year: c.year, ...afterM });
  c.lastDrift = {
    year: c.year,
    districts: currentStats().map((s, d) => ({ d, delta: s.share - beforeShares[d] }))
      .filter((x) => Math.abs(x.delta) >= 0.001)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    pop: totalPop() / beforePop - 1,
    winBefore: beforeM.win,
    winAfter: afterM.win,
  };
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
  if (c.year > decadeEnd(c)) {
    if (c.decade + 1 >= DECADES) {
      c.over = true;
      render();
      showDecadeSummary();
      return;
    }
    runCensus(c);
    return;
  }
  c.event = drawEvent(c);
  Sound.play(c.event && c.event.court ? 'buzz' : 'event');
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
  const reached = seats >= game.target;
  const earned = reached ? 2 : 1;
  c.capital += earned;
  const result = {
    year: c.year, seats, shares, reached, earned, target: game.target, districts: n, decade: c.decade,
    swing: unc.state[s] + c.nextSwing,
    turnout: unc.tState ? unc.tState[s] : 0,
  };
  c.elections.push(result);
  c.nextSwing = 0;
  c.nextBonus.fill(0);
  return result;
}

function showCampaignElection(r) {
  const c = game.campaign;
  const n = r.shares.length;
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
  const label = r.year >= CAMPAIGN_LAST_YEAR ? 'See the campaign results'
    : r.year >= decadeEnd(c) ? `Go to the ${r.year} census` : `Continue to ${r.year + 1}`;
  openDialog(`
    <h2>${r.year} election: ${r.reached ? 'target reached' : 'short of target'}</h2>
    <p>You won <strong>${r.seats} of ${n}</strong> seats (target ${r.target}). The state swung ${swing} points ${dir},
       and turnout was ${turnoutText}. You earned <strong>⚑${r.earned}</strong> political capital.</p>
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">Your vote</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  [{ label, primary: true, onClick: nextCampaignYear }]);
}

function campaignScore(c) {
  return {
    seats: c.elections.reduce((s, e) => s + e.seats, 0),
    reached: c.elections.filter((e) => e.reached).length,
  };
}

function showDecadeSummary() {
  const c = game.campaign;
  const sc = campaignScore(c);
  const decades = [];
  for (let k = 0; k < DECADES; k++) {
    const list = c.elections.filter((e) => e.decade === k);
    if (!list.length) continue;
    const y0 = CAMPAIGN_FIRST_YEAR + 10 * k;
    decades.push(`<h3 class="dialog-sub">${y0}–${y0 + 9}</h3><div class="histogram">${list.map((e) => `
      <div class="hist-row">
        <span class="hist-label">${e.year}</span>
        <span class="hist-track"><span class="hist-bar ${e.reached ? 'enough' : ''}" style="width:${(e.seats / e.districts) * 100}%"></span></span>
        <span class="hist-val">${e.seats} of ${e.districts}</span>
      </div>`).join('')}</div>`);
  }
  const verdict = sc.reached === c.elections.length ? 'Your maps held for the whole campaign.'
    : sc.reached === 0 ? 'Your maps never reached their target.'
      : `Your maps reached their target in ${sc.reached} of ${c.elections.length} elections.`;
  const cases = c.courtCases.length
    ? c.courtCases.map((x) => `${x.year}: ${x.outcome === 'won' ? 'won in court' : x.outcome === 'lost' ? 'lost in court and redrew' : 'settled and redrew'}`).join('; ')
    : 'none';
  const censuses = c.censuses.length
    ? c.censuses.map((x) => `${x.year}: ${x.from === x.to ? `kept ${x.to} seats` : `${x.from} → ${x.to} seats`} (grew ${(x.growth * 100).toFixed(1)}%)`).join('; ')
    : 'none';
  openDialog(`
    <h2>Campaign complete</h2>
    <p>${verdict} You won <strong>${sc.seats} seats</strong> across ${c.elections.length} elections over ${DECADES} decades,
       and finished with ⚑${c.capital} capital.</p>
    ${decades.join('')}
    <p class="small">Censuses: ${censuses}.<br>Court cases: ${cases}.</p>
    <p class="small muted">Suburbs trended ${trendWord(c.typeTrend.suburban)} per decade, rural areas ${trendWord(c.typeTrend.rural)}
       and cities ${trendWord(c.typeTrend.urban)}.</p>`,
  [{ label: 'Look at the map' }, { label: 'New campaign', primary: true, onClick: () => startGame(els.size.value, randomSeed()) }]);
}

function trendWord(x) {
  if (Math.abs(x) < 0.1) return 'held steady';
  return `${x > 0 ? `toward ${youSide()}` : `toward ${oppSide()}`} (${Math.abs(x * 10).toFixed(1)} points over 10 years)`;
}

// ---------- Panel ----------
// "Over 2023: D3 ▼0.6 · D5 ▲0.4 · population +0.6% · win chance 83% → 80%"
function driftLine(c) {
  const dr = c.lastDrift;
  if (!dr || dr.year !== c.year - 1) return '';
  const parts = dr.districts.slice(0, 4).map((x) =>
    `<span class="${x.delta > 0 ? 'ok' : 'bad'}">D${x.d + 1} ${x.delta > 0 ? '▲' : '▼'}${Math.abs(x.delta * 100).toFixed(1)}</span>`);
  if (!parts.length) parts.push('<span class="muted">little change in your districts</span>');
  const win = `win chance ${fmtChance(dr.winBefore)} → <strong class="${dr.winAfter >= dr.winBefore ? 'ok' : 'bad'}">${fmtChance(dr.winAfter)}</strong>`;
  return `<p class="drift-line" title="Yearly drift: population growth and gradual partisan trends">📈 Over ${dr.year}: ${parts.join(' · ')}
    · population ${dr.pop >= 0 ? '+' : '−'}${Math.abs(dr.pop * 100).toFixed(1)}% · ${win}</p>`;
}

// A small chart of win chance by year this decade, with the 70% line.
function sparkline(c) {
  const h = c.history;
  if (h.length < 2) return '';
  const w = 150;
  const ht = 30;
  const x = (i) => 4 + (i / 10) * (w - 8);
  const y = (v) => 3 + (1 - v) * (ht - 6);
  const pts = h.map((p, i) => `${x(i).toFixed(1)},${y(p.win).toFixed(1)}`).join(' ');
  const last = h.at(-1);
  return `<span class="camp-spark" title="Win chance by year this decade (dashed line: 70%)">
    <span class="spark-label">Win chance</span>
    <svg width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" aria-hidden="true">
      <line x1="4" x2="${w - 4}" y1="${y(PASS_PROBABILITY)}" y2="${y(PASS_PROBABILITY)}" class="spark-ref"/>
      <polyline points="${pts}" class="spark-line"/>
      <circle cx="${x(h.length - 1)}" cy="${y(last.win)}" r="2.5" class="spark-dot"/>
    </svg>
    <span class="spark-val ${last.win >= PASS_PROBABILITY ? 'ok' : 'bad'}">${fmtChance(last.win)}</span>
  </span>`;
}
function renderCampaign() {
  const show = !!game.campaignMode;
  els.campaign.hidden = !show;
  if (!show) return;
  const c = game.campaign;
  const n = game.cfg.districts;
  const years = [];
  const y0 = c ? decadeStart(c) : CAMPAIGN_FIRST_YEAR;
  for (let y = y0; y <= y0 + 9; y++) years.push(y);
  const timeline = years.map((y) => {
    const e = c && c.elections.find((x) => x.year === y);
    const court = c && c.courtCases.find((x) => x.year === y);
    const state = !c ? '' : c.over || y < c.year ? 'done' : y === c.year ? 'current' : '';
    return `<li class="tl-year ${state} ${isElectionYear(y) ? 'election' : ''}">
      <span class="tl-label">${y}</span>
      <span class="tl-mark" aria-hidden="true">${court ? '⚖' : isElectionYear(y) ? '🗳' : ''}</span>
      <span class="tl-result ${e ? (e.reached ? 'ok' : 'bad') : ''}">${e ? `${e.seats}/${n}` : ''}</span>
    </li>`;
  }).join('');

  let body;
  if (!c) {
    body = `<p class="camp-lead">Draw a legal map, then play <strong>${DECADES} decades, ${CAMPAIGN_FIRST_YEAR}–${CAMPAIGN_LAST_YEAR}</strong>.
      Each year brings an event; populations, leanings and turnout drift; every even year holds an election.
      After each decade's census the state may gain or lose a seat, and you redraw the map.
      You start with <strong>⚑${START_CAPITAL}</strong> political capital to spend on choices and earn more at each election.
      An extreme or unbalanced map can be challenged in court. Your score is the total seats you win.</p>
      <button type="button" class="primary" id="start-decade">Start the decade</button>`;
  } else if (c.over) {
    const sc = campaignScore(c);
    body = `<p class="camp-lead"><strong>Campaign complete.</strong> ${sc.seats} seats won; target reached in ${sc.reached} of ${c.elections.length} elections.</p>
      <button type="button" class="primary" id="new-campaign">New campaign</button>`;
  } else if (c.outcome) {
    const o = c.outcome;
    let rollHtml = '';
    if (o.roll) {
      const chance = Math.round(o.roll.chance * 100);
      const at = Math.min(99, Math.max(1, Math.round(o.roll.value * 100)));
      rollHtml = `
        <div class="roll ${o.roll.ok ? 'roll-ok' : 'roll-bad'}">
          <div class="roll-head">🎲 ${chance}% chance of success</div>
          <div class="roll-bar" aria-hidden="true">
            <span class="roll-zone" style="width:${chance}%"></span>
            <span class="roll-marker" style="--at:${at}%"></span>
          </div>
          <p class="roll-result">${o.roll.ok ? '✓' : '✗'} ${o.roll.label}</p>
        </div>`;
    }
    const rows = o.districts.map((x) => {
      const dlt = x.after - x.before;
      return `<li><span class="dot" style="background:${DISTRICT_COLORS[x.d]}"></span>District ${x.d + 1}:
        ${fmtPct(x.before)} → <strong>${fmtPct(x.after)}</strong>
        <span class="${dlt > 0 ? 'ok' : 'bad'}">${dlt > 0 ? '▲' : '▼'} ${Math.abs(dlt * 100).toFixed(1)}</span></li>`;
    }).join('');
    const lines = [];
    if (o.capital) lines.push(`<span class="${o.capital > 0 ? 'ok' : ''}">Capital ${o.capital > 0 ? '+' : '−'}⚑${Math.abs(o.capital)}</span> (now ⚑${c.capital})`);
    if (o.tiles.length) lines.push(`${o.tiles.length} hex${o.tiles.length === 1 ? '' : 'es'} changed: outlined on the map`);
    if (o.mods.length) lines.push(`At the ${o.nextElection} election: ${o.mods.join(', ')}`);
    if (o.reform > 0) lines.push(`Lawsuit risk +${pctText(o.reform)} for the rest of the decade`);
    if (!o.districts.length && !lines.length && !o.roll) lines.push('Nothing else changed.');
    body = `
      <div class="event-card outcome-card ${o.court ? 'court-card' : ''}">
        <p class="event-year">${c.year} · What happened</p>
        <h3>${o.title}</h3>
        <p>You chose: <strong>${o.choice}</strong>.</p>
        ${rollHtml}
        ${lines.length ? `<ul class="outcome-lines">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
        ${rows ? `<p class="small muted outcome-sub">Expected vote share at the ${o.nextElection} election:</p><ul class="outcome-districts">${rows}</ul>` : ''}
        <button type="button" class="primary" id="outcome-continue">${c.redraw ? 'Redraw the map'
          : isElectionYear(c.year) ? `Continue to the ${c.year} election` : `Continue to ${c.year + 1}`}</button>
      </div>`;
    if (o.roll && !o.soundDone) {
      o.soundDone = true;
      Sound.play('tick');
      setTimeout(() => Sound.play(o.roll.ok ? 'legal' : 'buzz'), 900);
    }
  } else if (c.redraw) {
    const checks = redrawChecks(c);
    body = `
      <div class="event-card redraw-card">
        <p class="event-year">${c.year} · ${REDRAW_RULES[c.redraw.kind].label}</p>
        <h3>${{ census: `Draw the map for ${c.year + 1}–${c.year + 10}`, commission: `Draw the map for ${c.year + 1}–${c.year + 10} under commission rules`, mid: 'Redraw the map mid-decade' }[c.redraw.kind] || 'Redraw the map'}</h3>
        <p>The map is unlocked. Populations must be equal at today's numbers (ideal ${fmtInt(game.ideal)} people per district${game.cfg.districts !== (c.elections.at(-1) || {}).districts && c.elections.length ? `, now ${game.cfg.districts} districts` : ''}).
           Repaint the districts to meet every rule, then submit.${c.redraw.kind === 'mid' ? " This year's event waits until you finish." : ''}</p>
        <ul class="checklist redraw-checks">${checks.map((x) => `
          <li class="${x.ok ? 'done' : ''}"><span class="check" aria-hidden="true">${x.ok ? '✓' : ''}</span>
            <span class="c-text">${x.text}</span><span class="c-count">${x.value}</span></li>`).join('')}</ul>
        <button type="button" class="primary" id="submit-redraw" ${checks.every((x) => x.ok) ? '' : 'aria-disabled="true"'}>Submit the new map</button>
      </div>`;
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
      if (ch.effectText) effect = `<span class="muted">${ch.effectText}</span>`;
      else if (ch.chance) effect = '<span class="muted">Outcome depends on chance.</span>';
      else if (pv && pv.length) {
        effect = pv.slice(0, 4).map((x) => `<span class="${x.delta > 0 ? 'ok' : 'bad'}">D${x.d + 1} ${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta * 100).toFixed(1)}</span>`).join(' · ');
      } else effect = '<span class="muted">No change to your districts\' vote shares.</span>';
      const cost = ch.cost ? `<span class="cost ${ch.cost > c.capital ? 'bad' : ''}">⚑${ch.cost}</span>` : ch.gain ? `<span class="cost ok">+⚑${ch.gain}</span>` : '';
      const tooPoor = (ch.cost || 0) > c.capital;
      return `<button type="button" class="choice" data-choice="${i}" ${tooPoor ? 'disabled title="Not enough political capital"' : ''}>
        <span class="choice-label">${ch.label} ${cost}</span>
        <span class="choice-detail">${ch.detail}</span>
        <span class="choice-effect">${effect}</span>
      </button>`;
    }).join('');
    body = `
      <div class="event-card ${ev.court ? 'court-card' : ''}">
        ${driftLine(c)}
        <p class="event-year">${c.year}${isElectionYear(c.year) ? ' · election at year end' : ''}${ev.chain ? ` · <span class="chain-tag">🔗 follow-up: ${ev.chain}</span>` : ''}</p>
        <h3>${ev.court ? '⚖ ' : ''}${ev.title}</h3>
        <p>${ev.text}</p>
        <div class="choices">${choices}</div>
        ${!ev.court && !c.midUsed ? `<p class="mid-redraw-row"><button type="button" class="secondary small-btn" id="mid-redraw" ${c.capital < MID_REDRAW_COST ? 'disabled' : ''}
          title="Redraw the whole map now, once per decade">Redraw mid-decade (⚑${MID_REDRAW_COST})</button>
          <span class="small muted">Once per decade; lawsuit risk +${pctText(MID_REDRAW_RISK)} for the rest of it.</span></p>` : ''}
        <p class="small muted">Effects show the change in each district's expected vote share at the ${nextElection} election.</p>
      </div>
      ${mods.length ? `<p class="small">Next election (${nextElection}): ${mods.join(', ')}.</p>` : ''}`;
  }
  const sc = c ? campaignScore(c) : null;
  const risk = c && !c.over && !c.redraw ? lawsuitRisk(c) : null;
  els.campaign.innerHTML = `
    <div class="camp-head">
      <h2>Campaign${c ? ` <span class="camp-decade">decade ${c.decade + 1} of ${DECADES} · ${decadeStart(c)}–${decadeEnd(c)}</span>` : ''}</h2>
      ${c ? `<span class="camp-stats">
        ${sparkline(c)}
        ${c.commission ? '<span class="camp-stat bad" title="A reform initiative passed: an independent commission sets the rules for your next census map">🏛 Commission next census</span>' : ''}
        <span class="camp-stat" title="Political capital: spend it on choices, earn it at elections">⚑ <strong>${c.capital}</strong> capital</span>
        ${risk != null ? `<span class="camp-stat ${risk >= 0.25 ? 'bad' : ''}" title="Chance of a lawsuit next year: rises with your efficiency gap and districts out of population balance">⚖ ${pctText(risk)} lawsuit risk</span>` : ''}
        <span class="camp-stat">${sc.seats} seats won · target ${sc.reached}/${c.elections.length}</span>
      </span>` : ''}
    </div>
    <ol class="timeline">${timeline}</ol>
    ${body}
    ${c && c.log.length ? `<details class="camp-log"><summary>What happened so far</summary><ul>${c.log.map((l) => `<li>${l}</li>`).join('')}</ul></details>` : ''}`;

  const start = els.campaign.querySelector('#start-decade');
  if (start) start.addEventListener('click', startDecade);
  const mid = els.campaign.querySelector('#mid-redraw');
  if (mid) mid.addEventListener('click', startMidRedraw);
  const again = els.campaign.querySelector('#new-campaign');
  if (again) again.addEventListener('click', () => startGame(els.size.value, randomSeed()));
  const cont = els.campaign.querySelector('#outcome-continue');
  if (cont) cont.addEventListener('click', continueFromOutcome);
  const submit = els.campaign.querySelector('#submit-redraw');
  if (submit) submit.addEventListener('click', submitRedraw);
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
  const changed = c && c.outcome ? c.outcome.tileMap : new Map();
  tileEls.forEach((el, i) => {
    el.g.classList.toggle('event-hex', ids.has(i));
    el.g.classList.toggle('event-hex-strong', strong && ids.has(i));
    const x = changed.get(i);
    el.g.classList.toggle('chg-up', !!x && x.lean >= 0.05);
    el.g.classList.toggle('chg-down', !!x && x.lean <= -0.05);
    el.g.classList.toggle('chg-other', !!x && Math.abs(x.lean) < 0.05);
  });
}

// Change since the decade began, in points toward you (for the Change view and tooltip).
function leanChange(t) {
  const c = game.campaign;
  return c ? t.lean - c.base[t.id].lean : 0;
}

// True while the map can be painted during a campaign (only during a redraw).
const campaignLocked = () => !!(game && game.campaign && !game.campaign.redraw);

if (typeof module !== 'undefined') {
  module.exports = { startDecade, driftYear, campaignElection, EVENT_TYPES, lawsuitRisk, roll };
}
