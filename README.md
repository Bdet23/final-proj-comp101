# Gerrymander

A browser game about gerrymandering. Group hex tiles into districts so your candidate wins a majority of seats, even though they have fewer votes statewide.

## How to play

- Each hex tile shows its **population** and the **expected vote share** for your candidate.
- Divide every tile into the required number of districts.
- Every district must be **connected** and have a population within **±5%** of the ideal (total population ÷ number of districts).
- Your candidate wins a district when its population-weighted vote share is **above 50%**.
- Win at least the target number of districts (a majority) to win the map.

Controls: choose a district, then click or drag across tiles to paint them. Clicking a tile that is already in the chosen district removes it. Keyboard: `1`–`8` choose a district, `E` selects the eraser, `V` switches between the voter view and the district view.

## Tutorial

New players start with three short lessons (the **Tutorial** button reopens them, and **Skip tutorial** goes straight to the game):

1. **Every voter counts.** Each tile is one voter who votes yes or no. Districts must have exactly 5 voters. This lesson teaches cracking and packing.
2. **People, not land.** Votes are still yes or no, but tiles hold different numbers of people, and districts must be within ±10% of the ideal population.
3. **Shades of support.** The full model: each tile has a population and a percentage of people who vote for your candidate, with a ±5% limit.
4. **Wave elections.** The same map with uncertain results (Realistic mode): you need a 70% chance of winning, so narrow seats are risky.

Lesson maps are hand-picked (found with an offline search that uses the game's solver). Progress is saved in the browser, and a lesson can be linked directly with `?tutorial=1` to `4`.

## Realistic mode

Switch **Mode** to **Realistic** for uncertain elections. Each of 1,000 simulated elections shifts every tile's expected vote share by a statewide swing (±3 points), regional swings (±2 points) and local noise (±1.5 points). Because most of the swing is shared, narrow seats tend to fall together.

- Badges, the district list and the Results view show each district's **chance to win**.
- A map passes when it wins the target number of seats in at least **70%** of simulations. The results show a histogram of seats won and one simulated election night.
- Realistic maps are generated and checked against this rule: the solver maximises the vote share of the weakest district you need, and few random legal plans reach 70%.

## Real states

Choose a state under **Real states (2020 data)** in the Map menu, then **Play as** Democrats or Republicans. Five states are included, each with its real number of House seats: Wisconsin (8), North Carolina (14), Pennsylvania (17), Michigan (13) and Ohio (15).

- Each hex is a county, or an equal share of a large county, with the county's real population and its 2020 two-party presidential vote share. Hexes are placed near each county's real location, so cities and regions sit where they belong.
- The seat target for each side is the smallest number of seats (at least a majority) that no more than 10% of random legal plans reach. Realistic mode has its own target, one the game's solver can win with at least a 75% chance.
- The mission and results show the real delegation elected in 2022 for comparison.

Data sources:

- 2020 presidential results by county: [tonmcg/US_County_Level_Election_Results_08-20](https://github.com/tonmcg/US_County_Level_Election_Results_08-20)
- 2019 Census Bureau county population estimates, coordinates and land area: [evangambit/JsonOfCounties](https://github.com/evangambit/JsonOfCounties)

To rebuild `states.js` after downloading those two files (`counties.json` and `2020_US_County_Level_Presidential_Results.csv`):

```bash
python3 tools/build_states.py counties.json 2020_US_County_Level_Presidential_Results.csv layouts.json
node tools/solve_states.js layouts.json states.js
```

## How maps are made

1. **Voter geography first.** Dense cities, suburbs, countryside, a corridor (river or highway) and scattered pockets set each tile's population and vote share. No district plan is involved, so the map does not reveal an answer.
2. **Difficulty check.** About 150 random legal plans are drawn. A map is kept only if at most 5% of them reach the target, so the obvious compact districts usually lose.
3. **Solver.** Simulated annealing searches for a winning plan, which proves the map can be won. If you lose, you can reveal that plan.

A map can be shared with its URL (`?size=medium&seed=42`).

## Running

The game is plain HTML, CSS and JavaScript with no build step. Open `index.html` in a browser, or publish it with GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**.

## Files

- `index.html` – page layout
- `style.css` – styles (supports light and dark mode)
- `game.js` – map generation, district rules and game interface
