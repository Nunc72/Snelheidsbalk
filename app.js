'use strict';

const VERSION = '22';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const PHOTON = 'https://photon.komoot.io/api/';
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (darkQuery.matches ? 'dark' : 'light');
const DEMO = new URLSearchParams(location.search).has('demo');

// Kleurschaal op basis van km/u boven of onder de maximumsnelheid.
// In dark mode zijn de uiteinden omgedraaid: stilstand is zwart, max+30 is wit.
const SKY = [135, 206, 235], GREEN = [0, 128, 0], YELLOW = [255, 255, 0], ORANGE = [255, 165, 0],
  RED = [255, 0, 0], PURPLE = [178, 0, 255], WHITE = [255, 255, 255], BLACK = [0, 0, 0];

function scaleColor(speed, limit) {
  const dark = theme() === 'dark';
  const d = speed - limit;  // km/u te hard (positief) of te langzaam (negatief)
  const stops = [[-limit, dark ? BLACK : WHITE]];
  if (limit > 15) stops.push([-15, SKY]);
  stops.push([0, GREEN], [2, YELLOW], [4, ORANGE], [6, RED], [20, PURPLE], [30, dark ? WHITE : BLACK]);
  if (d <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (d <= b) {
      const f = (d - a) / (b - a);
      return ca.map((c, j) => Math.round(c + (cb[j] - c) * f));
    }
  }
  return stops[stops.length - 1][1];
}

function luminance(c) {
  const l = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}

const $ = id => document.getElementById(id);

const state = {
  fix: null,          // laatste GPS-positie {lat, lon, speed, heading, acc, t}
  speedKmh: 0,
  heading: null,
  limit: null,        // geldende maximumsnelheid (km/u) of null
  limitCand: undefined,
  following: true,
  zoom: 16,
  pitch: 30,          // kanteling van de kaart; met twee vingers aan te passen
  barOn: false,       // kleurbalk zichtbaar; pas na de eerste keer harder dan 10 km/u
  concept: null,      // getoonde route vanaf een ander vertrekpunt: { nav, origin, dest, mode }
  nav: null,          // actieve route
  dest: null,
  lastRouteAt: 0,
  routing: false,
};

// ---------- Geo-hulpfuncties (coördinaten als [lon, lat]) ----------
const R = 6371000;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

function dist(a, b) {
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2));
  const y = rad(b[1] - a[1]);
  return Math.sqrt(x * x + y * y) * R;
}

function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function projectOnSegment(p, a, b) {
  const kx = Math.cos(rad(p[1])) * R * Math.PI / 180, ky = R * Math.PI / 180;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { t, d: Math.hypot(ax + t * dx, ay + t * dy), pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    const vals = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, byte;
      do { byte = str.charCodeAt(i++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
      vals.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += vals[0]; lon += vals[1];
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

// ---------- Opmaak van getallen ----------
function fmtDist(m) {
  if (m >= 1000) return (m >= 10000 ? Math.round(m / 1000) : (Math.round(m / 100) / 10).toString().replace('.', ',')) + ' km';
  if (m >= 100) return Math.round(m / 50) * 50 + ' m';
  return Math.max(10, Math.round(m / 10) * 10) + ' m';
}

function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' u ' + (min % 60) + ' min';
}

function fmtClock(date) {
  return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Kaart ----------
// Donkere kaart: de standaard 'dark'-stijl is bijna zwart. Deze kleuren maken hem
// iets lichter, met beter zichtbare straten, groene parken en blauwig water.
const DARK_BG = '#23262B';
const DARK_PAINT = {
  background: { 'background-color': DARK_BG },
  landuse_residential: { 'fill-color': '#272A30' },
  water: { 'fill-color': '#1E3550' },
  waterway: { 'line-color': '#1E3550' },
  landcover_wood: { 'fill-color': '#2F5E3E' },
  landuse_park: { 'fill-color': '#2F5E3E' },
  landcover_ice_shelf: { 'fill-color': DARK_BG },
  building: { 'fill-color': '#30333A', 'fill-outline-color': '#3A3E46' },
  'aeroway-area': { 'fill-color': '#2B2E34' },
  'aeroway-runway': { 'line-color': '#3A3E46' },
  road_area_pier: { 'fill-color': DARK_BG },
  road_pier: { 'line-color': DARK_BG },
  highway_path: { 'line-color': '#3A3E46' },
  highway_minor: { 'line-color': '#474B54' },
  highway_major_casing: { 'line-color': '#2A2D33' },
  highway_major_inner: { 'line-color': '#5A5F69' },
  highway_major_subtle: { 'line-color': '#4A4E57' },
  highway_motorway_casing: { 'line-color': '#2A2D33' },
  highway_motorway_inner: { 'line-color': '#6E737D' },
  highway_motorway_subtle: { 'line-color': '#4A4E57' },
  railway_transit: { 'line-color': '#3D4048' },
  railway_minor: { 'line-color': '#3D4048' },
  railway: { 'line-color': '#3D4048' },
  railway_transit_dashline: { 'line-color': DARK_BG },
  railway_minor_dashline: { 'line-color': DARK_BG },
  railway_dashline: { 'line-color': DARK_BG },
  water_name: { 'text-color': '#7193B8', 'text-halo-color': '#1E3550' },
  highway_name_other: { 'text-color': '#A6AAB2', 'text-halo-color': DARK_BG },
  highway_name_motorway: { 'text-color': '#B4B8C0' },
};
const PLACEHOLDER_DARK = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': DARK_BG } }] };

let darkStyleCache = null;
async function darkStyle() {
  if (darkStyleCache) return darkStyleCache;
  const style = await (await fetch(STYLES.dark)).json();
  for (const layer of style.layers) {
    const paint = DARK_PAINT[layer.id];
    if (paint) layer.paint = { ...layer.paint, ...paint };
    if (layer.id.startsWith('place_')) layer.paint = { ...layer.paint, 'text-color': '#B9BCC3', 'text-halo-color': 'rgba(35,38,43,0.85)' };
  }
  // Bos staat standaard als donker patroon op 40% dekking; vervang door egaal groen
  const wood = style.layers.find(l => l.id === 'landcover_wood');
  if (wood) {
    delete wood.paint['fill-pattern'];
    wood.paint['fill-opacity'] = 0.9;
    // Gras en stadsparken tekent de donkere stijl niet; voeg ze toe onder de wegen
    const at = style.layers.indexOf(wood) + 1;
    style.layers.splice(at, 0,
      { id: 'landcover_grass', type: 'fill', source: wood.source, 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'grass'], paint: { 'fill-color': '#2A5436', 'fill-opacity': 0.85 } },
      { id: 'park_area', type: 'fill', source: wood.source, 'source-layer': 'park',
        paint: { 'fill-color': '#2F5E3E', 'fill-opacity': 0.75 } });
  }
  darkStyleCache = style;
  return style;
}
// Lichte kaart: net als in dark mode wat meer kleur in water en groen
const LIGHT_PAINT = {
  water: { 'fill-color': '#BDD1DE' },
  waterway: { 'line-color': '#BDD1DE' },
  park: { 'fill-color': '#DDE9D7' },
  landcover_wood: { 'fill-color': '#D3E4CE' },
};
const PLACEHOLDER_LIGHT = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#F2F3F0' } }] };

let lightStyleCache = null;
async function lightStyle() {
  if (lightStyleCache) return lightStyleCache;
  const style = await (await fetch(STYLES.light)).json();
  for (const layer of style.layers) {
    const paint = LIGHT_PAINT[layer.id];
    if (paint) layer.paint = { ...layer.paint, ...paint };
  }
  // Gras tekent de lichte stijl niet; voeg het toe boven het bos
  const wood = style.layers.find(l => l.id === 'landcover_wood');
  if (wood) {
    style.layers.splice(style.layers.indexOf(wood) + 1, 0,
      { id: 'landcover_grass', type: 'fill', source: wood.source, 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'grass'], paint: { 'fill-color': '#DDE9D7', 'fill-opacity': 0.9 } });
  }
  lightStyleCache = style;
  return style;
}

// ---------- Kaartsoort: 3D (standaard), plat of luchtfoto ----------
const MAP_KINDS = ['standard', 'terrain', 'satellite'];
let mapKind = 'standard';
try { if (MAP_KINDS.includes(localStorage.getItem('mapKind'))) mapKind = localStorage.getItem('mapKind'); } catch (e) { /* geen opslag */ }

// Hoogtedata (Mapzen/AWS, gratis, wereldwijd) voor reliëf en 3D
const DEM = { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium', tileSize: 256, maxzoom: 14 };
// Luchtfoto van PDOK: open data, alleen Nederland
const PHOTO = { type: 'raster', tiles: ['https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg'],
  tileSize: 256, maxzoom: 19, bounds: [3.2, 50.7, 7.3, 53.6] };
// Gemarkeerde wandelroutes van Waymarked Trails, per soort met een eigen kleur.
// Lopen ze over hetzelfde pad, dan liggen de lijnen naast elkaar.
const TRAIL_TYPES = [
  { key: 'INT', label: 'Internationaal', sub: 'E-paden', color: '#D7263D', offset: -4.5 },
  { key: 'NAT', label: 'Nationaal', sub: 'LAW, GR', color: '#2B6CD9', offset: -1.5 },
  { key: 'REG', label: 'Regionaal', sub: 'streekpaden', color: '#F08C00', offset: 1.5 },
  { key: 'LOC', label: 'Lokaal', sub: 'rondwandelingen', color: '#9B4DCA', offset: 4.5 },
];
let trailOff = [];
try { trailOff = JSON.parse(localStorage.getItem('trailOff')) || []; } catch (e) { /* geen opslag */ }
const trailFilter = () => ['!', ['in', ['get', 'g'], ['literal', trailOff]]];
const byTrailType = prop => ['match', ['get', 'g'], ...TRAIL_TYPES.flatMap(t => [t.key, t[prop]]), 0];

function styleFor(base, kind, dark) {
  const style = { ...base, sources: { ...base.sources }, layers: [...base.layers] };
  const at = id => style.layers.findIndex(l => l.id === id);
  if (kind === 'terrain') {
    // Schaduw boven bos en gras, onder water en wegen; de bergen staan rechtop als je kantelt
    style.sources.dem = DEM;
    style.layers.splice(at('waterway'), 0, { id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: dark
        ? { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#4A4F58', 'hillshade-accent-color': '#15171A' }
        : { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': '#5A6B78', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#8A9A8A' } });
    style.terrain = { source: 'dem', exaggeration: 1.2 };
    style.layers.push({ id: 'peaks', type: 'symbol', source: 'openmaptiles', 'source-layer': 'mountain_peak', minzoom: 10,
      filter: ['has', 'name'],
      layout: { 'text-field': ['format', '▲\n', { 'font-scale': 0.8 }, ['get', 'name'], {},
        ['case', ['has', 'ele'], ['concat', '\n', ['to-string', ['get', 'ele']], ' m'], ''], { 'font-scale': 0.85 }],
        'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, -0.6],
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]] },
      paint: dark
        ? { 'text-color': '#D9B48F', 'text-halo-color': 'rgba(35,38,43,0.9)', 'text-halo-width': 1.5 }
        : { 'text-color': '#6B3E1F', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
  }
  if (kind === 'satellite') {
    // Foto boven vlakken en gebouwen; buiten Nederland blijft de gewone kaart zichtbaar.
    // Wegen dun en doorzichtig erover, namen wit met een donkere rand.
    const i = at('aeroway-taxiway');
    style.sources.photo = PHOTO;
    style.layers = style.layers.map((l, j) => {
      if (j < i) return l;
      if (l.type === 'line') return { ...l, paint: { ...l.paint, 'line-opacity': /casing/.test(l.id) ? 0 : 0.35 } };
      if (l.type === 'symbol') return { ...l, paint: { ...l.paint, 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-halo-width': 1.5 } };
      return l;
    });
    style.layers.splice(i, 0, { id: 'photo', type: 'raster', source: 'photo' });
  }
  // Wandelroutes: alleen zichtbaar bij Lopen en flink ingezoomd (zie updateTrails)
  style.sources.trails = { type: 'geojson', data: EMPTY_FC };
  const color = ['match', ['get', 'g'], ...TRAIL_TYPES.flatMap(t => [t.key, t.color]), '#888'];
  style.layers.splice(style.layers.findIndex(l => l.type === 'symbol'), 0,
    { id: 'trails', type: 'line', source: 'trails', filter: trailFilter(), layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': 3, 'line-opacity': 0.9, 'line-offset': byTrailType('offset') } });
  style.layers.push({ id: 'trails-label', type: 'symbol', source: 'trails', filter: ['all', trailFilter(), ['!=', ['get', 'ref'], '']],
    layout: { visibility: 'none', 'symbol-placement': 'line', 'symbol-spacing': 280, 'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, -0.9] },
    paint: { 'text-color': color, 'text-halo-color': dark ? DARK_BG : '#ffffff', 'text-halo-width': 2 } });
  return style;
}

// Breedte van het kaartbeeld in meters
function viewWidth(m) {
  const lat = m.getCenter().lat;
  return 40075016.686 * Math.cos(rad(lat)) / (512 * 2 ** m.getZoom()) * m.getContainer().clientWidth;
}

// De routes komen als kaarttegels van zoomniveau 12 (circa 10 km breed), in webmercator
const WMT = 'https://hiking.waymarkedtrails.org/api/v1';
const TRAIL_Z = 12;
const toMerc = (lon, lat) => [lon * 20037508.34 / 180, Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2)) * 6378137];
const fromMerc = ([x, y]) => [x / 20037508.34 * 180, deg(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2)];
const tileX = lon => Math.floor((lon + 180) / 360 * 2 ** TRAIL_Z);
const tileY = lat => Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** TRAIL_Z);
const tileLat = y => deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** TRAIL_Z))));
const tileLon = x => x / 2 ** TRAIL_Z * 360 - 180;

// Routes in een gebied, belangrijkste eerst (internationaal, nationaal, regionaal, lokaal)
async function trailRoutes(w, s, e, n) {
  const bbox = [...toMerc(w, s), ...toMerc(e, n)].map(Math.round).join(',');
  return (await (await fetch(`${WMT}/list/by_area?bbox=${bbox}&limit=100`)).json()).results || [];
}

const trailTiles = new Map();
function loadTrailTile(x, y) {
  const key = x + '/' + y;
  if (!trailTiles.has(key)) {
    const p = (async () => {
      const [tile, routes] = await Promise.all([
        fetch(`${WMT}/tiles/${TRAIL_Z}/${x}/${y}.json`).then(r => r.json()),
        trailRoutes(tileLon(x), tileLat(y + 1), tileLon(x + 1), tileLat(y)).catch(() => []),
      ]);
      const info = new Map(routes.map(r => [r.id, r]));
      const out = [];
      for (const f of tile.features) {
        if (f.properties.type !== 'way' || !f.geometry) continue;
        const g = f.geometry;
        const coordinates = g.type === 'LineString' ? g.coordinates.map(fromMerc) : g.coordinates.map(l => l.map(fromMerc));
        const groups = new Set((f.properties.shields || []).map(sh => sh.split('_')[1]));
        const rels = (f.properties.top_relations || []).map(id => info.get(id)).filter(Boolean);
        for (const t of TRAIL_TYPES) {
          if (!groups.has(t.key)) continue;
          // Naam alleen bij de grotere routes; lokale rondjes zouden de kaart volschrijven
          const ref = t.key === 'LOC' ? '' : [...new Set(rels.filter(r => r.group === t.key).map(r => r.ref || r.name))].join(' · ');
          out.push({ type: 'Feature', geometry: { type: g.type, coordinates }, properties: { g: t.key, ref } });
        }
      }
      return out;
    })();
    p.catch(() => trailTiles.delete(key));
    trailTiles.set(key, p);
  }
  return trailTiles.get(key);
}

async function updateTrails(m) {
  if (!m || !m.getLayer('trails')) return;
  const show = travelMode === 'pedestrian' && viewWidth(m) <= 1000 ? 'visible' : 'none';
  for (const id of ['trails', 'trails-label']) {
    if (m.getLayoutProperty(id, 'visibility') !== show) m.setLayoutProperty(id, 'visibility', show);
  }
  if (show === 'none') return;
  const b = m.getBounds();
  const keys = [];
  for (let x = tileX(b.getWest()); x <= tileX(b.getEast()); x++) {
    for (let y = tileY(b.getNorth()); y <= tileY(b.getSouth()); y++) keys.push([x, y]);
  }
  // Alleen opnieuw tekenen als er andere tegels in beeld komen (de kaart beweegt elke seconde mee)
  const key = keys.join(';');
  if (m._trailKey === key) return;
  m._trailKey = key;
  let failed = false;
  const features = (await Promise.all(keys.map(([x, y]) => loadTrailTile(x, y).catch(() => { failed = true; return []; })))).flat();
  if (failed && m._trailKey === key) m._trailKey = null;  // volgende beweging probeert het opnieuw
  const src = m.getSource('trails');
  if (src && m._trailKey === key) src.setData({ type: 'FeatureCollection', features });
}

function watchTrails(m) {
  m.on('style.load', () => { m._trailKey = null; updateTrails(m); });
  m.on('moveend', () => updateTrails(m));
}

// Soorten wandelroutes aan of uit; geldt voor alle kaarten
function setTrailType(key, on) {
  trailOff = on ? trailOff.filter(k => k !== key) : [...new Set([...trailOff, key])];
  try { localStorage.setItem('trailOff', JSON.stringify(trailOff)); } catch (e) { /* geen opslag */ }
  for (const m of [map, pmap, pickmap]) {
    if (!m || !m.getLayer('trails')) continue;
    m.setFilter('trails', trailFilter());
    m.setFilter('trails-label', ['all', trailFilter(), ['!=', ['get', 'ref'], '']]);
  }
}

// Publieke gebouwen iets donkerder. De kaartdata zegt niet wat voor gebouw iets is,
// dus zoeken we de gebouwen waar een kerk, museum, gemeentehuis enz. in ligt.
const PUBLIC_POI = new Set(['place_of_worship', 'museum', 'town_hall', 'library', 'theatre', 'cinema', 'art_gallery',
  'hospital', 'college', 'school', 'police', 'fire_station', 'post', 'castle']);
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function findPublicBuildings(m) {
  const src = m.getSource('public');
  if (!src || !m.getSource('openmaptiles')) return;
  const pois = m.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' })
    .filter(f => f.geometry.type === 'Point' && PUBLIC_POI.has(f.properties.class))
    .map(f => f.geometry.coordinates);
  const out = [];
  if (pois.length) {
    for (const b of m.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })) {
      const g = b.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const ring = poly[0];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (pois.some(p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inRing(p, ring))) {
          out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: {} });
        }
      }
    }
  }
  src.setData({ type: 'FeatureCollection', features: out });
}

function addPublicLayer(m) {
  if (!m.getLayer('building')) return;
  const dark = theme() === 'dark';
  const layers = m.getStyle().layers;
  const next = layers[layers.findIndex(l => l.id === 'building') + 1];
  m.addSource('public', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'public-building', type: 'fill', source: 'public',
    paint: { 'fill-color': dark ? '#3B3F47' : '#D9D8D0', 'fill-outline-color': dark ? '#474B54' : '#C9C8C0' } }, next && next.id);
  findPublicBuildings(m);
}

// Opnieuw zoeken zodra er nieuwe kaarttegels binnen zijn
function watchPublicBuildings(m) {
  let timer;
  m.on('style.load', () => addPublicLayer(m));
  m.on('sourcedata', e => {
    if (e.sourceId !== 'openmaptiles' || !e.tile) return;
    clearTimeout(timer);
    timer = setTimeout(() => findPublicBuildings(m), 400);
  });
}

// Kaart half gekanteld: 50% van de maximale kanteling (60°) geeft wat perspectief
const PITCH = 30;
const map = new maplibregl.Map({
  container: 'map',
  style: theme() === 'dark' ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT,
  center: [5.1214, 52.0907],
  zoom: 15,
  pitch: PITCH,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
// Twee vingers: samen omhoog of omlaag schuiven kantelt, tegen elkaar in draaien roteert.
// De gekozen kanteling blijft staan, ook als de kaart je weer volgt.
map.on('pitchend', e => { if (e.originalEvent) state.pitch = map.getPitch(); });
watchPublicBuildings(map);
watchTrails(map);

const markerEl = document.createElement('div');
markerEl.className = 'car marker';
markerEl.innerHTML = '<div><div></div></div>';
const marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map' });

let routeCoords = [];
const lineFeature = coords => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

function addRouteLayers(m, coords) {
  const dark = theme() === 'dark';
  m.addSource('route', { type: 'geojson', data: lineFeature(coords) });
  m.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 13 } });
  m.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#3D8BFF' : '#1F6FE0', 'line-width': 8 } });
}

// Conceptroute (vertrek niet vanaf je eigen positie): gestippeld, met blauw begin en rood eind
function addConceptLayers(m) {
  const dark = theme() === 'dark';
  m.addSource('concept', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'concept-line', type: 'line', source: 'concept', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#3D8BFF' : '#1F6FE0', 'line-width': 8, 'line-dasharray': [0, 2] } });
  m.addLayer({ id: 'concept-ends', type: 'circle', source: 'concept', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': ['match', ['get', 'kind'], 'start', 13, 10], 'circle-stroke-width': 4, 'circle-stroke-color': '#ffffff',
      'circle-color': ['match', ['get', 'kind'], 'start', dark ? '#3D8BFF' : '#1F6FE0', '#E5484D'],
      'circle-pitch-alignment': 'map' } });
  drawConcept();
}

// Wordt ook opnieuw aangeroepen na een wissel tussen licht en donker
map.on('style.load', () => { addRouteLayers(map, routeCoords); addConceptLayers(map); });

async function currentStyle() {
  const dark = theme() === 'dark';
  return styleFor(await (dark ? darkStyle() : lightStyle()), mapKind, dark);
}

function setMapKind(kind) {
  mapKind = kind;
  try { localStorage.setItem('mapKind', kind); } catch (e) { /* geen opslag */ }
  applyTheme();
}

async function applyTheme() {
  const style = await currentStyle();
  map.setStyle(style, { diff: false });
  if (pmap) pmap.setStyle(style, { diff: false });
  if (pickmap) pickmap.setStyle(style, { diff: false });
  renderBar();
}
darkQuery.addEventListener('change', applyTheme);
applyTheme();

function setRouteLine(coords) {
  routeCoords = coords;
  const src = map.getSource('route');
  if (src) src.setData(lineFeature(coords));
}

function stopFollowing() {
  if (!state.following) return;
  state.following = false;
  $('car').hidden = true;
  $('recenter').hidden = false;
  if (state.fix) marker.setLngLat([state.fix.lon, state.fix.lat]).setRotation(state.heading || 0).addTo(map);
}

map.on('dragstart', e => { if (e.originalEvent) stopFollowing(); });
map.on('zoomstart', e => { if (e.originalEvent) stopFollowing(); });
map.on('rotatestart', e => { if (e.originalEvent) stopFollowing(); });

function follow() {
  state.following = true;
  $('car').hidden = false;
  $('recenter').hidden = true;
  marker.remove();
  if (state.fix) updateCamera([state.fix.lon, state.fix.lat], 600);
}
$('recenter').addEventListener('click', follow);

function targetZoom(kmh) {
  if (kmh < 25) return 17;
  if (kmh < 55) return 16.3;
  if (kmh < 85) return 15.6;
  if (kmh < 110) return 15;
  return 14.5;
}

function updateCamera(p, duration = 1000) {
  if (!state.following) {
    marker.setLngLat(p).setRotation(state.heading || 0);
    return;
  }
  state.zoom += (targetZoom(state.speedKmh) - state.zoom) * 0.25;
  const h = map.getContainer().clientHeight;
  map.easeTo({
    center: p,
    // Rijrichting boven; zonder bekende richting terug naar het noorden
    bearing: state.heading ?? 0,
    zoom: state.zoom,
    pitch: state.pitch,
    padding: { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 },
    duration,
    easing: t => t,
  });
}

// ---------- Kleurbalk ----------
let lastTheme = '';
function renderBar() {
  const bar = $('bar'), lim = $('lim');
  // Pas tonen na de eerste keer harder dan 10 km/u; daarna blijft hij de hele rit staan
  if (state.speedKmh > 10) state.barOn = true;
  document.body.classList.toggle('nobar', !state.barOn);
  $('spd').textContent = state.fix ? Math.round(state.speedKmh) : '–';
  $('destlbl').hidden = state.speedKmh > 10;
  let bg = '#48484A', fg = '#fff';
  if (state.limit) {
    const c = scaleColor(state.speedKmh, state.limit);
    bg = `rgb(${c})`;
    fg = luminance(c) > 0.35 ? '#111' : '#fff';
    lim.textContent = state.limit;
    lim.hidden = false;
  } else {
    lim.hidden = true;
  }
  bar.style.background = bg;
  bar.style.color = fg;
  if (bg !== lastTheme) {
    document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
    lastTheme = bg;
  }
}

// ---------- Huidige weg linksboven: A-, N- en E-nummers als bordje ----------
const REF_ORDER = { a: 0, n: 1, e: 2 };
function refOf(name) {
  const m = name.trim().match(/^([AEN])\s?(\d+)$/i);
  return m && { cls: m[1].toLowerCase(), text: m[1].toUpperCase() + m[2] };
}
function roadParts(names) {
  const refs = [];
  for (const n of names || []) {
    const r = refOf(n);
    if (r && !refs.some(x => x.text === r.text)) refs.push(r);
  }
  refs.sort((x, y) => REF_ORDER[x.cls] - REF_ORDER[y.cls]);
  return refs.slice(0, 3);
}

function refSpan(p) {
  const span = document.createElement('span');
  span.className = 'ref ' + p.cls;
  span.textContent = p.text;
  return span;
}

let roadKey = null, roadCand;
let lastE = { road: null, refs: [] };

// Op korte stukken snelweg ontbreekt het E-nummer soms in de kaartgegevens;
// zolang je op dezelfde A-weg blijft, blijft het laatst bekende E-nummer staan.
function withStickyE(parts) {
  const main = parts.find(p => p.cls === 'a');
  if (!main) return parts;
  const es = parts.filter(p => p.cls === 'e');
  if (es.length) { lastE = { road: main.text, refs: es }; return parts; }
  return main.text === lastE.road ? [...parts, ...lastE.refs].slice(0, 3) : parts;
}

function acceptRoad(names) {
  const parts = withStickyE(roadParts(names));
  const key = parts.map(p => p.text).join('|');
  // Net als bij de limiet: pas wisselen als dezelfde weg twee keer terugkomt
  if (key === roadKey) { roadCand = undefined; return; }
  if (roadKey === null || roadCand === key) {
    roadKey = key;
    roadCand = undefined;
    const el = $('road');
    el.replaceChildren(...parts.map(refSpan));
  } else {
    roadCand = key;
  }
}

// ---------- Maximumsnelheid via Valhalla /locate ----------
let limitBusy = false, lastLimitAt = 0, lastLimitPos = null;

function acceptLimit(v) {
  // Een nieuwe waarde pas overnemen als hij twee keer achter elkaar terugkomt (voorkomt flikkeren op kruispunten)
  if (v === state.limit) { state.limitCand = undefined; return; }
  if (state.limit == null && v != null || state.limitCand === v) {
    state.limit = v;
    state.limitCand = undefined;
    renderBar();
  } else {
    state.limitCand = v;
  }
}

async function maybeFetchLimit(p) {
  const now = Date.now();
  if (limitBusy) return;
  if (lastLimitPos && now - lastLimitAt < 2500) return;
  if (lastLimitPos && dist(lastLimitPos, p) < 15 && now - lastLimitAt < 20000) return;
  limitBusy = true;
  lastLimitAt = now;
  lastLimitPos = p;
  try {
    const loc = { lat: p[1], lon: p[0], radius: 30 };
    if (state.heading != null && state.speedKmh > 8) { loc.heading = Math.round(state.heading); loc.heading_tolerance = 45; }
    const q = { locations: [loc], costing: 'auto', verbose: true };
    const res = await fetch(`${VALHALLA}/locate?json=${encodeURIComponent(JSON.stringify(q))}`);
    const data = await res.json();
    const edges = (data[0] && data[0].edges) || [];
    edges.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    const e = edges[0];
    const sl = e && e.edge_info && e.edge_info.speed_limit;
    acceptLimit(typeof sl === 'number' && sl > 0 && sl < 200 ? sl : null);
    acceptRoad(e && e.edge_info ? e.edge_info.names : null);
  } catch (err) {
    // Netwerkfout: laatste bekende limiet blijft staan
  } finally {
    limitBusy = false;
  }
}

// ---------- GPS ----------
function onFix(f) {
  const p = [f.lon, f.lat];
  const prev = state.fix;
  let sp = f.speed;
  if ((sp == null || sp < 0 || Number.isNaN(sp)) && prev) {
    const dt = (f.t - prev.t) / 1000;
    if (dt > 0.5) sp = dist([prev.lon, prev.lat], p) / dt;
  }
  if (sp == null || sp < 0 || Number.isNaN(sp)) sp = 0;
  state.speedKmh = sp * 3.6 < 2 ? 0 : sp * 3.6;

  let hd = (f.heading != null && !Number.isNaN(f.heading) && f.heading >= 0 && sp > 1.5) ? f.heading : null;
  if (hd == null && prev && sp > 1.5 && dist([prev.lon, prev.lat], p) > 8) hd = bearing([prev.lon, prev.lat], p);
  if (hd != null) state.heading = hd;

  const first = !prev;
  state.fix = f;
  $('gps').textContent = `GPS ±${Math.round(f.acc)} m`;
  renderBar();
  updateNav(p);
  updateCamera(p, first ? 0 : 1000);
  maybeFetchLimit(p);
}

function startGps() {
  if (DEMO) { startDemo(); return; }
  if (!navigator.geolocation) { toast('Dit toestel geeft geen GPS-positie door.'); return; }
  navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    onFix({ lat: c.latitude, lon: c.longitude, speed: c.speed, heading: c.heading, acc: c.accuracy, t: pos.timestamp || Date.now() });
  }, err => {
    if (err.code === 1) toast('Locatietoegang geweigerd. Sta locatie toe voor Safari in Instellingen › Privacy › Locatievoorzieningen.', 8000);
    else toast('GPS-fout: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

// Scherm aan houden
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* niet ondersteund */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.started) requestWakeLock();
});

$('startbtn').addEventListener('click', () => {
  state.started = true;
  $('start').hidden = true;
  requestWakeLock();
  startGps();
});

// ---------- Bestemming kiezen (Photon) ----------
let searchTimer, searchSeq = 0;
let pending = null;      // gekozen bestemming, wordt pas gestart met het vinkje
let streetCtx = null;    // gekozen straat zonder huisnummer: { street, city }
let firstResult = null;  // bovenste zoekresultaat, voor Enter
let firstRecent = null;  // bovenste passende recente bestemming, gaat voor bij Enter
let modeAtOpen = 'auto';
let origin = null;       // gekozen vertrekpunt; null = huidige locatie
let activeField = 'to';  // welk veld de lijsten en suggesties vult: 'to' (Naar) of 'from' (Van)
const field = () => $(activeField === 'from' ? 'qfrom' : 'q');
function setField(which) {
  activeField = which;
  $('search').dataset.field = which;
}

// Een gekozen plek gaat naar het veld waar je in zit
function useChoice(d, note) {
  if (activeField === 'from') {
    origin = d;
    if (pending) showPreview(pending, note); else showRecent();
  } else {
    showPreview(d, note);
  }
}
const MODE_LABEL = { auto: 'auto', bicycle: 'fiets', pedestrian: 'lopen' };

let travelMode = 'auto';
try { travelMode = localStorage.getItem('travelMode') || 'auto'; } catch (e) { /* geen opslag */ }

function setTravelMode(mode) {
  travelMode = mode;
  try { localStorage.setItem('travelMode', mode); } catch (e) { /* geen opslag */ }
  document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  for (const m of [map, pmap, pickmap]) updateTrails(m);
}

// Laatst gekozen bestemmingen, per toestel bewaard
function loadRecent() {
  try { return JSON.parse(localStorage.getItem('recent') || '[]'); } catch (e) { return []; }
}
function saveRecent(dest) {
  const list = [dest, ...loadRecent().filter(d => d.name !== dest.name)].slice(0, 30);
  try { localStorage.setItem('recent', JSON.stringify(list)); } catch (e) { /* geen opslag */ }
}

// Favorieten: met het sterretje gemarkeerde bestemmingen, in eigen volgorde
function loadFavs() {
  try { return JSON.parse(localStorage.getItem('favorites') || '[]'); } catch (e) { return []; }
}
function saveFavs(list) {
  try { localStorage.setItem('favorites', JSON.stringify(list)); } catch (e) { /* geen opslag */ }
}
const isFav = d => loadFavs().some(f => f.name === d.name);
const favLabel = d => d.label || (loadFavs().find(f => f.name === d.name) || {}).label || '';
function renameFav(d, label) {
  saveFavs(loadFavs().map(f => (f.name === d.name ? { ...f, label: label.trim() || undefined } : f)));
}
function deleteRecent(d) {
  try { localStorage.setItem('recent', JSON.stringify(loadRecent().filter(r => r.name !== d.name))); } catch (e) { /* geen opslag */ }
}

// Routes met een eigen vertrekpunt, bewaard zodra je ze een keer live bekeken hebt
const routeKey = r => r.from.name + '|' + r.to.name;
function loadRoutes() {
  try { return JSON.parse(localStorage.getItem('routes') || '[]'); } catch (e) { return []; }
}
function saveRoutes(list) {
  try { localStorage.setItem('routes', JSON.stringify(list)); } catch (e) { /* geen opslag */ }
}
function saveRoute(from, to, mode) {
  const place = d => ({ lat: d.lat, lon: d.lon, name: d.name });
  const item = { from: place(from), to: place(to), mode };
  saveRoutes([item, ...loadRoutes().filter(r => routeKey(r) !== routeKey(item))].slice(0, 30));
}

// Naar links vegen over een regel: verwijderen of hernoemen. De regel schuift opzij
// en laat de actie eronder zien; voorbij 80 px gaat de actie door.
function swipeable(li, action, onSwipe) {
  const row = li.firstElementChild;
  li.dataset.action = action;
  let start = null, dx = 0, active = false;
  li.addEventListener('pointerdown', e => {
    if (e.target.closest('.grip, input, .renok') || li.classList.contains('editing')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dx = 0;
    active = false;
  });
  li.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x, my = e.clientY - start.y;
    if (!active) {
      if (Math.abs(my) > 10) { start = null; return; }
      if (mx > -10) return;
      active = true;
      li.classList.add('swiping');
      li.setPointerCapture(e.pointerId);
      row.style.transition = 'none';
    }
    dx = Math.min(0, mx);
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = e => {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    if (!active) return;
    // De klik die na het loslaten volgt mag de regel niet kiezen
    li.dataset.swiped = '1';
    setTimeout(() => delete li.dataset.swiped, 300);
    row.style.transition = '';
    if (dx < -80) onSwipe();
    else {
      row.style.transform = '';
      setTimeout(() => li.classList.remove('swiping'), 200);
    }
  };
  li.addEventListener('pointerup', end);
  li.addEventListener('pointercancel', end);
}

function swipeAway(li, then) {
  li.firstElementChild.style.transform = 'translateX(-100%)';
  setTimeout(then, 200);
}

// Hernoemen: tekstveld met bevestigknop op de regel zelf
function editLabel(li, d) {
  const row = li.firstElementChild;
  row.style.transform = '';
  li.classList.remove('swiping');
  li.classList.add('editing');
  const text = row.querySelector('.rtext');
  text.innerHTML = '<input class="rename" type="text" enterkeyhint="done" aria-label="Naam van deze favoriet">';
  const input = text.querySelector('input');
  input.value = favLabel(d) || d.name.split(', ')[0];
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'renok';
  ok.setAttribute('aria-label', 'Naam bewaren');
  ok.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
  row.querySelector('.star').replaceWith(ok);
  const save = () => { renameFav(d, input.value); showRecent(); };
  ok.addEventListener('click', e => { e.stopPropagation(); save(); });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') showRecent();
  });
  input.focus();
  input.select();
}
function toggleFav(d) {
  const favs = loadFavs();
  saveFavs(isFav(d) ? favs.filter(f => f.name !== d.name) : [...favs, { lat: d.lat, lon: d.lon, name: d.name }]);
}

// Een regel in de lijst: klik kiest de bestemming, het sterretje maakt hem (geen) favoriet,
// in de favorietenlijst zit links een greep om te slepen.
function recentItem(d, { star = false, handle = false } = {}) {
  // Met een eigen naam staat die bovenaan en het hele adres eronder
  const label = favLabel(d);
  const [first, ...rest] = label ? [label, d.name] : d.name.split(', ');
  const li = document.createElement('li');
  li.className = 'recent';
  const fav = isFav(d);
  li.innerHTML = '<div class="row">' + (handle ? '<span class="grip" aria-label="Verslepen"><i class="ti ti-grip-vertical" aria-hidden="true"></i></span>'
    : `<i class="ti ${fav && !star ? 'ti-star' : 'ti-history'}" aria-hidden="true"></i>`)
    + '<div class="rtext"><div class="r1"></div><div class="r2"></div></div></div>';
  li.querySelector('.r1').textContent = first;
  li.querySelector('.r2').textContent = rest.join(', ');
  li.addEventListener('click', () => { if (!li.dataset.swiped && !li.classList.contains('editing')) chooseRecent(d); });
  if (star) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'star' + (fav ? ' on' : '');
    btn.setAttribute('aria-label', fav ? 'Uit favorieten halen' : 'Favoriet maken');
    btn.setAttribute('aria-pressed', String(fav));
    btn.innerHTML = `<i class="ti ${fav ? 'ti-star-filled' : 'ti-star'}" aria-hidden="true"></i>`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleFav(d);
      showRecent();
    });
    li.firstElementChild.appendChild(btn);
  }
  if (handle) makeDraggable(li, li.querySelector('.grip'));
  li.dataset.name = d.name;
  return li;
}

// Favorieten sorteren door aan de greep te slepen (werkt met vinger en muis).
// Luistert op window: een verplaatst element verliest anders zijn pointer.
function makeDraggable(li, grip) {
  grip.addEventListener('click', e => e.stopPropagation());
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    const ul = li.parentElement;
    const id = e.pointerId;
    li.classList.add('dragging');
    let startY = e.clientY;
    const centre = el => el.getBoundingClientRect().top + el.offsetHeight / 2;
    const shift = (ev, swap) => {
      const before = li.getBoundingClientRect().top - (ev.clientY - startY);
      swap();
      li.style.transform = '';
      startY += li.getBoundingClientRect().top - before;
      li.style.transform = `translateY(${ev.clientY - startY}px)`;
    };
    const move = ev => {
      if (ev.pointerId !== id) return;
      ev.preventDefault();
      li.style.transform = `translateY(${ev.clientY - startY}px)`;
      for (let guard = 0; guard < 50; guard++) {
        const prev = li.previousElementSibling, next = li.nextElementSibling;
        if (prev && centre(li) < centre(prev)) shift(ev, () => ul.insertBefore(li, prev));
        else if (next && centre(li) > centre(next)) shift(ev, () => ul.insertBefore(next, li));
        else break;
      }
    };
    const up = ev => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      li.classList.remove('dragging');
      li.style.transform = '';
      const byName = new Map(loadFavs().map(f => [f.name, f]));
      li.dataset.swiped = '1';
      setTimeout(() => delete li.dataset.swiped, 300);
      saveFavs([...ul.querySelectorAll('li[data-name]')].map(el => byName.get(el.dataset.name)).filter(Boolean));
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function chooseRecent(d) {
  streetCtx = null;
  field().value = d.name;
  field().blur();
  updateClear();
  useChoice(d);
}

// Bovenaan de lijst voor het Van-veld: terug naar vertrekken vanaf je eigen positie
function hereItem() {
  const li = document.createElement('li');
  li.className = 'recent here';
  li.innerHTML = '<div class="row"><i class="ti ti-current-location" aria-hidden="true"></i><div class="rtext"><div class="r1">Huidige locatie</div></div></div>';
  li.addEventListener('click', () => {
    $('qfrom').value = '';
    $('qfrom').blur();
    updateClear();
    origin = null;
    if (pending) showPreview(pending);
  });
  return li;
}

// Bewaarde route: openen toont het overzicht met Van en Naar ingevuld
function routeItem(r) {
  const li = document.createElement('li');
  li.className = 'recent';
  li.innerHTML = '<div class="row"><i class="ti ti-route" aria-hidden="true"></i><div class="rtext"><div class="r1"></div><div class="r2"></div></div></div>';
  const short = d => favLabel(d) || d.name.split(', ')[0];
  li.querySelector('.r1').textContent = `${short(r.from)} → ${short(r.to)}`;
  li.querySelector('.r2').textContent = MODE_LABEL[r.mode] || '';
  li.addEventListener('click', () => { if (!li.dataset.swiped) openRoute(r); });
  swipeable(li, 'Verwijderen', () => swipeAway(li, () => {
    saveRoutes(loadRoutes().filter(x => routeKey(x) !== routeKey(r)));
    showRecent();
  }));
  return li;
}

function showFrom() {
  $('fromwrap').hidden = false;
  $('swap').hidden = false;
}

function openRoute(r) {
  origin = r.from;
  $('qfrom').value = r.from.name;
  $('q').value = r.to.name;
  showFrom();
  setField('to');
  streetCtx = null;
  setTravelMode(r.mode);
  updateClear();
  showPreview(r.to);
}

// Recente bestemmingen waarin elk getypt woord het begin van een woord is
// ("heem" en "rotter" vinden "Heemraadssingel, Rotterdam", "raad" niet)
const fold = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function matchRecent(q) {
  const words = fold(q).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set();
  return [...loadFavs(), ...loadRecent()].filter(d => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    const parts = fold(d.name + ' ' + favLabel(d)).split(/[^\p{L}\p{N}]+/u);
    return words.every(w => parts.some(p => p.startsWith(w)));
  }).slice(0, 5);
}

// Bij een leeg zoekveld de tab Recent of Favorieten tonen
let listTab = 'recent';
function setListTab(tab) {
  listTab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  // Toetsenbord weg, anders valt de kaart erachter
  if (tab === 'map') field().blur();
  showRecent();
}

function showRecent() {
  searchSeq++;
  firstResult = null;
  firstRecent = null;
  const ul = $('results');
  ul.innerHTML = '';
  $('preview').hidden = true;
  $('pick').hidden = listTab !== 'map';
  if (listTab === 'map') { showPickMap(); return; }
  if (listTab === 'routes') {
    const routes = loadRoutes();
    if (!routes.length) ul.innerHTML = '<li class="empty">Nog geen routes. Tik op het blauwe beginpunt in het routeoverzicht om een eigen vertrekpunt te kiezen.</li>';
    for (const r of routes) ul.appendChild(routeItem(r));
    return;
  }
  const fav = listTab === 'fav';
  const list = fav ? loadFavs() : loadRecent();
  if (!fav && activeField === 'from') ul.appendChild(hereItem());
  if (!list.length) {
    ul.insertAdjacentHTML('beforeend', `<li class="empty">${fav ? 'Nog geen favorieten. Tik bij Recent op het sterretje om er een toe te voegen.' : 'Nog geen recente bestemmingen.'}</li>`);
    return;
  }
  for (const d of list) {
    const li = recentItem(d, { star: true, handle: fav });
    if (fav) swipeable(li, 'Hernoemen', () => editLabel(li, d));
    else swipeable(li, 'Verwijderen', () => swipeAway(li, () => { deleteRecent(d); showRecent(); }));
    ul.appendChild(li);
  }
}

function updateClear() {
  $('qclear').hidden = !$('q').value;
  $('qfromclear').hidden = !$('qfrom').value;
}

function openSearch() {
  const navigating = !!(state.nav || state.concept);
  $('search').hidden = false;
  $('q').value = navigating && state.dest ? state.dest.name : '';
  $('q-postcode').value = '';
  $('q-city').value = '';
  $('results').innerHTML = '';
  $('preview').hidden = true;
  $('pick').hidden = true;
  $('qfrom').value = '';
  $('fromwrap').hidden = true;
  $('swap').hidden = true;
  origin = null;
  setField('to');
  pending = null;
  streetCtx = null;
  firstResult = null;
  firstRecent = null;
  modeAtOpen = travelMode;
  setTravelMode(travelMode);
  listTab = 'recent';
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === 'recent')));
  if (state.concept) {
    origin = state.concept.origin;
    $('qfrom').value = origin.name;
    showFrom();
  }
  updateClear();
  if (navigating) showPreview(state.dest);
  else {
    showRecent();
    // Op iOS opent het toetsenbord alleen als focus direct binnen de tik gebeurt
    $('q').focus();
  }
}

function closeSearch() {
  $('q').blur();
  $('qfrom').blur();
  $('search').hidden = true;
  previewSeq++;
}

function describe(props) {
  const street = [props.street, props.housenumber].filter(Boolean).join(' ');
  const title = props.name || street || props.city || 'Onbekende plek';
  const sub = [props.name && street ? street : '', props.postcode, props.city || props.town || props.village, ['Nederland', 'Netherlands'].includes(props.country) ? '' : props.country]
    .filter(Boolean).join(', ');
  return { title, sub };
}

const isStreet = p => !p.housenumber && p.name && (p.type === 'street' || p.osm_key === 'highway');

// Dubbele resultaten samenvoegen (een straat met meerdere postcodes, of een gracht
// met dezelfde naam als de straat); de straat krijgt voorrang.
function dedupe(features) {
  const byKey = new Map();
  for (const f of features) {
    const p = f.properties;
    const key = (describe(p).title + '|' + (p.housenumber ? p.postcode : '') + '|' + (p.city || p.town || p.village || '')).toLowerCase();
    const have = byKey.get(key);
    if (!have) byKey.set(key, f);
    else if (!isStreet(have.properties) && isStreet(p)) byKey.set(key, f);
  }
  return [...byKey.values()];
}

// Kiezen uit de suggesties neemt de waarde over en toont het routeoverzicht;
// bij een straat zonder huisnummer kun je het nummer er nog achter typen.
function choose(f) {
  const p = f.properties;
  const { title, sub } = describe(p);
  const [lon, lat] = f.geometry.coordinates;
  const dest = { lat, lon, name: [title, sub].filter(Boolean).join(', ') };
  const q = field();
  if (isStreet(p)) {
    streetCtx = { street: p.name, city: p.city || p.town || p.village || '', dest };
    q.value = p.name + ' ';
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  } else {
    streetCtx = null;
    q.value = dest.name;
    q.blur();
  }
  updateClear();
  useChoice(dest);
}

function searchQuery() {
  let q = field().value.trim();
  const extra = activeField === 'to' ? [$('q-postcode').value, $('q-city').value].map(v => v.trim()).filter(Boolean) : [];
  if (extra.length) q = [q, ...extra].join(' ');
  else if (streetCtx && streetCtx.city && !q.toLowerCase().includes(streetCtx.city.toLowerCase())) q += ', ' + streetCtx.city;
  return q;
}

// Huisnummer achter een gekozen straat: geen lijst, maar het overzicht en de
// knoppen laten staan en de route bijwerken naar het juiste huisnummer.
async function resolveHouse(num, seq) {
  const { street, city, dest: streetDest } = streetCtx;
  const params = new URLSearchParams({ q: `${street} ${num}, ${city}`, limit: '10' });
  if (state.fix) { params.set('lat', state.fix.lat); params.set('lon', state.fix.lon); }
  $('psum').textContent = 'Huisnummer zoeken…';
  try {
    const data = await (await fetch(`${PHOTON}?${params}`)).json();
    if (seq !== searchSeq) return;
    const want = num.toLowerCase().replace(/\s+/g, '');
    const houses = data.features.filter(f => f.properties.housenumber && f.properties.street === street);
    const norm = f => f.properties.housenumber.toLowerCase().replace(/\s+/g, '');
    const f = houses.find(h => norm(h) === want) || houses.find(h => new RegExp('^' + want + '(\\D|$)').test(norm(h)));
    if (f) {
      const { title, sub } = describe(f.properties);
      const [lon, lat] = f.geometry.coordinates;
      useChoice({ lat, lon, name: [title, sub].filter(Boolean).join(', ') }, title);
    } else {
      useChoice(streetDest, `Nummer ${num} niet gevonden, route naar de straat`);
    }
  } catch (e) {
    if (seq === searchSeq) $('psum').textContent = 'Zoeken lukt nu niet. Controleer je verbinding.';
  }
}

async function search() {
  const seq = ++searchSeq;
  const ul = $('results');
  const v = field().value;
  if (streetCtx && v.startsWith(streetCtx.street)) {
    const num = v.slice(streetCtx.street.length).trim();
    if (num) resolveHouse(num, seq);
    else if ((activeField === 'from' ? origin : pending) !== streetCtx.dest) useChoice(streetCtx.dest);
    return;
  }
  const q = searchQuery();
  // Passende recente bestemmingen staan meteen bovenaan, nog voor de suggesties binnen zijn
  const recents = matchRecent(v);
  firstRecent = recents[0] || null;
  firstResult = null;
  ul.innerHTML = '';
  $('pick').hidden = true;
  if (recents.length) {
    $('preview').hidden = true;
    for (const d of recents) ul.appendChild(recentItem(d));
  }
  if (q.length < 3) return;
  const params = new URLSearchParams({ q, limit: '12' });
  if (state.fix) { params.set('lat', state.fix.lat); params.set('lon', state.fix.lon); }
  try {
    const res = await fetch(`${PHOTON}?${params}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    const known = new Set(recents.map(d => d.name));
    const features = dedupe(data.features)
      .filter(f => { const { title, sub } = describe(f.properties); return !known.has([title, sub].filter(Boolean).join(', ')); })
      .slice(0, 8);
    firstResult = features[0] || null;
    $('preview').hidden = true;
    if (!features.length && !recents.length) { ul.innerHTML = '<li class="empty">Niets gevonden</li>'; return; }
    for (const f of features) {
      const { title, sub } = describe(f.properties);
      const li = document.createElement('li');
      li.innerHTML = `<div class="r1"></div><div class="r2"></div>`;
      li.querySelector('.r1').textContent = title;
      li.querySelector('.r2').textContent = sub;
      li.addEventListener('click', () => choose(f));
      ul.appendChild(li);
    }
  } catch (e) {
    if (seq === searchSeq) ul.innerHTML = '<li class="empty">Zoeken lukt nu niet. Controleer je verbinding.</li>';
  }
}

function onSearchInput() {
  const v = field().value;
  if (streetCtx && !v.startsWith(streetCtx.street)) streetCtx = null;
  updateClear();
  clearTimeout(searchTimer);
  if (!v.trim()) {
    $('q-postcode').value = '';
    $('q-city').value = '';
    showRecent();
    return;
  }
  searchTimer = setTimeout(search, 300);
}

// ---------- Routeoverzicht in de dialoog ----------
let pmap = null, previewNav = null, previewSeq = 0, previewData = null;

function previewEnds(start, dest) {
  const pts = [];
  if (start) pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: start }, properties: { kind: 'start' } });
  pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [dest.lon, dest.lat] }, properties: { kind: 'end' } });
  return { type: 'FeatureCollection', features: pts };
}

// Geschat brandstofverbruik (liter): per stuk route de gemiddelde snelheid, met het
// zuinigste punt rond 75 km/u, plus wat extra voor optrekken na elke afslag
const STOP_TYPES = new Set([9, 10, 11, 12, 13, 14, 15, 16, 26]);
function fuel(nav) {
  let l = 0;
  for (const m of nav.maneuvers) {
    const km = m.length || 0;
    const v = m.time ? km / (m.time / 3600) : 50;
    l += km * (4.7 + 0.00055 * (v - 75) ** 2) / 100;
    if (STOP_TYPES.has(m.type)) l += 0.012;
  }
  return l;
}

// Plek voor het tijdlabel: zo ver mogelijk van de andere routes, maar niet op een ander label
function labelPoint(route, others, taken) {
  const step = r => Math.max(1, Math.floor(r.shape.length / 80));
  const pts = others.flatMap(r => r.shape.filter((_, i) => i % step(r) === 0));
  const cands = route.shape.filter((_, i) => i % step(route) === 0)
    .map(p => ({ p, d: pts.reduce((min, q) => Math.min(min, dist(p, q)), Infinity), px: pmap.project(p) }))
    .sort((a, b) => b.d - a.d);
  const free = cands.find(c => !taken.some(t => Math.abs(t.x - c.px.x) < 80 && Math.abs(t.y - c.px.y) < 28));
  return (free || cands[0]).p;
}

let previewTags = [];
function drawAltTags() {
  previewTags.forEach(t => t.remove());
  previewTags = [];
  const { routes, sel } = previewData;
  if (!routes || routes.length < 2) return;
  const fuels = routes.map(fuel);
  const eco = travelMode === 'auto' ? fuels.indexOf(Math.min(...fuels)) : -1;
  routes.forEach((r, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'alttag' + (i === sel ? ' sel' : '');
    el.innerHTML = (i === eco ? '<i class="ti ti-leaf" aria-label="Zuinigst"></i>' : '') + fmtDuration(r.time);
    el.addEventListener('click', e => { e.stopPropagation(); selectAlt(i); });
    const at = labelPoint(r, routes.filter(o => o !== r), previewTags.map(t => pmap.project(t.getLngLat())));
    previewTags.push(new maplibregl.Marker({ element: el }).setLngLat(at).addTo(pmap));
  });
}

function drawPreview() {
  if (!pmap || !previewData || !pmap.getSource('route')) return;
  const { coords, dest, start, routes, sel } = previewData;
  pmap.getSource('route').setData(lineFeature(coords));
  pmap.getSource('alts').setData({ type: 'FeatureCollection',
    features: (routes || []).map((r, i) => ({ ...lineFeature(r.shape), properties: { i } })).filter((_, i) => i !== sel) });
  pmap.getSource('ends').setData(previewEnds(start, dest));
  const all = (routes || []).flatMap(r => r.shape);
  if (!all.length) all.push(...(coords.length ? coords : [[dest.lon, dest.lat]]));
  const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  pmap.resize();
  pmap.fitBounds(b, { padding: 36, duration: 0, maxZoom: 16 });
  drawAltTags();
}

function previewSummary(note, time, dist) {
  $('psum').textContent = (note ? note + ' · ' : '') + `${fmtDuration(time)} · ${fmtDist(dist)} · ${MODE_LABEL[travelMode]}`;
}

// Andere route kiezen: tik op het label of op de grijze lijn
function selectAlt(i) {
  const d = previewData;
  if (!d || !d.routes || i === d.sel) return;
  d.sel = i;
  d.coords = d.routes[i].shape;
  previewNav = d.routes[i];
  drawPreview();
  previewSummary(d.note, previewNav.time, previewNav.total);
}

async function ensurePreviewMap() {
  if (pmap) { pmap.resize(); return; }
  pmap = new maplibregl.Map({ container: 'pmap', style: await currentStyle(), interactive: false, attributionControl: false,
    center: state.fix ? [state.fix.lon, state.fix.lat] : [5.1214, 52.0907], zoom: 12 });
  watchTrails(pmap);
  pmap.on('style.load', () => {
    const dark = theme() === 'dark';
    addRouteLayers(pmap, []);
    pmap.addSource('alts', { type: 'geojson', data: EMPTY_FC });
    pmap.addLayer({ id: 'alts-casing', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 11 } }, 'route-casing');
    pmap.addLayer({ id: 'alts-line', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#5A6270' : '#A9B4C2', 'line-width': 6 } }, 'route-casing');
    pmap.addSource('ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    pmap.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: {
      'circle-radius': 8, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff',
      'circle-color': ['match', ['get', 'kind'], 'start', '#1F6FE0', '#E5484D'] } });
    drawPreview();
  });
  // De kaart is niet te verschuiven, maar tikken op een grijze route kiest hem wel
  pmap.getContainer().addEventListener('click', e => {
    if (!pmap.getLayer('alts-line')) return;
    const r = pmap.getContainer().getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = pmap.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]], { layers: ['alts-line'] })[0];
    if (f) selectAlt(f.properties.i);
  });
}

async function showPreview(dest, note) {
  pending = dest;
  firstResult = null;
  firstRecent = null;
  $('results').innerHTML = '';
  $('pick').hidden = true;
  $('preview').hidden = false;
  $('stop').style.visibility = state.nav || state.concept ? 'visible' : 'hidden';
  $('qok').disabled = true;
  $('psum').textContent = 'Route berekenen…';
  previewNav = null;
  const seq = ++previewSeq;
  await ensurePreviewMap();
  try {
    const n = state.nav, c = state.concept;
    let coords, dist, time, routes = null;
    if (c && dest === c.dest && origin === c.origin && c.mode === travelMode) {
      previewNav = c.nav;
      coords = c.nav.shape; dist = c.nav.total; time = c.nav.time;
    } else if (n && dest === state.dest && n.mode === travelMode && !origin) {
      // Huidige route: alleen het stuk dat nog komt
      coords = routeCoords.length ? routeCoords : n.shape;
      dist = Math.max(0, n.total - n.along);
      time = n.time * (n.total ? dist / n.total : 0);
    } else {
      if (!state.fix && !origin) throw new Error('Nog geen GPS-positie');
      // Snelste route plus maximaal twee alternatieven
      routes = await fetchRoutes(dest, origin, 2);
      if (seq !== previewSeq) return;
      const r = routes[0];
      previewNav = r;
      coords = r.shape; dist = r.total; time = r.time;
    }
    const start = coords[0] || (origin ? [origin.lon, origin.lat] : state.fix && [state.fix.lon, state.fix.lat]);
    previewData = { coords, dest, start, routes, sel: 0, note };
    drawPreview();
    previewSummary(note, time, dist);
    $('qok').disabled = false;
  } catch (e) {
    if (seq === previewSeq) $('psum').textContent = 'Route berekenen lukt niet: ' + e.message;
  }
}

// ---------- Bestemming kiezen op de kaart ----------
// De pin staat vast in het midden; je schuift en zoomt de kaart eronder.
let pickmap = null;

async function showPickMap() {
  const chosen = activeField === 'from' ? origin : pending;
  let center, zoom = 15;
  if (!chosen && !state.following) {
    // Je keek op de live kaart naar een eigen plek: daar verder kiezen, net zo ver ingezoomd
    center = map.getCenter().toArray();
    zoom = map.getZoom();
  } else {
    const at = chosen || (activeField === 'from' ? state.fix : state.dest || state.fix);
    center = at ? [at.lon, at.lat] : [5.1214, 52.0907];
  }
  if (!pickmap) {
    pickmap = new maplibregl.Map({ container: 'pickmap', style: await currentStyle(), center, zoom,
      attributionControl: false, dragRotate: false, pitchWithRotate: false });
    pickmap.touchZoomRotate.disableRotation();
    watchPublicBuildings(pickmap);
    watchTrails(pickmap);
  } else {
    pickmap.resize();
    pickmap.jumpTo({ center, zoom });
  }
}

// Naam van de gekozen plek: dichtstbijzijnde adres, anders de coördinaten
async function placeName(lat, lon) {
  try {
    const data = await (await fetch(`${PHOTON.replace('/api/', '/reverse')}?lat=${lat}&lon=${lon}&limit=1`)).json();
    const f = data.features[0];
    if (f) {
      const { title, sub } = describe(f.properties);
      return [title, sub].filter(Boolean).join(', ');
    }
  } catch (e) { /* valt terug op coördinaten */ }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

async function confirmPick() {
  const { lng: lon, lat } = pickmap.getCenter();
  $('pickok').disabled = true;
  const name = await placeName(lat, lon);
  $('pickok').disabled = false;
  if ($('pick').hidden) return;
  streetCtx = null;
  field().value = name;
  updateClear();
  useChoice({ lat, lon, name });
}

function confirmPreview() {
  if (!pending) return;
  const dest = pending;
  if (!dest.here) saveRecent({ lat: dest.lat, lon: dest.lon, name: dest.name });
  closeSearch();
  // Eigen vertrekpunt: de route alleen tonen, niet navigeren vanaf je huidige positie
  if (origin && previewNav) {
    if (!dest.here) saveRoute(origin, dest, travelMode);
    showConcept({ nav: previewNav, origin, dest, mode: travelMode });
    previewNav = null;
    return;
  }
  clearConcept();
  if (previewNav) {
    state.dest = dest;
    state.nav = previewNav;
    previewNav = null;
    state.barOn = false;
    state.lastRouteAt = Date.now();
    if (DEMO) demo.along = 0;
    setMode('nav');
    if (state.fix) updateNav([state.fix.lon, state.fix.lat]);
  } else if (!(state.nav && dest === state.dest)) {
    startRoute(dest);
  }
}

function submitSearch() {
  if (firstRecent && $('preview').hidden) chooseRecent(firstRecent);
  else if (firstResult && !$('results').hidden && $('results').children.length) choose(firstResult);
  else if (pending && !$('qok').disabled) confirmPreview();
}

$('where').addEventListener('click', openSearch);
$('edit').addEventListener('click', openSearch);
$('qback').addEventListener('click', () => { setTravelMode(modeAtOpen); closeSearch(); });
$('stop').addEventListener('click', () => { stopRoute(); closeSearch(); });
$('qok').addEventListener('click', confirmPreview);

// Kaartsoort kiezen met het tandwiel tussen de rode en de groene knop
function toggleMapMenu(open) {
  $('mapmenu').hidden = !open;
  $('mapset').setAttribute('aria-expanded', String(open));
  $('mapmenu').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.kind === mapKind)));
  $('trailleg').hidden = !(open && travelMode === 'pedestrian');
  if (!$('trailleg').hidden) showTrailLegend();
}

// Legenda van de wandelroutes: alleen de soorten die in dit kaartdeel voorkomen
let legendSeq = 0;
async function showTrailLegend() {
  const seq = ++legendSeq;
  const rows = $('legrows');
  rows.replaceChildren();
  $('legnote').textContent = 'zoeken…';
  let present;
  try {
    const b = (pmap || map).getBounds();
    const routes = await trailRoutes(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
    present = new Set(routes.map(r => r.group));
  } catch (e) {
    present = new Set(TRAIL_TYPES.map(t => t.key));
  }
  if (seq !== legendSeq) return;
  const types = TRAIL_TYPES.filter(t => present.has(t.key));
  $('legnote').textContent = types.length ? 'in dit gebied' : 'geen in dit gebied';
  for (const t of types) {
    const row = document.createElement('label');
    row.className = 'legrow';
    row.innerHTML = `<span class="sw" style="background:${t.color}"></span><span class="lt">${t.label}<small>${t.sub}</small></span>`
      + '<input type="checkbox" role="switch">';
    const box = row.querySelector('input');
    box.checked = !trailOff.includes(t.key);
    box.addEventListener('change', () => setTrailType(t.key, box.checked));
    rows.appendChild(row);
  }
}

$('mapset').addEventListener('click', e => { e.stopPropagation(); toggleMapMenu($('mapmenu').hidden); });
$('mapmenu').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.kind !== mapKind) setMapKind(b.dataset.kind);
  toggleMapMenu(false);
});
document.addEventListener('click', () => { if (!$('mapmenu').hidden) toggleMapMenu(false); });
$('pickok').addEventListener('click', confirmPick);
$('pickme').addEventListener('click', () => { if (state.fix) pickmap.easeTo({ center: [state.fix.lon, state.fix.lat] }); });
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setListTab(b.dataset.tab)));
$('qclear').addEventListener('click', () => {
  setField('to');
  $('q').value = '';
  $('q-postcode').value = '';
  $('q-city').value = '';
  streetCtx = null;
  updateClear();
  showRecent();
  $('q').focus();
});
$('qfromclear').addEventListener('click', () => {
  setField('from');
  $('qfrom').value = '';
  origin = null;
  streetCtx = null;
  updateClear();
  showRecent();
  $('qfrom').focus();
});
// Wissel je van veld terwijl de lijst van het andere veld open staat, dan komt het overzicht terug
for (const [id, which] of [['q', 'to'], ['qfrom', 'from']]) $(id).addEventListener('focus', () => {
  const switched = activeField !== which;
  setField(which);
  if (switched) streetCtx = null;
  if (!$(id).value.trim()) showRecent();
  else if (switched && pending && $('preview').hidden) showPreview(pending);
});

// Tik op het blauwe vertrekpunt in het overzicht: het Van-veld verschijnt
$('pmap').addEventListener('click', e => {
  if (!previewData || !previewData.start || !$('fromwrap').hidden) return;
  const r = $('pmap').getBoundingClientRect();
  const p = pmap.project(previewData.start);
  if (Math.hypot(e.clientX - r.left - p.x, e.clientY - r.top - p.y) > 28) return;
  showFrom();
});

// Van en Naar omwisselen; je eigen positie kan zo ook de bestemming worden
$('swap').addEventListener('click', () => {
  if (!pending || (!origin && !state.fix)) return;
  const to = origin || { lat: state.fix.lat, lon: state.fix.lon, name: 'Huidige locatie', here: true };
  origin = pending.here ? null : pending;
  $('qfrom').value = origin ? origin.name : '';
  $('q').value = to.name;
  streetCtx = null;
  updateClear();
  showPreview(to);
});
$('qform').addEventListener('submit', e => { e.preventDefault(); submitSearch(); });
for (const id of ['q', 'qfrom', 'q-postcode', 'q-city']) $(id).addEventListener('input', onSearchInput);
document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
  setTravelMode(b.dataset.mode);
  if (pending) showPreview(pending);
}));

// ---------- Route (Valhalla) ----------
// Zonder vertrekpunt rijdt de route vanaf je huidige positie
async function fetchRoutes(dest, start = null, alternates = 0) {
  const f = state.fix;
  const from = start ? { lat: start.lat, lon: start.lon } : { lat: f.lat, lon: f.lon };
  if (!start && state.heading != null && state.speedKmh > 5) { from.heading = Math.round(state.heading); from.heading_tolerance = 60; }
  const body = {
    locations: [from, { lat: dest.lat, lon: dest.lon }],
    costing: travelMode,
    language: 'nl-NL',
    directions_options: { units: 'kilometers', language: 'nl-NL' },
  };
  if (alternates) body.alternates = alternates;
  const res = await fetch(`${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.trip) throw new Error(data.error || 'Geen route gevonden');
  return [data.trip, ...(data.alternates || []).map(a => a.trip)].map(navFromTrip);
}

function navFromTrip(trip) {
  const leg = trip.legs[0];
  const shape = decodePolyline6(leg.shape);
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i]));
  return { shape, cum, maneuvers: leg.maneuvers, total: cum[cum.length - 1], time: trip.summary.time, mode: travelMode, idx: 0, along: 0, off: 0, arrivedAt: 0 };
}

const fetchRoute = async (dest, start = null) => (await fetchRoutes(dest, start))[0];

async function startRoute(dest) {
  if (!state.fix) { toast('Nog geen GPS-positie. Probeer het zo opnieuw.'); return; }
  state.dest = dest;
  state.barOn = false;
  state.routing = true;
  state.lastRouteAt = Date.now();
  toast('Route berekenen…', 2000);
  try {
    state.nav = await fetchRoute(dest);
    if (DEMO) demo.along = 0;
    setMode('nav');
    updateNav([state.fix.lon, state.fix.lat]);
    $('toast').hidden = true;
  } catch (e) {
    toast('Route berekenen lukt niet: ' + e.message, 5000);
  } finally {
    state.routing = false;
  }
}

async function reroute() {
  if (!state.dest || state.routing) return;
  state.routing = true;
  state.lastRouteAt = Date.now();
  toast('Nieuwe route…', 2000);
  try {
    state.nav = await fetchRoute(state.dest);
    if (DEMO) demo.along = 0;
    updateNav([state.fix.lon, state.fix.lat]);
  } catch (e) {
    // volgende afwijking probeert het opnieuw
  } finally {
    state.routing = false;
  }
}

function stopRoute() {
  state.nav = null;
  state.dest = null;
  state.barOn = false;
  clearConcept();
  setRouteLine([]);
  setMode('idle');
  renderBar();
}

// ---------- Conceptroute: vanaf een ander vertrekpunt, alleen bekijken ----------
function drawConcept() {
  const src = map.getSource('concept');
  if (!src) return;
  const c = state.concept;
  if (!c) { src.setData(EMPTY_FC); return; }
  const shape = c.nav.shape;
  const point = (pt, kind) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { kind } });
  src.setData({ type: 'FeatureCollection', features: [lineFeature(shape), point(shape[0], 'start'), point(shape[shape.length - 1], 'end')] });
}

function clearConcept() {
  if (!state.concept) return;
  state.concept = null;
  drawConcept();
  follow();
}

// De kaart gaat naar het vertrekpunt, in de rijrichting van het eerste stuk
function showConcept(c) {
  state.nav = null;
  setRouteLine([]);
  state.concept = c;
  state.dest = c.dest;
  state.barOn = false;
  drawConcept();
  stopFollowing();
  const [a, b] = c.nav.shape;
  const h = map.getContainer().clientHeight;
  map.easeTo({ center: a, bearing: b ? bearing(a, b) : 0, zoom: 15.5, pitch: state.pitch,
    padding: { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 }, duration: 800 });
  $('eta').textContent = fmtClock(new Date(Date.now() + c.nav.time * 1000));
  $('remain-time').textContent = fmtDuration(c.nav.time);
  $('remain-dist').textContent = fmtDist(c.nav.total);
  setMode('concept');
  renderBar();
}

// Postcode weglaten, ook buitenlandse: een los adresdeel met cijfers en zonder
// kleine letters ("3022 CA", "75001", "SW1A 1AA", "D02 X285").
// "Heemraadssingel, 3022 CA, Rotterdam" -> "Heemraadssingel, Rotterdam"
function withoutPostcode(name) {
  return name.split(',').map(p => p.trim())
    .filter((p, i) => !(i > 0 && p.length <= 10 && /\d/.test(p) && !/[a-z]/.test(p)))
    .join(', ');
}

function setMode(mode) {
  const nav = mode === 'nav' || mode === 'concept';
  $('instr').hidden = mode !== 'nav';
  $('bottom-nav').hidden = !nav;
  $('destlbl').textContent = nav && state.dest ? withoutPostcode(state.dest.name) : '';
  $('bottom-idle').hidden = nav;
}

// Valhalla-manoeuvretypes -> korte Nederlandse tekst en icoon
const SKIP_TYPES = new Set([0, 1, 2, 3, 27]);
function maneuverInfo(m) {
  const t = m.type;
  const table = {
    4: ['bestemming', 'ti-flag'], 5: ['bestemming rechts', 'ti-flag'], 6: ['bestemming links', 'ti-flag'],
    7: ['rechtdoor', 'ti-arrow-up'], 8: ['rechtdoor', 'ti-arrow-up'], 22: ['rechtdoor', 'ti-arrow-up'], 17: ['rechtdoor', 'ti-arrow-up'],
    9: ['rechtsaf', 'ti-arrow-up-right'], 10: ['rechtsaf', 'ti-arrow-right'], 11: ['scherp rechtsaf', 'ti-arrow-right'],
    12: ['omkeren', 'ti-arrow-back-up'], 13: ['omkeren', 'ti-arrow-back-up'],
    14: ['scherp linksaf', 'ti-arrow-left'], 15: ['linksaf', 'ti-arrow-left'], 16: ['linksaf', 'ti-arrow-up-left'],
    18: ['oprit rechts', 'ti-arrow-ramp-right'], 19: ['oprit links', 'ti-arrow-ramp-left'],
    20: ['afrit rechts', 'ti-arrow-ramp-right'], 21: ['afrit links', 'ti-arrow-ramp-left'],
    23: ['houd rechts', 'ti-arrow-up-right'], 24: ['houd links', 'ti-arrow-up-left'],
    25: ['invoegen', 'ti-arrow-merge'], 37: ['invoegen', 'ti-arrow-merge'], 38: ['invoegen', 'ti-arrow-merge'],
    28: ['veerpont', 'ti-ship'], 29: ['veerpont verlaten', 'ti-ship'],
  };
  if (t === 26) {
    const n = m.roundabout_exit_count;
    return { verb: n ? `rotonde, ${n}e afslag` : 'rotonde', icon: 'ti-roundabout-right' };
  }
  const [verb, icon] = table[t] || ['rechtdoor', 'ti-arrow-up'];
  return { verb, icon };
}

// Onder de instructie: wegnummers als bordje (alleen als ze anders zijn dan de weg
// waar je nu op rijdt), daarna straatnaam en richting als tekst
function maneuverSub(m) {
  const names = m.street_names || m.begin_street_names || [];
  const toward = m.sign && m.sign.exit_toward_elements;
  const branch = (m.sign && m.sign.exit_branch_elements || []).map(e => e.text);
  const here = (roadKey || '').split('|');
  const refs = roadParts([...names, ...branch]).filter(r => !here.includes(r.text));
  const words = [...names, ...branch].filter(n => !refOf(n) && !/^Rijksweg\b/i.test(n));
  const parts = [];
  if (words.length) parts.push(words.slice(0, 2).join(' / '));
  if (toward && toward.length) parts.push('richting ' + toward.map(e => e.text).slice(0, 2).join(', '));
  const text = parts.join(' · ') || (refs.length ? '' : m.instruction || '');
  return { refs, text };
}

function setInstrSub(sub) {
  const el = $('instr-sub');
  if (typeof sub === 'string') sub = { refs: [], text: sub };
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = sub.text;
  el.replaceChildren(...sub.refs.map(refSpan), t);
}

function updateNav(p) {
  const n = state.nav;
  if (!n) return;

  // Positie op de route bepalen; eerst rond de vorige plek zoeken, dan de hele route
  let best = { d: Infinity, i: n.idx, pt: p };
  const lo = Math.max(0, n.idx - 3), hi = Math.min(n.shape.length - 1, n.idx + 200);
  for (let i = lo; i < hi; i++) {
    const r = projectOnSegment(p, n.shape[i], n.shape[i + 1]);
    if (r.d < best.d) best = { d: r.d, i, pt: r.pt };
  }
  if (best.d > 40) {
    for (let i = 0; i < n.shape.length - 1; i++) {
      const r = projectOnSegment(p, n.shape[i], n.shape[i + 1]);
      if (r.d < best.d) best = { d: r.d, i, pt: r.pt };
    }
  }

  const acc = state.fix ? state.fix.acc : 20;
  const tolerance = Math.max(35, Math.min(80, acc * 1.5));
  if (best.d > tolerance) {
    n.off++;
    if (n.off >= 3 && Date.now() - state.lastRouteAt > 8000) { n.off = 0; reroute(); }
  } else {
    n.off = 0;
    n.idx = best.i;
    n.along = n.cum[best.i] + dist(n.shape[best.i], best.pt);
    setRouteLine([best.pt, ...n.shape.slice(best.i + 1)]);
  }

  const remaining = Math.max(0, n.total - n.along);
  const remainingTime = n.time * (n.total ? remaining / n.total : 0);
  $('eta').textContent = fmtClock(new Date(Date.now() + remainingTime * 1000));
  $('remain-time').textContent = fmtDuration(remainingTime);
  $('remain-dist').textContent = fmtDist(remaining);

  if (remaining < 30) {
    $('instr-icon').className = 'ti ti-flag';
    $('instr-title').textContent = 'Je bent er';
    setInstrSub(state.dest ? state.dest.name : '');
    if (!n.arrivedAt) n.arrivedAt = Date.now();
    else if (Date.now() - n.arrivedAt > 15000) stopRoute();
    return;
  }

  const next = n.maneuvers.find(m => !SKIP_TYPES.has(m.type) && n.cum[m.begin_shape_index] > n.along + 1);
  if (!next) return;
  const d = n.cum[next.begin_shape_index] - n.along;
  const { verb, icon } = maneuverInfo(next);
  $('instr-icon').className = 'ti ' + icon;
  const isDest = next.type >= 4 && next.type <= 6;
  if (d < 30) $('instr-title').textContent = isDest ? 'Bestemming bereikt' : 'Nu ' + verb;
  else $('instr-title').textContent = isDest ? `Bestemming over ${fmtDist(d)}` : `Over ${fmtDist(d)} ${verb}`;
  setInstrSub(isDest ? (state.dest ? state.dest.name : '') : maneuverSub(next));
}

// ---------- Demo-modus (?demo=1): rijdt zelf over de route ----------
const demo = { along: 0, speed: 0, pos: [5.1125, 52.0868], heading: 0, t0: Date.now() };

function pointAlong(n, s) {
  let i = 0;
  while (i < n.cum.length - 2 && n.cum[i + 1] < s) i++;
  const a = n.shape[i], b = n.shape[i + 1];
  const seg = n.cum[i + 1] - n.cum[i];
  const f = seg ? Math.min(1, Math.max(0, (s - n.cum[i]) / seg)) : 0;
  return { pt: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
}

function startDemo() {
  $('demo-badge').hidden = false;
  setInterval(() => {
    const n = state.nav;
    if (n && demo.along < n.total - 5) {
      const k = (Date.now() - demo.t0) / 1000;
      const base = travelMode === 'bicycle' ? 18 : travelMode === 'pedestrian' ? 5 : (state.limit || 50);
      const target = base * (1 + 0.15 * Math.sin(k / 8)) / 3.6;
      demo.speed += Math.max(-3, Math.min(2.5, (target - demo.speed) * 0.35));
      demo.along = Math.min(n.total, demo.along + demo.speed);
      const { pt, heading } = pointAlong(n, demo.along);
      demo.pos = pt;
      demo.heading = heading;
    } else {
      demo.speed = Math.max(0, demo.speed - 3);
    }
    onFix({ lat: demo.pos[1], lon: demo.pos[0], speed: demo.speed, heading: demo.speed > 0.5 ? demo.heading : null, acc: 6, t: Date.now() });
  }, 1000);
}

renderBar();
