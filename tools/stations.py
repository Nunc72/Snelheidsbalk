#!/usr/bin/env python3
"""Treinstations in Europa klaarzetten voor de kaart, met per stad een voorrang.

Bron: Trainline stations (open data, ODbL), alleen stations met een UIC-code (spoor,
geen bushaltes). Stations met hetzelfde eerste woord dicht bij elkaar horen bij één stad.

  stations.json  [[naam, lat, lon, rang], ...]
  rang 0: hoofdstation van een stad (Utrecht Centraal), al uitgezoomd te zien
  rang 1: het enige station van een plaats (Bunnik)
  rang 2: de andere stations in een stad (Utrecht Zuilen), pas dichterbij

Gebruik: python3 tools/stations.py [stations.json]
"""
import csv
import io
import json
import math
import re
import sys
import urllib.request

SOURCE = 'https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv'


MAIN = re.compile(r'\b(Centraal|Central|Centrale|Centrala|Centralna|Hbf|Hauptbahnhof|Hlavní nádraží|Hlavná stanica|Główny|Termini)\b', re.I)


def km(a, b):
    dy = (a[1] - b[1]) * 111
    dx = (a[2] - b[2]) * 111 * math.cos(math.radians(a[1]))
    return math.hypot(dx, dy)


def main(out):
    req = urllib.request.Request(SOURCE, headers={'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'})
    rows = csv.DictReader(io.StringIO(urllib.request.urlopen(req, timeout=120).read().decode('utf-8')), delimiter=';')
    seen, stations = set(), []
    for r in rows:
        if not r['uic'] or r['is_city'] == 't' or not r['latitude'] or not r['longitude']:
            continue
        lat, lon = round(float(r['latitude']), 4), round(float(r['longitude']), 4)
        # Hetzelfde station staat er soms dubbel in (per vervoerder)
        key = (r['name'], round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        stations.append([r['name'], lat, lon, r['is_main_station'] == 't'])
    # Per stad: stations met hetzelfde eerste woord, elk binnen 8 km van een ander (Utrecht Centraal, Utrecht Zuilen)
    groups = {}
    for s in stations:
        city = re.split(r'[\s\-–(/,]', s[0], 1)[0]
        for g in groups.setdefault(city, []):
            if any(km(m, s) < 8 for m in g):
                g.append(s)
                break
        else:
            groups[city].append([s])
    out_list = []
    for city, gs in groups.items():
        for g in gs:
            if len(g) == 1:
                out_list.append(g[0][:3] + [1])
                continue
            # Het hoofdstation: zo aangemerkt, de kale plaatsnaam, of Centraal/Hbf in de naam
            main = next((s for s in g if s[3]), None) or next((s for s in g if s[0] == city), None) \
                or next((s for s in g if MAIN.search(s[0])), None)
            for s in g:
                out_list.append(s[:3] + [0 if s is main else 2 if main else 1])
    out_list.sort(key=lambda s: s[3])
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(out_list, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out_list)} stations, {sum(s[3] == 0 for s in out_list)} hoofdstations')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'stations.json')
