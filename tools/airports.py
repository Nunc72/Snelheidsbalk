#!/usr/bin/env python3
"""Luchthavens met een IATA-code (AMS, BCN, JFK) klaarzetten voor het zoeken in de app.

Bron: OurAirports (publiek domein), alleen grote en middelgrote luchthavens met
lijnvluchten. Met de stadscodes van IATA (NYC, RIO) die meerdere luchthavens dekken.

  airports.json  {"a": {code: [naam, plaats, land, lat, lon, rang]}, "m": {stadscode: [codes]}}
  rang 0: grote luchthaven, 1: middelgrote (voor de kaart: groot al verder uitgezoomd)

Gebruik: python3 tools/airports.py [airports.json]
"""
import csv
import io
import json
import sys
import urllib.request

SOURCE = 'https://davidmegginson.github.io/ourairports-data/airports.csv'
RANK = {'large_airport': 0, 'medium_airport': 1}

# Stadscodes van IATA; de belangrijkste luchthaven eerst
METRO = {
    'NYC': ['JFK', 'EWR', 'LGA'], 'RIO': ['GIG', 'SDU'], 'LON': ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'],
    'PAR': ['CDG', 'ORY', 'BVA'], 'TYO': ['HND', 'NRT'], 'MIL': ['MXP', 'LIN', 'BGY'], 'ROM': ['FCO', 'CIA'],
    'STO': ['ARN', 'BMA', 'NYO', 'VST'], 'MOW': ['SVO', 'DME', 'VKO'], 'CHI': ['ORD', 'MDW'],
    'WAS': ['IAD', 'DCA', 'BWI'], 'BUE': ['EZE', 'AEP'], 'SAO': ['GRU', 'CGH', 'VCP'], 'OSA': ['KIX', 'ITM', 'UKB'],
    'SEL': ['ICN', 'GMP'], 'BJS': ['PEK', 'PKX'], 'YTO': ['YYZ', 'YTZ', 'YHM'], 'YMQ': ['YUL', 'YMX'],
    'JKT': ['CGK', 'HLP'], 'REK': ['KEF', 'RKV'], 'BUH': ['OTP', 'BBU'], 'SPK': ['CTS', 'OKD'], 'TCI': ['TFS', 'TFN'],
    'IST': ['IST', 'SAW'], 'BKK': ['BKK', 'DMK'], 'TPE': ['TPE', 'TSA'], 'MEX': ['MEX', 'NLU'],
    'DTT': ['DTW'], 'QDF': ['DFW', 'DAL'],
}


def main(out):
    req = urllib.request.Request(SOURCE, headers={'User-Agent': 'VeloVerde (github.com/Nunc72/Snelheidsbalk)'})
    rows = csv.DictReader(io.StringIO(urllib.request.urlopen(req, timeout=120).read().decode('utf-8')))
    best = {}
    for r in rows:
        code = r['iata_code'].strip().upper()
        if len(code) != 3 or r['type'] not in RANK or r['scheduled_service'] != 'yes':
            continue
        have = best.get(code)
        if have and RANK[have['type']] <= RANK[r['type']]:
            continue
        best[code] = r
    airports = {c: [r['name'], r['municipality'], r['iso_country'], round(float(r['latitude_deg']), 5),
                    round(float(r['longitude_deg']), 5), RANK[r['type']]] for c, r in sorted(best.items())}
    metro = {m: [c for c in codes if c in airports] for m, codes in METRO.items()}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'a': airports, 'm': {m: c for m, c in metro.items() if c}}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(airports)} luchthavens, {len(metro)} stadscodes')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'airports.json')
