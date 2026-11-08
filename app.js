'use strict';

const VERSION = '67';
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
  pitch: 30,          // kanteling tijdens het navigeren; met twee vingers aan te passen
  concept: null,      // getoonde route vanaf een ander vertrekpunt: { nav, stops, mode }
  nav: null,          // actieve route
  dest: null,
  lastRouteAt: 0,
  routing: false,
};
let legView = null;  // het etappe-kaartje dat je bekijkt na swipen; null = het huidige

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

// Fouten tijdelijk in beeld, zodat ze op de iPhone te zien (en te screenshotten) zijn
window.addEventListener('error', e => toast('Fout: ' + (e.message || e.type) + (e.lineno ? ` (regel ${e.lineno})` : ''), 10000));
window.addEventListener('unhandledrejection', e => toast('Fout: ' + (e.reason && e.reason.message || e.reason), 10000));

// ---------- Kaart ook zonder bereik ----------
// Alle kaartbestanden van OpenFreeMap lopen via het eigen adres 'offline://'. Zo haalt de app
// ze uit de opslag van de browser als er geen bereik is: stijl, letters en symbolen worden
// onderweg bewaard, kaarttegels alleen als ze vooraf zijn opgeslagen (langs een wandelroute).
const MAP_CACHE = 'map-offline-v1';
const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const toOffline = u => u.replace(/^https:\/\//, 'offline://');
// Kaarttegels en hoogtetegels: alleen opgeslagen als ze vooraf geladen zijn
const isMapTile = u => /\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$|\/terrarium\/\d+\/\d+\/\d+\.png$/.test(u);

// De opslag één keer openen, en bijhouden welke tegels erin zitten. Zo kost een tegel
// die niet is opgeslagen (bijna altijd) geen trage zoektocht in de opslag: meteen van internet.
let mapCache = null;
const openMapCache = () => mapCache || (mapCache = caches.open(MAP_CACHE).catch(() => null));
const storedTiles = new Set();
const storedReady = openMapCache().then(c => c && c.keys())
  .then(keys => { for (const r of keys || []) if (isMapTile(r.url)) storedTiles.add(r.url); }).catch(() => {});

// Kaarttegels haalt MapLibre zelf op, op de achtergrond (snel). Alleen tegels die langs een
// wandelroute zijn opgeslagen gaan via 'offline://', zodat ze uit de opslag komen.
const transformRequest = url => (storedTiles.has(url) ? { url: toOffline(url) } : undefined);

// Stijlbestanden, symbolen en letters per sessie in het geheugen: elke nieuwe (kleine) kaart
// hoeft er dan niet opnieuw op te wachten
const memo = new Map();

async function mapFetch(url) {
  const cache = await openMapCache();
  // Opgeslagen tegels (langs een gedownloade route) en letters veranderen niet: eerst uit de opslag
  if (cache && (storedTiles.has(url) || url.includes('/fonts/'))) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  try {
    const res = await fetch(url);
    if (res.ok && cache && !isMapTile(url)) cache.put(url, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = cache && await cache.match(url);
    if (hit) return hit;
    throw e;
  }
}

async function loadMapFile(url, type) {
  const res = await mapFetch(url);
  if (!res.ok) throw new Error(`Kaartbestand niet gevonden (${res.status})`);
  if (type === 'json') {
    const data = await res.json();
    return data;
  }
  return res.arrayBuffer();
}

maplibregl.addProtocol('offline', async params => {
  const url = params.url.replace(/^offline:\/\//, 'https://');
  if (isMapTile(url)) return { data: await loadMapFile(url, params.type) };
  // Stijl, symbolen en letters: één keer per sessie ophalen
  const key = params.type + ' ' + url;
  if (!memo.has(key)) memo.set(key, loadMapFile(url, params.type).catch(e => { memo.delete(key); throw e; }));
  const data = await memo.get(key);
  // MapLibre krijgt een eigen kopie: een doorgegeven buffer is daarna leeg
  return { data: data instanceof ArrayBuffer ? data.slice(0) : structuredClone(data) };
});

function offlineStyle(style) {
  style.glyphs = toOffline(style.glyphs);
  if (typeof style.sprite === 'string') style.sprite = toOffline(style.sprite);
  const omt = style.sources.openmaptiles;
  if (omt && omt.url) style.sources.openmaptiles = { ...omt, url: toOffline(omt.url) };
  return style;
}

const tileAt = (lon, lat, z) => [Math.floor((lon + 180) / 360 * 2 ** z),
  Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** z)];

// Tegels langs de eerste 80 km van een route (circa twee dagen lopen), 800 m aan weerszijden
function corridorTiles(nav, z) {
  const keys = new Set(), dLat = 800 / 111320;
  for (let i = 0; i < nav.shape.length && nav.cum[i] <= 80000; i++) {
    const [lon, lat] = nav.shape[i], dLon = dLat / Math.cos(rad(lat));
    const [x1, y1] = tileAt(lon - dLon, lat + dLat, z), [x2, y2] = tileAt(lon + dLon, lat - dLat, z);
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) keys.add(x + '/' + y);
  }
  return [...keys].map(k => k.split('/').map(Number));
}

// Bestanden opslaan; wat er al is wordt overgeslagen.
// Geeft ook terug hoeveel er niet gelukt zijn.
async function storeAll(cacheName, urls, parallel = 2) {
  const cache = await caches.open(cacheName);
  let i = 0, missing = 0;
  const next = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      if (await cache.match(url)) { if (cacheName === MAP_CACHE) storedTiles.add(url); continue; }
      try {
        const res = await fetch(url);
        if (res.ok) {
          await cache.put(url, res);
          if (cacheName === MAP_CACHE) storedTiles.add(url);
        } else missing++;
      } catch (e) { missing++; /* volgende keer opnieuw */ }
    }
  };
  // Twee tegelijk: de kaart die je op dat moment bekijkt gaat voor
  await Promise.all(Array.from({ length: parallel }, next));
  return { cache, missing };
}

const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
// Kaarttegels (zoom 10 tot 14) en met de 3D-kaart ook het reliëf (zoom 10 tot 13)
function walkTileUrls(nav, tiles, relief) {
  const urls = [];
  for (let z = 10; z <= 14; z++) for (const [x, y] of corridorTiles(nav, z)) urls.push(tileUrl(tiles, z, x, y));
  if (relief) for (let z = 10; z <= 13; z++) for (const [x, y] of corridorTiles(nav, z)) urls.push(tileUrl(DEM_URL, z, x, y));
  return urls;
}

// De kaart zelf: zoomniveau 10 tot 14 (14 is het scherpste; verder inzoomen gebruikt die tegels),
// plus de letters van de drie lettertypes
// Met de 3D-kaart ook het reliëf (circa 15 MB voor 80 km)
async function preloadMap(nav, relief) {
  const tiles = (await (await mapFetch(OFM_TILEJSON)).json()).tiles[0];
  const urls = walkTileUrls(nav, tiles, relief);
  for (const font of ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic']) {
    for (const range of ['0-255', '256-511', '8192-8447']) urls.push(`https://tiles.openfreemap.org/fonts/${font}/${range}.pbf`);
  }
  const { cache, missing } = await storeAll(MAP_CACHE, urls);
  // Hooguit 2000 kaart- en hoogtetegels bewaren (circa 100 MB); de oudste eruit
  const stored = (await cache.keys()).filter(r => isMapTile(r.url));
  const gone = stored.slice(0, Math.max(0, stored.length - 2000)).map(r => r.url);
  for (const url of gone) { await cache.delete(url); storedTiles.delete(url); }
  // Gedownloade routes die daardoor niet meer compleet zijn, moeten opnieuw gedownload worden
  if (gone.length) {
    const goneSet = new Set(gone);
    for (const r of loadSaved().filter(x => x.offline)) {
      const n = await savedNav(r);
      if (!n || walkTileUrls(n, tiles, r.relief).some(u => goneSet.has(u))) {
        storeSaved(loadSaved().map(x => (x.id === r.id ? { ...x, offline: false } : x)));
      }
    }
  }
  return missing;
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
  const style = offlineStyle(await (await mapFetch(STYLES.dark)).json());
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
  const style = offlineStyle(await (await mapFetch(STYLES.light)).json());
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
// Tot zoomniveau 13 (circa 12 m per pixel): scherp genoeg voor reliëf en de helft lichter
// om onderweg op te slaan dan niveau 14. Loopt via offline:// zodat het zonder bereik werkt.
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM = { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 13 };
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
  { key: 'NDS', label: 'Wandelnetwerk', sub: 'knooppunten', color: '#1E8A5A', offset: 7.5 },
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
function trailListUrl(w, s, e, n) {
  const bbox = [...toMerc(w, s), ...toMerc(e, n)].map(Math.round).join(',');
  return `${WMT}/list/by_area?bbox=${bbox}&limit=100`;
}
// Per routetegel: de lijnen en de lijst met routenamen
const trailTileUrls = (x, y) => [`${WMT}/tiles/${TRAIL_Z}/${x}/${y}.json`,
  trailListUrl(tileLon(x), tileLat(y + 1), tileLon(x + 1), tileLat(y))];

// Routetegels gaan naar de schijfopslag van de browser (niet het werkgeheugen),
// zodat vooraf geladen tegels ook zonder bereik werken
const TRAIL_CACHE = 'trail-tiles-v1';
async function trailJson(url) {
  let cache = null;
  try { cache = await caches.open(TRAIL_CACHE); } catch (e) { /* geen opslag */ }
  const hit = cache && await cache.match(url);
  if (hit) return hit.json();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Wandelroutes laden lukt niet');
  if (cache) cache.put(url, res.clone()).catch(() => {});
  return res.json();
}

// Wandelroutes langs de eerste 80 km; hooguit 300 bestanden (circa 150 tegels) bewaren
async function preloadTrails(nav) {
  const urls = corridorTiles(nav, TRAIL_Z).flatMap(([x, y]) => trailTileUrls(x, y));
  const { cache, missing } = await storeAll(TRAIL_CACHE, urls);
  const all = await cache.keys();
  for (const req of all.slice(0, Math.max(0, all.length - 600))) await cache.delete(req);
  return missing;
}

const trailTiles = new Map();
function loadTrailTile(x, y) {
  const key = x + '/' + y;
  if (!trailTiles.has(key)) {
    const p = (async () => {
      const [tileUrl, listUrl] = trailTileUrls(x, y);
      const [tile, routes] = await Promise.all([
        trailJson(tileUrl),
        trailJson(listUrl).then(d => d.results || []).catch(() => []),
      ]);
      const info = new Map(routes.map(r => [r.id, r]));
      const out = [];
      for (const f of tile.features) {
        if (f.properties.type !== 'way' || !f.geometry) continue;
        const g = f.geometry;
        const coordinates = g.type === 'LineString' ? g.coordinates.map(fromMerc) : g.coordinates.map(l => l.map(fromMerc));
        const groups = new Set((f.properties.shields || []).map(sh => sh.split('_')[1]));
        // Knooppuntennetwerken hebben geen routebordje, alleen deze stijl
        if (f.properties.style === 'NDS') groups.add('NDS');
        const rels = (f.properties.top_relations || []).map(id => info.get(id)).filter(Boolean);
        for (const t of TRAIL_TYPES) {
          if (!groups.has(t.key)) continue;
          // Naam alleen bij de grotere routes; lokale rondjes zouden de kaart volschrijven
          const ref = t.key === 'LOC' || t.key === 'NDS' ? '' : [...new Set(rels.filter(r => r.group === t.key).map(r => r.ref || r.name))].join(' · ');
          out.push({ type: 'Feature', geometry: { type: g.type, coordinates }, properties: { g: t.key, ref } });
        }
      }
      return out;
    })();
    p.catch(() => trailTiles.delete(key));
    trailTiles.set(key, p);
    // Hooguit 12 tegels bewaren (de oudste eruit)
    if (trailTiles.size > 12) trailTiles.delete(trailTiles.keys().next().value);
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
  // Alleen het gebied rond het midden (1 km naar elke kant). De randen van het beeld tellen
  // niet mee: bij een gekantelde 3D-kaart reiken die tot de horizon, tientallen kilometers ver.
  const c = m.getCenter(), dLat = 1000 / 111320, dLon = dLat / Math.cos(rad(c.lat));
  const keys = [];
  for (let x = tileX(c.lng - dLon); x <= tileX(c.lng + dLon); x++) {
    for (let y = tileY(c.lat + dLat); y <= tileY(c.lat - dLat); y++) keys.push([x, y]);
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

// Iets doen zodra de kaarttegels in beeld binnen zijn. Niet via 'idle': tijdens het
// navigeren beweegt de kaart elke seconde mee en komt die nooit.
function onSettled(m, fn) {
  let timer = null;
  const check = () => {
    timer = null;
    let ready = false;
    try { ready = m.isStyleLoaded() && m.isSourceLoaded('openmaptiles'); } catch (e) { /* stijl nog niet klaar */ }
    if (ready) fn(); else timer = setTimeout(check, 300);
  };
  const kick = () => { if (!timer) timer = setTimeout(check, 200); };
  m.on('moveend', kick);
  m.on('idle', kick);
  m.on('sourcedata', e => { if (e.tile) kick(); });
}

// Eerst de gewone kaart, dan de wandelroutes
function watchTrails(m) {
  m.on('style.load', () => { m._trailKey = null; });
  onSettled(m, () => updateTrails(m));
}

// Soorten wandelroutes aan of uit; geldt voor alle kaarten
function setTrailType(key, on) {
  trailOff = on ? trailOff.filter(k => k !== key) : [...new Set([...trailOff, key])];
  try { localStorage.setItem('trailOff', JSON.stringify(trailOff)); } catch (e) { /* geen opslag */ }
  for (const m of [map]) {
    if (!m.getLayer('trails')) continue;
    m.setFilter('trails', trailFilter());
    m.setFilter('trails-label', ['all', trailFilter(), ['!=', ['get', 'ref'], '']]);
  }
}

// Publieke gebouwen iets donkerder. De kaartdata zegt niet wat voor gebouw iets is,
// dus zoeken we de gebouwen waar een kerk, museum, gemeentehuis enz. in ligt.
const PUBLIC_POI = new Set(['place_of_worship', 'museum', 'town_hall', 'library', 'theatre', 'cinema', 'art_gallery',
  'hospital', 'college', 'school', 'police', 'fire_station', 'post', 'castle']);
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const PUBLIC_NL = { place_of_worship: 'Kerk', museum: 'Museum', town_hall: 'Openbaar gebouw', library: 'Bibliotheek', theatre: 'Theater',
  cinema: 'Bioscoop', art_gallery: 'Galerie', hospital: 'Ziekenhuis', college: 'Hogeschool', school: 'School', police: 'Politie',
  fire_station: 'Brandweer', post: 'Postkantoor', castle: 'Kasteel' };
// Publieke gebouwen met een naam in de kaartdelen die geladen zijn: daar kun je ook op zoeken
let publicPlaces = [];

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
    .map(f => ({ c: f.geometry.coordinates, name: f.properties['name:nl'] || f.properties.name || '', cls: f.properties.class }));
  if (m === map) {
    const seen = new Set();
    publicPlaces = pois.filter(q => q.name && !seen.has(q.name + q.c[0].toFixed(3)) && seen.add(q.name + q.c[0].toFixed(3)))
      .map(q => ({ name: q.name, lon: q.c[0], lat: q.c[1], kind: PUBLIC_NL[q.cls] || 'Openbaar gebouw' }));
  }
  const out = [];
  if (pois.length) {
    for (const b of m.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })) {
      const g = b.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const ring = poly[0];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const hit = pois.find(({ c: p }) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inRing(p, ring));
        if (hit) out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { name: hit.name } });
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
  // De naam midden in het gebouw, pas flink ingezoomd; onder de straatnamen en de route
  const label = m.getStyle().layers.find(l => l.type === 'symbol');
  m.addLayer({ id: 'public-label', type: 'symbol', source: 'public', minzoom: 16, filter: ['!=', ['get', 'name'], ''],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 11.5, 'text-max-width': 8,
      'text-padding': 4 },
    paint: dark
      ? { 'text-color': '#B9BDC6', 'text-halo-color': 'rgba(35,38,43,0.9)', 'text-halo-width': 1.4 }
      : { 'text-color': '#5E5D57', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 } }, label && label.id);
  findPublicBuildings(m);
}

// Opnieuw zoeken zodra er nieuwe kaarttegels binnen zijn
// Pas als de kaart klaar is met laden, en alleen ingezoomd (vanaf 15) waar je gebouwen ziet:
// het doorzoeken van alle gebouwen is zwaar en mag het laden niet ophouden
function watchPublicBuildings(m) {
  let fresh = false;
  m.on('style.load', () => addPublicLayer(m));
  m.on('sourcedata', e => { if (e.sourceId === 'openmaptiles' && e.tile) fresh = true; });
  onSettled(m, () => {
    if (!fresh || m.getZoom() < 15) return;
    fresh = false;
    findPublicBuildings(m);
  });
}

// Geheugen sparen: scherpte maximaal 2x en een beperkte voorraad kaarttegels
const PIXEL_RATIO = Math.min(devicePixelRatio || 1, 2);
const SMALL_MAP = { pixelRatio: PIXEL_RATIO, maxTileCacheSize: 30, transformRequest };

const map = new maplibregl.Map({
  container: 'map',
  style: theme() === 'dark' ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT,
  pixelRatio: PIXEL_RATIO,
  maxTileCacheSize: 80,
  transformRequest,
  center: [5.1214, 52.0907],
  zoom: 15,
  pitch: 0,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
// Twee vingers: samen omhoog of omlaag schuiven kantelt, tegen elkaar in draaien roteert.
// De gekozen kanteling blijft staan, ook als de kaart je weer volgt; navigeren en de
// kaart zonder route hebben elk hun eigen kanteling.
map.on('pitchend', e => { if (e.originalEvent && (state.nav || state.concept)) state.pitch = map.getPitch(); });
// Alleen tijdens het navigeren (ook een conceptroute) is de kaart gekanteld en draait hij mee; anders
// plat met het noorden boven. Kantel of draai je hem zonder navigatie toch, dan stopt het volgen; het kompas zet hem terug.
const camPitch = () => (state.nav || state.concept ? state.pitch : 0);
// Richting waarin de route vertrekt: zo kijk je bij het starten al de goede kant op
function startBearing(shape) {
  const a = shape[0];
  for (let i = 1; i < shape.length; i++) if (dist(a, shape[i]) > 25) return bearing(a, shape[i]);
  return shape.length > 1 ? bearing(a, shape[shape.length - 1]) : 0;
}
// Richting waarin de route bij punt i aankomt
function arriveBearing(shape, i) {
  const b = shape[i];
  for (let j = i - 1; j >= 0; j--) if (dist(shape[j], b) > 25) return bearing(shape[j], b);
  return i + 1 < shape.length ? bearing(b, shape[i + 1]) : 0;
}
// Navigeren: je rijrichting boven; nog stilstaand (richting onbekend): de richting van de route
const camBearing = () => (state.nav ? state.heading ?? startBearing(state.nav.shape) : 0);
watchPublicBuildings(map);
watchTrails(map);
// Kaart weggevallen (meestal geheugen): melden; MapLibre tekent hem opnieuw zodra het kan
map.on('webglcontextlost', () => toast('De kaart is even weggevallen (geheugen). Hij komt vanzelf terug.', 8000));
// Vangnet: gaat er midden in een kaartanimatie iets mis, dan blijft MapLibre hangen en
// tekent hij niets meer (lege kaart). Staat de takenlijst langer dan 2 s 'bezig', dan
// zetten we hem vrij en tekenen opnieuw. Normaal is hij nooit buiten een tekenbeurt bezig.
let stuckSince = 0;
setInterval(() => {
  const q = map._renderTaskQueue;
  if (!q || !q._currentlyRunning) { stuckSince = 0; return; }
  if (!stuckSince) { stuckSince = Date.now(); return; }
  if (Date.now() - stuckSince > 2000) {
    q._currentlyRunning = false;
    stuckSince = 0;
    map.triggerRepaint();
  }
}, 1000);
// Alleen fouten van de stijl zelf; een ontbrekende kaarttegel (bijv. zonder bereik) is geen melding waard
map.on('error', e => { if (!map.isStyleLoaded() && !e.sourceId && !e.tile) toast('Kaart laden lukt niet: ' + (e.error && e.error.message || 'onbekende fout'), 10000); });

const markerEl = document.createElement('div');
markerEl.className = 'car marker dot';
markerEl.innerHTML = '<div><div></div></div>';
const marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map' });

let routeCoords = [];
const lineFeature = coords => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

// Routelijnen even dik op elke zoom en kanteling. De dikte groeit mee met de zoom
// (uitgezoomd dunner), en bij een gekantelde kaart tekent MapLibre lijnen dichtbij de
// camera dikker (perspectief): dat compenseren we, gemeten iets onder het midden, waar
// je auto staat. 'base' is de dikte in pixels op zoom 15, plat.
const LINE_BASE = new WeakMap();
function pitchFactor(pitch) {
  const p = pitch * Math.PI / 180, a = 11 * Math.PI / 180;
  return Math.cos(p) * Math.cos(a) / Math.cos(p - a);
}
const lineWidth = (w, f) => ['interpolate', ['exponential', 1.5], ['zoom'],
  6, Math.max(1, w * 0.4 * f), 10, w * 0.6 * f, 13, w * 0.85 * f, 15, w * f, 18, w * 1.3 * f];
function fitLines(m, force) {
  const base = LINE_BASE.get(m);
  if (!base) return;
  const f = Math.round(pitchFactor(m.getPitch()) * 50) / 50;
  if (!force && f === m._lineF) return;
  m._lineF = f;
  for (const [id, w] of Object.entries(base)) if (m.getLayer(id)) m.setPaintProperty(id, 'line-width', lineWidth(w, f));
}
function scaleLines(m, base) {
  LINE_BASE.set(m, { ...LINE_BASE.get(m), ...base });
  fitLines(m, true);
  if (m._lineHook) return;
  m._lineHook = true;
  let raf = 0;
  m.on('pitch', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitLines(m); }); });
}

function addRouteLayers(m, coords) {
  const dark = theme() === 'dark';
  m.addSource('route', { type: 'geojson', data: lineFeature(coords) });
  m.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 13 } });
  m.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#3D8BFF' : '#1F6FE0', 'line-width': 8 } });
}

// Een streepje voor de conceptroute: een effen blauw rechthoekje (2x scherp), in de lijnrichting
function dashImage(dark) {
  const c = document.createElement('canvas');
  c.width = 20;
  c.height = 10;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#3D8BFF' : '#1F6FE0';
  g.fillRect(0, 0, 20, 10);
  return g.getImageData(0, 0, 20, 10);
}

// Conceptroute (vertrek niet vanaf je eigen positie): gestreept, met blauw begin en rood eind.
// Losse streepjes langs de lijn in plaats van een gestreepte lijn: die blijven scherp en even
// lang, ook gekanteld in 3D en tussen twee zoomniveaus in.
function addConceptLayers(m) {
  const dark = theme() === 'dark';
  m.addSource('concept', { type: 'geojson', data: EMPTY_FC, tolerance: 0.1 });
  if (m.hasImage('cdash')) m.removeImage('cdash');
  m.addImage('cdash', dashImage(dark), { pixelRatio: 2 });
  m.addLayer({ id: 'concept-line', type: 'symbol', source: 'concept', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 8, 8, 12, 12, 15, 16, 18, 20],
      'icon-image': 'cdash', 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 0.75, 15, 1, 18, 1.2],
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-padding': 0, 'icon-keep-upright': false } });
  m.addLayer({ id: 'concept-ends', type: 'circle', source: 'concept', filter: ['==', ['geometry-type'], 'Point'],
    paint: { ...endsPaint(dark), 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport' } });
  drawConcept();
}

// Wordt ook opnieuw aangeroepen na een wissel tussen licht en donker
// Begin (blauw), tussenstops (wit) en eind (rood) van de lopende route, net als bij de conceptroute
function addRouteEnds(m) {
  const dark = theme() === 'dark';
  m.addSource('route-ends', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'route-ends', type: 'circle', source: 'route-ends', paint: { ...endsPaint(dark), 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport' } });
  drawRouteEnds();
}

let endsFor = null, endsLeg = -1;
function drawRouteEnds() {
  const src = map.getSource('route-ends');
  const n = state.nav;
  endsFor = n;
  endsLeg = n ? n.legIdx : -1;
  if (!src) return;
  if (!n) { src.setData(EMPTY_FC); return; }
  // Het beginpunt blijft waar je vertrok, ook als de route onderweg opnieuw berekend is;
  // tussenstops alleen die nog komen
  const vias = n.legs.slice(n.legIdx, -1).map(l => n.shape[l.endIdx]);
  src.setData(stopPoints([state.navStart || n.shape[0], ...vias, n.shape[n.shape.length - 1]]));
}

map.on('style.load', () => {
  addRouteLayers(map, routeCoords); addRouteEnds(map); addConceptLayers(map);
  scaleLines(map, { 'route-casing': 13, 'route-line': 8 });
  if (msmap) { showMainLayers(false); addMsLayers(map); msDraw(); msTilt(true); }
});

// De kleine routeoverzichtkaart is altijd de gewone kaart: geen reliëf, luchtfoto of
// wandelroutes. Die maken hem traag en kosten de iPhone veel geheugen. De grote zoekkaart
// volgt wel de gekozen kaartsoort, zodat je in 3D je punten kunt kiezen.
async function currentStyle(small = false) {
  const dark = theme() === 'dark';
  await storedReady;
  const base = await (dark ? darkStyle() : lightStyle());
  return small ? base : styleFor(base, mapKind, dark);
}

function setMapKind(kind) {
  mapKind = kind;
  try { localStorage.setItem('mapKind', kind); } catch (e) { /* geen opslag */ }
  applyTheme();
}

async function applyTheme() {
  map.setStyle(await currentStyle(), { diff: false });
  const small = await currentStyle(true);
  // De kleine kaarten veranderen alleen mee met licht en donker
  if (pmap && pmap._dark !== theme()) { pmap._dark = theme(); pmap.setStyle(small, { diff: false }); }
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
  $('recenter').hidden = false;
  showCar();
}

// Je positie: tijdens navigeren een vast pijltje in beeld; anders een stip die aan de kaart
// vastzit, zodat hij niet verschuift als je de kaart beweegt. Bij zoeken op de kaart staat
// je positie er al als blauwe stip.
let markerOn = false;
function showCar() {
  const overlay = !!state.nav && state.following;
  $('car').hidden = !overlay;
  const on = !overlay && !!state.fix && !msmap;
  if (on) marker.setLngLat([state.fix.lon, state.fix.lat]).setRotation(state.heading || 0);
  if (on !== markerOn) { if (on) marker.addTo(map); else marker.remove(); markerOn = on; }
}

// Ruimte rond het midden van de kaart. Navigeren: je positie laag in beeld (70%), met
// ruimte voor wat er voor je ligt. Anders midden in het stuk kaart boven het onderste paneel.
function camPadding() {
  const h = map.getContainer().clientHeight;
  if (state.nav || state.concept) return { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 };
  const idle = $('bottom-idle');
  const bottom = idle.hidden ? 0 : Math.max(0, h - idle.offsetTop);
  return { top: 0, bottom, left: 0, right: 0 };
}

map.on('dragstart', e => { if (e.originalEvent) stopFollowing(); });
map.on('zoomstart', e => { if (e.originalEvent) stopFollowing(); });
map.on('rotatestart', e => { if (e.originalEvent) stopFollowing(); });
map.on('pitchstart', e => { if (e.originalEvent && !state.nav) stopFollowing(); });

function follow() {
  state.following = true;
  $('recenter').hidden = true;
  peek(false);
  showCar();
  clearLook();
  if (state.fix) updateCamera([state.fix.lon, state.fix.lat], 600);
  // De terugvlucht eerst afmaken: nieuwe GPS-metingen zouden hem steeds opnieuw laten beginnen
  state.easeUntil = Date.now() + 650;
  // Bekeek je een ander etappe-kaartje, dan terug naar het huidige
  if (legView !== null) { legView = null; renderCards(); }
}
$('recenter').addEventListener('click', follow);

function targetZoom(kmh) {
  if (kmh < 25) return 17;
  if (kmh < 55) return 16.3;
  if (kmh < 85) return 15.6;
  if (kmh < 110) return 15;
  return 14.5;
}

// Grote sprong (verder dan 15 km): eerst alleen de gewone kaart laden, het 3D-reliëf pas
// als die er staat. Anders wacht alles op hoogtetegels en zie je lang een lege kaart.
function farJump(to) {
  const c = map.getCenter();
  if (dist([c.lng, c.lat], to) <= 15000) return false;
  if (map.getTerrain()) {
    map.setTerrain(null);
    if (map.getLayer('hillshade')) map.setLayoutProperty('hillshade', 'visibility', 'none');
    const restore = () => {
      let ready = false;
      try { ready = map.isSourceLoaded('openmaptiles'); } catch (e) { /* nieuwe stijl: die heeft zijn eigen reliëf */ return; }
      if (!ready) { setTimeout(restore, 300); return; }
      if (mapKind !== 'terrain' || !map.getSource('dem') || map.getTerrain()) return;
      map.setTerrain({ source: 'dem', exaggeration: 1.2 });
      if (map.getLayer('hillshade')) map.setLayoutProperty('hillshade', 'visibility', 'visible');
    };
    setTimeout(restore, 300);
  }
  return true;
}

// Alleen tijdens het navigeren een pijl in de rijrichting; anders een blauwe stip
function syncCar() {
  const dot = !state.nav;
  $('car').classList.toggle('dot', dot);
  markerEl.classList.toggle('dot', dot);
}

function updateCamera(p, duration = 1000) {
  syncCar();
  // Achter het zoekscherm hoeft de live kaart niet mee te bewegen: dan heeft de
  // routekaart de telefoon voor zich alleen. Bij het sluiten volgt hij meteen weer.
  if (!$('search').hidden) return;
  showCar();
  if (!state.following) return;
  if (Date.now() < (state.easeUntil || 0)) return;
  if (farJump(p)) duration = 0;
  state.zoom += (targetZoom(state.speedKmh) - state.zoom) * 0.25;
  // Navigeren: rijrichting boven (zonder bekende richting het noorden). Anders noord boven
  // en draait alleen het pijltje.
  const bear = camBearing();
  $('car').firstElementChild.style.transform = `rotate(${state.nav ? 0 : state.heading || 0}deg)`;
  map.easeTo({
    center: p,
    bearing: bear,
    zoom: state.zoom,
    pitch: camPitch(),
    padding: camPadding(),
    duration,
    easing: t => t,
  });
}

// ---------- Kleurbalk ----------
let lastTheme = '';
// Alleen tijdens echte autonavigatie (vanaf je eigen positie), ongeacht de snelheid
const barShown = () => !!(state.nav && state.nav.mode === 'auto');
function renderBar() {
  const bar = $('bar'), lim = $('lim');
  document.body.classList.toggle('nobar', !barShown());
  $('spd').textContent = state.fix ? Math.round(state.speedKmh) : '–';
  // Bij een route met tussenstops blijft de regel met de stop en de tijd ernaartoe staan
  $('destlbl').hidden = state.speedKmh > 10 && !(state.nav && state.nav.legs.length > 1);
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
  // Zonder kleurbalk geen limiet nodig: scheelt data en batterij
  if (limitBusy || !barShown()) return;
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
  syncDriving();

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

// ---------- De route: een lijst adresregels ----------
// Vertrekpunt, tussenstops en bestemming. Een lege regel is null; je eigen positie is HERE.
const HERE = { here: true, name: 'Huidige locatie' };
let stops = [HERE, null];
const filled = () => stops.filter(Boolean);
// Je eigen positie met de coördinaten van nu
const hereNow = () => state.fix && { here: true, name: 'Huidige locatie', lat: state.fix.lat, lon: state.fix.lon };
const resolveStop = s => (s && s.here ? hereNow() : s);
const lastPlace = () => filled().filter(s => !s.here).pop() || null;

let searchTimer, searchSeq = 0;
let streetCtx = null;    // gekozen straat zonder huisnummer: { street, city, dest }
let firstResult = null;  // bovenste zoekresultaat, voor Enter
let firstRecent = null;  // bovenste passende recente bestemming, gaat voor bij Enter
let modeAtOpen = 'auto';
let editRow = 1;         // de adresregel die het tekst-zoekscherm invult
let textFrom = 'home';   // vanwaar het tekst-zoekscherm kwam: 'home' of 'overview'
const field = () => $('q');

const MODE_LABEL = { auto: 'auto', bicycle: 'fiets', pedestrian: 'lopen' };
const MODE_ICON = { auto: 'ti-car', bicycle: 'ti-bike', pedestrian: 'ti-walk' };

let travelMode = 'auto';
try { travelMode = localStorage.getItem('travelMode') || 'auto'; } catch (e) { /* geen opslag */ }

function setTravelMode(mode) {
  travelMode = mode;
  try { localStorage.setItem('travelMode', mode); } catch (e) { /* geen opslag */ }
  document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  updateTrails(map);
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
  const f = loadFavs().find(x => x.name === d.name);
  saveFavs(loadFavs().map(x => (x.name === d.name ? { ...x, label: label.trim() || undefined } : x)));
  if (f && f.pin) renamePin(f.pin, label.trim());
}
function deleteRecent(d) {
  try { localStorage.setItem('recent', JSON.stringify(loadRecent().filter(r => r.name !== d.name))); } catch (e) { /* geen opslag */ }
}

// Een route met tussenstops of een eigen vertrekpunt staat als één regel bij Recent,
// en kan net als een bestemming favoriet worden
const place = d => (d.here ? HERE : { lat: d.lat, lon: d.lon, name: d.name });
const routeEntry = (list, mode) => ({ stops: list.map(place), mode, name: list.map(s => s.name).join(' → ') });
// Oude regels hadden alleen van en naar
const stopsOf = d => d.stops || (d.from ? [d.from, d.to] : null);
const shortName = d => (d.here ? 'Huidige locatie' : favLabel(d) || d.name.split(', ')[0]);
// Meer dan twee punten: alleen vertrek … aankomst
const routeText = list => (list.length > 2 ? `${shortName(list[0])} → … → ${shortName(list[list.length - 1])}` : list.map(shortName).join(' → '));

// Vroeger stonden deze routes in een eigen tab; eenmalig naar Recent verhuizen
try {
  const old = JSON.parse(localStorage.getItem('routes') || 'null');
  if (Array.isArray(old)) {
    const moved = old.filter(r => r.from && r.to).map(r => routeEntry([r.from, r.to], r.mode));
    const names = new Set(moved.map(r => r.name));
    localStorage.setItem('recent', JSON.stringify([...loadRecent().filter(d => !names.has(d.name)), ...moved].slice(0, 30)));
    localStorage.removeItem('routes');
  }
} catch (e) { /* geen opslag */ }

// ---------- Tab Routes: routes met een boekenlint, met download voor onderweg zonder bereik ----------
// Elke gestarte route wordt onthouden; bij Recent zet je er een boekenlint op en dan staat hij
// bij Routes. Het download-icoontje slaat de kaart langs de eerste 80 km op (bij Lopen ook de
// wandelroutes); daarna is het blauw en opent de route ook zonder bereik.
const ROUTE_CACHE = 'walks-v1';
const routeUrl = id => `${location.origin}/__walk/${id}.json`;
const routeKey = r => r.mode + '|' + r.stops.map(s => s.name).join('|');
const sigOf = (list, mode) => mode + '|' + list.map(s => (s.here ? 'here' : s.name)).join('|');
function loadSaved() {
  try { return JSON.parse(localStorage.getItem('savedRoutes') || '[]'); } catch (e) { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem('savedRoutes', JSON.stringify(list)); } catch (e) { /* geen opslag */ }
}
// Opgeslagen wandelingen van vroeger worden routes die al gedownload zijn
try {
  const walks = JSON.parse(localStorage.getItem('walks') || 'null');
  if (Array.isArray(walks)) {
    storeSaved([...walks.map(w => ({ id: w.id, stops: [place(w.from), place(w.to)], mode: 'pedestrian', km: w.km, offline: true, relief: w.relief })),
      ...loadSaved()].slice(0, 30));
    localStorage.removeItem('walks');
  }
} catch (e) { /* geen opslag */ }
// Herkent een route ook als hij vanaf je eigen positie begint (die heeft per keer een ander adres)
const savedSig = r => r.sig || sigOf(r.stops, r.mode);
const bookmarked = () => loadSaved().filter(r => r.bookmark);
const savedFor = d => { const sig = sigOf(stopsOf(d), d.mode); return loadSaved().find(r => savedSig(r) === sig); };
const isBookmarked = d => !!(savedFor(d) || {}).bookmark;
async function toggleBookmark(d) {
  const r = savedFor(d);
  if (r) { storeSaved(loadSaved().map(x => (x.id === r.id ? { ...x, bookmark: !x.bookmark } : x))); return; }
  // Nog nooit gestart: nu bewaren, met het adres van je eigen positie als die erin zit
  const list = stopsOf(d), sig = sigOf(list, d.mode);
  const fixed = await Promise.all(list.map(async x => (x.here ? (state.fix ? { lat: state.fix.lat, lon: state.fix.lon,
    name: await placeName(state.fix.lat, state.fix.lon) } : null) : place(x))));
  if (fixed.includes(null)) { toast('Je positie is nog niet bekend; start de route een keer en probeer het dan opnieuw.'); return; }
  storeSaved([{ id: Date.now().toString(36), stops: fixed, mode: d.mode, km: null, offline: false, bookmark: true, sig }, ...loadSaved()]);
}
// Eenmalig: routes bij Favorieten krijgen een boekenlint, net als al gedownloade routes
try {
  if (!localStorage.getItem('bookmarks1')) {
    const favRoutes = loadFavs().filter(f => stopsOf(f));
    let saved = loadSaved().map(r => (r.offline ? { ...r, bookmark: true } : r));
    for (const f of favRoutes) {
      const sig = sigOf(stopsOf(f), f.mode), hit = saved.find(r => savedSig(r) === sig);
      if (hit) hit.bookmark = true;
      else if (!stopsOf(f).some(x => x.here)) saved.unshift({ id: (Date.now() + saved.length).toString(36), stops: stopsOf(f).map(place), mode: f.mode, km: null, offline: false, bookmark: true, sig });
    }
    storeSaved(saved);
    saveFavs(loadFavs().filter(f => !stopsOf(f)));
    localStorage.setItem('bookmarks1', '1');
  }
} catch (e) { /* geen opslag */ }

// Een route van vroeger heeft nog geen etappes: dan is het er één
const freshNav = nav => ({ legs: [{ endIdx: nav.shape.length - 1, time: nav.time, begin: 0, end: nav.total }],
  ...nav, idx: 0, along: 0, off: 0, arrivedAt: 0, legIdx: 0 });
async function savedNav(r) {
  try {
    const hit = await (await caches.open(ROUTE_CACHE)).match(routeUrl(r.id));
    return hit ? await hit.json() : null;
  } catch (e) { return null; }
}
async function dropSavedNav(id) {
  try { (await caches.open(ROUTE_CACHE)).delete(routeUrl(id)); } catch (e) { /* geen opslag */ }
}

// Je eigen positie als vertrekpunt krijgt de naam van het adres daar
async function rememberRoute(list, mode, nav) {
  const fixed = await Promise.all(list.map(async s => (s.here ? { lat: s.lat, lon: s.lon, name: await placeName(s.lat, s.lon) } : place(s))));
  const sig = sigOf(list, mode);
  const item = { id: Date.now().toString(36), stops: fixed, mode, km: Math.round(nav.total / 100) / 10, offline: false, sig };
  const all = loadSaved();
  const same = r => savedSig(r) === sig || routeKey(r) === routeKey(item);
  const old = all.find(same);
  if (old) Object.assign(item, { id: old.id, offline: old.offline, relief: old.relief, bookmark: old.bookmark });
  // Routes met een boekenlint blijven altijd; van de rest de laatste 30
  const rest = [item, ...all.filter(r => !same(r))];
  const keep = rest.filter(r => r.bookmark || rest.filter(x => !x.bookmark).indexOf(r) < 30);
  for (const r of rest) if (!keep.includes(r)) dropSavedNav(r.id);
  storeSaved(keep);
}

function deleteSaved(r) {
  storeSaved(loadSaved().filter(x => x.id !== r.id));
  dropSavedNav(r.id);
}

async function downloadRoute(r, btn) {
  if (btn.classList.contains('busy')) return;
  if (r.offline) { toast('Deze route staat op je telefoon en werkt ook zonder bereik'); return; }
  btn.classList.add('busy');
  btn.innerHTML = '<i class="ti ti-loader-2" aria-hidden="true"></i>';
  try {
    const nav = await savedNav(r) || (await fetchRoutes(r.stops, 0, r.mode))[0];
    const relief = mapKind === 'terrain';
    const [a, b] = await Promise.all([preloadMap(nav, relief).catch(() => Infinity),
      r.mode === 'pedestrian' ? preloadTrails(nav).catch(() => Infinity) : 0]);
    if (a || b) {
      toast('Niet alles kon worden opgeslagen (geen bereik?). Tik nog eens op het icoontje om het af te maken.', 6000);
    } else {
      await (await caches.open(ROUTE_CACHE)).put(routeUrl(r.id), new Response(JSON.stringify(freshNav(nav))));
      storeSaved(loadSaved().map(x => (x.id === r.id ? { ...x, offline: true, relief } : x)));
      toast(`Kaart${r.mode === 'pedestrian' ? ' en wandelroutes' : ''} voor ${fmtDist(Math.min(80000, nav.total))} opgeslagen`, 4000);
    }
  } catch (e) {
    toast('Downloaden lukt niet: ' + e.message, 6000);
  }
  if (!$('search').hidden && listTab === 'routes') showRecent();
}

// Sta je bij het beginpunt, dan navigeer je vanaf je eigen positie; zonder bereik
// komt de gedownloade route uit de opslag
let savedPick = null;
async function openSaved(r) {
  const nav = r.offline ? await savedNav(r) : null;
  const list = r.stops.map(place);
  if (state.fix && dist([state.fix.lon, state.fix.lat], [list[0].lon, list[0].lat]) < 300) list[0] = HERE;
  savedPick = nav && { nav, sig: sigOf(list, r.mode) };
  setTravelMode(r.mode);
  stops = list;
  showOverview();
}

// ---------- Lijsten ----------
// Naar links vegen over een regel: verwijderen of hernoemen. De regel schuift opzij
// en laat de actie eronder zien; voorbij 80 px gaat de actie door.
function swipeable(li, action, onSwipe) {
  const row = li.firstElementChild;
  li.dataset.action = action;
  let start = null, dx = 0, active = false;
  li.addEventListener('pointerdown', e => {
    if (e.target.closest('.grip, input, .renok, .dl') || li.classList.contains('editing')) return;
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

// Hernoemen: tekstveld met bevestigknop op de regel zelf. Een bewaarde route (tab Routes)
// heeft een eigen naam; anders is het een favoriet.
function editLabel(li, d, route = null) {
  const row = li.firstElementChild;
  row.style.transform = '';
  li.classList.remove('swiping');
  li.classList.add('editing');
  const text = row.querySelector('.rtext');
  text.innerHTML = `<input class="rename" type="text" enterkeyhint="done" aria-label="Naam van deze ${route ? 'route' : 'favoriet'}">`;
  const input = text.querySelector('input');
  input.value = route ? route.label || routeText(route.stops) : favLabel(d) || (stopsOf(d) ? routeText(stopsOf(d)) : d.name.split(', ')[0]);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'renok';
  ok.setAttribute('aria-label', 'Naam bewaren');
  ok.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
  row.querySelector('.star').replaceWith(ok);
  const dl = row.querySelector('.dl');
  if (dl) dl.hidden = true;
  const save = () => {
    if (route) storeSaved(loadSaved().map(x => (x.id === route.id ? { ...x, label: input.value.trim() || undefined } : x)));
    else renameFav(d, input.value);
    showRecent();
  };
  ok.addEventListener('click', e => { e.stopPropagation(); save(); });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') showRecent();
  });
  input.focus();
  input.select();
}
// Sterretje bij een plek: Favorieten; bij een route: tab Routes
function toggleFav(d) {
  const favs = loadFavs(), f = favs.find(x => x.name === d.name);
  // Een pin van de kaart: uit favorieten halen haalt ook de pin weg
  if (f && f.pin) { removePin(f.pin); return; }
  saveFavs(f ? favs.filter(x => x !== f) : [...favs, place(d)]);
}

// Een regel in de lijst: klik kiest de bestemming, het sterretje maakt hem (geen) favoriet,
// in de favorietenlijst zit links een greep om te slepen.
function recentItem(d, { star = false, handle = false } = {}) {
  // Met een eigen naam staat die bovenaan en het hele adres eronder
  const label = favLabel(d);
  // Een route: van → (via →) naar, met het vervoer eronder
  const list = stopsOf(d);
  const route = list && routeText(list);
  const [first, ...rest] = route ? (label ? [label, route + ' · ' + MODE_LABEL[d.mode]] : [route, MODE_LABEL[d.mode] || ''])
    : label ? [label, d.name] : d.name.split(', ');
  const li = document.createElement('li');
  li.className = 'recent';
  const fav = !list && isFav(d);
  li.innerHTML = '<div class="row">' + (handle ? '<span class="grip" aria-label="Verslepen"><i class="ti ti-grip-vertical" aria-hidden="true"></i></span>'
    : `<i class="ti ${route ? 'ti-route' : 'ti-map-pin'}" aria-hidden="true"></i>`)
    + '<div class="rtext"><div class="r1"></div><div class="r2"></div></div></div>';
  li.querySelector('.r1').textContent = first;
  li.querySelector('.r2').textContent = rest.join(', ');
  li.addEventListener('click', () => { if (!li.dataset.swiped && !li.classList.contains('editing')) chooseRecent(d); });
  if (star && route) {
    // Een route: met het sterretje staat hij bij Routes
    const on = isBookmarked(d);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'star' + (on ? ' on' : '');
    btn.setAttribute('aria-label', on ? 'Uit Routes halen' : 'Bewaren bij Routes');
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = `<i class="ti ${on ? 'ti-star-filled' : 'ti-star'}" aria-hidden="true"></i>`;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await toggleBookmark(d);
      showRecent();
    });
    li.firstElementChild.appendChild(btn);
  } else if (star) {
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
  if (handle) {
    makeDraggable(li, li.querySelector('.grip'), ul => {
      const byName = new Map(loadFavs().map(f => [f.name, f]));
      saveFavs([...ul.querySelectorAll('li[data-name]')].map(el => byName.get(el.dataset.name)).filter(Boolean));
    });
  }
  li.dataset.name = d.name;
  return li;
}

// Sorteren door aan de greep te slepen (werkt met vinger en muis).
// Luistert op window: een verplaatst element verliest anders zijn pointer.
function makeDraggable(li, grip, onDrop) {
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
      li.dataset.swiped = '1';
      setTimeout(() => delete li.dataset.swiped, 300);
      onDrop(ul);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

// Een gekozen plek gaat in de adresregel die je aan het invullen bent
function useChoice(d, note) {
  // Vertrekpunt kiezen vanaf het beginscherm (Zoek locatie): terug naar het beginscherm
  if (textFrom === 'start') { pickStart(d); return; }
  stops[editRow] = d;
  savedPick = null;
  showOverview(note);
}

// Een route uit de lijst vervangt alle regels; een plek vult de regel
function chooseRecent(d) {
  const list = stopsOf(d);
  if (list) {
    stops = list.map(place);
    if (d.mode) setTravelMode(d.mode);
    savedPick = null;
    showOverview();
    return;
  }
  streetCtx = null;
  useChoice(place(d));
}

// Bovenaan de lijst bij het vertrekpunt: je eigen positie
function hereItem() {
  const li = document.createElement('li');
  li.className = 'recent here';
  li.innerHTML = '<div class="row"><i class="ti ti-current-location" aria-hidden="true"></i><div class="rtext"><div class="r1">Huidige locatie</div></div></div>';
  li.addEventListener('click', () => useChoice(HERE));
  return li;
}

function savedItem(r) {
  const li = document.createElement('li');
  li.className = 'recent';
  li.innerHTML = `<div class="row"><i class="ti ${MODE_ICON[r.mode] || 'ti-route'}" aria-hidden="true"></i><div class="rtext"><div class="r1"></div><div class="r2"></div></div>`
    + `<button type="button" class="dl${r.offline ? ' on' : ''}"><i class="ti ti-download" aria-hidden="true"></i></button>`
    + '<button type="button" class="star on" aria-label="Uit Routes halen" aria-pressed="true"><i class="ti ti-star-filled" aria-hidden="true"></i></button></div>';
  li.querySelector('.r1').textContent = r.label || routeText(r.stops);
  li.querySelector('.r2').textContent = [r.km != null && `${String(r.km).replace('.', ',')} km`, MODE_LABEL[r.mode], r.offline && 'ook zonder bereik'].filter(Boolean).join(' · ');
  li.querySelector('.star').addEventListener('click', e => {
    e.stopPropagation();
    storeSaved(loadSaved().map(x => (x.id === r.id ? { ...x, bookmark: false } : x)));
    showRecent();
  });
  const dl = li.querySelector('.dl');
  dl.setAttribute('aria-label', r.offline ? 'Opgeslagen voor zonder bereik' : 'Kaart downloaden voor zonder bereik');
  dl.addEventListener('click', e => { e.stopPropagation(); downloadRoute(r, dl); });
  li.addEventListener('click', () => { if (!li.dataset.swiped) openSaved(r); });
  // Vegen hernoemt; weghalen doe je met het sterretje
  swipeable(li, 'Hernoemen', () => editLabel(li, null, r));
  return li;
}

// ---------- In de buurt: plekken per soort, dichtstbij eerst (Photon) ----------
const NEAR = {
  charging: { label: 'Laden', icon: 'ti-charging-pile', tags: { amenity: ['charging_station'] } },
  fuel: { label: 'Tanken', icon: 'ti-gas-station', tags: { amenity: ['fuel'] } },
  food: { label: 'Eten', icon: 'ti-tools-kitchen-2', tags: { amenity: ['restaurant', 'cafe', 'fast_food', 'pub', 'biergarten', 'ice_cream'] } },
  sleep: { label: 'Slapen', icon: 'ti-bed', tags: { tourism: ['hotel', 'guest_house', 'hostel', 'motel', 'camp_site', 'chalet'] } },
  culture: { label: 'Cultuur', icon: 'ti-building-arch',
    tags: { tourism: ['museum', 'gallery', 'attraction'], amenity: ['theatre', 'arts_centre', 'cinema'],
      historic: ['castle', 'monument', 'ruins', 'archaeological_site', 'fort', 'manor', 'city_gate', 'memorial'], man_made: ['windmill'] } },
};
const KIND_NL = {
  fuel: 'Tankstation', charging_station: 'Laadpaal', restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Snackbar', pub: 'Kroeg',
  biergarten: 'Biergarten', ice_cream: 'IJssalon', hotel: 'Hotel', guest_house: 'B&B', hostel: 'Hostel', motel: 'Motel',
  camp_site: 'Camping', chalet: 'Vakantiehuisje', museum: 'Museum', gallery: 'Galerie', attraction: 'Bezienswaardigheid',
  theatre: 'Theater', arts_centre: 'Kunstcentrum', cinema: 'Bioscoop', castle: 'Kasteel', monument: 'Monument', ruins: 'Ruïne',
  archaeological_site: 'Archeologie', fort: 'Fort', manor: 'Landhuis', city_gate: 'Stadspoort', memorial: 'Gedenkteken', windmill: 'Molen',
  zoo: 'Dierentuin', theme_park: 'Pretpark', aquarium: 'Aquarium',
};
let nearCat = 'fuel';
try { nearCat = localStorage.getItem('nearCat') || 'fuel'; } catch (e) { /* geen opslag */ }
if (nearCat === 'history') nearCat = 'culture';  // Cultuur en Historie zijn samengevoegd
if (!NEAR[nearCat]) nearCat = 'fuel';
const nearMemo = new Map(), legMemo = new Map();

// Rond je eigen positie; zonder GPS rond het midden van de kaart
function nearCentre() {
  if (state.fix) return { lat: state.fix.lat, lon: state.fix.lon };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

// ---------- Plekken uit de kaarttegels ----------
// De kaarttegels van OpenFreeMap (zoom 14) bevatten alle plekken van de kaart, ook laadpalen
// zonder naam, plus de namen van wijken en dorpen. Snel (dezelfde tegels als de kaart, vaak al
// geladen) en langs een opgeslagen route zelfs zonder bereik. Elke tegel wordt één keer
// uitgepakt, voor alle soorten tegelijk: wisselen van soort kost dan niets.
const POI_Z = 14;
const PARKS = ['zoo', 'theme_park', 'aquarium'];
const SUB_CAT = new Map();
for (const [cat, c] of Object.entries(NEAR)) for (const vs of Object.values(c.tags)) for (const v of vs) SUB_CAT.set(v, cat);
for (const v of PARKS) SUB_CAT.set(v, 'culture');
const PLACE_CLASSES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood']);
const NO_TILE = { pois: [], places: [], size: 0 };
let poiTpl = null;
const poiTileTpl = () => poiTpl || (poiTpl = mapFetch(OFM_TILEJSON).then(r => r.json()).then(j => j.tiles[0])
  .catch(e => { poiTpl = null; throw e; }));

// Een vectortegel (protobuf) uitpakken: alleen de lagen 'poi' en 'place', alleen punten
const utf8 = new TextDecoder();
function decodePois(buf, tx, ty, z = POI_Z) {
  const b = new Uint8Array(buf);
  let pos = 0;
  const varint = () => { let r = 0, m = 1, x; do { x = b[pos++]; r += (x & 0x7f) * m; m *= 128; } while (x & 0x80); return r; };
  const skip = wt => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; };
  const str = () => { const len = varint(), t = utf8.decode(b.subarray(pos, pos + len)); pos += len; return t; };
  const zz = n => (n % 2 ? -(n + 1) / 2 : n / 2);
  const out = { pois: [], places: [], size: b.length };
  const n = 2 ** z;
  function value(end) {
    let v = null;
    while (pos < end) {
      const key = varint();
      if (key >> 3 === 1 && (key & 7) === 2) v = str();
      else if ((key & 7) === 0) v = varint();
      else skip(key & 7);
    }
    return v;
  }
  function layer(end) {
    let name = '', extent = 4096;
    const keys = [], vals = [], feats = [];
    while (pos < end) {
      const key = varint(), tag = key >> 3, wt = key & 7;
      if (tag === 1 && wt === 2) { name = str(); if (name !== 'poi' && name !== 'place') { pos = end; return; } }
      else if (tag === 2 && wt === 2) { const len = varint(); feats.push([pos, pos + len]); pos += len; }
      else if (tag === 3 && wt === 2) keys.push(str());
      else if (tag === 4 && wt === 2) { const len = varint(); vals.push(value(pos + len)); }
      else if (tag === 5 && wt === 0) extent = varint();
      else skip(wt);
    }
    for (const [start, fend] of feats) {
      pos = start;
      const tags = [], g = [];
      while (pos < fend) {
        const key = varint(), tag = key >> 3, wt = key & 7;
        if (tag === 2 && wt === 2) { const e = varint() + pos; while (pos < e) tags.push(varint()); }
        else if (tag === 4 && wt === 2) { const e = varint() + pos; while (pos < e && g.length < 3) g.push(varint()); pos = e; }
        else skip(wt);
      }
      if (g.length < 3 || (g[0] & 7) !== 1) continue;
      const px = zz(g[1]), py = zz(g[2]);
      // Punten in de rand horen bij de buurtegel: niet dubbel
      if (px < 0 || py < 0 || px >= extent || py >= extent) continue;
      const pr = {};
      for (let i = 0; i + 1 < tags.length; i += 2) pr[keys[tags[i]]] = vals[tags[i + 1]];
      const lon = (tx + px / extent) / n * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py / extent) / n))) * 180 / Math.PI;
      const label = pr['name:nl'] || pr.name || '';
      if (name === 'place') { if (label && PLACE_CLASSES.has(pr.class)) out.places.push({ lon, lat, name: label }); }
      else if (SUB_CAT.has(pr.subclass)) out.pois.push({ lon, lat, cat: SUB_CAT.get(pr.subclass), sub: pr.subclass, name: label });
    }
    pos = end;
  }
  while (pos < b.length) {
    const key = varint();
    if (key >> 3 === 3 && (key & 7) === 2) { const len = varint(); layer(pos + len); } else skip(key & 7);
  }
  return out;
}

const tileMemo = new Map();
function poiTile(x, y) {
  const key = x + '/' + y;
  if (!tileMemo.has(key)) {
    if (tileMemo.size > 600) tileMemo.delete(tileMemo.keys().next().value);
    tileMemo.set(key, (async () => {
      const res = await mapFetch(tileUrl(await poiTileTpl(), POI_Z, x, y));
      if (!res.ok) throw new Error('kaarttegel ' + res.status);
      return decodePois(await res.arrayBuffer(), x, y);
    })().catch(e => { tileMemo.delete(key); return NO_TILE; }));
  }
  return tileMemo.get(key);
}

// De plekken van één soort uit een stel tegels, met afstand tot 'at' en de wijk of het dorp erbij
function tileItems(cat, tiles, at) {
  const places = tiles.flatMap(t => t.places);
  const all = tiles.flatMap(t => t.pois).filter(p => p.cat === cat);
  // Onderdelen van een dierentuin of pretpark (de dieren, de achtbanen) horen bij dat park:
  // dan alleen het park zelf
  const parks = all.filter(p => PARKS.includes(p.sub));
  const pois = all.filter(p => p.sub !== 'attraction' || !parks.some(q => dist(ll(p), ll(q)) < 450));
  return pois.map(p => {
    let place = '', best = 6000;
    for (const q of places) { const d = dist(ll(p), ll(q)); if (d < best) { best = d; place = q.name; } }
    const kind = KIND_NL[p.sub] || '';
    const title = p.name || kind;
    return { lat: p.lat, lon: p.lon, title, sub: [p.name ? kind : '', place].filter(Boolean).join(' · '),
      name: [title, place].filter(Boolean).join(', '), d: dist(ll(at), ll(p)) };
  }).sort((a, b) => a.d - b.d);
}

// Rond een punt: eerst de 9 tegels eromheen (circa 2 km), zijn er te weinig dan 25 (circa 3,5 km).
// Een tegel in een stadscentrum is wel 300 kB: zijn de eerste 9 al zwaar, dan niet ruimer
// (dan vult Photon aan). 'enough': binnen het gezochte gebied zijn er zeker 'want' gevonden.
async function tileNear(cat, at, want) {
  const [cx, cy] = tileAt(at.lon, at.lat, POI_Z);
  const tileM = 40075016 * Math.cos(rad(at.lat)) / 2 ** POI_Z;
  let items = [];
  for (const k of [1, 2]) {
    const ids = [];
    for (let x = cx - k; x <= cx + k; x++) for (let y = cy - k; y <= cy + k; y++) ids.push([x, y]);
    const tiles = await Promise.all(ids.map(([x, y]) => poiTile(x, y)));
    items = tileItems(cat, tiles, at);
    if (items.filter(p => p.d <= k * tileM).length >= want) return { items: items.slice(0, 25), enough: true };
    if (tiles.reduce((t, x) => t + x.size, 0) > 3000000) break;
  }
  return { items, enough: false };
}

// Reserve: de zoekdienst Photon (ver weg, of als de tegels niet lukken)
async function photonNear(cat, at, km) {
  const include = Object.entries(NEAR[cat].tags).flatMap(([k, vs]) => vs.map(v => `osm.${k}.${v}`)).join(',');
  const params = new URLSearchParams({ lat: at.lat.toFixed(5), lon: at.lon.toFixed(5), radius: km, include, limit: '40' });
  const res = await fetch(`${PHOTON.replace('/api/', '/reverse')}?${params}`);
  if (!res.ok) throw new Error('dienst bezet (' + res.status + ')');
  // Laadpalen hebben vaak geen naam; die heten dan gewoon 'Laadpaal'
  return (await res.json()).features.filter(f => f.properties.name || cat === 'charging').map(f => {
    const pr = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const street = [pr.street, pr.housenumber].filter(Boolean).join(' ');
    const city = pr.city || pr.town || pr.village || '';
    const title = pr.name || KIND_NL[pr.osm_value] || 'Laadpaal';
    return { lat, lon, title, sub: [pr.name ? KIND_NL[pr.osm_value] || '' : '', street, city].filter(Boolean).join(' · '),
      name: [title, street, city].filter(Boolean).join(', '), d: dist([at.lon, at.lat], [lon, lat]) };
  }).sort((a, b) => a.d - b.d).slice(0, 25);
}

function renderCats() {
  const el = $('cats');
  el.hidden = listTab !== 'near';
  if (el.hidden || el.childElementCount) {
    el.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.cat === nearCat)));
    return;
  }
  for (const [key, c] of Object.entries(NEAR)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.cat = key;
    b.setAttribute('aria-checked', String(key === nearCat));
    b.innerHTML = `<i class="ti ${c.icon}" aria-hidden="true"></i>${c.label}`;
    b.addEventListener('click', () => {
      nearCat = key;
      try { localStorage.setItem('nearCat', key); } catch (e) { /* geen opslag */ }
      renderCats();
      showNear();
    });
    el.appendChild(b);
  }
}

// Plekken rond één punt: eerst binnen 4 km, is daar weinig dan binnen 25 km
// 'want': zoveel plekken zijn nodig (5 per reeks, 25 voor de lijst Dichtbij)
function nearList(cat, at, want = 5) {
  const key = cat + '|' + want + '|' + at.lat.toFixed(3) + '|' + at.lon.toFixed(3);
  if (!nearMemo.has(key)) {
    nearMemo.set(key, (async () => {
      const { items, enough } = await tileNear(cat, at, want);
      if (enough) return items;
      // Te weinig dichtbij (platteland, of een vol stadscentrum): Photon vult aan, tot 25 km
      const far = await photonNear(cat, at, 25).catch(() => []);
      const all = [...items];
      for (const p of far) if (!all.some(q => dist(ll(p), ll(q)) < 40)) all.push(p);
      return all.sort((a, b) => a.d - b.d).slice(0, 25);
    })().catch(e => { nearMemo.delete(key); throw e; }));
  }
  return nearMemo.get(key);
}

// De etappe waar de regel in valt: van het adres ervoor tot het adres erna
function nearLeg() {
  const prev = resolveStop(stops.slice(0, editRow).filter(Boolean).pop());
  const next = resolveStop(stops.slice(editRow + 1).find(Boolean));
  return { prev, next };
}
const stopLabel = s => s.here ? 'Je positie' : withoutPostcode(s.name).split(',')[0];

// Het punt op de route op afstand 'along' (meters vanaf het begin)
function alongPoint(n, along) {
  along = Math.max(0, Math.min(n.total, along));
  let i = 1;
  while (i < n.shape.length - 1 && n.cum[i] < along) i++;
  const seg = n.cum[i] - n.cum[i - 1], g = seg ? (along - n.cum[i - 1]) / seg : 0;
  const [p, q] = [n.shape[i - 1], n.shape[i]];
  return { lon: p[0] + g * (q[0] - p[0]), lat: p[1] + g * (q[1] - p[1]), along };
}

// Het punt op de autoroute van a naar b na 90 minuten rijden, als de rit langer is dan 2 uur
const LONG_LEG = 120 * 60, BREAK_AT = 90 * 60;
async function breakPoint(a, b) {
  const key = [a.lat, a.lon, b.lat, b.lon].map(v => v.toFixed(4)).join('|');
  if (!legMemo.has(key)) {
    legMemo.set(key, fetchRoutes([a, b], 0, 'auto').then(([n]) => {
      if (n.time <= LONG_LEG) return null;
      // Tijd per instructie optellen tot 90 minuten, daarbinnen naar rato van de afstand
      let t = 0;
      for (const m of n.maneuvers) {
        if (t + m.time < BREAK_AT) { t += m.time; continue; }
        const f = m.time ? (BREAK_AT - t) / m.time : 0;
        const along = n.cum[m.begin_shape_index] + f * (n.cum[m.end_shape_index] - n.cum[m.begin_shape_index]);
        return { ...alongPoint(n, along), nav: n };
      }
      return null;
    }).catch(e => { legMemo.delete(key); throw e; }));
  }
  return legMemo.get(key);
}

// Reistijden over de weg van elk punt in 'from' naar elk punt in 'to' (seconden, null = onbereikbaar)
async function travelTimes(from, to) {
  const body = { sources: from.map(p => ({ lat: p.lat, lon: p.lon })), targets: to.map(p => ({ lat: p.lat, lon: p.lon })), costing: 'auto' };
  const res = await fetch(`${VALHALLA}/sources_to_targets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.sources_to_targets) throw new Error(data.error || 'geen reistijden');
  return data.sources_to_targets.map(row => row.map(c => c.time));
}

// Rond 90 minuten: plekken langs de route, op volgorde van omrijtijd (niet hemelsbreed).
// Een tankstation aan de snelweg 8 km verder gaat zo voor een pomp 2 km ernaast in een dorp.
const midMemo = new Map();
function midList(cat, bp) {
  const key = cat + '|' + bp.lat.toFixed(4) + '|' + bp.lon.toFixed(4);
  if (!midMemo.has(key)) midMemo.set(key, rankMid(cat, bp).catch(e => { midMemo.delete(key); throw e; }));
  return midMemo.get(key);
}
async function rankMid(cat, bp) {
  const n = bp.nav;
  // De tegels langs de route, van 12 km ervoor tot 12 km erna, met 1 km speling opzij
  const ids = new Set(), dLat = 1000 / 111320;
  for (let a = bp.along - 12000; a <= bp.along + 12000; a += 400) {
    const q = alongPoint(n, a), dLon = dLat / Math.cos(rad(q.lat));
    const [x1, y1] = tileAt(q.lon - dLon, q.lat + dLat, POI_Z), [x2, y2] = tileAt(q.lon + dLon, q.lat - dLat, POI_Z);
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) ids.add(x + '/' + y);
  }
  const tiles = await Promise.all([...ids].map(k => poiTile(...k.split('/').map(Number))));
  const near = n.shape.filter((c, i) => Math.abs(n.cum[i] - bp.along) < 14000);
  const toRoute = p => Math.min(...near.map(c => dist(c, ll(p))));
  let cands = tileItems(cat, tiles, bp).map(p => ({ ...p, r: toRoute(p) })).filter(p => p.r <= 1000);
  // Weinig langs de route: ook Photon, iets verder van de weg
  if (cands.length < 5) {
    const seen = new Set(cands.map(p => p.lat.toFixed(4) + '|' + p.lon.toFixed(4)));
    const more = (await Promise.all([0, -8, 8].map(km => photonNear(cat, alongPoint(n, bp.along + km * 1000), 4.5).catch(() => [])))).flat();
    for (const p of more) {
      const k = p.lat.toFixed(4) + '|' + p.lon.toFixed(4);
      if (!seen.has(k)) { seen.add(k); cands.push({ ...p, d: dist(ll(bp), ll(p)), r: toRoute(p) }); }
    }
  }
  // De 25 die het dichtst bij de route liggen gaan mee in de reistijdberekening
  cands = cands.sort((a, b) => a.r - b.r).slice(0, 25);
  if (!cands.length) return [];
  // Omrijtijd: van 25 km vóór het punt via de plek naar 25 km erna, min de tijd zonder stop
  const from = alongPoint(n, bp.along - 25000), to = alongPoint(n, bp.along + 25000);
  try {
    const [[there], backRows] = await Promise.all([travelTimes([from], [...cands, to]), travelTimes(cands, [to])]);
    const base = there.pop(), back = backRows.map(r => r[0]);
    cands.forEach((p, i) => {
      p.extra = there[i] == null || back[i] == null ? Infinity : Math.max(0, there[i] + back[i] - base);
    });
    // Per hele minuut omrijden telt; bij gelijk de plek het dichtst bij 90 minuten
    cands.sort((a, b) => Math.round(a.extra / 60) - Math.round(b.extra / 60) || a.d - b.d);
    cands = cands.filter(p => p.extra !== Infinity);
  } catch (e) { /* zonder reistijden: hemelsbreed */ }
  return cands.slice(0, 10);
}
const fmtExtra = s => (s < 60 ? 'op route' : '+' + Math.round(s / 60) + ' min');

function nearItem(p, cat) {
  const li = document.createElement('li');
  li.className = 'recent';
  li.innerHTML = `<div class="row"><i class="ti ${NEAR[cat].icon}" aria-hidden="true"></i><div class="rtext"><div class="r1"></div><div class="r2"></div></div><span class="dist"></span></div>`;
  li.querySelector('.r1').textContent = p.title;
  li.querySelector('.r2').textContent = p.sub;
  li.querySelector('.dist').textContent = p.extra != null ? fmtExtra(p.extra) : fmtDist(p.d);
  li.addEventListener('click', () => useChoice({ lat: p.lat, lon: p.lon, name: p.name }));
  return li;
}

// Kopje boven een reeks, met daaronder de plekken (of een melding)
function nearSection(title, sub) {
  const head = document.createElement('li');
  head.className = 'sect';
  head.innerHTML = '<span class="st"></span><span class="ss"></span>';
  head.querySelector('.st').textContent = title;
  head.querySelector('.ss').textContent = sub || '';
  const note = document.createElement('li');
  note.className = 'empty';
  note.textContent = 'Zoeken…';
  return { head, note, fill(items, cat, route, all) {
    if (!items.length) { note.textContent = 'Niets gevonden.'; return; }
    note.replaceWith(...items.map(p => nearItem(p, cat)));
    // De kop opent de kaart met de eerste vijf plekken (bij één lijst: allemaal)
    const list = all ? items : items.slice(0, 5);
    head.classList.add('link');
    head.insertAdjacentHTML('beforeend', '<span class="go">Kaart<i class="ti ti-chevron-right" aria-hidden="true"></i></span>');
    head.setAttribute('role', 'button');
    head.addEventListener('click', () => { $('q').blur(); ms.nextStartPick = textFrom === 'start'; openMapSearch('row', 'near', editRow, { list, cat, route }); });
  } };
}

// In een etappe drie reeksen: dichtbij vertrek, na 90 minuten (lange autorit) en dichtbij aankomst.
// Zonder adres erna (je kiest de bestemming) één lijst rond het adres ervoor.
async function showNear() {
  const seq = ++searchSeq;
  const ul = $('results');
  ul.replaceChildren();
  const cat = nearCat;
  const { prev, next } = nearLeg();
  const key = p => p.lat.toFixed(4) + '|' + p.lon.toFixed(4);
  const fail = (sec, e) => { if (seq === searchSeq) sec.note.textContent = 'Zoeken lukt nu niet: ' + e.message; };
  if (!(prev && next)) {
    const at = editRow > 0 && prev || nearCentre();
    const sec = nearSection('Dichtbij', prev && editRow > 0 && !prev.here ? stopLabel(prev) : 'je positie');
    ul.append(sec.head, sec.note);
    try {
      const list = await nearList(cat, at, 25);
      if (seq === searchSeq) sec.fill(list, cat, null, true);
    } catch (e) { fail(sec, e); }
    return;
  }
  const from = nearSection('Dichtbij vertrek', stopLabel(prev));
  const to = nearSection('Dichtbij aankomst', stopLabel(next));
  // Is de etappe hemelsbreed korter dan 60 km, dan is hij nooit 2 uur rijden: niet uitrekenen
  const long = travelMode === 'auto' && dist(ll(prev), ll(next)) > 60000;
  const mid = long && nearSection('Na 90 minuten', 'Zoeken op de route…');
  ul.append(from.head, from.note, ...(mid ? [mid.head, mid.note] : []), to.head, to.note);
  // Alles tegelijk ophalen; de route voor 'na 90 minuten' meteen al uitrekenen
  const near = [nearList(cat, prev), nearList(cat, next)];
  const midP = mid && breakPoint(prev, next).then(async bp => ({ bp, all: bp ? await midList(cat, bp) : [] }));
  // Geen plek twee keer: vertrek gaat voor aankomst, en beide gaan voor na 90 minuten
  // (aankomst kan maar een half uur na dat punt liggen)
  const fromKeys = near[0].then(l => new Set(l.slice(0, 5).map(key)), () => new Set());
  const toList = Promise.all([fromKeys, near[1]]).then(([shown, l]) => l.filter(p => !shown.has(key(p))).slice(0, 5));
  const bothKeys = Promise.all([fromKeys, toList.catch(() => [])]).then(([f, t]) => new Set([...f, ...t.map(key)]));
  const fillFrom = (async () => {
    try {
      const a = (await near[0]).slice(0, 5);
      if (seq === searchSeq) from.fill(a, cat);
    } catch (e) { fail(from, e); }
  })();
  const fillTo = (async () => {
    try {
      const b = await toList;
      if (seq === searchSeq) to.fill(b, cat);
    } catch (e) { fail(to, e); }
  })();
  const fillMid = mid && (async () => {
    try {
      const { bp, all } = await midP;
      if (seq !== searchSeq) return;
      if (!bp) { mid.head.remove(); mid.note.remove(); return; }
      mid.head.querySelector('.ss').textContent = 'na ' + fmtDist(bp.along) + ' rijden';
      const shown = await bothKeys;
      if (seq !== searchSeq) return;
      mid.fill(all.filter(p => !shown.has(key(p))).slice(0, 5), cat, bp.nav.shape);
    } catch (e) { fail(mid, e); }
  })();
  await Promise.all([fillFrom, fillTo, fillMid]);
}

// Recente bestemmingen waarin elk getypt woord het begin van een woord is
// ("heem" en "rotter" vinden "Heemraadssingel, Rotterdam", "raad" niet)
const fold = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function matchRecent(q) {
  const words = fold(q).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set();
  return [...loadFavs(), ...loadRecent()].filter(d => {
    // Routes staan alleen in de lijsten Recent en Routes, niet tussen de zoekresultaten
    if (stopsOf(d) || seen.has(d.name)) return false;
    seen.add(d.name);
    const parts = fold(d.name + ' ' + favLabel(d)).split(/[^\p{L}\p{N}]+/u);
    return words.every(w => parts.some(p => p.startsWith(w)));
  }).slice(0, 5);
}

// Bij een leeg zoekveld: Recent, Favorieten, In de buurt of Routes
// De laatst gekozen tab blijft bewaard, ook als je de app opnieuw opent
let listTab = 'recent';
try { listTab = localStorage.getItem('listTab') || 'recent'; } catch (e) {}
function setListTab(tab) {
  listTab = tab;
  try { localStorage.setItem('listTab', tab); } catch (e) {}
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  // In de buurt en Routes: toetsenbord weg, dan zie je de hele lijst
  if (tab === 'near' || tab === 'routes') field().blur();
  showRecent();
}

function showRecent() {
  searchSeq++;
  firstResult = null;
  firstRecent = null;
  const ul = $('results');
  ul.innerHTML = '';
  renderCats();
  if (listTab === 'near') { showNear(); return; }
  if (listTab === 'routes') {
    const saved = bookmarked();
    if (!saved.length) ul.innerHTML = '<li class="empty">Nog geen routes. Tik bij Recent op het sterretje achter een route om hem hier te bewaren. Met het download-icoontje sla je de kaart op voor onderweg zonder bereik.</li>';
    for (const r of saved) ul.appendChild(savedItem(r));
    return;
  }
  const fav = listTab === 'fav';
  const list = fav ? loadFavs().filter(d => !stopsOf(d)) : loadRecent();
  if (!fav && (editRow === 0 || !stops.some(s => s && s.here))) ul.appendChild(hereItem());
  if (!list.length) {
    ul.insertAdjacentHTML('beforeend', `<li class="empty">${fav ? 'Nog geen favorieten. Tik bij Recent op het sterretje, of druk lang op de kaart en kies Plaats pin.' : 'Nog geen recente bestemmingen.'}</li>`);
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
}

// ---------- Het zoekscherm: tekst zoeken, overzicht en zoeken op kaart ----------
const PANES = ['textpane', 'overview', 'mapsearch'];
function showPane(id) {
  if (id !== 'mapsearch') leaveMsMap(false);
  for (const p of PANES) $(p).hidden = p !== id;
  toggleMapMenu(false);
  // Vervoer en kaartinstellingen staan in het overzicht en bovenin bij zoeken op kaart
  const row = $('moderow');
  if (id === 'mapsearch') $('mstop').appendChild(row);
  else if (id === 'overview' && row.parentElement !== $('overview')) $('overview').insertBefore(row, $('preview'));
}

function openSheet() {
  $('search').hidden = false;
  closePlaceMenu();
  clearLook();
  homeControls(false);
  modeAtOpen = travelMode;
  setTravelMode(travelMode);
  savedPick = null;
  streetCtx = null;
  firstResult = null;
  firstRecent = null;
}

// Tekst zoeken voor één adresregel
function showText(row, from) {
  editRow = row;
  textFrom = from;
  if (from === 'home' || from === 'start') listTab = 'recent';
  else try { listTab = localStorage.getItem('listTab') || 'recent'; } catch (e) { /* geen opslag */ }
  showPane('textpane');
  // Leeg veld, zodat de tabs te zien zijn; het huidige adres staat er grijs in
  const s = stops[row];
  const q = $('q');
  q.value = '';
  q.placeholder = s ? withoutPostcode(s.name) : row === 0 && (stops.length > 1 || from === 'start') ? 'Vertrekpunt zoeken' : row === stops.length - 1 ? 'Zoek adres of plaats' : 'Tussenstop zoeken';
  $('q-postcode').value = '';
  $('q-city').value = '';
  streetCtx = null;
  updateClear();
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === listTab)));
  showRecent();
  // Op iOS opent het toetsenbord alleen als focus direct binnen de tik gebeurt.
  // Alleen bij Recent: bij de andere tabs zie je zo de hele lijst.
  if (listTab === 'recent') q.focus();
}

// Waar naartoe?: alleen de bestemming invullen, vanaf het vertrekpunt boven het zoekveld.
// Zonder vertrekpunt (Zoek locatie): eerst het vertrekpunt kiezen.
function openSearch() {
  openSheet();
  if (homeStart === false) {
    stops = [null];
    showText(0, 'start');
    return;
  }
  stops = [homeStart || HERE, null];
  showText(1, 'home');
}

// Het gekozen vertrekpunt: terug naar het beginscherm, met Waar naartoe? en 'Vanaf …' erboven.
// De kaart gaat naar dat vertrekpunt (bij Huidige locatie: weer je eigen positie volgen).
function pickStart(d) {
  const p = d.here ? null : cleanPlace(d);
  setHomeStart(p);
  closeSearch();
  peek(false);
  if (!p) { follow(); return; }
  stopFollowing();
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15), bearing: 0, pitch: 0,
    padding: camPadding(), duration: 1400, essential: true });
}

// Wat er nu gepland staat: de lopende route, de conceptroute of alleen een gekozen vertrekpunt.
// Zet ook het vervoer van die route. Niets gepland: null.
function plannedStops() {
  const n = state.nav, c = state.concept;
  if (n) {
    setTravelMode(n.mode);
    return [HERE, ...n.legStops.slice(n.legIdx).map(place)];
  }
  if (c) {
    setTravelMode(c.mode);
    return c.stops.map(place);
  }
  // Geen vertrekpunt: een lege vertrekregel om in te vullen
  return homeStart ? [homeStart] : homeStart === false ? [null] : null;
}

// Potloodje: het overzicht van de route die loopt (of bekeken wordt)
function editRoute() {
  openSheet();
  stops = plannedStops() || [HERE, null];
  showOverview();
}

function closeSearch() {
  leaveMsMap(false);
  $('q').blur();
  $('search').hidden = true;
  homeControls(true);
  previewSeq++;
  ms.seq++;
  if (state.following && state.fix) updateCamera([state.fix.lon, state.fix.lat], 0);
  // De routekaart blijft bestaan: opnieuw opbouwen kost op de iPhone seconden.
  // De grote kaart om te zoeken gaat weg; die kost veel geheugen.
  previewTags.forEach(t => t.remove());
  previewTags = [];
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

// Bij een straat zonder huisnummer kun je het nummer er nog achter typen;
// de straat zelf staat dan als enige keuze in de lijst
function streetItem() {
  const li = document.createElement('li');
  li.innerHTML = '<div class="r1"></div><div class="r2">Typ het huisnummer, of tik hier voor de straat zelf</div>';
  li.querySelector('.r1').textContent = streetCtx.dest.name;
  const d = streetCtx.dest;
  li.addEventListener('click', () => { streetCtx = null; useChoice(d); });
  return li;
}

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
    updateClear();
    searchSeq++;
    $('results').replaceChildren(streetItem());
    return;
  }
  streetCtx = null;
  q.blur();
  useChoice(dest);
}

function searchQuery() {
  let q = field().value.trim();
  const extra = [$('q-postcode').value, $('q-city').value].map(v => v.trim()).filter(Boolean);
  if (extra.length) q = [q, ...extra].join(' ');
  else if (streetCtx && streetCtx.city && !q.toLowerCase().includes(streetCtx.city.toLowerCase())) q += ', ' + streetCtx.city;
  return q;
}

// Huisnummer achter een gekozen straat opzoeken
async function resolveHouse(num, seq, go) {
  const { street, city, dest: streetDest } = streetCtx;
  const params = new URLSearchParams({ q: `${street} ${num}, ${city}`, limit: '10' });
  if (state.fix) { params.set('lat', state.fix.lat); params.set('lon', state.fix.lon); }
  try {
    const data = await (await fetch(`${PHOTON}?${params}`)).json();
    if (seq !== searchSeq) return;
    const want = num.toLowerCase().replace(/\s+/g, '');
    const houses = data.features.filter(f => f.properties.housenumber && f.properties.street === street);
    const norm = f => f.properties.housenumber.toLowerCase().replace(/\s+/g, '');
    const f = houses.find(h => norm(h) === want) || houses.find(h => new RegExp('^' + want + '(\\D|$)').test(norm(h)));
    const ul = $('results');
    if (f) {
      const { title, sub } = describe(f.properties);
      const [lon, lat] = f.geometry.coordinates;
      const d = { lat, lon, name: [title, sub].filter(Boolean).join(', ') };
      if (go) { streetCtx = null; useChoice(d, title); return; }
      const li = document.createElement('li');
      li.innerHTML = '<div class="r1"></div><div class="r2"></div>';
      li.querySelector('.r1').textContent = title;
      li.querySelector('.r2').textContent = sub;
      li.addEventListener('click', () => { streetCtx = null; field().blur(); useChoice(d, title); });
      firstResult = { house: d, title };
      ul.replaceChildren(li, streetItem());
    } else {
      if (go) { streetCtx = null; useChoice(streetDest, `Nummer ${num} niet gevonden, route naar de straat`); return; }
      ul.replaceChildren(streetItem());
      ul.insertAdjacentHTML('afterbegin', `<li class="empty">Nummer ${num} niet gevonden</li>`);
    }
  } catch (e) {
    if (seq === searchSeq) $('results').innerHTML = '<li class="empty">Zoeken lukt nu niet. Controleer je verbinding.</li>';
  }
}

async function search() {
  const seq = ++searchSeq;
  const ul = $('results');
  const v = field().value;
  if (streetCtx && v.startsWith(streetCtx.street)) {
    const num = v.slice(streetCtx.street.length).trim();
    if (num) resolveHouse(num, seq, false);
    else ul.replaceChildren(streetItem());
    return;
  }
  const q = searchQuery();
  // Passende recente bestemmingen staan meteen bovenaan, nog voor de suggesties binnen zijn
  const recents = matchRecent(v);
  firstRecent = recents[0] || null;
  firstResult = null;
  ul.innerHTML = '';
  for (const d of recents) ul.appendChild(recentItem(d));
  if (q.length < 3) return;
  const known = new Set(recents.map(d => d.name));
  const local = publicMatches(v).filter(d => !known.has(d.name));
  for (const d of local) ul.appendChild(publicItem(d));
  const params = new URLSearchParams({ q, limit: '12' });
  if (state.fix) { params.set('lat', state.fix.lat); params.set('lon', state.fix.lon); }
  try {
    const res = await fetch(`${PHOTON}?${params}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    // Hetzelfde gebouw als uit de kaart (zelfde naam, vlakbij) niet nog een keer
    const same = f => local.some(d => d.name.toLowerCase() === describe(f.properties).title.toLowerCase() && dist([d.lon, d.lat], f.geometry.coordinates) < 300);
    const features = dedupe(data.features)
      .filter(f => { const { title, sub } = describe(f.properties); return !known.has([title, sub].filter(Boolean).join(', ')) && !same(f); })
      .slice(0, 8 - local.length);
    firstResult = features[0] || null;
    if (!firstResult && local.length) firstResult = local[0].feature;
    if (!features.length && !recents.length && !local.length) { ul.innerHTML = '<li class="empty">Niets gevonden</li>'; return; }
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

// Publieke gebouwen op de kaart waarvan de naam past, dichtstbij eerst
function publicMatches(v) {
  const t = v.trim().toLowerCase();
  if (t.length < 3) return [];
  const at = state.fix ? [state.fix.lon, state.fix.lat] : map.getCenter().toArray();
  return publicPlaces.filter(d => d.name.toLowerCase().includes(t))
    .sort((a, b) => dist(at, [a.lon, a.lat]) - dist(at, [b.lon, b.lat])).slice(0, 3)
    .map(d => ({ ...d, feature: { properties: { name: d.name }, geometry: { coordinates: [d.lon, d.lat] } } }));
}
function publicItem(d) {
  const li = document.createElement('li');
  li.innerHTML = '<div class="r1"></div><div class="r2"></div>';
  li.querySelector('.r1').textContent = d.name;
  li.querySelector('.r2').textContent = d.kind;
  li.addEventListener('click', () => choose(d.feature));
  return li;
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

function submitSearch() {
  if (streetCtx) {
    const num = field().value.slice(streetCtx.street.length).trim();
    if (num) resolveHouse(num, ++searchSeq, true);
    else { const d = streetCtx.dest; streetCtx = null; useChoice(d); }
  } else if (firstRecent) chooseRecent(firstRecent);
  else if (firstResult) choose(firstResult);
}

// ---------- Overzicht: adresregels en de route ----------
let pmap = null, previewNav = null, previewSeq = 0, previewData = null;

const pointFeature = (pt, kind) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { kind } });
// Begin blauw, tussenstops wit met blauwe rand, eind rood
function stopPoints(pts) {
  return { type: 'FeatureCollection', features: pts.map((p, i) => pointFeature(Array.isArray(p) ? p : [p.lon, p.lat],
    i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'via')) };
}
function endsPaint(dark, start = 13, end = 10, via = 9, width = 4) {
  const blue = dark ? '#3D8BFF' : '#1F6FE0';
  return { 'circle-radius': ['match', ['get', 'kind'], 'start', start, 'via', via, 'ghost', via, end], 'circle-stroke-width': width,
    'circle-stroke-color': ['match', ['get', 'kind'], 'via', blue, 'ghost', '#A9B4C2', '#ffffff'],
    'circle-color': ['match', ['get', 'kind'], 'start', blue, 'via', '#ffffff', 'ghost', '#ffffff', '#E5484D'],
    'circle-opacity': ['match', ['get', 'kind'], 'ghost', 0.7, 1], 'circle-stroke-opacity': ['match', ['get', 'kind'], 'ghost', 0.8, 1] };
}

function renderStops(fresh = -1) {
  const ul = $('stops');
  ul.innerHTML = '';
  stops.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'stop';
    li.dataset.i = i;
    const kind = i === 0 ? 'start' : i === stops.length - 1 ? 'end' : 'via';
    li.innerHTML = '<span class="grip" aria-label="Verslepen"><i class="ti ti-grip-vertical" aria-hidden="true"></i></span>'
      + `<span class="sdot k-${kind}" aria-hidden="true"></span>`
      + `<button type="button" class="sfield${!s ? ' empty' : s.here ? ' here' : ''}${i === fresh ? ' new' : ''}"></button>`
      + '<button type="button" class="sbtn" aria-label="Kies op de kaart"><i class="ti ti-map-pin" aria-hidden="true"></i></button>'
      + '<button type="button" class="sbtn x" aria-label="Regel weghalen"><i class="ti ti-x" aria-hidden="true"></i></button>';
    li.querySelector('.sfield').textContent = s ? withoutPostcode(s.name)
      : i === fresh ? 'Zoek adres of kies op kaart' : kind === 'start' ? 'Vertrekpunt' : kind === 'end' ? 'Bestemming' : 'Tussenstop';
    li.querySelector('.sfield').addEventListener('click', () => { if (!li.dataset.swiped) showText(i, 'overview'); });
    li.querySelector('.sbtn').addEventListener('click', () => openMapSearch('row', 'overview', i));
    li.querySelector('.x').addEventListener('click', () => removeRow(i));
    makeDraggable(li, li.querySelector('.grip'), list => {
      const order = [...list.children].map(el => stops[+el.dataset.i]);
      const moved = order.some((s2, k) => s2 !== stops[k]);
      stops = order;
      renderStops();
      if (moved) { savedPick = null; computePreview(); }
    });
    ul.appendChild(li);
  });
}

// Weghalen. Het vertrekpunt verdwijnt echt: de volgende regel wordt het vertrekpunt, ook als
// er dan maar één regel over is. Bij de andere regels blijven er twee over (dan wordt hij leeg).
function removeRow(i) {
  if (stops.length > 2 || (i === 0 && stops.length > 1)) stops.splice(i, 1); else stops[i] = null;
  savedPick = null;
  renderStops();
  computePreview();
}

// De grijze +: een lege regel vóór de bestemming; met alleen een vertrekpunt erachter
function addRow() {
  const at = stops.length > 1 ? stops.length - 1 : stops.length;
  stops.splice(at, 0, null);
  renderStops(at);
  const ul = $('stops');
  ul.scrollTop = ul.scrollHeight;
}

function showOverview(note) {
  showPane('overview');
  if (!stops.length) stops.push(null);
  renderStops();
  computePreview(note);
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
  const { coords, pts, routes, sel } = previewData;
  pmap.getSource('route').setData(lineFeature(coords));
  pmap.getSource('alts').setData({ type: 'FeatureCollection',
    features: (routes || []).map((r, i) => ({ ...lineFeature(r.shape), properties: { i } })).filter((_, i) => i !== sel) });
  pmap.getSource('ends').setData(stopPoints(pts));
  const all = (routes || []).flatMap(r => r.shape);
  if (!all.length) all.push(...(coords.length ? coords : pts.map(p => [p.lon, p.lat])));
  pmap.resize();
  if (all.length) {
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    pmap.fitBounds(b, { padding: 36, duration: 0, maxZoom: 16 });
  }
  drawAltTags();
}

function previewSummary(note, time, d) {
  const n = filled().length - 2;
  $('psum').textContent = (note ? note + ' · ' : '') + `${fmtDuration(time)} · ${fmtDist(d)} · ${MODE_LABEL[travelMode]}`
    + (n > 0 ? ` · ${n} ${n === 1 ? 'tussenstop' : 'tussenstops'}` : '');
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
  const style = await currentStyle(true);
  if (pmap || $('search').hidden) return;
  pmap = new maplibregl.Map({ container: 'pmap', style, interactive: false, attributionControl: false,
    center: state.fix ? [state.fix.lon, state.fix.lat] : [5.1214, 52.0907], zoom: 12, ...SMALL_MAP });
  pmap._dark = theme();
  pmap.on('style.load', () => {
    const dark = theme() === 'dark';
    addRouteLayers(pmap, []);
    // Kleine overzichtskaart: dunnere lijnen dan tijdens het rijden
    pmap.setPaintProperty('route-casing', 'line-width', 7);
    pmap.setPaintProperty('route-line', 'line-width', 4);
    pmap.addSource('alts', { type: 'geojson', data: EMPTY_FC });
    pmap.addLayer({ id: 'alts-casing', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 6 } }, 'route-casing');
    pmap.addLayer({ id: 'alts-line', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#5A6270' : '#A9B4C2', 'line-width': 3.5 } }, 'route-casing');
    pmap.addSource('ends', { type: 'geojson', data: EMPTY_FC });
    pmap.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: endsPaint(dark, 8, 8, 6, 3) });
    drawPreview();
  });
}

// Tik op een grijze route kiest hem; elders op de kaart: de route aanpassen op de grote kaart
$('pmap').addEventListener('click', e => {
  if (e.target.closest('.alttag')) return;
  if (pmap && pmap.getLayer('alts-line')) {
    const r = $('pmap').getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = pmap.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]], { layers: ['alts-line'] })[0];
    if (f) { selectAlt(f.properties.i); return; }
  }
  openMapSearch('edit', 'overview');
});

const MAX_DIST = { bicycle: 150000, pedestrian: 100000 };

// Maar één plek (geen route): de groene knop wordt een blauwe verrekijker
const lookMode = () => filled().length === 1 && !filled()[0].here;
function syncOk() {
  const look = lookMode(), b = $('qok');
  b.classList.toggle('okbig', !look);
  b.classList.toggle('lookbig', look);
  b.querySelector('.ti').className = 'ti ' + (look ? 'ti-binoculars' : 'ti-arrow-ramp-right');
  b.setAttribute('aria-label', look ? 'Bekijk op de kaart' : 'Navigatie starten');
}

// Verrekijker: naar het eerste (of enige) punt op de live kaart, met een pin erop
let lookMarker = null;
function clearLook() {
  if (lookMarker) { lookMarker.remove(); lookMarker = null; }
}
function lookAt() {
  const p = resolveStop(filled()[0]);
  if (!p) return;
  saveRecent(place(p));
  closeSearch();
  // Een lopende route (of conceptroute) maakt plaats voor deze plek
  stopRoute(true);
  stopFollowing();
  // Deze plek is nu het vertrekpunt: verder zoeken (tekst of kaart) gaat vanaf hier
  if (!p.here) setHomeStart(cleanPlace(p));
  const el = document.createElement('div');
  el.className = 'lookpin';
  el.innerHTML = '<svg viewBox="0 0 36 48" aria-hidden="true"><path d="M18 46.5C18 46.5 34 28.5 34 17A16 16 0 0 0 2 17C2 28.5 18 46.5 18 46.5Z"/><circle cx="18" cy="17" r="6"/></svg>';
  clearLook();
  lookMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
  map.flyTo({ center: [p.lon, p.lat], zoom: 16, bearing: 0, pitch: camPitch(), padding: camPadding(), duration: 1600, essential: true });
}

async function computePreview(note) {
  const list = filled();
  $('qok').disabled = true;
  previewNav = null;
  const seq = ++previewSeq;
  await ensurePreviewMap();
  if (seq !== previewSeq) return;
  const pts = list.map(resolveStop);
  const noRoute = msg => {
    previewData = { coords: [], pts: pts.filter(Boolean), routes: null, sel: 0, note };
    drawPreview();
    $('psum').textContent = msg;
  };
  syncOk();
  if (lookMode()) {
    noRoute('Eén plek: bekijk hem op de kaart');
    $('qok').disabled = false;
    return;
  }
  if (list.length < 2) { noRoute(list.length ? 'Vul nog een adres in' : 'Kies waar je heen wilt'); return; }
  if (pts.some(p => !p)) { noRoute('Nog geen GPS-positie voor "Huidige locatie"'); return; }
  // Fietsen en lopen rekent de routedienst niet verder dan 150 en 100 km hemelsbreed
  const max = MAX_DIST[travelMode];
  const span = pts.slice(1).reduce((s, p, i) => s + dist([pts[i].lon, pts[i].lat], [p.lon, p.lat]), 0);
  // Verder dan dat: dan met de auto
  if (max && span > max) {
    setTravelMode('auto');
    savedPick = null;
  }
  noRoute('Route berekenen…');
  try {
    // Gedownloade route: zonder internet uit de opslag. Anders de snelste, en bij alleen
    // vertrek en bestemming maximaal twee alternatieven
    const sp = savedPick;
    const routes = sp && sp.sig === sigOf(list, travelMode) ? [freshNav(sp.nav)] : await fetchWithShort(pts);
    if (seq !== previewSeq) return;
    for (const r of routes) r.legStops = pts.slice(1);
    // De snelste eerst. Met de auto mag de zuinigste (met het blaadje) voor, als hij hooguit
    // twee minuten langzamer is: liever iets korter dan een omweg over de snelweg.
    const mins = r => Math.round(r.time / 60);
    if (routes.length > 1) routes.sort((a, b) => mins(a) - mins(b) || (travelMode === 'auto' ? fuel(a) - fuel(b) : 0));
    if (travelMode === 'auto' && routes.length > 1) {
      const near = routes.filter(r => r.time <= routes[0].time + ECO_SLACK);
      const eco = near.reduce((a, b) => (fuel(b) < fuel(a) ? b : a));
      routes.splice(routes.indexOf(eco), 1);
      routes.unshift(eco);
    }
    previewNav = routes[0];
    previewData = { coords: previewNav.shape, pts, routes, sel: 0, note };
    drawPreview();
    previewSummary(note, previewNav.time, previewNav.total);
    $('qok').disabled = false;
  } catch (e) {
    if (seq === previewSeq) noRoute('Route berekenen lukt niet: ' + e.message);
  }
}

// Naam van een plek: dichtstbijzijnde adres, anders de coördinaten
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

function confirmPreview() {
  if (!previewNav) return;
  const list = filled();
  const nav = previewNav;
  previewNav = null;
  const fromHere = list[0].here;
  saveRecent(fromHere && list.length === 2 ? place(list[1]) : routeEntry(list, travelMode));
  rememberRoute(nav.legStops ? [resolveStop(list[0]), ...nav.legStops] : list.map(resolveStop), travelMode, nav);
  setHomeStart(null);
  closeSearch();
  // Eigen vertrekpunt: de route alleen tonen (gestippeld), niet navigeren
  if (!fromHere) {
    showConcept({ nav, stops: list, mode: travelMode });
    return;
  }
  clearConcept(true);
  // Zelfde bestemming opnieuw berekend: het blauwe beginpunt blijft waar je vertrok
  const dest = list[list.length - 1];
  const same = state.nav && state.dest && state.dest.name === dest.name;
  state.navStart = same && state.navStart || nav.shape[0];
  state.dest = dest;
  state.nav = nav;
  nav.legIdx = 0;
  shownLeg = -1;
  state.lastRouteAt = Date.now();
  if (DEMO) demo.along = 0;
  setMode('nav');
  // Echte navigatie: de live kaart volgt meteen je eigen positie, gekanteld en in de rijrichting
  follow();
  if (state.fix) updateNav([state.fix.lon, state.fix.lat]);
}

// ---------- Zoeken op kaart ----------
// De pin staat vast in het midden; je schuift de kaart eronder. Drie soorten:
// 'build' (vanaf home: punten zetten en verder kiezen), 'edit' (de hele route aanpassen)
// en 'row' (één adresregel kiezen, met de route erbij).
let msmap = null;
const ms = { kind: 'build', back: 'home', row: 0, prefix: [], pts: [], legs: [], action: null, hover: { type: 'free' }, seq: 0, ui: '', pois: null };
const ll = p => [p.lon, p.lat];

// 'pois' (alleen bij 'row'): plekken uit In de buurt, genummerd op de kaart, met hun route
async function openMapSearch(kind, back, row = 0, pois = null) {
  ms.kind = kind;
  ms.pois = pois;
  // Het vertrekpunt van het beginscherm kiezen (Zoek locatie): ✓ gaat terug naar het beginscherm
  ms.startPick = !!ms.nextStartPick;
  ms.nextStartPick = false;
  msMarkers();
  ms.back = back;
  ms.row = row;
  ms.action = null;
  ms.hover = { type: 'free' };
  ms.ui = '';
  ms.seq++;
  ms.prefix = [];
  ms.pts = [];
  ms.legs = [];
  // Een nieuwe route maak je meteen; een bestaande bekijk je eerst (potlood), met + ga je toevoegen
  ms.adding = kind === 'build';
  // front: met de grote + punten vóór het vertrekpunt zetten (de route groeit naar achteren)
  ms.front = false;
  ms.fresh = null;
  const list = filled();
  if (kind !== 'row') {
    // Nieuwe route of bestaande aanpassen werkt hetzelfde: je eigen positie is het eerste punt.
    // Zonder GPS kan die niet op de kaart; hij blijft dan gewoon vooraan.
    if (list[0] && list[0].here && !state.fix) ms.prefix = [list[0]];
    ms.pts = list.slice(ms.prefix.length).map(resolveStop).filter(Boolean);
    // De berekende route meteen tonen, per etappe; anders etappe voor etappe uitrekenen
    const n = kind === 'edit' && previewData && previewData.routes && previewData.routes[previewData.sel];
    ms.legs = ms.pts.slice(1).map(() => null);
    if (n && n.legs && n.legs.length === ms.legs.length && !ms.prefix.length) {
      let from = 0;
      ms.legs = n.legs.map(l => { const s = n.shape.slice(from, l.endIdx + 1); from = l.endIdx; return s; });
    }
  } else {
    ms.pts = list.map(resolveStop).filter(Boolean);
  }
  showPane('mapsearch');
  ensureMsMap();
  if (!msmap) return;
  // Waar de kaart begint
  const target = pois ? null : kind === 'row' ? stops[row] && resolveStop(stops[row]) || resolveStop(stops[row - 1]) || hereNow()
    : kind === 'build' ? hereNow() : null;
  const routeCoords = kind === 'row' && previewData ? previewData.coords : ms.legs.flat();
  const all = pois ? pois.list.map(ll) : [...routeCoords, ...ms.pts.map(ll)];
  // Vanaf het beginscherm blijft de kaart precies staan zoals hij stond
  const keep = ms.keep;
  ms.keep = false;
  if (keep) msTilt(false, msmap.getPitch());
  else msmap.jumpTo({ pitch: 0, bearing: 0 });
  if (keep) { /* niets verschuiven */ }
  else if (target) msmap.jumpTo({ center: ll(target), zoom: 15.5 });
  else if (all.length) {
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    msmap.fitBounds(b, { padding: { top: pois ? 130 : 90, bottom: 190, left: 40, right: 40 }, duration: 0, maxZoom: 16 });
  } else {
    const c = map.getCenter();
    msmap.jumpTo({ center: c, zoom: 15 });
  }
  if (!keep) msTilt(false);
  ms.start = { c: msmap.getCenter(), z: msmap.getZoom() };
  msDraw();
  msMarkers();
  ms.legs.forEach((l, i) => { if (!l) computeLeg(i); });
}

// Zoeken op de kaart gebruikt de hoofdkaart zelf: die verhuist zolang naar het zoekscherm.
// Geen tweede kaart die moet laden (geen flits) en geen extra geheugen.
const MAIN_LAYERS = ['route-casing', 'route-line', 'route-ends', 'concept-line', 'concept-ends'];
function showMainLayers(on) {
  for (const id of MAIN_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
const MS_LAYERS = ['old-line', 'ms-casing', 'ms-line', 'guide', 'pts'];
const MS_SOURCES = ['old', 'msroute', 'guide', 'pts'];

function ensureMsMap() {
  if (msmap) return;
  // Een lopende kaartbeweging eerst stoppen, anders verspringt het beeld. Vloog de kaart
  // net terug naar je positie, dan meteen naar waar hij heen ging.
  map.stop();
  if (state.following && state.fix && Date.now() < (state.easeUntil || 0)) {
    map.jumpTo({ center: [state.fix.lon, state.fix.lat], zoom: state.zoom, bearing: camBearing(),
      pitch: camPitch(), padding: camPadding() });
  }
  // Hoe de kaart stond, om hem zo terug te zetten
  ms.saved = { cam: { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() },
    following: state.following, maxPitch: map.getMaxPitch() };
  msmap = map;
  // De pin staat midden in beeld: zonder de ruimte boven die je eigen positie lager zet,
  // maar met hetzelfde beeld
  const el = map.getContainer();
  const mid = map.unproject([el.clientWidth / 2, el.clientHeight / 2]);
  $('msmap').appendChild(el);
  map.resize();
  map.jumpTo({ center: mid, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  showCar();
  showMainLayers(false);
  if (map.style && map.style._loaded && !map.getSource('pts')) addMsLayers(map);
  if (!ms.moveHook) {
    ms.moveHook = true;
    let raf = 0;
    map.on('move', () => { if (msmap && !raf) raf = requestAnimationFrame(() => { raf = 0; if (msmap) msMove(); }); });
  }
}

// Terug naar het beginscherm. stay: blijft de kaart waar je hem hebt neergezet
// (alleen als je hem verschoven hebt); anders staat hij weer zoals voor het zoeken.
function leaveMsMap(stay) {
  if (!msmap) return;
  const sv = ms.saved;
  ms.pois = null;
  msMarkers();
  for (const id of MS_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of MS_SOURCES) if (map.getSource(id)) map.removeSource(id);
  showMainLayers(true);
  map.setMaxPitch(sv.maxPitch);
  msmap = null;
  $('mapsearch').classList.remove('over');
  document.body.insertBefore(map.getContainer(), document.body.firstChild);
  map.resize();
  const moved = ms.start && (Math.abs(map.getZoom() - ms.start.z) > 0.05 || dist(map.getCenter().toArray(), ms.start.c.toArray()) > 10);
  if (stay && moved) {
    state.following = true;   // zodat stopFollowing het pijltje op de kaart zet
    stopFollowing();
    return;
  }
  map.jumpTo(sv.cam);
  if (sv.following) {
    state.following = true;
    $('recenter').hidden = true;
    showCar();
  } else {
    state.following = true;
    stopFollowing();
  }
}

// Kantelen kan alleen in 3D: twee vingers samen omhoog of omlaag. De kaart opent altijd
// plat (en met het noorden boven, behalve vanaf het beginscherm: daar blijft hij zoals hij stond).
// Draaien kan altijd; het kompas zet het noorden weer boven.
function msTilt(animate, keep) {
  if (!msmap) return;
  msmap.setMaxPitch(mapKind === 'terrain' ? 70 : Math.min(70, keep || 0));
}

function addMsLayers(m) {
  const dark = theme() === 'dark';
  m.addSource('old', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'old-line', type: 'line', source: 'old', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#5A6270' : '#A9B4C2', 'line-width': 6 } });
  m.addSource('msroute', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'ms-casing', type: 'line', source: 'msroute',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 10 } });
  m.addLayer({ id: 'ms-line', type: 'line', source: 'msroute',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#3D8BFF' : '#1F6FE0', 'line-width': 6 } });
  m.addSource('guide', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'guide', type: 'line', source: 'guide', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#f2f2f7' : '#1c1c1e', 'line-width': 2.2, 'line-dasharray': [3, 2.5], 'line-opacity': 0.75 } });
  m.addSource('pts', { type: 'geojson', data: EMPTY_FC });
  m.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: { ...endsPaint(dark, 9, 8, 7, 3.5), 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport' } });
  scaleLines(m, { 'ms-casing': 10, 'ms-line': 6, 'old-line': 6, guide: 2.2 });
}

// Tekent de route, de punten en (tijdens een wijziging) de oude stukken in grijs
function msDraw() {
  if (!msmap || !msmap.getSource('pts')) return;
  const a = ms.action;
  const oldLegs = new Set();
  if (a && a.type === 'insert') oldLegs.add(a.i);
  if (a && a.type === 'move') { oldLegs.add(a.i - 1); oldLegs.add(a.i); }
  let solid;
  if (ms.pois && ms.pois.route) solid = [lineFeature(ms.pois.route)];
  else if (ms.kind === 'row') solid = previewData && previewData.coords.length ? [lineFeature(previewData.coords)] : [];
  else solid = ms.legs.map((l, i) => (l && !oldLegs.has(i) ? lineFeature(l) : null)).filter(Boolean);
  msmap.getSource('msroute').setData({ type: 'FeatureCollection', features: solid });
  msmap.getSource('old').setData({ type: 'FeatureCollection',
    features: [...oldLegs].filter(i => ms.legs[i]).map(i => lineFeature(ms.legs[i])) });
  const fc = stopPoints(ms.pts);
  if (a && a.type === 'move') fc.features[a.i].properties.kind = 'ghost';
  // Je eigen positie altijd als blauwe stip, ook als die (nog) geen adresregel is
  const me = hereNow();
  if (me && !ms.pts.some(p => p.here)) fc.features.unshift(pointFeature(ll(me), 'start'));
  msmap.getSource('pts').setData(fc);
  msMove(true);
}

// Waar staat de pin: op een punt, op de route, of vrij. Daarbij hoort het actiekaartje.
function msHover() {
  const cv = msmap.getCanvas();
  const c = { x: cv.clientWidth / 2, y: cv.clientHeight / 2 };
  // Plekken uit In de buurt: staat de pin erop, dan kies je die plek
  if (ms.pois && !ms.action) {
    let best = null;
    ms.pois.list.forEach((p, i) => {
      const q = msmap.project(ll(p));
      const d = Math.hypot(q.x - c.x, q.y - c.y);
      if (d < 24 && (!best || d < best.d)) best = { type: 'poi', i, d };
    });
    if (best) return best;
  }
  if (ms.kind === 'row' || ms.action) return { type: 'free' };
  // Net een punt neergezet: pas wijzigen als je er weggeweest bent en terugkomt
  if (ms.fresh) {
    const q = msmap.project(ll(ms.fresh));
    if (ms.pts.includes(ms.fresh) && Math.hypot(q.x - c.x, q.y - c.y) < 24) return { type: 'free' };
    ms.fresh = null;
  }
  let best = null;
  ms.pts.forEach((p, i) => {
    // Alleen je eigen positie, nog zonder route: daar valt niets te wijzigen
    if (ms.pts.length === 1 && p.here) return;
    const q = msmap.project(ll(p));
    const d = Math.hypot(q.x - c.x, q.y - c.y);
    if (d < 24 && (!best || d < best.d)) best = { type: 'wp', i, d };
  });
  if (best) return best;
  ms.legs.forEach((l, i) => {
    const line = l || [ll(ms.pts[i]), ll(ms.pts[i + 1])];
    const step = Math.max(1, Math.ceil(line.length / 400));
    let prev = msmap.project(line[0]);
    for (let k = step; k < line.length + step - 1; k += step) {
      const q = msmap.project(line[Math.min(k, line.length - 1)]);
      const dx = q.x - prev.x, dy = q.y - prev.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((c.x - prev.x) * dx + (c.y - prev.y) * dy) / len2)) : 0;
      const d = Math.hypot(prev.x + t * dx - c.x, prev.y + t * dy - c.y);
      if (d < 16 && (!best || d < best.d)) best = { type: 'seg', i, d };
      prev = q;
    }
  });
  return best || { type: 'free' };
}

function msMove(force) {
  if (!msmap || !msmap.getSource('guide')) return;
  ms.hover = msHover();
  const c = msmap.getCenter().toArray();
  const a = ms.action, P = ms.pts;
  let guide = [];
  if (a && a.type === 'insert') guide = [[ll(P[a.i]), c, ll(P[a.i + 1])]];
  else if (a && a.type === 'move') guide = [[P[a.i - 1] && ll(P[a.i - 1]), c, P[a.i + 1] && ll(P[a.i + 1])].filter(Boolean)];
  // Toevoegen: hulplijn vanaf het laatste punt van de route, zonder punten vanaf je telefoon
  else if (!a && ms.adding && ms.kind !== 'row' && ms.hover.type === 'free') {
    const from = P.length ? ll(P[ms.front ? 0 : P.length - 1]) : hereNow() && ll(hereNow());
    if (from) guide = [[from, c]];
  }
  // Eén adresregel wijzigen: hulplijn van de regel ervoor, via de pin, naar de regel erna
  else if (!a && ms.kind === 'row' && !ms.pois) {
    const prev = resolveStop(stops[ms.row - 1]), next = resolveStop(stops[ms.row + 1]);
    guide = [[prev && ll(prev), c, next && ll(next)].filter(Boolean)];
  }
  // Terug bij het vertrekpunt: de hulplijn blijft, ✓ maakt er een rondje van
  else if (!a && roundTrip()) guide = [[ll(P[ms.front ? 0 : P.length - 1]), ll(P[ms.front ? P.length - 1 : 0])]];
  // Etappes die nog berekend worden: een rechte hulplijn
  if (ms.kind !== 'row') ms.legs.forEach((l, i) => { if (!l) guide.push([ll(P[i]), ll(P[i + 1])]); });
  msmap.getSource('guide').setData({ type: 'FeatureCollection', features: guide.filter(g => g.length > 1).map(lineFeature) });
  msUi(force);
}

const actBtn = (cls, icon, label, fn) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'roundbtn ' + cls;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>`;
  b.addEventListener('click', e => { e.stopPropagation(); fn(); });
  return b;
};
const ACT_TEXT = { insert: ['ti-plus', 'Punt'], move: ['ti-arrows-move', 'Verplaats'] };

// Knoppen en hint; alleen opnieuw opbouwen als er iets verandert
function msUi(force) {
  const a = ms.action, h = ms.hover;
  const key = [ms.kind, a && a.type, h.type, h.i, ms.pts.length, ms.adding, ms.front].join('|');
  if (key === ms.ui && !force) return;
  ms.ui = key;
  $('mbtns').classList.toggle('dim', !!a);
  if (ms.markers) ms.markers.forEach((m, i) => m.getElement().classList.toggle('on', h.type === 'poi' && h.i === i));
  $('mapsearch').classList.toggle('over', !a && (h.type === 'wp' || h.type === 'seg' || (!ms.adding && ms.kind !== 'row')));
  // Aan het toevoegen: + blauw en ✓ groen
  const adding = ms.adding && ms.kind !== 'row';
  $('msadd').className = 'roundbtn ' + (adding ? 'viewbig' : 'addbig');
  $('msok').className = 'roundbtn ' + (adding || h.type === 'poi' ? 'okbig' : 'addbig');
  $('msadd').hidden = ms.kind === 'row' || !!a || h.type !== 'free';
  const card = $('actcard');
  card.replaceChildren();
  if (a) {
    const [icon, text] = ACT_TEXT[a.type];
    const lbl = document.createElement('span');
    lbl.className = 'lbltxt';
    lbl.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>${text}`;
    const sep = document.createElement('span');
    sep.className = 'sep';
    card.append(lbl, sep, actBtn('addbig', 'ti-arrow-back-up', 'Annuleren', msCancel), actBtn('okbig', 'ti-check', 'Bevestigen', msConfirm));
  } else if (h.type === 'poi') {
    const p = ms.pois.list[h.i];
    const lbl = document.createElement('span');
    lbl.className = 'lbltxt poitxt';
    lbl.innerHTML = `<i class="ti ${NEAR[ms.pois.cat].icon}" aria-hidden="true"></i><span class="pt"><b></b><small></small></span>`;
    lbl.querySelector('b').textContent = p.title;
    lbl.querySelector('small').textContent = [p.extra != null ? fmtExtra(p.extra) : fmtDist(p.d), p.sub].filter(Boolean).join(' · ');
    const sep = document.createElement('span');
    sep.className = 'sep';
    card.append(lbl);
  } else if (h.type === 'seg') {
    card.append(actBtn('viewbig', 'ti-plus', 'Hier een routepunt invoegen', () => msStart({ type: 'insert', i: h.i })));
  } else if (h.type === 'wp') {
    card.append(actBtn('yellowbig', 'ti-minus', 'Dit punt verwijderen', () => msRemove(h.i)),
      actBtn('addbig', 'ti-arrows-move', 'Dit punt verplaatsen', () => msStart({ type: 'move', i: h.i })));
    // Vertrek- of eindpunt: vanaf daar verder 'plussen' met de grote +
    const n = ms.pts.length, end = h.i === 0 ? 'front' : h.i === n - 1 ? 'back' : null;
    if (n > 1 && end && !(ms.adding && ms.front === (end === 'front'))) {
      card.append(actBtn('viewbig', 'ti-plus', end === 'front' ? 'Punten toevoegen vóór het vertrekpunt' : 'Punten toevoegen na het eindpunt',
        () => msFrom(end === 'front')));
    }
  }
  card.hidden = !card.childElementCount;
  const hint = a && a.type === 'insert' ? 'Schuif de kaart naar het nieuwe punt'
    : a && a.type === 'move' ? 'Schuif de kaart naar de nieuwe plek'
    : ms.pois ? (h.type === 'poi' ? '' : 'Tik op een plek of schuif de kaart')
    : ms.kind === 'row' ? 'Schuif de kaart tot de pin op de goede plek staat'
    : !ms.pts.some(p => !p.here) ? 'Schuif de kaart tot de pin goed staat' : '';
  $('mshint').textContent = hint;
  $('mshint').hidden = !hint;
}

// Aan het toevoegen en de pin staat op het andere uiteinde van de route
const roundTrip = () => ms.adding && ms.kind !== 'row' && ms.hover.type === 'wp' && ms.pts.length > 1
  && ms.hover.i === (ms.front ? ms.pts.length - 1 : 0);

// Toevoegen vanaf het vertrekpunt (front) of vanaf het eindpunt
function msFrom(front) {
  ms.adding = true;
  ms.front = front;
  // De pin staat nu op dat punt: pas iets doen als je wegschuift
  ms.fresh = ms.pts[front ? 0 : ms.pts.length - 1];
  msMove(true);
}

function msStart(action) {
  ms.action = action;
  msDraw();
}
// Verwijderen hoeft niet bevestigd te worden
function msRemove(i) {
  ms.action = { type: 'remove', i };
  msConfirm();
}
function msCancel() {
  ms.action = null;
  msDraw();
}

// Een nieuw punt op de plek van de pin; de naam (het adres) komt erachteraan
function pinPlace() {
  const { lng: lon, lat } = msmap.getCenter();
  return placeAt(lat, lon);
}
function placeAt(lat, lon) {
  const p = { lat, lon, name: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  p.naming = placeName(lat, lon).then(n => { p.name = n; });
  return p;
}

function msConfirm() {
  const a = ms.action;
  if (!a) return;
  const P = ms.pts, L = ms.legs;
  const redo = [];
  if (a.type === 'insert') {
    P.splice(a.i + 1, 0, ms.fresh = pinPlace());
    L.splice(a.i, 1, null, null);
    redo.push(a.i, a.i + 1);
  } else if (a.type === 'move') {
    P[a.i] = ms.fresh = pinPlace();
    if (a.i > 0) { L[a.i - 1] = null; redo.push(a.i - 1); }
    if (a.i < L.length) { L[a.i] = null; redo.push(a.i); }
  } else {
    P.splice(a.i, 1);
    if (a.i === 0) L.splice(0, 1);
    else if (a.i >= L.length) L.splice(a.i - 1, 1);
    else { L.splice(a.i - 1, 2, null); redo.push(a.i - 1); }
  }
  ms.action = null;
  msDraw();
  redo.forEach(computeLeg);
}

// De blauwe +: hier een punt zetten en verder kiezen; het stuk ernaartoe wordt meteen berekend
function msAdd() {
  if (ms.action || ms.kind === 'row') return;
  // De eerste tik zet het toevoegen aan: pin en hulplijn verschijnen
  if (!ms.adding) { ms.adding = true; ms.front = false; msMove(true); return; }
  // Vóór het vertrekpunt: het nieuwe punt wordt het vertrekpunt
  if (ms.front) {
    ms.pts.unshift(ms.fresh = pinPlace());
    if (ms.pts.length > 1) { ms.legs.unshift(null); computeLeg(0); }
  } else {
    ms.pts.push(ms.fresh = pinPlace());
    if (ms.pts.length > 1) {
      ms.legs.push(null);
      computeLeg(ms.legs.length - 1);
    }
  }
  msDraw();
}

// Eén etappe over de weg uitrekenen; klopt de etappe daarna niet meer (punt verplaatst), dan vervalt hij
async function computeLeg(i) {
  const a = ms.pts[i], b = ms.pts[i + 1], seq = ms.seq;
  if (!a || !b) return;
  try {
    const [r] = await fetchRoutes([a, b], 0);
    if (seq !== ms.seq) return;
    const j = ms.pts.findIndex((p, k) => p === a && ms.pts[k + 1] === b);
    if (j < 0 || j >= ms.legs.length) return;
    ms.legs[j] = r.shape;
    msDraw();
  } catch (e) { /* de rechte hulplijn blijft staan */ }
}

// Genummerde plekken (1 = minste omweg); tikken schuift de kaart erheen, ✓ kiest
function msMarkers() {
  (ms.markers || []).forEach(m => m.remove());
  ms.markers = null;
  if (!ms.pois || !msmap) return;
  ms.markers = ms.pois.list.map((p, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'poimark';
    el.textContent = i + 1;
    el.setAttribute('aria-label', p.title);
    el.addEventListener('click', e => { e.stopPropagation(); msmap.easeTo({ center: ll(p) }); });
    const m = new maplibregl.Marker({ element: el }).setLngLat(ll(p)).addTo(msmap);
    // De beste bovenop als ze overlappen
    el.style.zIndex = 20 - i;
    el.setAttribute('aria-label', (i + 1) + ': ' + p.title);
    return m;
  });
  ms.ui = '';
  msUi();
}

const cleanPlace = p => (p.here ? HERE : { lat: p.lat, lon: p.lon, name: p.name });

async function msOk() {
  if (ms.action || !msmap) return;
  if (ms.kind === 'row') {
    const poi = ms.hover.type === 'poi' && ms.pois.list[ms.hover.i];
    stops[ms.row] = poi ? { lat: poi.lat, lon: poi.lon, name: poi.name } : pinPlace();
    streetCtx = null;
  } else {
    // Aan het toevoegen en de pin staat vrij: die plek is het laatste punt (de hulplijn liep ernaartoe)
    const last = ms.pts[ms.front ? 0 : ms.pts.length - 1];
    const c = msmap.getCenter().toArray();
    const put = q => (ms.front ? ms.pts.unshift(q) : ms.pts.push(q));
    if (ms.adding && ms.hover.type === 'free' && (!last || dist(ll(last), c) > 15)) put(pinPlace());
    // Rondje: de route komt terug bij het andere uiteinde (als vaste plek, ook als dat je eigen positie was)
    else if (roundTrip()) {
      const s = ms.pts[ms.front ? ms.pts.length - 1 : 0];
      put(s.here ? placeAt(s.lat, s.lon) : { lat: s.lat, lon: s.lon, name: s.name });
    }
    if (ms.prefix.length + ms.pts.length < 2) { toast('Schuif de kaart naar je bestemming en tik op ✓.'); return; }
    stops = [...ms.prefix, ...ms.pts];
  }
  const naming = stops.filter(s => s && s.naming).map(s => s.naming);
  if (naming.length) {
    $('msok').disabled = true;
    await Promise.all(naming);
    $('msok').disabled = false;
  }
  stops = stops.map(s => s && cleanPlace(s));
  if (ms.startPick && ms.kind === 'row') {
    const d = stops[ms.row];
    leaveMsMap(true);
    pickStart(d);
    return;
  }
  savedPick = null;
  showOverview();
}

function msBack() {
  if (ms.action) { msCancel(); return; }
  ms.seq++;
  if (ms.back === 'overview') { showPane('overview'); renderStops(); return; }
  if (ms.back === 'text') { showPane('textpane'); $('q').focus(); return; }
  if (ms.back === 'near') { showPane('textpane'); return; }
  setTravelMode(modeAtOpen);
  leaveMsMap(true);
  closeSearch();
}

// Ander vervoer op de kaart: alle etappes opnieuw
function msRecompute() {
  ms.seq++;
  ms.legs = ms.legs.map(() => null);
  msDraw();
  ms.legs.forEach((_, i) => computeLeg(i));
}

$('where').addEventListener('click', openSearch);
$('wheremap').addEventListener('click', () => {
  openSheet();
  // Zonder vertrekpunt: met de pin het vertrekpunt kiezen
  if (homeStart === false) {
    stops = [null];
    textFrom = 'start';
    ms.keep = true;
    ms.nextStartPick = true;
    openMapSearch('row', 'home', 0);
    return;
  }
  stops = [homeStart || HERE];
  // Dezelfde kaart, die blijft staan zoals hij stond
  ms.keep = true;
  openMapSearch('build', 'home');
});
$('edit').addEventListener('click', editRoute);
$('qback').addEventListener('click', () => {
  if (textFrom === 'overview') { $('q').blur(); showPane('overview'); renderStops(); return; }
  setTravelMode(modeAtOpen);
  closeSearch();
});
$('qmap').addEventListener('click', () => {
  $('q').blur();
  if (textFrom === 'overview') openMapSearch('row', 'text', editRow);
  else if (textFrom === 'start') { ms.nextStartPick = true; openMapSearch('row', 'text', 0); }
  else openMapSearch('build', 'text');
});
// Een conceptroute stoppen: de kaart blijft op dezelfde plek
$('stop').addEventListener('click', () => { stopRoute(!!state.concept && !state.nav); closeSearch(); });
$('qadd').addEventListener('click', addRow);
$('qok').addEventListener('click', () => (lookMode() ? lookAt() : confirmPreview()));
$('pmapedit').addEventListener('click', e => { e.stopPropagation(); openMapSearch('edit', 'overview'); });
$('msback').addEventListener('click', msBack);
$('msadd').addEventListener('click', msAdd);
$('msok').addEventListener('click', msOk);
$('pickme').addEventListener('click', () => { if (state.fix && msmap) msmap.easeTo({ center: [state.fix.lon, state.fix.lat] }); });

// Richtknop altijd los boven het onderste paneel, hoe hoog dat ook is (kleine iPhones)
const bottomCards = ['bottom-idle', 'bottom-nav'].map($);
function placeRecenter() {
  const h = Math.max(0, ...bottomCards.filter(c => !c.hidden).map(c => (c.classList.contains('peek') ? 4 : c.offsetHeight)));
  document.documentElement.style.setProperty('--bottomh', h + 'px');
}
const bottomWatch = new ResizeObserver(placeRecenter);
bottomCards.forEach(c => bottomWatch.observe(c));

// Kaartsoort kiezen met het tandwiel naast het vervoer
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
    // Alleen 3 km rond de bestemming (zonder bestemming: rond het midden van de kaart).
    // De lijst per gebied geeft maximaal 100 routes, dus we kijken ook in de routetegels zelf.
    const at = (!$('search').hidden && lastPlace()) || state.dest || (({ lng, lat }) => ({ lon: lng, lat }))(map.getCenter());
    // Elke soort route die door de cirkel van 3 km loopt, ook als er geen knikpunt in ligt
    const c = [at.lon, at.lat], dLat = 3000 / 111320, dLon = dLat / Math.cos(rad(at.lat));
    const crosses = l => l.some((p, i) => i && projectOnSegment(c, l[i - 1], p).d <= 3000);
    present = new Set();
    for (let x = tileX(at.lon - dLon); x <= tileX(at.lon + dLon); x++) {
      for (let y = tileY(at.lat + dLat); y <= tileY(at.lat - dLat); y++) {
        for (const f of await loadTrailTile(x, y)) {
          if (present.has(f.properties.g)) continue;
          const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
          if (lines.some(crosses)) present.add(f.properties.g);
        }
      }
    }
  } catch (e) {
    present = new Set(TRAIL_TYPES.map(t => t.key));
  }
  if (seq !== legendSeq) return;
  const types = TRAIL_TYPES.filter(t => present.has(t.key));
  $('legnote').textContent = types.length ? 'binnen 3 km' : 'geen binnen 3 km';
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

// ---------- Rechtsboven op de kaart: kaartsoort en kompas ----------
const mapsetEl = document.querySelector('.mapset');
// Zonder zoekscherm staat de kaartsoort op de kaart; in het zoekscherm naast het vervoer
function homeControls(on) {
  if (on) $('mapctl').prepend(mapsetEl);
  else if (mapsetEl.parentElement !== $('moderow')) $('moderow').appendChild(mapsetEl);
  toggleMapMenu(false);
  syncCompass();
}

// Kompas alleen zonder navigatie, als de kaart gedraaid of gekanteld is
function syncCompass() {
  const b = map.getBearing(), p = map.getPitch();
  const show = !state.nav && !state.concept && !msmap && (Math.abs(b) > 0.5 || p > 0.5);
  $('compass').hidden = !show;
  if (show) $('compass').firstElementChild.style.transform = `rotate(${-b}deg)`;
  // Zoekkaart: alleen gedraaid; de kanteling (3D) blijft
  const ms2 = !!msmap && Math.abs(b) > 0.5;
  $('mscompass').hidden = !ms2;
  if (ms2) $('mscompass').firstElementChild.style.transform = `rotate(${-b}deg)`;
}
map.on('rotate', syncCompass);
map.on('pitch', syncCompass);
map.on('moveend', syncCompass);
$('compass').addEventListener('click', () => map.easeTo({ bearing: 0, pitch: 0, duration: 400 }));
$('mscompass').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 400 }));

// Tijdens het rijden weg, bij stilstand terug (met wat marge, zodat het niet knippert)
function syncDriving() {
  const was = document.body.classList.contains('driving');
  const now = state.speedKmh > (was ? 3 : 8);
  if (now === was) return;
  document.body.classList.toggle('driving', now);
  if (now) toggleMapMenu(false);
}

// ---------- Waar naartoe?: zakt weg als je de kaart verschuift ----------
function peek(on) {
  const idle = $('bottom-idle');
  if (idle.classList.contains('peek') === on) return;
  idle.classList.toggle('peek', on);
  placeRecenter();
}
map.on('dragstart', e => { if (e.originalEvent && $('search').hidden && !$('bottom-idle').hidden) peek(true); });
// Ingeklapt: een tik op het randje haalt hem terug, niet de knoppen eronder
$('bottom-idle').addEventListener('click', e => {
  if (!$('bottom-idle').classList.contains('peek')) return;
  e.stopPropagation();
  e.preventDefault();
  peek(false);
}, true);
// Omhoog vegen haalt hem terug, omlaag vegen klapt hem in
let peekY = null;
$('bottom-idle').addEventListener('pointerdown', e => { peekY = e.clientY; });
$('bottom-idle').addEventListener('pointerup', e => {
  if (peekY == null) return;
  const dy = e.clientY - peekY;
  peekY = null;
  if (dy < -20) peek(false);
  else if (dy > 30) peek(true);
});
$('bottom-idle').addEventListener('pointercancel', () => { peekY = null; });

// ---------- Eigen vertrekpunt vanaf de kaart ----------
// null: vanaf je huidige locatie (standaard); een plek; of false: nog geen vertrekpunt (Zoek locatie)
let homeStart = null, startMarker = null;
function setHomeStart(p) {
  homeStart = p;
  if (p && p.naming) p.naming.then(() => { if (homeStart === p) { delete p.naming; setHomeStart(p); } });
  const none = p === false;
  $('fromrow').hidden = none;
  $('fromname').textContent = p ? withoutPostcode(p.name) : 'huidige locatie';
  $('fromrow').firstElementChild.className = 'ti ' + (p ? 'ti-flag' : 'ti-current-location');
  $('wheretxt').textContent = none ? 'Zoek locatie' : 'Waar naartoe?';
  $('where').setAttribute('aria-label', none ? 'Vertrekpunt zoeken' : 'Waar naartoe?');
  $('wheremap').setAttribute('aria-label', none ? 'Vertrekpunt kiezen op de kaart' : 'Zoek op kaart');
  if (startMarker) { startMarker.remove(); startMarker = null; }
  if (p) {
    const el = document.createElement('div');
    el.className = 'startmark';
    startMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  }
  placeRecenter();
}
// Kruisje: niet vanaf hier vertrekken; dan eerst een vertrekpunt zoeken
$('fromx').addEventListener('click', () => setHomeStart(false));
setHomeStart(null);

// ---------- Lang drukken op de kaart: route, vertrekpunt of een pin ----------
// Tikken in een menu of op een pin is niet ook een tik (of sleep) op de kaart
const shield = el => ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'wheel', 'contextmenu', 'keydown']
  .forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true }));

let placeMenu = null;
function closePlaceMenu() {
  if (!placeMenu) return;
  placeMenu.remove();
  placeMenu = null;
}

function openPlaceMenu(at, pin = null) {
  closePlaceMenu();
  const el = document.createElement('div');
  el.className = 'pmenu';
  el.innerHTML = '<div class="pcard"><div class="ptitle"></div>'
    + '<button type="button" data-act="route"><i class="ti ti-route" aria-hidden="true"></i>Route hier naartoe</button>'
    + '<button type="button" data-act="start"><i class="ti ti-flag" aria-hidden="true"></i>Vertrekpunt</button>'
    + (pin ? '<button type="button" data-act="del" class="del"><i class="ti ti-trash" aria-hidden="true"></i>Pin verwijderen</button>'
      : '<button type="button" data-act="pin"><i class="ti ti-map-pin-plus" aria-hidden="true"></i>Plaats pin</button>')
    + '<form class="pinform" hidden><input type="text" enterkeyhint="done" placeholder="Naam van de pin" autocomplete="off" autocorrect="off" autocapitalize="sentences">'
    + '<button type="submit" aria-label="Pin plaatsen"><i class="ti ti-check" aria-hidden="true"></i></button></form>'
    + '</div><div class="ptail"></div>';
  shield(el);
  const p = pin ? { lat: pin.lat, lon: pin.lon, name: pin.label || pin.name } : placeAt(at.lat, at.lon);
  const title = el.querySelector('.ptitle');
  title.textContent = pin ? pin.label || withoutPostcode(pin.name) : 'Adres zoeken…';
  if (p.naming) p.naming.then(() => { title.textContent = withoutPostcode(p.name); });
  // Bovenaan het scherm klapt het menu naar onderen
  const below = map.project([at.lon, at.lat]).y < 240;
  el.classList.toggle('below', below);
  placeMenu = new maplibregl.Marker({ element: el, anchor: below ? 'top' : 'bottom' }).setLngLat([at.lon, at.lat]).addTo(map);
  // Niet buiten het scherm: het kaartje schuift opzij, het puntje blijft op de plek
  const card = el.querySelector('.pcard'), r = card.getBoundingClientRect();
  const dx = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
  card.style.transform = `translateX(${dx}px)`;
  el.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) placeAction(b.dataset.act, p, pin, el);
  });
  el.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    addPin(p, el.querySelector('input').value.trim());
    closePlaceMenu();
  });
}

function placeAction(act, p, pin, el) {
  if (act === 'pin') {
    // Eerst een naam; de pin komt er pas bij bevestigen
    el.querySelectorAll('button[data-act]').forEach(b => { b.hidden = true; });
    const form = el.querySelector('form');
    form.hidden = false;
    form.querySelector('input').focus();
    return;
  }
  closePlaceMenu();
  if (act === 'del') { removePin(pin.id); return; }
  if (act === 'start') { setHomeStart(p); peek(false); return; }
  // Route hier naartoe: een extra bestemming achter wat er al gepland staat (ook als dat alleen
  // een vertrekpunt is); niets gepland: vanaf je eigen positie. Meteen het overzicht.
  openSheet();
  stops = [...(plannedStops() || [HERE]), p];
  showOverview();
  if (p.naming) p.naming.then(() => { delete p.naming; if (!$('overview').hidden && stops.includes(p)) renderStops(); });
}

// Lang drukken: 0,55 s stil op één plek. Met de muis werkt rechtsklikken ook.
const lp = { timer: 0, x: 0, y: 0, opened: false, eatUntil: 0 };
const canvasBox = map.getCanvasContainer();
const lpCancel = () => { clearTimeout(lp.timer); lp.timer = 0; };
canvasBox.addEventListener('pointerdown', e => {
  lpCancel();
  lp.opened = false;
  if (!e.isPrimary || msmap || !$('search').hidden || (e.pointerType === 'mouse' && e.button !== 0)) return;
  lp.x = e.clientX;
  lp.y = e.clientY;
  lp.timer = setTimeout(() => {
    lp.timer = 0;
    const r = canvasBox.getBoundingClientRect();
    const at = map.unproject([lp.x - r.left, lp.y - r.top]);
    lp.opened = true;
    openPlaceMenu({ lat: at.lat, lon: at.lng });
  }, 550);
});
canvasBox.addEventListener('pointermove', e => { if (lp.timer && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel(); });
const lpEnd = () => {
  lpCancel();
  // De tik die bij het loslaten volgt, sluit het menu niet meteen weer
  if (lp.opened) { lp.opened = false; lp.eatUntil = Date.now() + 500; }
};
canvasBox.addEventListener('pointerup', lpEnd);
canvasBox.addEventListener('pointercancel', lpEnd);
map.on('movestart', e => { if (e.originalEvent) lpCancel(); });
map.on('contextmenu', e => {
  if (msmap || !$('search').hidden) return;
  lpCancel();
  lp.opened = true;
  openPlaceMenu({ lat: e.lngLat.lat, lon: e.lngLat.lng });
});
map.on('click', () => { if (Date.now() >= lp.eatUntil) { closePlaceMenu(); clearLook(); } });

// ---------- Eigen pins: blijven staan tot je ze verwijdert ----------
function loadPins() {
  try { return JSON.parse(localStorage.getItem('pins')) || []; } catch (e) { return []; }
}
function savePins(list) {
  try { localStorage.setItem('pins', JSON.stringify(list)); } catch (e) { /* geen opslag */ }
}
const pinMarkers = new Map();
function drawPin(pin) {
  const el = document.createElement('div');
  el.className = 'upin';
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', 'Pin ' + (pin.label || withoutPostcode(pin.name)));
  el.innerHTML = '<svg viewBox="0 0 36 48" aria-hidden="true"><path d="M18 46.5C18 46.5 34 28.5 34 17A16 16 0 0 0 2 17C2 28.5 18 46.5 18 46.5Z"/><circle cx="18" cy="17" r="6"/></svg>';
  if (pin.label) {
    const l = document.createElement('span');
    l.className = 'upin-lbl';
    l.textContent = pin.label;
    el.appendChild(l);
  }
  shield(el);
  // Kort tikken: dezelfde keuzes, met verwijderen in plaats van plaatsen
  el.addEventListener('click', () => { if (!msmap && $('search').hidden) openPlaceMenu(pin, pin); });
  pinMarkers.set(pin.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pin.lon, pin.lat]).addTo(map));
}
// Elke pin staat ook bij Favorieten (met zijn naam als label)
const pinFav = pin => ({ lat: pin.lat, lon: pin.lon, name: pin.name, label: pin.label || undefined, pin: pin.id });
async function addPin(p, label) {
  const pin = { id: Date.now(), lat: p.lat, lon: p.lon, name: p.name, label };
  savePins([...loadPins(), pin]);
  drawPin(pin);
  if (p.naming) {
    await p.naming;
    pin.name = p.name;
    savePins(loadPins().map(q => (q.id === pin.id ? { ...q, name: p.name } : q)));
  }
  if (loadPins().some(q => q.id === pin.id)) saveFavs([...loadFavs().filter(f => f.pin !== pin.id && f.name !== pin.name), pinFav(pin)]);
}
function removePin(id) {
  savePins(loadPins().filter(q => q.id !== id));
  saveFavs(loadFavs().filter(f => f.pin !== id));
  const m = pinMarkers.get(id);
  if (m) m.remove();
  pinMarkers.delete(id);
}
function renamePin(id, label) {
  const pin = loadPins().find(q => q.id === id);
  if (!pin) return;
  pin.label = label;
  savePins(loadPins().map(q => (q.id === id ? pin : q)));
  const m = pinMarkers.get(id);
  if (m) m.remove();
  drawPin(pin);
}
loadPins().forEach(pin => {
  drawPin(pin);
  // Pins van vóór deze versie alsnog bij Favorieten
  if (!loadFavs().some(f => f.pin === pin.id)) saveFavs([...loadFavs().filter(f => f.name !== pin.name), pinFav(pin)]);
});
homeControls(true);
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setListTab(b.dataset.tab)));
$('qclear').addEventListener('click', () => {
  $('q').value = '';
  $('q-postcode').value = '';
  $('q-city').value = '';
  streetCtx = null;
  updateClear();
  showRecent();
  $('q').focus();
});
$('q').addEventListener('focus', () => { if (!$('q').value.trim() && !$('textpane').hidden) showRecent(); });
$('qform').addEventListener('submit', e => { e.preventDefault(); submitSearch(); });
for (const id of ['q', 'q-postcode', 'q-city']) $(id).addEventListener('input', onSearchInput);
document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.mode === travelMode) return;
  setTravelMode(b.dataset.mode);
  savedPick = null;
  if (!$('mapsearch').hidden) msRecompute();
  else computePreview();
}));

// ---------- Route (Valhalla) ----------
// Door alle punten, in volgorde. Je eigen positie als vertrek rijdt in je rijrichting weg.
async function fetchRoutes(pts, alternates = 0, mode = travelMode, opts = null) {
  const locations = pts.map((p, i) => {
    const l = { lat: p.lat, lon: p.lon, type: 'break' };
    if (i === 0 && p.here && state.heading != null && state.speedKmh > 5) { l.heading = Math.round(state.heading); l.heading_tolerance = 60; }
    return l;
  });
  const body = {
    locations,
    costing: mode,
    language: 'nl-NL',
    directions_options: { units: 'kilometers', language: 'nl-NL' },
  };
  if (opts) body.costing_options = { [mode]: opts };
  // Alternatieven kent de routedienst alleen zonder tussenstops
  if (alternates && pts.length === 2) body.alternates = alternates;
  const res = await fetch(`${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.trip) throw new Error(data.error || 'Geen route gevonden');
  return [data.trip, ...(data.alternates || []).map(a => a.trip)].map(t => Object.assign(navFromTrip(t, mode, pts.slice(1)), opts && { opts }));
}

// Met de auto ook routes die de afstand meewegen: vaak even snel maar zonder omweg over de
// snelweg. Licht (0,2): Amsterdam–Doldersum over de N-wegen, 30 km korter. Sterker (0,6): vanuit
// Amsterdam-Oost over de Wibautstraat naar de A10 in plaats van via Zeeburgereiland. Alleen
// zelf gekozen als hij niet (veel) langzamer is, zie ECO_SLACK; anders staat hij als alternatief.
const SHORT = [{ use_distance: 0.2 }, { use_distance: 0.6 }];
const ECO_SLACK = 120;
async function fetchWithShort(pts) {
  const [routes, ...short] = await Promise.all([fetchRoutes(pts, 2),
    ...(travelMode === 'auto' ? SHORT.map(o => fetchRoutes(pts, 0, 'auto', o).catch(() => [])) : [])]);
  // Bijna dubbele (even snel, op 1% na even lang) maar één keer
  const same = (r, s) => Math.abs(r.total - s.total) < Math.max(300, r.total * 0.01) && Math.abs(r.time - s.time) < 60;
  return [...routes, ...short.flat()].reduce((out, r) => (out.some(o => same(o, r)) ? out : [...out, r]), []);
}

// Alle etappes achter elkaar; per etappe het eindpunt op de route en de reistijd
function navFromTrip(trip, mode, legStops) {
  const shape = [], maneuvers = [], legs = [];
  trip.legs.forEach((leg, k) => {
    const pts = decodePolyline6(leg.shape);
    const off = shape.length ? shape.length - 1 : 0;
    shape.push(...(shape.length ? pts.slice(1) : pts));
    for (const m of leg.maneuvers) maneuvers.push({ ...m, begin_shape_index: m.begin_shape_index + off, end_shape_index: m.end_shape_index + off, leg: k });
    legs.push({ endIdx: shape.length - 1, time: leg.summary.time });
  });
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i]));
  let begin = 0;
  for (const l of legs) { l.begin = begin; l.end = cum[l.endIdx]; begin = l.end; }
  return { shape, cum, maneuvers, legs, legStops, total: cum[cum.length - 1], time: trip.summary.time, mode,
    idx: 0, along: 0, off: 0, arrivedAt: 0, legIdx: 0 };
}

// Van de route afgeraakt: opnieuw vanaf je positie, langs de stops die nog komen
async function reroute() {
  const n = state.nav;
  if (!n || state.routing || !state.fix) return;
  state.routing = true;
  state.lastRouteAt = Date.now();
  toast('Nieuwe route…', 2000);
  try {
    const [nav] = await fetchRoutes([hereNow(), ...n.legStops.slice(n.legIdx)], 0, n.mode, n.opts);
    if (state.nav !== n) return;
    state.nav = nav;
    shownLeg = -1;
    if (DEMO) demo.along = 0;
    updateNav([state.fix.lon, state.fix.lat]);
  } catch (e) {
    // volgende afwijking probeert het opnieuw
  } finally {
    state.routing = false;
  }
}

// stay: de kaart blijft waar hij is (en wordt plat), in plaats van terug naar je positie
function stopRoute(stay = false) {
  state.nav = null;
  state.navStart = null;
  drawRouteEnds();
  state.dest = null;
  clearConcept(stay);
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
  const ends = stopPoints([shape[0], ...c.nav.legs.map(l => shape[l.endIdx])]);
  src.setData({ type: 'FeatureCollection', features: [lineFeature(shape), ...ends.features] });
}

function clearConcept(stay = false) {
  if (!state.concept) return;
  state.concept = null;
  drawConcept();
  if (!stay) { follow(); return; }
  map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
}

// De kaart gaat naar het vertrekpunt
function showConcept(c) {
  state.nav = null;
  drawRouteEnds();
  setRouteLine([]);
  state.concept = c;
  state.dest = c.stops[c.stops.length - 1];
  drawConcept();
  stopFollowing();
  conceptView();
  $('eta').textContent = fmtClock(new Date(Date.now() + c.nav.time * 1000));
  $('remain-time').textContent = fmtDuration(c.nav.time);
  $('remain-dist').textContent = fmtDist(c.nav.total);
  setMode('concept');
  // Met tussenstops: een kaartje per etappe, net als tijdens het navigeren
  if (c.nav.legs.length > 1) { shownLeg = -1; renderLegs(c.nav, c.nav.legs[0].time, c.nav.time, c.nav.total); }
  else $('destlbl').textContent = `Vanaf ${shortName(c.stops[0])} · naar ${withoutPostcode(state.dest.name)}`;
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
  $('bottom-next').hidden = true;
  $('bottom-prev').hidden = true;
  legView = null;
  $('destlbl').textContent = nav && state.dest ? withoutPostcode(state.dest.name) : '';
  $('destlbl').classList.remove('legs');
  $('bottom-idle').hidden = nav;
  if (nav) peek(false);
  syncCar();
  syncCompass();
  renderBar();
}

// ---------- Etappe-kaartjes ----------
// Rechts piept het volgende kaartje, links (als je terug kunt) het vorige. Bij de tussenstop
// schuift het volgende erin en gaat het oude naar links. Lichtgrijs: de tijd van de etappe.
let shownLeg = -1, legSlide = null;
function legTitle(n, k) {
  const s = n.legStops[k];
  return (k < n.legs.length - 1 ? 'Tussenstop · ' : n.legs.length > 1 ? 'Bestemming · ' : '') + withoutPostcode(s.name);
}
function fillCard(card, n, k, legSec, totalSec, totalM, title) {
  // Naam afkappen, de tijd tot de stop blijft altijd zichtbaar
  const lbl = card.querySelector('.destlbl');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = title || legTitle(n, k);
  lbl.replaceChildren(t);
  lbl.classList.toggle('legs', n.legs.length > 1);
  if (n.legs.length > 1 && !title) {
    const sp = document.createElement('span');
    sp.className = 'leg';
    sp.textContent = ' · ' + fmtDuration(legSec);
    lbl.appendChild(sp);
  }
  card.querySelector('.eta').textContent = fmtClock(new Date(Date.now() + totalSec * 1000));
  card.querySelector('.min').textContent = fmtDuration(totalSec);
  card.querySelector('.mid .lbl').textContent = fmtDist(totalM);
}

// De kaartjes: eerst het live kaartje (tijdens navigeren volgt de kaart jou, bij een
// gestippelde route staat hij op het vertrekpunt), daarna één kaartje per stop die nog komt.
// Swipen gaat stop voor stop en de kaart gaat mee naar die stop.
const legNav = () => state.nav || (state.concept && state.concept.nav);
const viewCount = n => n.legs.length - n.legIdx;  // aantal stop-kaartjes na het live kaartje

// Kaartje v: 0 = live (tijd naar de eerstvolgende stop, totale reistijd),
// v >= 1 = stop: lichtgrijs de etappe zelf, groot de aankomst bij die stop
function fillView(card, n, v) {
  const c = n.cur;
  // Gestippelde route: het eerste kaartje is het vertrekpunt, waar de kaart dan staat
  if (!v && state.concept && !state.nav) {
    fillCard(card, n, 0, 0, c.totalSec, c.totalM, 'Vertrek · ' + withoutPostcode(shortName(state.concept.stops[0])));
    return;
  }
  if (!v) { fillCard(card, n, n.legIdx, c.legSec, c.totalSec, c.totalM); return; }
  const j = n.legIdx + v - 1;
  const until = c.legSec + n.legs.slice(n.legIdx + 1, j + 1).reduce((t, l) => t + l.time, 0);
  fillCard(card, n, j, j === n.legIdx ? c.legSec : n.legs[j].time, until, Math.max(0, n.legs[j].end - n.along));
}

function renderCards() {
  const n = legNav();
  if (!n || n.legs.length < 2 || !n.cur) return;
  const v = legView || 0, next = $('bottom-next'), prev = $('bottom-prev');
  fillView($('bottom-nav'), n, v);
  next.hidden = v >= viewCount(n);
  if (!next.hidden) fillView(next, n, v + 1);
  // Links piept het vorige kaartje; op het live kaartje niet (die stop is al geweest)
  prev.hidden = v === 0;
  if (!prev.hidden) fillView(prev, n, v - 1);
}

function renderLegs(n, legSec, totalSec, totalM) {
  n.cur = { legSec, totalSec, totalM };
  const k = n.legIdx, next = $('bottom-next');
  // Stop bereikt terwijl je andere kaartjes bekeek: die schuiven één op
  if (legView !== null && n.seenIdx !== undefined && k > n.seenIdx) legView = legView - (k - n.seenIdx) > 0 ? legView - (k - n.seenIdx) : null;
  n.seenIdx = k;
  if (legView === null && shownLeg >= 0 && k > shownLeg && !legSlide && !next.hidden) {
    // Het volgende kaartje staat al klaar: inschuiven, daarna wordt het weer het hoofdkaartje
    legSlide = setTimeout(() => {
      endSlide();
      shownLeg = -1;
      if (state.fix && state.nav) updateNav([state.fix.lon, state.fix.lat]);
    }, 480);
    document.body.classList.add('legslide');
    return;
  }
  if (legSlide) return;
  shownLeg = k;
  if (n.legs.length < 2) { fillCard($('bottom-nav'), n, k, legSec, totalSec, totalM); next.hidden = true; $('bottom-prev').hidden = true; return; }
  renderCards();
}

const legCards = () => ['bottom-prev', 'bottom-nav', 'bottom-next'].map($);

// Na het schuiven: kaartjes zonder animatie terug op hun plek, met de nieuwe inhoud
function endSlide() {
  const cards = legCards();
  cards.forEach(c => c.classList.add('noanim'));
  document.body.classList.remove('legslide', 'legback');
  renderCards();
  void cards[1].offsetWidth;
  cards.forEach(c => c.classList.remove('noanim'));
  legSlide = null;
}

// Waar de kaart staat bij een gestippelde route: op het vertrekpunt, plat en noord boven
function conceptView() {
  const shape = state.concept.nav.shape, a = shape[0];
  const h = map.getContainer().clientHeight;
  map.easeTo({ center: a, bearing: startBearing(shape), zoom: 15.5, pitch: camPitch(),
    padding: { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 }, duration: farJump(a) ? 0 : 800 });
}

// Swipen: naar het volgende (dir 1) of vorige (-1) kaartje; de kaart gaat mee naar die stop.
// Terug op het live kaartje volgt de kaart jou weer (of staat hij op het vertrekpunt).
function slideLeg(dir) {
  const n = legNav();
  legCards().forEach(c => { c.style.transform = ''; });
  if (!n || legSlide) return;
  const v = (legView || 0) + dir;
  if (v < 0 || v > viewCount(n)) return;
  legView = v || null;
  document.body.classList.add(dir > 0 ? 'legslide' : 'legback');
  legSlide = setTimeout(endSlide, 480);
  if (!v) {
    if (state.nav) follow();
    else conceptView();
    return;
  }
  stopFollowing();
  // De stop midden in beeld (zonder de ruimte boven die je eigen positie lager zet),
  // in de rijrichting waarin je er aankomt
  const i = n.legs[n.legIdx + v - 1].endIdx, p = n.shape[i];
  map.easeTo({ center: p, zoom: 15.5, bearing: arriveBearing(n.shape, i), pitch: camPitch(),
    padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: farJump(p) ? 0 : 800 });
}

// Vinger op het kaartje: het schuift mee; ver genoeg en het volgende of vorige kaartje komt
{
  const card = $('bottom-nav');
  let x0 = null, y0 = 0, dragging = false;
  card.addEventListener('pointerdown', e => {
    const n = legNav();
    if (!n || n.legs.length < 2 || legSlide) return;
    x0 = e.clientX; y0 = e.clientY; dragging = false;
  });
  card.addEventListener('pointermove', e => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    if (!dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(e.clientY - y0)) {
      dragging = true;
      card.setPointerCapture(e.pointerId);
      legCards().forEach(c => c.classList.add('dragging'));
    }
    if (!dragging) return;
    // Aan de rand (geen kaartje meer) schuift hij maar een beetje; de buren schuiven mee
    const n = legNav(), v = legView || 0;
    const edge = dx < 0 ? v >= viewCount(n) : v <= 0;
    const d = edge ? dx * 0.25 : dx;
    const [prev, main, next] = legCards();
    main.style.transform = `translateX(${d}px)`;
    next.style.transform = `translateX(calc(100% + 6px + ${d}px))`;
    prev.style.transform = `translateX(calc(-100% - 6px + ${d}px))`;
  });
  const end = e => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (!dragging) return;
    dragging = false;
    legCards().forEach(c => c.classList.remove('dragging'));
    card.dataset.swiped = '1';
    setTimeout(() => { delete card.dataset.swiped; }, 50);
    if (Math.abs(dx) > 60) slideLeg(dx < 0 ? 1 : -1);
    else legCards().forEach(c => { c.style.transform = ''; });
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  // Een swipe is geen tik op het potlood
  card.addEventListener('click', e => { if (card.dataset.swiped) { e.stopPropagation(); e.preventDefault(); } }, true);
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

  // Bij een tussenstop (binnen 30 m) door naar de volgende etappe
  while (n.legIdx < n.legs.length - 1 && n.along >= n.legs[n.legIdx].end - 30) n.legIdx++;
  if (endsFor !== n || endsLeg !== n.legIdx) drawRouteEnds();
  const leg = n.legs[n.legIdx];
  const legLen = leg.end - leg.begin, legLeft = Math.max(0, leg.end - n.along);
  const legSec = leg.time * (legLen ? Math.min(1, legLeft / legLen) : 0);
  const totalSec = legSec + n.legs.slice(n.legIdx + 1).reduce((s, l) => s + l.time, 0);
  const remaining = Math.max(0, n.total - n.along);
  renderLegs(n, legSec, totalSec, remaining);

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
  const isDest = next.type >= 4 && next.type <= 6;
  const via = isDest && next.leg < n.legs.length - 1;
  $('instr-icon').className = 'ti ' + (via ? 'ti-map-pin' : icon);
  const what = via ? 'Tussenstop' : 'Bestemming';
  if (d < 30) $('instr-title').textContent = isDest ? what + ' bereikt' : 'Nu ' + verb;
  else $('instr-title').textContent = isDest ? `${what} over ${fmtDist(d)}` : `Over ${fmtDist(d)} ${verb}`;
  setInstrSub(via ? n.legStops[next.leg].name : isDest ? (state.dest ? state.dest.name : '') : maneuverSub(next));
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

// De app zelf ook zonder bereik kunnen openen (zie sw.js)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
