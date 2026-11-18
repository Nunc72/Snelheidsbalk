"""Parkeren op straat in het buitenland: per stad een omzetter naar dezelfde vorm als de RDW-data.

We tonen alleen wat de open data van de stad geeft; er wordt niets bij gezocht. Per stad levert
een omzetter (soort, gebied) op, met soort 'a' (betaald) of 'v' (vergunning), plus speciale dagen.
Extra velden naast die van tools/parking.py:
  "c": munt (EUR, CHF, GBP), "src": bron voor in het blad, "t" (vergunning): wat de vergunning hier betekent.
  In een tarief: "mx": maximale parkeerduur in minuten, "l": prijs van het eerste uur als die anders is
  dan "h" (Brussel: het eerste halfuur is goedkoper).
Een stad die niet bereikbaar is valt die nacht weg; de rest gaat door.
"""
import gzip
import json
import re
import urllib.request
from datetime import date, timedelta

UA = {'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'}
WEEK = ['MAANDAG', 'DINSDAG', 'WOENSDAG', 'DONDERDAG', 'VRIJDAG', 'ZATERDAG', 'ZONDAG']


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as res:
        raw = res.read()
    # Sommige portalen sturen gzip, ook ongevraagd
    return json.loads((gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw).decode('utf-8'))


def geo_rings(geom, simplify, holes=True, tol=0.00002):
    """De ringen van een (Multi)Polygon; de app telt ze oneven/even. Zonder gaten (holes=False) telt
    ook een huizenblok midden in de zone mee, want daar ligt het adres van je bestemming vaak."""
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    return [simplify([tuple(p[:2]) for p in ring], tol) for poly in polys for ring in (poly if holes else poly[:1]) if len(ring) >= 4]


def easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(y, month, (h + l - 7 * m + 114) % 31 + 1)


def french_holidays(today, days):
    out = {}
    for y in {today.year, (today + timedelta(days=days)).year}:
        e = easter(y)
        for d in [date(y, 1, 1), e + timedelta(1), date(y, 5, 1), date(y, 5, 8), e + timedelta(39), e + timedelta(50),
                  date(y, 7, 14), date(y, 8, 15), date(y, 11, 1), date(y, 11, 11), date(y, 12, 25)]:
            if today <= d <= today + timedelta(days=days):
                out[d.strftime('%Y%m%d')] = 'FERIE'
    return out


def cumulative_fare(points, extra=None, mx=None):
    """Een tarief uit totaalbedragen ("1 uur € 3,50, 2 uur € 8"): per stuk de prijs per uur."""
    rates, t0, c0 = [], 0, 0
    for t, c in points:
        rates.append([t0, round((c - c0) * 60 / (t - t0))])
        t0, c0 = t, c
    if extra is not None:
        rates.append([t0, extra])
    f = {'h': rates[0][1]}
    steps = [r for i, r in enumerate(rates) if i and r[1] != rates[i - 1][1]]
    if steps:
        f['s'] = steps
    first = dict(points).get(60)
    if first is not None and first != f['h']:
        f['l'] = first
    if mx:
        f['mx'] = mx
    return f


# ---------- Parijs ----------
# Ville de Paris, open data (ODbL). Tarief per uur voor het 1e … 6e uur; meer dan 6 uur mag niet.
# Betaald ma–za 9–20, gratis op zondag en feestdagen (de regel van de stad; niet in de dataset).
PARIS = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/{}/exports/geojson'


def paris(today, simplify):
    m = 'FR-PARIS'
    items = []
    for feat in get_json(PARIS.format('stationnement-sur-voie-publique-zones-tarifaires'))['features']:
        p = feat['properties']
        hours = [round(float(p[f'vis_vl_h{i}_lv']) * 100) for i in range(1, 7)]
        steps, prev = [], hours[0]
        for i, h in enumerate(hours[1:], 1):
            if h != prev:
                steps.append([i * 60, h])
                prev = h
        f = {'h': hours[0], 'mx': 360}
        if steps:
            f['s'] = steps
        week = {d: [[540, 1200, 0]] for d in WEEK[:6]}
        week['FERIE'] = []
        items.append(('a', {'m': m, 'id': 'Z' + str(p['zone']), 'n': 'Zone ' + str(p['zone']), 'g': 'Paris',
                            'r': geo_rings(feat['geometry'], simplify), 'w': week, 'f': [f], 'c': 'EUR',
                            'src': 'Ville de Paris (open data)'}))
    for feat in get_json(PARIS.format('stationnement-sur-voie-publique-secteurs-residentiels'))['features']:
        nom = str(feat['properties']['nom'])
        items.append(('v', {'m': m, 'id': nom, 'k': f'{m}:A:{nom}', 'n': 'Secteur ' + nom, 'g': 'Paris',
                            'r': geo_rings(feat['geometry'], simplify),
                            't': 'Met je carte résident betaal je hier het bewonerstarief.'}))
    return items, {m: french_holidays(today, 21)}


# ---------- Brussel ----------
# parking.brussels (CC BY 4.0): per gereglementeerd gebied de zone (Rode zone, Groene zone …), de dagen
# en uren, de totaalprijs na 30 min, 1, 2, 3 en 4 uur, een prijs per extra uur en de maximale duur.
# Een gebied kan meer regels hebben (overdag rood, 's avonds groen). Evenementenzones slaan we over.
# De vlakken zijn de straten zelf, met de huizenblokken als gaten; die gaten laten we weg.
BXL = ('https://ows.parking.brussels/ws/ParkingBrussels/ows?service=WFS&version=1.0.0&request=GetFeature'
       '&outputFormat=application/json&srsName=EPSG:4326&typeName=ParkingBrussels:{}')
BXL_DAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']


def num_or(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def hhmm_min(v):
    h, m = v.split(':')
    return 1440 if v == '23:59' else int(h) * 60 + int(m)


def brussels(today, simplify):
    m = 'BE-BRUSSEL'
    towns = {str(f['properties']['niscode']): f['properties']['namedut'] for f in get_json(BXL.format('municipality'))['features']}
    by = {}
    for feat in get_json(BXL.format('regulation_surfaces'))['features']:
        p = feat['properties']
        if p['type_validity'] not in ('dominant', 'secondary') or not str(p['type_namedut']).startswith('Betalend'):
            continue
        by.setdefault(p['code'], []).append((p, feat['geometry']))
    items = []
    for code, rows in by.items():
        week, fares = {}, []
        for p, _ in rows:
            pts = [(t, round(c * 100)) for t, c in ((30, num_or(p['charge30'])), (60, num_or(p['charge60'])), (120, num_or(p['charge120'])),
                                                    (180, num_or(p['charge180'])), (240, num_or(p['charge240']))) if c is not None]
            if not pts or p['starthour'] == '-':
                continue
            extra = num_or(p['chargeextra'])
            fares.append(cumulative_fare(pts, round(extra * 100) if extra is not None else None, int(num_or(p['maxtime']) or 0) or None))
            d0, d1 = BXL_DAYS.index(p['startday_namedut']), BXL_DAYS.index(p['endday_namedut'])
            for d in range(d0, d1 + 1):
                week.setdefault(WEEK[d], []).append([hhmm_min(p['starthour']), hhmm_min(p['endhour']), len(fares) - 1])
        if not fares:
            continue
        for v in week.values():
            v.sort()
        main = next((p for p, _ in rows if p['type_validity'] == 'dominant'), rows[0][0])
        items.append(('a', {'m': m, 'id': code, 'n': main['typreg_namedut'], 'g': towns.get(str(main['niscode']), 'Brussel'),
                            'r': geo_rings(rows[0][1], simplify, holes=False, tol=0.00005), 'w': week, 'f': fares, 'c': 'EUR', 'src': 'parking.brussels (open data)'}))
    return items, {}


# ---------- Straatsburg ----------
# Eurométropole de Strasbourg (Licence Ouverte): 19 zones met kleur en een trap van totaalbedragen
# ("1h = 3.5€ / 2h = 8€ / … / 3h = 17€"); de laatste stap is de maximale duur. Betaald ma–za 9–19,
# gratis op zondag en feestdagen (zo staat het in de beschrijving van de dataset).
STRAS = 'https://data.strasbourg.eu/api/explore/v2.1/catalog/datasets/stationnement-payant/exports/geojson'


def strasbourg(today, simplify):
    m = 'FR-STRASBOURG'
    items = []
    for feat in get_json(STRAS)['features']:
        p = feat['properties']
        pts = [(int(h) * 60 + int(mi or 0), round(float(c) * 100)) for h, mi, c in re.findall(r'(\d+)h(\d+)?\s*=\s*([\d.]+)\s*€', p['tarif'])]
        if not pts:
            continue
        f = cumulative_fare(pts, mx=pts[-1][0])
        week = {d: [[540, 1140, 0]] for d in WEEK[:6]}
        week['FERIE'] = []
        rs = geo_rings(feat['geometry'], simplify)
        items.append(('a', {'m': m, 'id': 'V' + str(p['id_zone_visiteur']), 'n': 'Zone ' + p['couleur'], 'g': 'Strasbourg',
                            'r': rs, 'w': week, 'f': [f], 'c': 'EUR', 'src': 'Eurométropole de Strasbourg (open data)'}))
        if p.get('numero_zone_resident'):
            nr = str(p['numero_zone_resident'])
            items.append(('v', {'m': m, 'id': 'R' + nr, 'k': f'{m}:A:R{nr}', 'n': 'Zone résidentielle ' + nr, 'g': 'Strasbourg',
                                'r': rs, 't': 'Met je bewonersvergunning betaal je hier het bewonerstarief.'}))
    return items, {m: french_holidays(today, 21)}


CITIES = [('Parijs', paris), ('Brussel', brussels), ('Straatsburg', strasbourg)]


def collect(today, simplify):
    """Alle steden: lijst van (soort, gebied) en de speciale dagen per beheerder."""
    items, special = [], {}
    for name, fn in CITIES:
        try:
            got, sp = fn(today, simplify)
        except Exception as e:  # een stad die niet bereikbaar is, slaan we deze nacht over
            print(f'{name}: overgeslagen ({e})')
            continue
        items += got
        special.update(sp)
        print(f'{name}: {sum(k == "a" for k, _ in got)} betaald, {sum(k == "v" for k, _ in got)} vergunning')
    return items, special
