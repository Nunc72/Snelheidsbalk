'use strict';

const VERSION = '4';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const PHOTON = 'https://photon.komoot.io/api/';
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (darkQuery.matches ? 'dark' : 'light');
const DEMO = new URLSearchParams(location.search).has('demo');

// Kleurschaal: percentage van de maximumsnelheid -> kleur.
// In dark mode zijn de uiteinden omgedraaid: 0% is zwart, 200% is wit.
const STOPS_LIGHT = [[0, [255, 255, 255]], [80, [135, 206, 235]], [98, [0, 128, 0]], [100, [0, 128, 0]], [102, [255, 255, 0]],
  [104, [255, 165, 0]], [106, [255, 0, 0]], [150, [178, 0, 255]], [200, [0, 0, 0]]];
const STOPS_DARK = [[0, [0, 0, 0]], ...STOPS_LIGHT.slice(1, -1), [200, [255, 255, 255]]];

function scaleColor(p) {
  const STOPS = theme() === 'dark' ? STOPS_DARK : STOPS_LIGHT;
  p = Math.min(200, Math.max(0, p));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1];
    if (p >= a && p <= b) {
      const f = (p - a) / (b - a);
      return ca.map((c, j) => Math.round(c + (cb[j] - c) * f));
    }
  }
  return [0, 0, 0];
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
  darkStyleCache = style;
  return style;
}
const map = new maplibregl.Map({
  container: 'map',
  style: theme() === 'dark' ? PLACEHOLDER_DARK : STYLES.light,
  center: [5.1214, 52.0907],
  zoom: 15,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();

const markerEl = document.createElement('div');
markerEl.className = 'car marker';
markerEl.innerHTML = '<div><div></div></div>';
const marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map' });

let routeCoords = [];
const lineFeature = coords => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

// Wordt ook opnieuw aangeroepen na een wissel tussen licht en donker
map.on('style.load', () => {
  const dark = theme() === 'dark';
  map.addSource('route', { type: 'geojson', data: lineFeature(routeCoords) });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? DARK_BG : '#ffffff', 'line-width': 13 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#3D8BFF' : '#1F6FE0', 'line-width': 8 } });
});

async function applyTheme() {
  const style = theme() === 'dark' ? await darkStyle() : STYLES.light;
  map.setStyle(style, { diff: false });
  renderBar();
}
darkQuery.addEventListener('change', applyTheme);
if (theme() === 'dark') applyTheme();

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

$('recenter').addEventListener('click', () => {
  state.following = true;
  $('car').hidden = false;
  $('recenter').hidden = true;
  marker.remove();
  if (state.fix) updateCamera([state.fix.lon, state.fix.lat], 600);
});

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
    bearing: state.heading ?? map.getBearing(),
    zoom: state.zoom,
    padding: { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 },
    duration,
    easing: t => t,
  });
}

// ---------- Snelheidsbalk ----------
let lastTheme = '';
function renderBar() {
  const bar = $('bar'), lim = $('lim');
  $('spd').textContent = state.fix ? Math.round(state.speedKmh) : '–';
  let bg = '#48484A', fg = '#fff';
  if (state.limit) {
    const c = scaleColor(state.speedKmh / state.limit * 100);
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

// ---------- Huidige weg linksboven: alleen A- en E-nummers ----------
function roadParts(names) {
  const refs = [];
  for (const raw of names || []) {
    const n = raw.trim();
    let m;
    if ((m = n.match(/^A\s?(\d+)$/i))) refs.push({ cls: 'a', text: 'A' + m[1] });
    else if ((m = n.match(/^E\s?(\d+)$/i))) refs.push({ cls: 'e', text: 'E' + m[1] });
  }
  refs.sort((x, y) => (x.cls === 'a' ? 0 : 1) - (y.cls === 'a' ? 0 : 1));
  return refs.slice(0, 3);
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
    el.innerHTML = '';
    for (const p of parts) {
      const span = document.createElement('span');
      span.className = 'ref ' + p.cls;
      span.textContent = p.text;
      el.appendChild(span);
    }
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

// ---------- Zoeken (Photon) ----------
let searchTimer, searchSeq = 0;

function openSearch() {
  $('search').hidden = false;
  $('q').value = '';
  $('results').innerHTML = '';
  // Op iOS opent het toetsenbord alleen als focus direct binnen de tik gebeurt
  $('q').focus();
}
function closeSearch() {
  $('q').blur();
  $('search').hidden = true;
}

function describe(props) {
  const street = [props.street, props.housenumber].filter(Boolean).join(' ');
  const title = props.name || street || props.city || 'Onbekende plek';
  const sub = [props.name && street ? street : '', props.postcode, props.city || props.town || props.village, ['Nederland', 'Netherlands'].includes(props.country) ? '' : props.country]
    .filter(Boolean).join(', ');
  return { title, sub };
}

async function search(q) {
  const seq = ++searchSeq;
  const ul = $('results');
  if (q.trim().length < 3) { ul.innerHTML = ''; return; }
  const params = new URLSearchParams({ q, limit: '8' });
  if (state.fix) { params.set('lat', state.fix.lat); params.set('lon', state.fix.lon); }
  try {
    const res = await fetch(`${PHOTON}?${params}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    ul.innerHTML = '';
    if (!data.features.length) { ul.innerHTML = '<li class="empty">Niets gevonden</li>'; return; }
    for (const f of data.features) {
      const { title, sub } = describe(f.properties);
      const li = document.createElement('li');
      li.innerHTML = `<div class="r1"></div><div class="r2"></div>`;
      li.querySelector('.r1').textContent = title;
      li.querySelector('.r2').textContent = sub;
      li.addEventListener('click', () => {
        closeSearch();
        const [lon, lat] = f.geometry.coordinates;
        startRoute({ lat, lon, name: title });
      });
      ul.appendChild(li);
    }
  } catch (e) {
    if (seq === searchSeq) ul.innerHTML = '<li class="empty">Zoeken lukt nu niet. Controleer je verbinding.</li>';
  }
}

$('where').addEventListener('click', openSearch);
$('qcancel').addEventListener('click', closeSearch);
$('q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(e.target.value), 300);
});
$('q').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); search(e.target.value); }
});

// ---------- Route (Valhalla) ----------
async function fetchRoute(dest) {
  const f = state.fix;
  const from = { lat: f.lat, lon: f.lon };
  if (state.heading != null && state.speedKmh > 5) { from.heading = Math.round(state.heading); from.heading_tolerance = 60; }
  const body = {
    locations: [from, { lat: dest.lat, lon: dest.lon }],
    costing: 'auto',
    language: 'nl-NL',
    directions_options: { units: 'kilometers', language: 'nl-NL' },
  };
  const res = await fetch(`${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.trip) throw new Error(data.error || 'Geen route gevonden');
  const leg = data.trip.legs[0];
  const shape = decodePolyline6(leg.shape);
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i]));
  return { shape, cum, maneuvers: leg.maneuvers, total: cum[cum.length - 1], time: data.trip.summary.time, idx: 0, along: 0, off: 0, arrivedAt: 0 };
}

async function startRoute(dest) {
  if (!state.fix) { toast('Nog geen GPS-positie. Probeer het zo opnieuw.'); return; }
  state.dest = dest;
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
  setRouteLine([]);
  setMode('idle');
}
$('stop').addEventListener('click', stopRoute);

function setMode(mode) {
  const nav = mode === 'nav';
  $('instr').hidden = !nav;
  $('bottom-nav').hidden = !nav;
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

function maneuverSub(m) {
  const names = m.street_names || m.begin_street_names;
  const toward = m.sign && m.sign.exit_toward_elements;
  const branch = m.sign && m.sign.exit_branch_elements;
  const parts = [];
  if (names && names.length) parts.push(names.slice(0, 2).join(' / '));
  if (branch && branch.length) parts.push(branch.map(e => e.text).join('/'));
  if (toward && toward.length) parts.push('richting ' + toward.map(e => e.text).slice(0, 2).join(', '));
  return parts.join(' · ') || m.instruction || '';
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
    $('instr-sub').textContent = state.dest ? state.dest.name : '';
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
  $('instr-sub').textContent = isDest ? (state.dest ? state.dest.name : '') : maneuverSub(next);
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
      const lim = state.limit || 50;
      const target = lim * (1 + 0.15 * Math.sin(k / 8)) / 3.6;
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
