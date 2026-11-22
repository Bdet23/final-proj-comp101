"""Build hex-cartogram layouts of US states from real county data.

Inputs (downloaded separately, paths given on the command line):
  counties.json  -- https://github.com/evangambit/JsonOfCounties (Census Bureau
                    population estimates, county coordinates and land area)
  pres2020.csv   -- https://github.com/tonmcg/US_County_Level_Election_Results_08-20
                    (2020 presidential results by county)

Each cell is [col, row, population, Democratic two-party %, county index,
turnout %], where turnout is 2020 votes cast divided by adult residents.

Output: a JSON file of hex layouts that tools/solve_states.js turns into states.js.

Method, per state:
  1. Each county gets k hexes: its population divided by a "hex unit" (an eighth of
     an ideal district), rounded, with at least one hex. Large counties are split
     into several equal hexes with the county's vote share.
  2. A hex lattice is laid over the state (projected to km) with one cell per
     hex of land area; the cells closest to county centres (relative to each
     county's size) form the state shape.
  3. County hexes are assigned to those cells to minimise distance from each
     county's real location, then swapped to keep each county's hexes together.

Usage: python3 tools/build_states.py counties.json pres2020.csv out.json
"""

import csv
import json
import math
import sys

STATES = {
    # code: (name, House seats after the 2020 census, delegation elected in 2022 (D, R))
    'WI': ('Wisconsin', 8, (2, 6)),
    'NC': ('North Carolina', 14, (7, 7)),
    'PA': ('Pennsylvania', 17, (9, 8)),
    'MI': ('Michigan', 13, (7, 6)),
    'OH': ('Ohio', 15, (5, 10)),
}
UNITS_PER_DISTRICT = 8
SQRT3 = math.sqrt(3)


def load(counties_path, votes_path):
    counties = json.load(open(counties_path))
    votes = {r['county_fips'].zfill(5): r for r in csv.DictReader(open(votes_path))}
    return counties, votes


def odd_r_neighbors(c, r):
    if r & 1:
        dirs = [(1, 0), (1, 1), (0, 1), (-1, 0), (0, -1), (1, -1)]
    else:
        dirs = [(1, 0), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1)]
    return [(c + dc, r + dr) for dc, dr in dirs]


def build_state(code, counties, votes):
    name, seats, actual = STATES[code]
    rows = []
    for c in counties:
        if c['state'] != code:
            continue
        v = votes[c['fips']]
        dem, gop = int(v['votes_dem']), int(v['votes_gop'])
        # Turnout: 2020 votes cast / adults (ages 15-19 counted as 2/5 adults).
        a = c['age']
        adults = c['population']['2019'] * (1 - a['0-4'] - a['5-9'] - a['10-14'] - 0.6 * a['15-19'])
        rows.append({
            'name': c['name'].title(),
            'pop': c['population']['2019'],
            'lat': c['latitude (deg)'],
            'lon': c['longitude (deg)'],
            'land': c['land_area (km^2)'],
            'dem': dem,
            'gop': gop,
            'turnout': min(0.95, int(v['total_votes']) / adults),
        })
    total = sum(r['pop'] for r in rows)
    unit = total / seats / UNITS_PER_DISTRICT
    for r in rows:
        r['k'] = max(1, round(r['pop'] / unit))
    H = sum(r['k'] for r in rows)

    # Project to km around the state's centre.
    lat0 = sum(r['lat'] for r in rows) / len(rows)
    lon0 = sum(r['lon'] for r in rows) / len(rows)
    kx = 111.32 * math.cos(math.radians(lat0))
    for r in rows:
        r['x'] = (r['lon'] - lon0) * kx
        r['y'] = (lat0 - r['lat']) * 110.57
    area = sum(r['land'] for r in rows)
    R = math.sqrt(area / (H * 1.5 * SQRT3))  # hex radius so H cells cover the land area

    # Lattice covering the state, then the H cells closest to any county centre.
    xs = [r['x'] for r in rows]
    ys = [r['y'] for r in rows]
    w, hstep = SQRT3 * R, 1.5 * R
    r0, r1 = math.floor(min(ys) / hstep) - 3, math.ceil(max(ys) / hstep) + 3
    c0, c1 = math.floor(min(xs) / w) - 3, math.ceil(max(xs) / w) + 3
    lattice = []
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            cx = w * (col + 0.5 * (row & 1))
            cy = hstep * row
            # distance to the nearest county centre, relative to that county's size
            # (radius of a circle with its land area), so large counties are covered
            d = min(((cx - r['x']) ** 2 + (cy - r['y']) ** 2) / (r['land'] / math.pi) for r in rows)
            lattice.append((d, col, row, cx, cy))
    lattice.sort()
    cells = [(col, row, cx, cy) for _, col, row, cx, cy in lattice[:H]]
    keep_connected(cells, lattice[H:])
    fill_holes(cells, w, hstep)

    # Points: one per hex, at its county's location.
    points = []
    for i, r in enumerate(rows):
        points += [i] * r['k']
    n = len(cells)
    dist = [[((cells[j][2] - rows[points[p]]['x']) ** 2 + (cells[j][3] - rows[points[p]]['y']) ** 2) / (R * R)
             for j in range(n)] for p in range(n)]

    # Greedy assignment by distance, then pairwise swaps that reduce total distance.
    pairs = sorted((dist[p][j], p, j) for p in range(n) for j in range(n))
    cell_of, point_at = [None] * n, [None] * n
    for _, p, j in pairs:
        if cell_of[p] is None and point_at[j] is None:
            cell_of[p], point_at[j] = j, p
    county_at = [points[point_at[j]] for j in range(n)]
    index = {(cells[j][0], cells[j][1]): j for j in range(n)}
    nbrs = [[index[q] for q in odd_r_neighbors(cells[j][0], cells[j][1]) if q in index] for j in range(n)]

    def cost(j, county):
        # distance of this county's location from cell j, minus a bonus for same-county neighbours
        p_d = ((cells[j][2] - rows[county]['x']) ** 2 + (cells[j][3] - rows[county]['y']) ** 2) / (R * R)
        same = sum(1 for q in nbrs[j] if county_at[q] == county)
        return p_d - 1.5 * same

    for _ in range(40):
        improved = False
        for a in range(n):
            for b in range(a + 1, n):
                ca, cb = county_at[a], county_at[b]
                if ca == cb:
                    continue
                before = cost(a, ca) + cost(b, cb)
                county_at[a], county_at[b] = cb, ca
                after = cost(a, cb) + cost(b, ca)
                if after < before - 1e-9:
                    improved = True
                else:
                    county_at[a], county_at[b] = ca, cb
        if not improved:
            break

    # Normalise grid coordinates (keep row parity so the odd-r offsets stay valid).
    min_c = min(c[0] for c in cells)
    min_r = min(c[1] for c in cells)
    min_r -= min_r & 1
    out_cells = []
    seen = {}
    for j, (col, row, _, _) in enumerate(cells):
        ci = county_at[j]
        r = rows[ci]
        seen[ci] = seen.get(ci, 0) + 1
        out_cells.append([
            col - min_c,
            row - min_r,
            round(r['pop'] / r['k']),
            round(100 * r['dem'] / (r['dem'] + r['gop']), 1),
            ci,
            round(100 * r['turnout'], 1),
        ])
    dem = sum(r['dem'] for r in rows)
    gop = sum(r['gop'] for r in rows)
    return {
        'code': code,
        'name': name,
        'seats': seats,
        'actual2022': {'dem': actual[0], 'rep': actual[1]},
        'demShare': round(100 * dem / (dem + gop), 2),
        'cols': max(c[0] for c in out_cells) + 1,
        'rows': max(c[1] for c in out_cells) + 1,
        'counties': [{'name': r['name'], 'hexes': r['k'], 'pop': r['pop'],
                      'dem': round(100 * r['dem'] / (r['dem'] + r['gop']), 1)} for r in rows],
        'cells': out_cells,
    }


def is_connected(keys):
    keys = set(keys)
    start = next(iter(keys))
    seen, stack = {start}, [start]
    while stack:
        x = stack.pop()
        for q in odd_r_neighbors(*x):
            if q in keys and q not in seen:
                seen.add(q)
                stack.append(q)
    return len(seen) == len(keys)


def fill_holes(cells, w, hstep):
    """Move exposed edge cells into interior gaps (empty cells with 4+ filled neighbours)."""
    for _ in range(300):
        keys = {(c[0], c[1]) for c in cells}
        cols = [k[0] for k in keys]
        rows = [k[1] for k in keys]
        holes = []
        for row in range(min(rows), max(rows) + 1):
            for col in range(min(cols), max(cols) + 1):
                if (col, row) in keys:
                    continue
                filled = sum(q in keys for q in odd_r_neighbors(col, row))
                if filled >= 4:
                    holes.append((filled, col, row))
        if not holes:
            return
        holes.sort(reverse=True)
        _, hc, hr = holes[0]
        # donor: a filled cell with the fewest filled neighbours (an exposed edge cell)
        order = sorted(range(len(cells)), key=lambda i: sum(q in keys for q in odd_r_neighbors(cells[i][0], cells[i][1])))
        for i in order:
            donor = (cells[i][0], cells[i][1])
            if sum(q in keys for q in odd_r_neighbors(*donor)) >= 4:
                return  # nothing exposed left to move
            trial = (keys - {donor}) | {(hc, hr)}
            if is_connected(trial):
                cells[i] = (hc, hr, w * (hc + 0.5 * (hr & 1)), hstep * hr)
                break
        else:
            return


def keep_connected(cells, spare):
    """Swap stray cells for spare lattice cells until the footprint is one piece."""
    for _ in range(200):
        index = {(c[0], c[1]): i for i, c in enumerate(cells)}
        seen = set()
        comps = []
        for i in range(len(cells)):
            if i in seen:
                continue
            comp, stack = [], [i]
            seen.add(i)
            while stack:
                x = stack.pop()
                comp.append(x)
                for q in odd_r_neighbors(cells[x][0], cells[x][1]):
                    j = index.get(q)
                    if j is not None and j not in seen:
                        seen.add(j)
                        stack.append(j)
            comps.append(comp)
        if len(comps) == 1:
            return
        comps.sort(key=len)
        small = comps[0]
        big = set(map(tuple, ((cells[i][0], cells[i][1]) for c in comps[1:] for i in c)))
        # replace one cell of the smallest piece with the spare cell nearest it that touches the rest
        victim = small[0]
        vx, vy = cells[victim][2], cells[victim][3]
        best = None
        for k, (_, col, row, cx, cy) in enumerate(spare):
            if (col, row) in index:
                continue
            touches_big = any(q in big for q in odd_r_neighbors(col, row))
            touches_small = any(index.get(q) in small for q in odd_r_neighbors(col, row))
            if touches_big and touches_small:
                d = (cx - vx) ** 2 + (cy - vy) ** 2
                if best is None or d < best[0]:
                    best = (d, k)
        if best is None:
            raise RuntimeError('could not connect footprint')
        # Bridge: add the spare cell and drop the cell farthest from everything else.
        _, k = best
        _, col, row, cx, cy = spare.pop(k)
        cells.append((col, row, cx, cy))
        far = max(range(len(cells) - 1), key=lambda i: min(
            (cells[i][2] - cells[j][2]) ** 2 + (cells[i][3] - cells[j][3]) ** 2
            for j in range(len(cells)) if j != i))
        cells.pop(far)
    raise RuntimeError('footprint did not become connected')


def main():
    counties, votes = load(sys.argv[1], sys.argv[2])
    out = [build_state(code, counties, votes) for code in STATES]
    json.dump(out, open(sys.argv[3], 'w'))
    for s in out:
        pops = [c[2] for c in s['cells']]
        print(f"{s['code']}: {len(s['cells'])} hexes on {s['cols']}x{s['rows']}, "
              f"hex pop {min(pops):,}-{max(pops):,}, D two-party {s['demShare']}%")


if __name__ == '__main__':
    main()
