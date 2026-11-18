"""Parkeren op straat in het buitenland: per stad een omzetter naar dezelfde vorm als de RDW-data.

We tonen alleen wat de open data van de stad geeft; er wordt niets bij gezocht. Per stad levert
een omzetter (soort, gebied) op, met soort 'a' (betaald) of 'v' (vergunning), plus speciale dagen.
Extra velden naast die van tools/parking.py:
  "c": munt (EUR, CHF, GBP), "src": bron voor in het blad, "t" (vergunning): wat de vergunning hier betekent,
  "u": de ringen zijn losse stukjes die mogen overlappen (binnen = in één ervan, niet oneven),
  "sg": straatdelen [lon1, lat1, lon2, lat2] in plaats van ringen; tools/parking.py schrijft ze per vak
  klein weg (zie daar) en de app maakt er zelf de vlakjes van.
  In een tarief: "mx": maximale parkeerduur in minuten, "l": prijs van het eerste uur als die anders is
  dan "h" (Brussel: het eerste halfuur is goedkoper), "t": tekst in plaats van het bedrag ("2 u gratis",
  "€ 3,00–4,00"), "nc": niet doorrekenen, "zn": alleen de naam van de zone, geen bedrag ("Hochtarifzone"),
  "lv": 3 als we alleen weten dat er betaald wordt.
Een stad die niet bereikbaar is valt die nacht weg; de rest gaat door.
"""
import csv
import gzip
import io
import json
import math
import os
import re
import sys
import urllib.request
from datetime import date, timedelta

UA = {'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'}
WEEK = ['MAANDAG', 'DINSDAG', 'WOENSDAG', 'DONDERDAG', 'VRIJDAG', 'ZATERDAG', 'ZONDAG']


def get_text(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as res:
        raw = res.read()
    return (gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw).decode('utf-8-sig')


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


def barcelona_holidays(today, days):
    """Feestdagen in Barcelona (Spanje, Catalonië en de stad zelf)."""
    out = {}
    for y in {today.year, (today + timedelta(days=days)).year}:
        e = easter(y)
        for d in [date(y, 1, 1), date(y, 1, 6), e - timedelta(2), e + timedelta(1), date(y, 5, 1), e + timedelta(50), date(y, 6, 24),
                  date(y, 8, 15), date(y, 9, 11), date(y, 9, 24), date(y, 10, 12), date(y, 11, 1), date(y, 12, 6), date(y, 12, 8),
                  date(y, 12, 25), date(y, 12, 26)]:
            if today <= d <= today + timedelta(days=days):
                out[d.strftime('%Y%m%d')] = 'FESTIU'
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
        f = {'h': hours[0], 'mx': 360}
        if steps:
            f['s'] = steps
        week = {d: [[540, 1200, 0]] for d in WEEK[:6]}
        week['FERIE'] = []
        items.append(('a', {'m': m, 'id': 'Z' + str(p['zone']), 'n': 'Zone ' + str(p['zone']), 'g': 'Paris',
                            'r': geo_rings(feat['geometry'], simplify), 'w': week, 'f': [f], 'c': 'EUR',
                            'src': 'Ville de Paris (open data)'}))
    # Parkings (garages) van de stad, met de totaalprijs na 1, 2, 3, 4 en 24 uur
    for g in get_json(PARIS.format('stationnement-en-ouvrage'))['features']:
        p = g['properties']
        pts = [(t, round(float(p[k]) * 100)) for t, k in ((60, 'tarif_1h'), (120, 'tarif_2h'), (180, 'tarif_3h'), (240, 'tarif_4h'), (1440, 'tarif_24h'))
               if p.get(k) not in (None, '')]
        item = {'m': m, 'id': str(p.get('id')), 'n': 'Parking ' + str(p.get('nom') or '').title(), 'g': 'Paris', 'p': g['geometry']['coordinates'][:2], 'c': 'EUR'}
        if pts:
            item.update({'w': {d: [[0, 1440, 0]] for d in WEEK}, 'f': [cumulative_fare(pts)]})
        elif 'abonn' in str(p.get('type_usagers') or '').lower():
            continue  # alleen voor abonnees
        items.append(('g', item))
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


# ---------- Barcelona ----------
# Open Data BCN (CC BY 4.0), elk kwartaal bijgewerkt: 17.000 straatdelen (begin- en eindpunt) met
# soort, tarief en tijden. Àrea blava (AZL) en Àrea verda (VM) zijn betaald; Àrea verda alleen voor
# bewoners (VR) is "Alleen vergunning". Laden/lossen en bussen slaan we over. De app maakt van elk
# straatdeel een vlak tot 75 m opzij, zodat ook een adres midden in een huizenblok erin valt.
# Per vak van 0,05 graad en per soort/tarief/tijden één gebied.
BCN = 'https://opendata-ajuntament.barcelona.cat/data/api/3/action/package_show?id={}'
BCN_DAYS = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg']
BCN_TYPES = {'AZL': ('a', 'Àrea blava'), 'VM': ('a', 'Àrea verda'), 'VR': ('v', 'Àrea verda (residents)')}


# Het portaal weigert verzoeken van GitHub (403). Daarom staat er een kopie in tools/data/barcelona,
# te vernieuwen vanaf een eigen computer met: python3 tools/parking_abroad.py barcelona
# De stad werkt de data eens per kwartaal bij. Lukt het live wel, dan gaat dat voor.
BCN_NAMES = ['trams-aparcament-superficie', 'tarifes-aparcament-superficie', 'horaris-aparcaments-superficie']
BCN_COPY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'barcelona')


def bcn_live(name):
    return get_text(get_json(BCN.format(name))['result']['resources'][0]['url'])


def bcn_csv(name):
    try:
        text = bcn_live(name)
    except Exception as e:
        with open(os.path.join(BCN_COPY, name + '.csv'), encoding='utf-8') as f:
            text = f.read()
        print(f'Barcelona {name}: kopie uit de repository ({e})')
    return list(csv.DictReader(io.StringIO(text)))


def refresh_barcelona():
    os.makedirs(BCN_COPY, exist_ok=True)
    for name in BCN_NAMES:
        text = bcn_live(name)
        with open(os.path.join(BCN_COPY, name + '.csv'), 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'{name}: {text.count(chr(10))} regels')


def bcn_hours(text):
    """'de Dl a Dv de 09:00 a 20:00, Ds de 09:00 a 14:00' → {dag: [[van, tot]]}. Wat na
    'exclusiu'/'excl.' komt gaat over bewoners en telt niet."""
    text = re.split(r'excl', text, flags=re.I)[0]
    out, days = {}, []
    for tok in re.finditer(r'(D[ltcjvsg])(?:\s+a\s+(D[ltcjvsg]))?|(\d{1,2}):(\d{2})\s*a\s*(\d{1,2}):(\d{2})', text):
        if tok.group(1):
            d0 = BCN_DAYS.index(tok.group(1))
            d1 = BCN_DAYS.index(tok.group(2)) if tok.group(2) else d0
            days = [WEEK[d] for d in range(d0, d1 + 1)]
        else:
            span = [int(tok.group(3)) * 60 + int(tok.group(4)), int(tok.group(5)) * 60 + int(tok.group(6))]
            for d in days:
                out.setdefault(d, []).append(span)
    return out


def barcelona(today, simplify):
    m = 'ES-BARCELONA'
    fares = {r['ID_TARIFA']: r for r in bcn_csv('tarifes-aparcament-superficie')}
    hours = {r['ID_HORARI']: r for r in bcn_csv('horaris-aparcaments-superficie')}
    groups = {}
    for r in bcn_csv('trams-aparcament-superficie'):
        kind = BCN_TYPES.get(r['TIPUS_TRAM'])
        h = hours.get(r['ID_HORARIO'])
        if not kind or not h:
            continue
        try:
            lat1, lon1, lat2, lon2 = (float(r[k]) for k in ('LATITUD_I', 'LONGITUD_I', 'LATITUD_F', 'LONGITUD_F'))
        except ValueError:
            continue
        tile = (math.floor((lat1 + lat2) / 2 / 0.05), math.floor((lon1 + lon2) / 2 / 0.05))
        key = (tile, r['TIPUS_TRAM'], r['ID_TARIFA'], r['ID_HORARIO'])
        groups.setdefault(key, []).append([lon1, lat1, lon2, lat2])
    items = []
    for (tile, typ, fare_id, hour_id), segs in groups.items():
        kind, name = BCN_TYPES[typ]
        gid = f'{typ}-{fare_id}-{hour_id}-{tile[0]}_{tile[1]}'
        if kind == 'v':
            items.append(('v', {'m': m, 'id': gid, 'k': f'{m}:A:{gid}', 'n': name, 'g': 'Barcelona', 'sg': segs, 'u': 1}))
            continue
        fr = fares.get(fare_id)
        if not fr or float(fr['IMPORT_FRACCIO'] or 0) <= 0 or fr['TIPUS_FRACCIO'] != '1':
            continue
        h = hours[hour_id]
        week = {d: [[s, e, 0] for s, e in v] for d, v in bcn_hours(h['DESCRIPCIO']).items()}
        if not week:
            continue
        if h['INCLUS_FESTIUS'] != '1':
            week['FESTIU'] = []
        f = {'h': round(float(fr['IMPORT_FRACCIO']) * 100), 'mx': int(fr['TEMPS_MAXIM']) * 60}
        items.append(('a', {'m': m, 'id': gid, 'n': name, 'g': 'Barcelona', 'sg': segs, 'u': 1, 'w': week, 'f': [f], 'c': 'EUR',
                            'src': 'Ajuntament de Barcelona (Open Data BCN)'}))
    return items, {m: barcelona_holidays(today, 21)}


def euro_cents(text):
    m = re.search(r'(\d+)(?:[,.](\d{1,2}))?', text or '')
    return int(m.group(1)) * 100 + int((m.group(2) or '0').ljust(2, '0')) if m else None


def week_from(text, names, default_days=None):
    """'Mo-Fr 9-20 Uhr / Sa 9-18 Uhr' → {dag: [[van, tot, 0]]}; dagnamen in 'names' (ma … zo)."""
    alt = '|'.join(names)
    out, days = {}, default_days or []
    for tok in re.finditer(rf'\b({alt})\b(?:\s*-\s*({alt})\b)?|(\d{{1,2}})(?:[:.](\d\d))?\s*-\s*(\d{{1,2}})(?:[:.](\d\d))?', text, re.I):
        if tok.group(1):
            d0 = [n.lower() for n in names].index(tok.group(1).lower())
            d1 = [n.lower() for n in names].index(tok.group(2).lower()) if tok.group(2) else d0
            days = [WEEK[d] for d in range(d0, d1 + 1)]
        else:
            span = [int(tok.group(3)) * 60 + int(tok.group(4) or 0), int(tok.group(5)) * 60 + int(tok.group(6) or 0), 0]
            for d in days:
                if span not in out.setdefault(d, []):
                    out[d].append(span)
    return out


# ---------- Berlijn ----------
# Geoportal Berlin (dl-de/by-2.0): 104 parkeerzones met het uurtarief ("3,00 Euro", soms "3,00 bzw.
# 4,00 Euro") en de tijden ("Mo-Fr 9-20 Uhr / Sa 9-18 Uhr"). Afwijkingen per straat staan er niet in.
BERLIN = ('https://gdi.berlin.de/services/wfs/parkraumbewirtschaftung?service=WFS&version=2.0.0&request=GetFeature'
          '&typeNames=parkraumbewirtschaftung:parkzonen&outputFormat=application/json&srsName=EPSG:4326')
DE_DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']


def berlin(today, simplify):
    m = 'DE-BERLIN'
    items = []
    for feat in get_json(BERLIN)['features']:
        p = feat['properties']
        amounts = [euro_cents(x) for x in re.findall(r'\d+,\d\d', p.get('gebuehr') or '')]
        week = week_from(re.split(r'Advent', p.get('zeiten') or '')[0], DE_DAYS)
        if not amounts or not week:
            continue
        f = {'h': min(amounts)}
        if len(set(amounts)) > 1:
            f.update({'t': '€\u00a0' + '–'.join(f'{a / 100:.2f}'.replace('.', ',') for a in sorted(set(amounts))), 'nc': 1})
        items.append(('a', {'m': m, 'id': str(p['parkzone']), 'n': f"Parkzone {p['parkzone']}", 'g': 'Berlin ' + str(p.get('bezirk') or ''),
                            'r': geo_rings(feat['geometry'], simplify), 'w': week, 'f': [f], 'c': 'EUR', 'src': 'Geoportal Berlin (open data)'}))
    return items, {}


# ---------- Antwerpen ----------
# Stad Antwerpen (open data): tariefzones per kleur met starttarief, volgende uren, uren en maximale
# duur. De dagen staan er meestal niet bij; dan ma–za (de regel van de stad). Blauwe zone (schijf) valt
# weg; de vergunningzone (het centrum) wordt "Alleen vergunning".
ANTWERP = ('https://geodata.antwerpen.be/arcgissql/rest/services/P_Publiek/parkeertariefzones/MapServer/2/query'
           '?where=1%3D1&outFields=*&outSR=4326&f=geojson')
NL_DAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']


def antwerp_fare(p):
    start, extra = p.get('Starttarief') or '', p.get('Extra_SNA') or p.get('Extra_tarief') or ''
    mx_text = p.get('Maximum_parkeerduur') or ''
    mx = None if 'evenement' in mx_text else re.match(r'\s*(\d+)\s*(uur|minuten)', mx_text)
    mx = (int(mx.group(1)) * (60 if mx.group(2) == 'uur' else 1)) if mx else None
    if 'gratis' in start.lower():
        free = re.search(r'(\d+)\s*uur', start)
        f = {'h': 0, 's': [[int(free.group(1)) * 60, euro_cents(extra)]], 't': f'{free.group(1)}\u00a0u gratis'} if free and euro_cents(extra) else None
    elif 'van toepassing' in extra.lower() and euro_cents(start) and mx and mx < 60:
        f = {'h': round(euro_cents(start) * 60 / mx), 'b': mx}
    elif euro_cents(start):
        later = re.findall(r'(\d)e uur:\s*\+\s*€\s*([\d,]+)', extra)
        if later:
            f = {'h': euro_cents(start), 's': [[(int(n) - 1) * 60, euro_cents(c)] for n, c in later]}
        else:
            nxt = euro_cents(extra)
            f = {'h': euro_cents(start), **({'s': [[60, nxt]]} if nxt and nxt != euro_cents(start) else {})}
    else:
        return None
    if f and mx:
        f['mx'] = mx
    return f


def antwerp(today, simplify):
    m = 'BE-ANTWERPEN'
    items = []
    for feat in get_json(ANTWERP)['features']:
        p = feat['properties']
        if (p.get('Status') or '') != 'actief' or not feat.get('geometry'):
            continue
        if (p.get('TARIEFKLEUR') or '').lower() == 'vergunning':
            gid = str(p.get('GISID'))
            items.append(('v', {'m': m, 'id': gid, 'k': f'{m}:A:{gid}', 'n': p.get('NAAM') or 'Vergunningzone', 'g': 'Antwerpen',
                                'r': geo_rings(feat['geometry'], simplify)}))
            continue
        f = antwerp_fare(p)
        week = week_from(p.get('Uurregeling') or '', NL_DAYS, default_days=WEEK[:6])
        if not f or not week:
            continue
        items.append(('a', {'m': m, 'id': str(p.get('GISID')), 'n': p.get('NAAM') or 'Parkeerzone ' + str(p.get('TARIEFKLEUR')), 'g': 'Antwerpen',
                            'r': geo_rings(feat['geometry'], simplify), 'w': week, 'f': [f], 'c': 'EUR', 'src': 'Stad Antwerpen (open data)'}))
    return items, {}


# ---------- Zürich ----------
# Stadt Zürich (CC0): alleen de hoogtariefzone (Innenstadt en Oerlikon) met de tijden; bedragen staan
# er niet in. Daar tonen we "Hochtarifzone".
ZURICH = ('https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Gebietseinteilung_Parkierungsgebuehren?service=WFS&version=1.1.0'
          '&request=GetFeature&typename=tarifzonen&outputFormat=GeoJSON&srsName=EPSG:4326')
DE_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']


def zurich(today, simplify):
    m = 'CH-ZUERICH'
    items = []
    for i, feat in enumerate(get_json(ZURICH)['features']):
        p = feat['properties']
        week = week_from(p.get('bedienungszeiten') or '', DE_LONG)
        if not week:
            continue
        items.append(('a', {'m': m, 'id': f'Z{i}', 'n': p.get('zone_bezeichnung') or p['tarifzone'], 'g': 'Zürich', 'r': geo_rings(feat['geometry'], simplify),
                            'w': week, 'f': [{'h': 0, 'zn': p['tarifzone']}], 'c': 'CHF', 'src': 'Stadt Zürich (open data)'}))
    return items, {}


# ---------- München ----------
# Landeshauptstadt München (dl-de/by-2.0): Parklizenzgebiete. Alleen dat er betaald wordt (bewoners
# met Parkausweis niet); geen tarief en geen tijden.
MUNICH = ('https://geoportal.muenchen.de/geoserver/mor_wfs/ows?service=WFS&version=1.0.0&request=GetFeature'
          '&typeName=mor_wfs:ruhver_prm_gebiete_poly&outputFormat=application/json&srsName=EPSG:4326')


def munich(today, simplify):
    m = 'DE-MUENCHEN'
    items = []
    for feat in get_json(MUNICH)['features']:
        p = feat['properties']
        if p.get('status') != 'in Betrieb':
            continue
        rs, nm = geo_rings(feat['geometry'], simplify), str(p.get('name') or '')
        items.append(('a', {'m': m, 'id': nm, 'n': nm, 'g': 'München', 'r': rs, 'w': {d: [[0, 1440, 0]] for d in WEEK},
                            'f': [{'h': 0, 'zn': 'Betaald', 'lv': 3}], 'src': 'Landeshauptstadt München (open data)'}))
        if 'Lizenz' in str(p.get('massnahme')):
            items.append(('v', {'m': m, 'id': nm, 'k': f'{m}:A:{nm}', 'n': 'Lizenzgebiet ' + nm, 'g': 'München', 'r': rs,
                                't': 'Met je Bewohnerparkausweis parkeer je hier gratis.'}))
    return items, {}


# ---------- Sheffield ----------
# Sheffield City Council (OGL): twee zones in het centrum met het tarief als tekst
# ("Mon-Sat (08:00-20:30) £3.25 per hour <br /> … Sun (08:00-20:30) - £2 per hour").
SHEFFIELD = 'https://opendata.arcgis.com/datasets/79d3dad6138a4eafbbbed26f15b338f0_3.geojson'
EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def sheffield(today, simplify):
    m = 'GB-SHEFFIELD'
    items = []
    for i, feat in enumerate(get_json(SHEFFIELD)['features']):
        p = feat['properties']
        week, fares = {}, []
        for part in re.split(r'<br\s*/?>', p.get('tariff') or ''):
            if 'evening' in part.lower():
                continue
            price = re.search(r'£\s*([\d.]+)\s*per hour', part)
            w = week_from(part, EN_DAYS)
            if not price or not w:
                continue
            fares.append({'h': round(float(price.group(1)) * 100)})
            for d, spans in w.items():
                week.setdefault(d, []).extend([[s, e, len(fares) - 1] for s, e, _ in spans])
        if fares:
            items.append(('a', {'m': m, 'id': f'S{i}', 'n': p.get('zone') or 'Zone', 'g': 'Sheffield', 'r': geo_rings(feat['geometry'], simplify),
                                'w': week, 'f': fares, 'c': 'GBP', 'src': 'Sheffield City Council (open data)'}))
    return items, {}


CITIES = [('Parijs', paris), ('Brussel', brussels), ('Straatsburg', strasbourg), ('Barcelona', barcelona), ('Berlijn', berlin),
          ('Antwerpen', antwerp), ('Zürich', zurich), ('München', munich), ('Sheffield', sheffield)]


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
        print(f'{name}: ' + ', '.join(f'{sum(k == x for k, _ in got)} {w}' for x, w in (('a', 'betaald'), ('v', 'vergunning'), ('g', 'garages'))))
    return items, special


if __name__ == '__main__' and sys.argv[1:] == ['barcelona']:
    refresh_barcelona()
