#!/usr/bin/env python3
"""Parkeertarieven op straat uit het Nationaal Parkeer Register (RDW open data) klaarzetten.

Draait elke nacht als GitHub Action (.github/workflows/parking.yml). De losse datasets van
de RDW (gebieden, regelingen, tijdvakken, tarieven) zijn samen ruim 20 MB en moeten aan
elkaar geknoopt worden; de app krijgt per vak van 0,05 graad alleen wat daar ligt:

  p/<rij>_<kolom>.json  {"a": betaalde gebieden, "v": vergunninggebieden, "s": speciale dagen}
  meta.json             wanneer dit is gemaakt

Het buitenland komt erbij uit tools/parking_abroad.py, in dezelfde vorm.

Een betaald gebied: {"m": beheerder, "id", "n": naam, "g": gemeente, "r": ringen,
  "w": {dag: [[van, tot, tarief], ...]}, "f": [tarieven], "x": max per dag (centen)}
  dag = MAANDAG … ZONDAG of de naam van een speciale dag (FEESTDAG); van/tot in minuten.
  tarief = {"h": centen per uur, "s": [[na minuten, centen per uur], ...], "b": blok in minuten}
Een vergunninggebied: {"m", "id", "k": sleutel van de vergunning, "n": naam, "g", "r"}

Gebruik: python3 tools/parking.py <uitvoermap>
"""
import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, timedelta

import parking_abroad

BASE = 'https://opendata.rdw.nl/api/views/{}/rows.csv?accessType=DOWNLOAD'
SETS = {'geo': 'nsk3-v9n7', 'area': 'adw6-9hsg', 'name': 'mz4f-59fw', 'areg': 'qtex-qwd8', 'reg': 'yefi-qfiq',
        'tv': 'ixf8-gtwq', 'fare': '534e-5vdg', 'special': 'hpi4-mynq', 'mgr': '2uc2-nnv3'}
GRID = 0.05
TODAY = date.today()
NOW = TODAY.strftime('%Y%m%d')
# Namen van gebieden die over andere heen liggen
UMBRELLA = re.compile(r'overkoepelend|^(heel|geheel|de gehele|gehele|alle zones)\b|niet[- ]fiscaal|totaalgebied|fictief', re.I)
DAYS = ['MAANDAG', 'DINSDAG', 'WOENSDAG', 'DONDERDAG', 'VRIJDAG', 'ZATERDAG', 'ZONDAG']


def fetch(key, folder=None):
    if folder:
        with open(os.path.join(folder, SETS[key] + '.csv'), encoding='utf-8') as f:
            return list(csv.DictReader(f))
    req = urllib.request.Request(BASE.format(SETS[key]), headers={'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                return list(csv.DictReader(io.StringIO(res.read().decode('utf-8'))))
        except OSError:
            if attempt == 2:
                raise
            time.sleep(20)


def ymd(s):
    s = (s or '').strip()
    if not s:
        return '29991231'
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})', s)
    return m.group(3) + m.group(2) + m.group(1) if m else s[:8]


def current(start, end):
    return ymd(start) <= NOW < ymd(end)


def num(s, default=0.0):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


# ---------- Vormen ----------
def rings(wkt):
    out = []
    for ring in re.findall(r'\(([^()]+)\)', wkt or ''):
        pts = []
        for p in ring.split(','):
            xy = p.split()
            if len(xy) >= 2:
                pts.append((float(xy[0]), float(xy[1])))
        if len(pts) >= 4:
            out.append(simplify(pts, 0.00002))
    return out


def simplify(pts, tol):
    # Douglas-Peucker, dan op 5 decimalen (ongeveer een meter)
    if len(pts) < 5:
        return [[round(x, 5), round(y, 5)] for x, y in pts]
    keep = [False] * len(pts)
    # Een gesloten ring (begin = eind) in twee helften, anders valt alles weg
    mid = len(pts) // 2
    keep[0] = keep[mid] = keep[-1] = True
    stack = [(0, mid), (mid, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-12
        best, idx = 0, -1
        for i in range(a + 1, b):
            d = abs(dy * (pts[i][0] - x1) - dx * (pts[i][1] - y1)) / L
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [[round(x, 5), round(y, 5)] for (x, y), k in zip(pts, keep) if k]


def bbox(rs):
    xs = [p[0] for r in rs for p in r]
    ys = [p[1] for r in rs for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def clean_name(s):
    s = re.sub(r'\s*\([^)]*\)\s*$', '', (s or '').strip())
    # Amsterdam zet de code ervoor: "SO36 Oost-2" wordt "Oost-2"
    s = re.sub(r'^[A-Z]{2,3}\d{2,3}[A-Z]?(?:_U\d+)?\s+(?=\S)', '', s)
    return re.sub(r'\s+', ' ', s)


# ---------- Tarieven ----------
def fare_of(parts):
    """Centen per uur bij de start, en hoe het daarna verandert (staffel)."""
    parts = sorted(parts, key=lambda p: num(p['StartDurationFarePart']))
    if not parts:
        return None
    steps = []
    for p in parts:
        step = max(1.0, num(p['StepSizeFarePart'], 1))
        steps.append([int(num(p['StartDurationFarePart'])), round(num(p['AmountFarePart']) * 60 / step * 100), int(step)])
    f = {'h': steps[0][1]}
    if steps[0][2] > 60:
        f['b'] = steps[0][2]
    later = [[s, h] for s, h, _ in steps[1:] if h != steps[0][1]]
    if later:
        f['s'] = later
    return f


def place(tiles, items, rs, m, special):
    x1, y1, x2, y2 = bbox(rs)
    for row in range(math.floor(y1 / GRID), math.floor(y2 / GRID) + 1):
        for col in range(math.floor(x1 / GRID), math.floor(x2 / GRID) + 1):
            t = tiles[(row, col)]
            for kind, item in items:
                t[kind].append(item)
            if m in special:
                t['s'][m] = special[m]


def main(out, folder=None):
    D = {k: fetch(k, folder) for k in SETS}
    city = {}
    for r in D['mgr']:
        if current(r['StartDateAreaManagerId'], r['EndDateAreaManagerId']) or r['AreaManagerId'] not in city:
            city[r['AreaManagerId']] = r['AreaManagerDesc'].strip()
    desc = {(r['AreaManagerId'], r['AreaId']): r['AreaDesc'] for r in D['area']}
    name = {(r['AreaManagerId'], r['AreaId']): r['AreaName'] for r in D['name']}
    regs = {(r['AreaManagerId'], r['RegulationId']): r for r in D['reg'] if current(r['StartDateRegulation'], r['EndDateRegulation'])}
    frames = defaultdict(list)
    for t in D['tv']:
        if current(t['StartDateTimeFrame'], t['EndDateTimeFrame']) and t['ClaimRightPossible'] != 'N':
            frames[(t['AreaManagerId'], t['RegulationId'])].append(t)
    parts = defaultdict(list)
    for p in D['fare']:
        if current(str(p['StartDateFarePart']), str(p['EndDateFarePart'])):
            parts[(p['AreaManagerId'], p['FareCalculationCode'])].append(p)

    # Per gebied de regelingen die nu gelden
    paid_reg, permit_reg = {}, {}
    for r in D['areg']:
        if not current(r['StartDateAreaRegulation'], r['EndDateAreaRegulation']):
            continue
        key = (r['AreaManagerId'], r['AreaId'])
        reg = regs.get((r['AreaManagerId'], r['RegulationId']))
        if not reg:
            continue
        if r['UsageId'] == 'BETAALDP' and reg['RegulationType'] != 'A':
            # Meer basisregelingen: die met de meeste betaalde tijdvakken
            n = sum(1 for t in frames[(r['AreaManagerId'], r['RegulationId'])] if t['FareCalculationCode'])
            if n and (key not in paid_reg or n > paid_reg[key][1]):
                paid_reg[key] = (r['RegulationId'], n)
        elif r['UsageId'] == 'VERGUNP':
            permit_reg[key] = r['RegulationId']
    # Een vergunning geldt meestal per gebied. Alleen als de regeling zelf een gebied noemt
    # (Utrecht: "Vergunningen gebied 1") geldt ze voor alle gebieden met die regeling. Een regeling
    # als "Vergunning" of "Vergunninghouders ma-zo 00-24" zegt alleen iets over de tijden.
    def by_reg(m, reg_id):
        return bool(re.search(r'\bgebied\s*\d', regs[(m, reg_id)]['RegulationDesc'], re.I))

    special = defaultdict(dict)
    horizon = (TODAY + timedelta(days=21)).strftime('%Y%m%d')
    for s in D['special']:
        d = s['DateSpecialDay'][:8]
        if NOW <= d <= horizon:
            special[s['AreaManagerId']][d] = s['NameSpecialDay'].strip()

    # Overkoepelende gebieden ("Heel Amsterdam", "Overkoepelend voor Noord 3") liggen over de
    # gewone heen; daarin zou een vergunning overal lijken te gelden. Weg ermee. Andere overlap
    # (een straat die bij twee buurten hoort) lost de app op door het kleinste gebied te kiezen.
    umbrella = {key for key in permit_reg if UMBRELLA.search(name.get(key) or desc.get(key) or '')}

    tiles = defaultdict(lambda: {'a': [], 'v': [], 's': {}})
    n_paid = n_permit = 0
    for g in D['geo']:
        if not current(g['StartDateArea'], g['EndDateArea']):
            continue
        key = (g['AreaManagerId'], g['AreaId'])
        if key not in paid_reg and (key not in permit_reg or key in umbrella):
            continue
        rs = rings(g['GeoDataAsText'])
        if not rs:
            continue
        m, aid = key
        nm = clean_name(name.get(key) or desc.get(key) or aid)
        items = []
        if key in paid_reg:
            reg_id = paid_reg[key][0]
            fares, idx, week = [], {}, defaultdict(list)
            for t in frames[(m, reg_id)]:
                code = t['FareCalculationCode']
                if not code:
                    continue
                if code not in idx:
                    f = fare_of(parts[(m, code)])
                    if f is None:
                        continue
                    idx[code] = len(fares)
                    fares.append(f)
                s, e = int(num(t['StartTimeTimeFrame'])), int(num(t['EndTimeTimeFrame']))
                week[t['DayTimeFrame'].strip()].append([s // 100 * 60 + s % 100, e // 100 * 60 + e % 100, idx[code]])
            if fares and any(d in week for d in DAYS):
                for v in week.values():
                    v.sort()
                item = {'m': int(m), 'id': aid, 'n': nm, 'g': city.get(m, ''), 'r': rs, 'w': week, 'f': fares}
                x = num(regs[(m, reg_id)]['MaximumDayCharge'])
                if x:
                    item['x'] = round(x * 100)
                items.append(('a', item))
                n_paid += 1
        if key in permit_reg and key not in umbrella:
            reg_id = permit_reg[key]
            shared = by_reg(m, reg_id)
            pname = clean_name(regs[(m, reg_id)]['RegulationDesc']) if shared else nm
            items.append(('v', {'m': int(m), 'id': aid, 'k': f'{m}:R:{reg_id}' if shared else f'{m}:A:{aid}',
                                'n': pname, 'g': city.get(m, ''), 'r': rs}))
            n_permit += 1
        place(tiles, items, rs, m, special)

    # Buitenland: per stad wat de open data geeft (tools/parking_abroad.py)
    abroad, abroad_special = parking_abroad.collect(TODAY, simplify)
    special.update(abroad_special)
    for kind, item in abroad:
        place(tiles, [(kind, item)], item['r'], item['m'], special)
    for (row, col), t in tiles.items():
        path = f'{out}/p/{row}_{col}.json'
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(t, f, ensure_ascii=False, separators=(',', ':'))
    with open(f'{out}/meta.json', 'w') as f:
        json.dump({'t': int(time.time()), 'paid': n_paid, 'permit': n_permit, 'tiles': len(tiles)}, f)
    print(f'{n_paid} betaalde gebieden, {n_permit} vergunninggebieden, {len(tiles)} vakken')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'parking-out', sys.argv[2] if len(sys.argv) > 2 else None)
