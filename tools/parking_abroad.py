"""Parkeren op straat in het buitenland: per stad een omzetter naar dezelfde vorm als de RDW-data.

We tonen alleen wat de open data van de stad geeft; er wordt niets bij gezocht. Per stad levert
een omzetter (soort, gebied) op, met soort 'a' (betaald) of 'v' (vergunning), plus speciale dagen.
Extra velden naast die van tools/parking.py:
  "c": munt (EUR, CHF, GBP), "mx": maximale parkeerduur in minuten, "src": bron voor in het blad,
  "t" (vergunning): wat de vergunning hier betekent.
Een stad die niet bereikbaar is valt die nacht weg; de rest gaat door.
"""
import gzip
import json
import urllib.request
from datetime import date, timedelta

UA = {'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'}
WEEK = ['MAANDAG', 'DINSDAG', 'WOENSDAG', 'DONDERDAG', 'VRIJDAG', 'ZATERDAG', 'ZONDAG']


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as res:
        raw = res.read()
    # Sommige portalen sturen gzip, ook ongevraagd
    return json.loads((gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw).decode('utf-8'))


def geo_rings(geom, simplify):
    """Alle ringen (buitenkant en gaten) van een (Multi)Polygon; de app telt ze oneven/even."""
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    return [simplify([tuple(p[:2]) for p in ring], 0.00002) for poly in polys for ring in poly if len(ring) >= 4]


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
        f = {'h': hours[0]}
        if steps:
            f['s'] = steps
        week = {d: [[540, 1200, 0]] for d in WEEK[:6]}
        week['FERIE'] = []
        items.append(('a', {'m': m, 'id': 'Z' + str(p['zone']), 'n': 'Zone ' + str(p['zone']), 'g': 'Paris',
                            'r': geo_rings(feat['geometry'], simplify), 'w': week, 'f': [f], 'c': 'EUR', 'mx': 360,
                            'src': 'Ville de Paris (open data)'}))
    for feat in get_json(PARIS.format('stationnement-sur-voie-publique-secteurs-residentiels'))['features']:
        nom = str(feat['properties']['nom'])
        items.append(('v', {'m': m, 'id': nom, 'k': f'{m}:A:{nom}', 'n': 'Secteur ' + nom, 'g': 'Paris',
                            'r': geo_rings(feat['geometry'], simplify),
                            't': 'Met je carte résident betaal je hier het bewonerstarief.'}))
    return items, {m: french_holidays(today, 21)}


CITIES = [('Parijs', paris)]


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
