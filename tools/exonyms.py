#!/usr/bin/env python3
"""Namen van buitenlandse steden in de taal van de app (Parijs, Keulen, Londen), per taal één bestand.

Photon kent alleen de eigen naam van een plaats en een paar grote talen. Wie in het Nederlands
'Parijs' typt, vindt daar niets. Deze lijsten vullen dat aan, voor elke taal waarin de app uitkomt.

Bronnen: welke steden uit GeoNames (CC-BY): 100.000 of meer inwoners, in Europa al vanaf 30.000
(Bergen/Mons, Doornik/Tournai), plus de grote steden en hoofdsteden uit Wikidata zelf (bij Keulen
hangt het GeoNames-nummer aan het Regierungsbezirk). De namen per taal uit Wikidata (CC0).
Een naam komt er alleen in als hij anders is dan de eigen naam van de stad (die vindt Photon zelf).

  exonyms/<taal>.json  [[naam, lat, lon, land, inwoners], ...]  grootste stad eerst

Gebruik: python3 tools/exonyms.py [nl de es fr it en]
"""
import io
import json
import math
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile

UA = {'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'}
ENDPOINT = 'https://query.wikidata.org/sparql'
CITIES = 'https://download.geonames.org/export/dump/cities15000.zip'


def sparql(q):
    for attempt in range(4):
        try:
            req = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({'query': q, 'format': 'json'}).encode(), headers=UA)
            return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())['results']['bindings']
        except Exception as e:  # druk of een time-out: even wachten en opnieuw
            print('  opnieuw:', e)
            time.sleep(5 * (attempt + 1))
    raise SystemExit('Wikidata geeft geen antwoord')


def fold(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t.lower()) if unicodedata.category(c) != 'Mn')


def km(a, b):
    return math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * math.cos(math.radians(a[0])))


def main(langs):
    raw = urllib.request.urlopen(urllib.request.Request(CITIES, headers=UA), timeout=120).read()
    cities = {}
    for line in zipfile.ZipFile(io.BytesIO(raw)).read('cities15000.txt').decode('utf-8').splitlines():
        r = line.split('\t')
        pop = int(r[14] or 0)
        # Geen stadsdelen (PPLX: Neukölln, arrondissementen)
        if r[7] == 'PPLX':
            continue
        if pop >= 100000 or (r[17].startswith('Europe/') and pop >= 30000):
            cities[r[0]] = {'at': (round(float(r[4]), 4), round(float(r[5]), 4)), 'cc': r[8], 'pop': pop,
                            'own': {fold(r[1]), fold(r[2])}, 'labels': {}}
    ids = sorted(cities)
    print(f'{len(ids)} steden')
    want = sorted(set(langs))
    for i in range(0, len(ids), 200):
        values = ' '.join(f'"{g}"' for g in ids[i:i + 200])
        rows = sparql(f"""SELECT ?gid ?l ?lang WHERE {{
          VALUES ?gid {{ {values} }}
          ?c wdt:P1566 ?gid; rdfs:label ?l. BIND(lang(?l) AS ?lang) FILTER(?lang IN ({','.join(repr(x) for x in want)}))
          # Alleen een woonplaats: soms hangt het GeoNames-nummer aan iets anders (een bedrijf, een plein)
          FILTER EXISTS {{ ?c wdt:P31/wdt:P279* wd:Q486972 }}
          # Geen stadsdeel of wijk (arrondissement van Parijs)
          FILTER NOT EXISTS {{ ?c wdt:P31/wdt:P279* ?no. VALUES ?no {{ wd:Q702842 wd:Q2983893 wd:Q123705 }} }}
        }}""")
        for r in rows:
            cities[r['gid']['value']]['labels'][r['lang']['value']] = r['l']['value']
        print(f'  {min(i + 200, len(ids))}/{len(ids)}')
        time.sleep(0.3)
    # Tweede route: de grote steden (100.000+) en hoofdsteden van Wikidata zelf
    big = {r['c']['value'].rsplit('/', 1)[1] for r in sparql(
        'SELECT ?c WHERE { ?c wdt:P31 wd:Q1549591; wdt:P1082 ?pop. FILTER(?pop >= 100000) }')}
    big |= {r['c']['value'].rsplit('/', 1)[1] for r in sparql('SELECT ?c WHERE { ?x wdt:P31 wd:Q6256; wdt:P36 ?c }')}
    big = sorted(big)
    print(f'{len(big)} grote steden uit Wikidata')
    extra = {}
    for i in range(0, len(big), 150):
        values = ' '.join('wd:' + q for q in big[i:i + 150])
        for r in sparql(f"""SELECT ?c ?coord ?cc ?pop ?l ?lang WHERE {{
          VALUES ?c {{ {values} }}
          ?c wdt:P625 ?coord; wdt:P17 ?country. ?country wdt:P297 ?cc.
          OPTIONAL {{ ?c wdt:P1082 ?pop }}
          ?c rdfs:label ?l. BIND(lang(?l) AS ?lang) FILTER(?lang IN ({','.join(repr(x) for x in want)}))
        }}"""):
            q = r['c']['value'].rsplit('/', 1)[1]
            lon, lat = r['coord']['value'][6:-1].split(' ')[:2]
            c = extra.setdefault(q, {'at': (round(float(lat), 4), round(float(lon), 4)), 'cc': r['cc']['value'], 'pop': 0, 'own': set(), 'labels': {}})
            if 'pop' in r:
                c['pop'] = max(c['pop'], int(float(r['pop']['value'])))
            c['labels'][r['lang']['value']] = r['l']['value']
        print(f'  {min(i + 150, len(big))}/{len(big)}')
        time.sleep(0.3)
    # Eigen naam: die van de GeoNames-plaats op die plek (binnen 10 km), anders de Engelse
    grid = {}
    for c in cities.values():
        grid.setdefault((round(c['at'][0]), round(c['at'][1])), []).append(c)
    for c in extra.values():
        lat, lon = c['at']
        for dlat in (-1, 0, 1):
            for dlon in (-1, 0, 1):
                for g in grid.get((round(lat) + dlat, round(lon) + dlon), []):
                    if km(g['at'], c['at']) < 10:
                        c['own'] |= g['own']
                        c['pop'] = max(c['pop'], g['pop'])
        if not c['own']:
            c['own'] = {fold(c['labels'].get('en', ''))}
    all_cities = list(cities.values()) + list(extra.values())
    os.makedirs('exonyms', exist_ok=True)
    for lang in langs:
        out, seen = [], []
        for c in sorted(all_cities, key=lambda c: -c['pop']):
            name = c['labels'].get(lang)
            # De eigen naam vindt Photon zelf
            if not name or fold(name) in c['own'] or '(' in name:
                continue
            # Dezelfde stad via beide routes: één keer
            if any(n == fold(name) and km(at, c['at']) < 20 for n, at in seen):
                continue
            seen.append((fold(name), c['at']))
            out.append([name, c['at'][0], c['at'][1], c['cc'], c['pop']])
        out.sort(key=lambda x: -x[4])
        with open(f'exonyms/{lang}.json', 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        print(f'{lang}: {len(out)} namen')


if __name__ == '__main__':
    main(sys.argv[1:] or ['nl', 'de', 'es', 'fr', 'it', 'en'])
