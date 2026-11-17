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

Lesson maps are hand-picked (found with an offline search that uses the game's solver). Progress is saved in the browser, and a lesson can be linked directly with `?tutorial=1`, `2` or `3`.

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
