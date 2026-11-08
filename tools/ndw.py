#!/usr/bin/env python3
"""Open data van NDW (opendata.ndw.nu) klaarzetten voor de app.

Draait elke 5 minuten als GitHub Action (.github/workflows/ndw.yml). De app kan de
bestanden van NDW zelf niet ophalen (geen toegang vanaf andere sites, en het
laadpalenbestand is 185 MB), dus maken we er kleine stukjes van:

  c/<rij>_<kolom>.json  laadpalen per vak van 0,05 graad, met hoeveel punten er vrij zijn
  closures.json         afsluitingen (hele rijbaan of weg dicht) die nu of binnen 24 uur gelden
  meta.json             wanneer dit is gemaakt

Gebruik: python3 tools/ndw.py <uitvoermap>
"""
import gzip
import json
import math
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

BASE = 'https://opendata.ndw.nu/'
GRID = 0.05
NOW = time.time()

FREE = {'AVAILABLE'}
BUSY = {'CHARGING', 'BLOCKED', 'RESERVED'}
GONE = {'REMOVED'}


def fetch(name):
    req = urllib.request.Request(BASE + name, headers={'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'})
    with urllib.request.urlopen(req, timeout=120) as res:
        return gzip.decompress(res.read())


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))


# ---------- Laadpalen ----------
# Per locatie: [lat, lon, adres, plaats, aanbieder, punten, vrij, bezet, max kW]
def chargers(out):
    tiles = {}
    for loc in json.loads(fetch('charging_point_locations_ocpi.json.gz')):
        if loc.get('publish') is False:
            continue
        evses = [e for e in loc.get('evses') or [] if e.get('status') not in GONE]
        if not evses:
            continue
        try:
            lat = float(loc['coordinates']['latitude'])
            lon = float(loc['coordinates']['longitude'])
        except (KeyError, TypeError, ValueError):
            continue
        kw = max((c.get('max_electric_power') or 0 for e in evses for c in e.get('connectors') or []), default=0) / 1000
        op = (loc.get('operator') or {}).get('name') or (loc.get('owner') or {}).get('name') or ''
        row = [round(lat, 5), round(lon, 5), (loc.get('address') or '').strip(), (loc.get('city') or '').strip(), op.strip(),
               len(evses), sum(e.get('status') in FREE for e in evses), sum(e.get('status') in BUSY for e in evses), round(kw)]
        tiles.setdefault((math.floor(lat / GRID), math.floor(lon / GRID)), []).append(row)
    for key, rows in tiles.items():
        tiles[key] = merge(rows)
    for (r, c), rows in tiles.items():
        write(f'{out}/c/{r}_{c}.json', rows)
    return sum(len(v) for v in tiles.values())


# Een parkeergarage staat er soms als meerdere locaties op hetzelfde adres: samen één,
# met alle punten bij elkaar (binnen 150 m, zelfde adres, plaats en aanbieder)
def merge(rows):
    out, seen = [], {}
    for row in rows:
        key = (row[2].lower(), row[3].lower(), row[4].lower())
        have = seen.get(key) if row[2] else None
        if have and abs(have[0] - row[0]) < 0.0014 and abs(have[1] - row[1]) < 0.0022:
            have[5] += row[5]
            have[6] += row[6]
            have[7] += row[7]
            have[8] = max(have[8], row[8])
            continue
        seen[key] = row
        out.append(row)
    return out


# ---------- Afsluitingen ----------
NS = {
    'sit': 'http://datex2.eu/schema/3/situation',
    'com': 'http://datex2.eu/schema/3/common',
    'loc': 'http://datex2.eu/schema/3/locationReferencing',
}
XSI = '{http://www.w3.org/2001/XMLSchema-instance}type'
BLOCKING = {'carriagewayClosures', 'roadClosed'}
CAUSE_NL = {'roadMaintenance': 'Wegwerkzaamheden', 'constructionWork': 'Bouwwerkzaamheden', 'publicEvent': 'Evenement',
            'accident': 'Ongeval'}
WAY_NL = {'mainCarriageway': 'rijbaan', 'entrySlipRoad': 'toerit', 'exitSlipRoad': 'afrit',
          'connectingCarriageway': 'verbindingsweg', 'parallelCarriageway': 'parallelbaan'}


def epoch(s):
    # Soms met nanoseconden ('...00:15.662231238+00:00'): de seconden zijn genoeg
    return int(datetime.fromisoformat(re.sub(r'\.\d+', '', s.replace('Z', '+00:00'))).timestamp()) if s else None


def closures(out):
    root = ET.fromstring(fetch('tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz'))
    found = []
    for rec in root.iter('{%s}situationRecord' % NS['sit']):
        kind = rec.findtext('sit:roadOrCarriagewayOrLaneManagementType', namespaces=NS)
        if kind not in BLOCKING:
            continue
        start = epoch(rec.findtext('sit:validity/com:validityTimeSpecification/com:overallStartTime', namespaces=NS))
        end = epoch(rec.findtext('sit:validity/com:validityTimeSpecification/com:overallEndTime', namespaces=NS))
        if (end and end < NOW) or (start and start > NOW + 86400):
            continue
        # Soms alleen in bepaalde periodes (bijv. 's nachts) binnen de hele looptijd
        periods = [[epoch(p.findtext('com:startOfPeriod', namespaces=NS)), epoch(p.findtext('com:endOfPeriod', namespaces=NS))]
                   for p in rec.iterfind('sit:validity/com:validityTimeSpecification/com:validPeriod', namespaces=NS)]
        periods = [p for p in periods if not (p[1] and p[1] < NOW)]
        if any(rec.iterfind('sit:validity/com:validityTimeSpecification/com:validPeriod', namespaces=NS)) and not periods:
            continue
        lines = []
        for pl in rec.iterfind('.//loc:gmlLineString/loc:posList', namespaces=NS):
            v = [float(x) for x in pl.text.split()]
            line = [[round(v[i + 1], 5), round(v[i], 5)] for i in range(0, len(v) - 1, 2)]
            if len(line) > 1 and line not in lines:
                lines.append(line)
        if not lines:
            continue
        way = rec.findtext('.//loc:carriageway/loc:carriageway', namespaces=NS)
        cause = rec.findtext('sit:cause/sit:causeType', namespaces=NS)
        found.append({'id': rec.get('id'), 'k': kind, 'w': WAY_NL.get(way, ''), 'c': CAUSE_NL.get(cause, ''),
                      's': start, 'e': end, 'p': periods or None, 'l': lines})
    write(f'{out}/closures.json', found)
    return len(found)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'ndw-out'
    n_c = chargers(out)
    n_a = closures(out)
    write(f'{out}/meta.json', {'t': int(NOW), 'chargers': n_c, 'closures': n_a})
    print(f'{n_c} laadlocaties, {n_a} afsluitingen')
