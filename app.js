/* ECMWF viewer: Leaflet map + canvas layers (colour shading, particles, isobars, barbs). */
(function () {
'use strict';
const MS2KT = 1.943844;
let INDEX = null, meta = null, field = null, stepIdx = 0;
const cache = new Map();   // "run:step" -> decoded step (small LRU so long scrubbing doesn't eat memory)
const CACHE_MAX = 10;
const $ = id => document.getElementById(id);

// ---------- user settings (saved in localStorage) ----------
const DEFAULTS = { units: 'kt', tempUnit: 'F', precipUnit: 'in', shade: 'speed', precipPeriod: '3',
  speed: 0.4, width: 1.0, trail: 6, density: 1.0, particles: true, barbs: true, isobars: false,
  // pinpoint readout options ("Additional Map Settings" menu)
  // hoverAuto: show the variable(s) matching the displayed layer; hv* = extra (or, with auto off, the full manual set)
  hoverOn: true, hoverAuto: true, hoverStyle: 'compact', hvSpeed: false, hvDir: false, hvGust: false, hvTemp: false,
  hvPres: false, hvPcp: false, hvPcpTot: false, hvCoord: false };
const HOVER_KEYS = ['hoverOn', 'hoverAuto', 'hoverStyle', 'hvSpeed', 'hvDir', 'hvGust', 'hvTemp', 'hvPres', 'hvPcp', 'hvPcpTot', 'hvCoord'];
const UNITS = {
  kt:  { f: 1.943844, label: 'kt',   name: 'knots', ticks: [0, 10, 20, 30, 40, 50, 60, 80, 100] },
  mph: { f: 2.236936, label: 'mph',  name: 'mph',   ticks: [0, 20, 40, 60, 80, 100] },
  kmh: { f: 3.6,      label: 'km/h', name: 'km/h',  ticks: [0, 20, 40, 60, 80, 100, 140, 180] },
  ms:  { f: 1,        label: 'm/s',  name: 'm/s',   ticks: [0, 5, 10, 15, 20, 25, 30, 40, 50] }
};
const settings = Object.assign({}, DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('windSettings') || '{}');
  for (const k in DEFAULTS) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) settings[k] = saved[k];
  if (!UNITS[settings.units]) settings.units = DEFAULTS.units;
  if (!['speed', 'gust', 'temp', 'precip', 'off'].includes(settings.shade)) settings.shade = DEFAULTS.shade;
  if (!['3', '6', '24', 'total'].includes(settings.precipPeriod)) settings.precipPeriod = DEFAULTS.precipPeriod;
  if (!['F', 'C'].includes(settings.tempUnit)) settings.tempUnit = 'F';
  if (!['in', 'mm'].includes(settings.precipUnit)) settings.precipUnit = 'in';
  if (!['compact', 'detailed'].includes(settings.hoverStyle)) settings.hoverStyle = 'compact';
} catch (e) {}
function saveSettings() { try { localStorage.setItem('windSettings', JSON.stringify(settings)); } catch (e) {} }
function fmtSpeed(ms) { const u = UNITS[settings.units]; const v = ms * u.f; return (settings.units === 'ms' ? v.toFixed(1) : v.toFixed(0)) + ' ' + u.label; }
function fmtTemp(c) { return settings.tempUnit === 'F' ? (c * 9 / 5 + 32).toFixed(0) + '°F' : c.toFixed(1) + '°C'; }
function fmtPrecip(mm) {
  if (settings.precipUnit === 'mm') return (mm < 10 ? mm.toFixed(1) : mm.toFixed(0)) + ' mm';
  const i = mm / 25.4; return (i < 10 ? i.toFixed(2) : i.toFixed(1)) + ' in';
}
// trail length 1..10 -> per-frame fade (how much of the old trail survives each frame)
function trailFade() { return 0.80 + settings.trail * 0.0185; }

// ---------- map & basemap ----------
const map = L.map('map', { center: [30, 0], zoom: 2, minZoom: 1, maxZoom: 12, worldCopyJump: true, preferCanvas: true });
map.createPane('shade'); map.getPane('shade').style.zIndex = 350;
map.createPane('particles'); map.getPane('particles').style.zIndex = 420;
map.createPane('barbs'); map.getPane('barbs').style.zIndex = 430;
map.createPane('isobars'); map.getPane('isobars').style.zIndex = 425; map.getPane('isobars').style.pointerEvents = 'none';
map.createPane('labels'); map.getPane('labels').style.zIndex = 440; map.getPane('labels').style.pointerEvents = 'none';
map.createPane('coast'); map.getPane('coast').style.zIndex = 400; map.getPane('coast').style.pointerEvents = 'none';
const dataAttrib = 'Wind data: <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF open data</a> (CC BY 4.0) | Coastlines: Natural Earth';
const esriAttrib = 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
const dark = L.layerGroup([
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: esriAttrib + ' | ' + dataAttrib, maxZoom: 16, crossOrigin: 'anonymous' }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'labels', crossOrigin: 'anonymous' })
]).addTo(map);
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | ' + dataAttrib, maxZoom: 19, crossOrigin: 'anonymous' });
L.control.layers({ 'Dark (Esri)': dark, 'OpenStreetMap': osm }, null, { position: window.innerWidth < 600 ? 'topleft' : 'topright' }).addTo(map);
// coastlines + borders drawn above the colour shading so land/sea stay readable
const coastRenderer = L.canvas({ pane: 'coast', padding: 0.3 });
fetch('vendor/coast.geojson').then(r => r.json()).then(g => L.geoJSON(g, { renderer: coastRenderer, interactive: false, style: { color: '#e8e8e8', weight: 1, opacity: 0.75 } }).addTo(map));
fetch('vendor/borders.geojson').then(r => r.json()).then(g => L.geoJSON(g, { renderer: coastRenderer, interactive: false, style: { color: '#bbbbbb', weight: 0.7, opacity: 0.55, dashArray: '3 3' } }).addTo(map));

// ---------- canvas layers ----------
function makeCanvas(pane) { return L.DomUtil.create('canvas', 'wind-canvas', map.getPane(pane)); }
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const shadeCv = makeCanvas('shade'), partCv = makeCanvas('particles'), isoCv = makeCanvas('isobars'), barbCv = makeCanvas('barbs');
function fitCanvas(c, ratio) {
  const s = map.getSize();
  c.width = Math.round(s.x * ratio); c.height = Math.round(s.y * ratio);
  c.style.width = s.x + 'px'; c.style.height = s.y + 'px';
  L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
}

// ---------- data loading ----------
// Each forecast step = PNG images whose colour channels hold 8-bit scaled values:
//   wind_XXX.png: R=u, G=v, B=gust   met_XXX.png: R=2 m temp, G=MSL pressure, B=precip since run start
//   pcp_XXX.png:  R/G/B = precip in previous 3 h / 6 h / 24 h  (loaded only when the precip layer is on)
function runBase() { return 'data/runs/' + meta.id + '/'; }
function bust() { return '?v=' + encodeURIComponent(meta.generated + meta.res); }
function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
      res({ w: img.width, h: img.height, px: ctx.getImageData(0, 0, img.width, img.height).data });
    };
    img.onerror = () => rej(new Error('failed to load ' + src));
    img.src = src;
  });
}
function cacheGet(k) { if (!cache.has(k)) return null; const f = cache.get(k); cache.delete(k); cache.set(k, f); return f; }
function cachePut(k, f) { cache.set(k, f); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
async function loadStep(i) {
  const key = meta.id + ':' + meta.res + ':' + i;
  const hit = cacheGet(key); if (hit) return hit;
  const st = meta.steps[i], n = String(st.hour).padStart(3, '0');
  const [w, m] = await Promise.all([loadImg(runBase() + 'wind_' + n + '.png' + bust()), loadImg(runBase() + 'met_' + n + '.png' + bust())]);
  const f = { key, st, w: w.w, h: w.h, wind: w.px, met: m.px, pcp: null, iso: null };
  cachePut(key, f); return f;
}
async function loadPcp(f) {
  if (f.pcp) return f;
  const n = String(f.st.hour).padStart(3, '0');
  f.pcp = (await loadImg(runBase() + 'pcp_' + n + '.png' + bust())).px; return f;
}
async function loadIso(f) {
  if (f.iso) return f;
  const n = String(f.st.hour).padStart(3, '0');
  const j = await fetch(runBase() + 'isobars_' + n + '.json' + bust()).then(r => r.json());
  // decode delta-encoded integer tenths of a degree
  j.lines.forEach(l => {
    const d = l.d, pts = new Float32Array(d.length); let x = 0, y = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < d.length; k += 2) { x += d[k]; y += d[k + 1]; pts[k] = x / 10; pts[k + 1] = y / 10;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    l.pts = pts; l.bb = [x0 / 10, y0 / 10, x1 / 10, y1 / 10]; delete l.d;
  });
  f.iso = j; return f;
}

// ---------- field sampling (bilinear on the 8-bit values) ----------
// returns [x0, x1, y0, y1 indices, weights] for a lat/lon, or null
function cell(lat, lon) {
  if (!field || lat > 90 || lat < -90) return null;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const x = (lon - meta.lon0) / meta.dlon, y = (meta.lat0 - lat) / meta.dlat;
  const x0 = Math.floor(x), y0 = Math.min(Math.floor(y), field.h - 2), fx = x - x0, fy = y - y0;
  const W = field.w, x1 = (x0 + 1) % W;
  return [(y0 * W + x0) * 4, (y0 * W + x1) * 4, ((y0 + 1) * W + x0) * 4, ((y0 + 1) * W + x1) * 4,
          (1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
}
function bil(px, c, ch) { return px[c[0] + ch] * c[4] + px[c[1] + ch] * c[5] + px[c[2] + ch] * c[6] + px[c[3] + ch] * c[7]; }
const lin = (b, lo, hi) => lo + b / 255 * (hi - lo);
const sq = (b, mx) => { const t = b / 255; return t * t * mx; };
// wind [u,v] m/s or null
function sample(lat, lon) {
  const c = cell(lat, lon); if (!c) return null; const s = field.st;
  return [lin(bil(field.wind, c, 0), s.uMin, s.uMax), lin(bil(field.wind, c, 1), s.vMin, s.vMax)];
}
function sampleGust(lat, lon) {
  const s = field && field.st; if (!s || s.gMax === undefined) return null;
  const c = cell(lat, lon); return c ? lin(bil(field.wind, c, 2), s.gMin, s.gMax) : null;
}
function sampleTemp(lat, lon) { const c = cell(lat, lon); return c ? lin(bil(field.met, c, 0), field.st.tMin, field.st.tMax) : null; }
function samplePres(lat, lon) { const c = cell(lat, lon); return c ? lin(bil(field.met, c, 1), field.st.pMin, field.st.pMax) : null; }
function sampleAcc(lat, lon) { const c = cell(lat, lon); return c ? sq(bil(field.met, c, 2), field.st.aMax) : null; }
const PCH = { '3': [0, 'r3Max'], '6': [1, 'r6Max'], '24': [2, 'r24Max'] };
function samplePcp(lat, lon, period) {
  if (period === 'total') return sampleAcc(lat, lon);
  if (!field || !field.pcp) return null; const [ch, k] = PCH[period], mx = field.st[k]; if (mx == null) return null;
  const c = cell(lat, lon); return c ? sq(bil(field.pcp, c, ch), mx) : null;
}
// precip period actually shown at this step (falls back when the chosen one isn't available)
function pcpAvail(p, st) { return p === 'total' ? st.hour > 0 : st[PCH[p][1]] != null; }
function effPeriod() {
  const st = meta && meta.steps[stepIdx]; if (!st) return settings.precipPeriod;
  const want = settings.precipPeriod;
  if (pcpAvail(want, st)) return want;
  for (const p of { '3': ['6'], '6': ['3'], '24': ['6', '3'] }[want] || []) if (pcpAvail(p, st)) return p;
  return null;
}
// screen geometry helpers: in Web Mercator, lon is linear in x and lat depends only on y
function viewGeom() {
  const s = map.getSize();
  const lonL = map.containerPointToLatLng([0, 0]).lng, lonR = map.containerPointToLatLng([s.x, 0]).lng;
  const rowLat = new Float32Array(s.y + 1);
  for (let y = 0; y <= s.y; y++) rowLat[y] = map.containerPointToLatLng([0, y]).lat;
  return { w: s.x, h: s.y, lonL, dLon: (lonR - lonL) / s.x, rowLat };
}

// ---------- colour scales ----------
function makeLut(scale, lo, hi) {   // linear-interpolated LUT for integer values lo..hi
  const n = hi - lo + 1, lut = new Uint8Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = lo + k; let j = 0; while (j < scale.length - 2 && v > scale[j + 1][0]) j++;
    const [k0, c0] = scale[j], [k1, c1] = scale[j + 1], t = Math.min(1, Math.max(0, (v - k0) / (k1 - k0)));
    for (let ch = 0; ch < 3; ch++) lut[k * 3 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * t);
  }
  return lut;
}
const LUT = makeLut([[0,[98,113,183]],[5,[57,97,159]],[10,[74,148,169]],[15,[77,141,123]],[20,[83,165,83]],[25,[53,159,53]],
  [30,[167,157,81]],[35,[159,127,58]],[40,[161,108,92]],[50,[129,58,78]],[60,[175,80,136]],[70,[117,74,147]],[85,[109,97,163]],[100,[230,230,230]]], 0, 100);
// temperature in °F, -40..120
const TLUT = makeLut([[-40,[235,225,255]],[-20,[190,150,235]],[0,[130,80,200]],[10,[80,70,190]],[20,[50,110,220]],[32,[70,170,240]],
  [40,[80,200,200]],[50,[70,180,110]],[60,[150,205,80]],[70,[240,220,70]],[80,[245,160,50]],[90,[230,90,40]],[100,[190,30,40]],[110,[140,10,60]],[120,[100,0,80]]], -40, 120);
// radar-like precipitation colours; thresholds depend on unit and period
const PCOL = [[170,225,170],[110,200,110],[50,165,60],[25,125,45],[230,230,60],[245,195,50],[245,145,35],[230,80,30],[205,30,40],[170,20,90],[150,50,190],[200,140,240],[245,225,255]];
const PTHR = {
  in: { int: [0.01,0.02,0.05,0.1,0.15,0.25,0.5,0.75,1,1.5,2,3,4], total: [0.05,0.1,0.25,0.5,1,1.5,2,3,4,6,8,12,20] },
  mm: { int: [0.1,0.5,1,2,4,6,10,15,20,30,50,75,100], total: [1,2.5,5,10,20,30,50,75,100,150,200,300,500] }
};
function pThresholds(period) { return PTHR[settings.precipUnit][period === 'total' ? 'total' : 'int']; }
function pIndex(mm, thr) {  // -1 = transparent
  const v = settings.precipUnit === 'in' ? mm / 25.4 : mm; let k = -1;
  while (k + 1 < thr.length && v >= thr[k + 1]) k++; return k;
}

// ---------- colour shading ----------
function drawShade() {
  fitCanvas(shadeCv, 1);
  const ctx = shadeCv.getContext('2d'); ctx.clearRect(0, 0, shadeCv.width, shadeCv.height);
  const mode = settings.shade;
  if (!field || mode === 'off') return;
  if (mode === 'gust' && field.st.gMax === undefined) return;
  let period = null, thr = null;
  if (mode === 'precip') {
    period = effPeriod(); if (!period) return;
    if (period !== 'total' && !field.pcp) { const f = field; loadPcp(f).then(() => { if (f === field) { drawShade(); } }); return; }
    thr = pThresholds(period);
  }
  const g = viewGeom(), R = 3, sw = Math.ceil(g.w / R), sh = Math.ceil(g.h / R);
  const off = document.createElement('canvas'); off.width = sw; off.height = sh;
  const octx = off.getContext('2d'), im = octx.createImageData(sw, sh), d = im.data;
  for (let j = 0; j < sh; j++) {
    const lat = g.rowLat[Math.min(g.h, j * R + 1)];
    for (let i = 0; i < sw; i++) {
      const lon = g.lonL + (i * R + 1) * g.dLon, o = (j * sw + i) * 4;
      let r, gg, b, a;
      if (mode === 'speed' || mode === 'gust') {
        let ms;
        if (mode === 'gust') ms = sampleGust(lat, lon); else { const p = sample(lat, lon); ms = p && Math.hypot(p[0], p[1]); }
        if (ms === null) continue;
        const k = Math.min(100, Math.round(ms * MS2KT)) * 3; r = LUT[k]; gg = LUT[k + 1]; b = LUT[k + 2]; a = 150;
      } else if (mode === 'temp') {
        const c = sampleTemp(lat, lon); if (c === null) continue;
        const k = (Math.min(120, Math.max(-40, Math.round(c * 9 / 5 + 32))) + 40) * 3; r = TLUT[k]; gg = TLUT[k + 1]; b = TLUT[k + 2]; a = 165;
      } else {
        const mm = samplePcp(lat, lon, period); if (mm === null) continue;
        const k = pIndex(mm, thr); if (k < 0) continue;
        [r, gg, b] = PCOL[k]; a = 215;
      }
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = a;
    }
  }
  octx.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, sw * R, sh * R);
}

// ---------- wind barbs ----------
// Meteorological convention: staff points toward where the wind comes FROM.
// Pennant = 50 kt, full barb = 10 kt, half barb = 5 kt. Feathers on the
// low-pressure side (left looking downwind) in the N. hemisphere, mirrored in the S.
function drawBarb(ctx, x, y, u, v, lat, size) {
  const kt = Math.hypot(u, v) * MS2KT;
  let r = Math.round(kt / 5) * 5;
  if (r < 5) { ctx.beginPath(); ctx.arc(x, y, size * 0.12, 0, 2 * Math.PI); ctx.stroke(); return; }
  const mag = Math.hypot(u, v);
  const dx = -u / mag, dy = v / mag;               // screen unit vector toward the source (y down)
  const side = lat >= 0 ? 1 : -1;
  const px = -dy * side, py = dx * side;            // perpendicular for feathers
  const L = size, ex = x + dx * L, ey = y + dy * L;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
  const flen = L * 0.42, gap = L * 0.14;
  let pos = 0; // distance back from the tip
  ctx.beginPath();
  while (r >= 50) {             // pennants (filled triangles)
    const bx = ex - dx * pos, by = ey - dy * pos, cx2 = ex - dx * (pos + gap * 1.4), cy2 = ey - dy * (pos + gap * 1.4);
    ctx.moveTo(bx, by); ctx.lineTo(bx + px * flen, by + py * flen); ctx.lineTo(cx2, cy2); ctx.closePath();
    pos += gap * 1.4 + gap * 0.5; r -= 50;
  }
  ctx.fill();
  ctx.beginPath();
  const tilt = 0.35;
  if (pos === 0 && r === 5) pos = gap;  // a lone half barb sits a little in from the tip
  while (r >= 10) {
    const bx = ex - dx * pos, by = ey - dy * pos;
    ctx.moveTo(bx, by); ctx.lineTo(bx + px * flen + dx * flen * tilt, by + py * flen + dy * flen * tilt);
    pos += gap; r -= 10;
  }
  if (r >= 5) {
    const bx = ex - dx * pos, by = ey - dy * pos;
    ctx.moveTo(bx, by); ctx.lineTo(bx + px * flen * 0.5 + dx * flen * 0.5 * tilt, by + py * flen * 0.5 + dy * flen * 0.5 * tilt);
  }
  ctx.stroke();
}
function drawBarbs() {
  fitCanvas(barbCv, dpr);
  const ctx = barbCv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, barbCv.width, barbCv.height);
  if (!field || !settings.barbs) return;
  const z = map.getZoom(), pxPerDeg = 256 * Math.pow(2, z) / 360;
  const spacingPx = 52;
  // thin barbs: take every n-th model grid point so they are ~spacingPx apart
  const n = Math.max(1, Math.ceil(spacingPx / (pxPerDeg * meta.dlon)));
  const stepDeg = n * meta.dlon;
  const b = map.getBounds().pad(0.05);
  const latMin = Math.max(-85, b.getSouth()), latMax = Math.min(85, b.getNorth());
  const size = 22;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let lat = Math.ceil(latMax / stepDeg) * stepDeg;
  let count = 0;
  while (lat >= latMin && count < 6000) {
    for (let lon = Math.floor(b.getWest() / stepDeg) * stepDeg; lon <= b.getEast(); lon += stepDeg) {
      const p = sample(lat, lon); if (!p) continue;
      const pt = map.latLngToContainerPoint([lat, lon]);
      drawBarb(ctx, pt.x, pt.y, p[0], p[1], lat, size); count++;
    }
    // next row: keep the on-screen vertical spacing ~ the horizontal spacing (Mercator stretch)
    const k = Math.max(1, Math.round(n * Math.cos(lat * Math.PI / 180)));
    lat -= k * meta.dlat;
    lat = Math.round(lat / meta.dlat) * meta.dlat;
  }
}

// ---------- isobars (MSL pressure every 4 hPa) + H/L ----------
function drawIsobars() {
  fitCanvas(isoCv, dpr);
  const ctx = isoCv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, isoCv.width, isoCv.height);
  if (!field || !settings.isobars) return;
  if (!field.iso) { const f = field; loadIso(f).then(() => { if (f === field) drawIsobars(); }); return; }
  const b = map.getBounds(), W = b.getWest(), E = b.getEast(), S = b.getSouth(), N = b.getNorth();
  const size = map.getSize();
  const offsets = []; for (let o = Math.floor((W + 180) / 360) * 360; o - 180 <= E; o += 360) offsets.push(o);
  const labels = [], placed = [];
  const free = (x, y, r) => placed.every(p => Math.abs(p[0] - x) > r || Math.abs(p[1] - y) > r * 0.6);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const l of field.iso.lines) {
    if (l.bb[1] > N || l.bb[3] < S) continue;
    for (const off of offsets) {
      if (l.bb[0] + off > E || l.bb[2] + off < W) continue;
      const p = l.pts; let dist = 0, nextLab = 120, px = 0, py = 0;
      ctx.beginPath();
      for (let k = 0; k < p.length; k += 2) {
        const pt = map.latLngToContainerPoint([p[k + 1], p[k] + off]);
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else {
          ctx.lineTo(pt.x, pt.y); dist += Math.hypot(pt.x - px, pt.y - py);
          if (dist > nextLab && pt.x > 30 && pt.y > 20 && pt.x < size.x - 30 && pt.y < size.y - 20) {
            if (free(pt.x, pt.y, 70)) { labels.push([pt.x, pt.y, l.v]); placed.push([pt.x, pt.y]); }
            nextLab = dist + 380;
          }
        }
        px = pt.x; py = pt.y;
      }
      const major = l.v % 20 === 0 || l.v === 1012;
      ctx.strokeStyle = 'rgba(15,15,20,0.55)'; ctx.lineWidth = major ? 3.6 : 2.8; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = major ? 1.8 : 1.1; ctx.stroke();
    }
  }
  ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, y, v] of labels) {
    const t = String(v), w = ctx.measureText(t).width + 6;
    ctx.fillStyle = 'rgba(20,22,28,0.85)'; ctx.fillRect(x - w / 2, y - 7, w, 14);
    ctx.fillStyle = '#fff'; ctx.fillText(t, x, y);
  }
  for (const c of field.iso.hl) {
    if (c.lat < S || c.lat > N) continue;
    for (const off of offsets) {
      if (c.lon + off < W || c.lon + off > E) continue;
      const pt = map.latLngToContainerPoint([c.lat, c.lon + off]);
      ctx.font = '800 22px system-ui, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = c.t === 'H' ? '#5aa9ff' : '#ff5c5c';
      ctx.strokeText(c.t, pt.x, pt.y); ctx.fillText(c.t, pt.x, pt.y);
      ctx.font = '700 11px system-ui, sans-serif'; ctx.lineWidth = 2.5;
      ctx.strokeText(c.v, pt.x, pt.y + 16); ctx.fillStyle = '#fff'; ctx.fillText(c.v, pt.x, pt.y + 16);
    }
  }
}

// ---------- particles ----------
let parts = [], geom = null, moving = false, PART_AGE = 90, looping = false;
function partAge() { return Math.round(Math.min(400, 90 / Math.sqrt(Math.max(0.05, settings.speed)))); }
function resetParticles() {
  fitCanvas(partCv, 1);
  geom = viewGeom();
  PART_AGE = partAge();
  const nP = Math.round(Math.min(7000, geom.w * geom.h / 500) * settings.density);
  parts = [];
  for (let i = 0; i < nP; i++) parts.push(newParticle(Math.random() * PART_AGE | 0));
}
function newParticle(age) { return { x: Math.random() * geom.w, y: Math.random() * geom.h, age: age || 0 }; }
function stepParticles() {
  const ctx = partCv.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = 'rgba(0,0,0,' + trailFade().toFixed(4) + ')'; ctx.fillRect(0, 0, partCv.width, partCv.height);
  ctx.globalCompositeOperation = 'source-over';
  if (!field || !settings.particles || moving) return;
  const k = settings.speed * 0.11 * Math.pow(1.15, map.getZoom() - 2);   // pixels per frame per m/s
  ctx.lineWidth = settings.width; ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.age++ > PART_AGE || p.x < 0 || p.y < 0 || p.x > geom.w || p.y > geom.h) { parts[i] = newParticle(); continue; }
    const lat = geom.rowLat[Math.max(0, Math.min(geom.h, Math.round(p.y)))];
    const uv = sample(lat, geom.lonL + p.x * geom.dLon);
    if (!uv) { p.age = PART_AGE + 1; continue; }
    const nx = p.x + uv[0] * k, ny = p.y - uv[1] * k;
    ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); p.x = nx; p.y = ny;
  }
  ctx.stroke();
}
function loop() { stepParticles(); requestAnimationFrame(loop); }

// ---------- time / run UI ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function parseT(iso) { return new Date(iso.replace('Z', ':00Z')); }
function fmtTime(iso) { return parseT(iso).toUTCString().replace(':00 GMT', ' UTC'); }
function runLabel(iso) { const d = parseT(iso); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONS[d.getUTCMonth()] + ' ' + String(d.getUTCHours()).padStart(2, '0') + 'Z'; }
function redrawStatic() { drawShade(); drawIsobars(); drawBarbs(); }
let loadToken = 0;
async function setStep(i) {
  stepIdx = i;
  const st = meta.steps[i];
  $('stepLabel').textContent = '+' + st.hour + 'h';
  $('stepLabel').title = 'Day ' + (st.hour / 24).toFixed(1);
  $('validtime').textContent = 'Valid ' + fmtTime(st.valid);
  const tok = ++loadToken, ld = $('loading');
  const t = setTimeout(() => ld.style.display = 'block', 150);
  let f;
  try { f = await loadStep(i); } finally { clearTimeout(t); if (tok === loadToken) ld.style.display = 'none'; }
  if (tok !== loadToken) return;
  field = f;
  redrawStatic(); updateNotes();
  if (i + 1 < meta.steps.length) loadStep(i + 1).catch(() => {});   // prefetch next step
}
let playTimer = null;
$('play').onclick = function () {
  if (playTimer) { clearInterval(playTimer); playTimer = null; this.textContent = '▶'; return; }
  this.textContent = '❚❚';
  playTimer = setInterval(() => { const n = (stepIdx + 1) % meta.steps.length; $('slider').value = n; setStep(n); }, 1200);
};
$('slider').oninput = e => setStep(+e.target.value);

// precip period menu + notes
function updateNotes() {
  const st = meta && meta.steps[stepIdx], n = $('shadeNote'), sel = $('pcpSel');
  sel.parentElement.style.display = settings.shade === 'precip' ? '' : 'none';
  if (!st) return;
  for (const o of sel.options) if (o.value !== '1') o.disabled = !pcpAvail(o.value, st);
  let txt = '';
  if (settings.shade === 'gust') txt = st.gustPeriod ? 'max gust in previous ' + st.gustPeriod + ' h' : 'no gust at +0h (starts +3h)';
  else if (settings.shade === 'precip') {
    const p = effPeriod(), want = settings.precipPeriod;
    if (!p) txt = st.hour === 0 ? 'no precipitation at +0h' : want + ' h totals not available at this step';
    else {
      txt = p === 'total' ? 'total since run start (' + st.hour + ' h)' : p + ' h total, ending at valid time';
      if (p !== want) txt += want === '3' ? ' (3 h only to +144h)' : want === '24' ? ' (24 h starts at +24h)' : ' (6 h starts at +6h)';
    }
  }
  n.textContent = txt;
  drawLegend();
}
$('shadeSel').value = settings.shade; $('pcpSel').value = settings.precipPeriod;
$('shadeSel').onchange = e => { settings.shade = e.target.value; saveSettings(); drawShade(); updateNotes(); };
$('pcpSel').onchange = e => { if (e.target.value === '1') { e.target.value = settings.precipPeriod; return; } settings.precipPeriod = e.target.value; saveSettings(); drawShade(); updateNotes(); };
[['tParticles', 'particles'], ['tBarbs', 'barbs'], ['tIsobars', 'isobars']].forEach(([id, k]) => {
  $(id).checked = settings[k];
  $(id).onchange = e => {
    settings[k] = e.target.checked; saveSettings();
    if (k === 'particles') partCv.getContext('2d').clearRect(0, 0, partCv.width, partCv.height);
    if (k === 'barbs') drawBarbs(); if (k === 'isobars') drawIsobars();
  };
});

map.on('movestart zoomstart', () => { moving = true; partCv.getContext('2d').clearRect(0, 0, partCv.width, partCv.height); });
map.on('moveend', () => { moving = false; resetParticles(); redrawStatic(); });
map.on('resize', () => { resetParticles(); redrawStatic(); });

// hover readout (one variable per line; contents chosen in "Additional Map Settings")
const tip = $('tooltip');
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function fmtCoord(la, lo) {
  return Math.abs(la).toFixed(2) + '°' + (la >= 0 ? 'N' : 'S') + ', ' + Math.abs(lo).toFixed(2) + '°' + (lo >= 0 ? 'E' : 'W');
}
// variables implied by what is on screen (used when "Match current layer" is on)
function autoVars() {
  const a = new Set();
  if (!settings.hoverAuto) return a;
  const sh = settings.shade;
  if (sh === 'speed' || sh === 'off') { a.add('hvSpeed'); a.add('hvDir'); }
  if (sh === 'gust') a.add('hvGust');
  if (sh === 'temp') a.add('hvTemp');
  if (sh === 'precip') a.add('hvPcp');
  if (settings.isobars) a.add('hvPres');
  return a;
}
function shown(k) { return settings[k] || autoVars().has(k); }
function readoutRows(la, lo) {
  const p = sample(la, lo);
  if (!p) return null;
  const st = field.st, det = settings.hoverStyle === 'detailed', rows = [];
  const sub = t => det && t ? ` <span class="sub">${t}</span>` : '';
  const na = '<span class="sub">n/a at +0h</span>';
  const ms = Math.hypot(p[0], p[1]), dir = (Math.atan2(-p[0], -p[1]) * 180 / Math.PI + 360) % 360;
  const second = v => settings.units === 'ms' ? (v * MS2KT).toFixed(0) + ' kt' : v.toFixed(1) + ' m/s';
  if (shown('hvSpeed')) rows.push(['Wind', fmtSpeed(ms) + sub(second(ms))]);
  if (shown('hvDir')) rows.push(['Direction', 'from ' + COMPASS[Math.round(dir / 22.5) % 16] + sub(dir.toFixed(0) + '°')]);
  if (shown('hvGust')) {
    const gs = sampleGust(la, lo);
    rows.push(['Gust', gs === null ? na : fmtSpeed(gs) + sub(second(gs) + ' · max, prev ' + st.gustPeriod + ' h')]);
  }
  if (shown('hvTemp')) {
    const c = sampleTemp(la, lo);
    rows.push(['Temp', fmtTemp(c) + sub(settings.tempUnit === 'F' ? c.toFixed(1) + '°C' : (c * 9 / 5 + 32).toFixed(0) + '°F')]);
  }
  if (shown('hvPres')) rows.push(['Pressure', samplePres(la, lo).toFixed(0) + ' hPa' + sub('sea level')]);
  const other = mm => settings.precipUnit === 'in' ? mm.toFixed(1) + ' mm' : (mm / 25.4).toFixed(2) + ' in';
  let totalShown = false;
  if (shown('hvPcp')) {
    const per = st.hour > 0 ? effPeriod() : null;
    if (st.hour === 0) rows.push(['Precip', na]);
    else if (per === 'total' || !per || !field.pcp) { const v = sampleAcc(la, lo); rows.push(['Precip total', fmtPrecip(v) + sub(other(v) + ' · since run start')]); totalShown = true; }
    else { const v = samplePcp(la, lo, per); rows.push(['Precip ' + per + ' h', fmtPrecip(v) + sub(other(v) + ' · ending at valid time')]); }
  }
  if (shown('hvPcpTot') && !totalShown && !(shown('hvPcp') && st.hour === 0)) {
    if (st.hour === 0) rows.push(['Precip total', na]);
    else { const v = sampleAcc(la, lo); rows.push(['Precip total', fmtPrecip(v) + sub(other(v) + ' · since run start')]); }
  }
  if (shown('hvCoord')) {
    const lon = ((lo + 180) % 360 + 360) % 360 - 180;
    rows.push(['Location', '<span class="sub2">' + fmtCoord(la, lon) + '</span>']);
  }
  return rows;
}
function showTip(e) {
  if (!settings.hoverOn || !field) { tip.style.display = 'none'; return; }
  const rows = readoutRows(e.latlng.lat, e.latlng.lng);
  if (!rows || !rows.length) { tip.style.display = 'none'; return; }
  tip.innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('');
  tip.style.display = 'grid';
  const x = e.containerPoint.x + 14, y = e.containerPoint.y + 14, sz = map.getSize();
  tip.style.left = Math.max(4, Math.min(x, sz.x - tip.offsetWidth - 6)) + 'px';
  tip.style.top = Math.max(4, Math.min(y, sz.y - tip.offsetHeight - 6)) + 'px';
}
map.on('mousemove', showTip);
map.on('click', e => { if (L.Browser.touch) showTip(e); });   // tap-to-read on phones/tablets
map.on('mouseout', () => tip.style.display = 'none');

// ---------- "Additional Map Settings" menu (bottom-left) ----------
const hoverUI = (function () {
  const btn = $('amsBtn'), body = $('amsBody');
  function setOpen(open) { body.hidden = !open; btn.setAttribute('aria-expanded', open); $('amsArrow').textContent = open ? '▾' : '▴'; }
  btn.onclick = () => {
    const open = body.hidden; setOpen(open);
    if (open && !$('settings').hidden) $('settingsBtn').click();   // only one panel open at a time (they overlap on short screens)
  };
  $('settingsBtn').addEventListener('click', () => setTimeout(() => { if (!$('settings').hidden) setOpen(false); }, 0));
  const boxes = { hoverOn: 'hOn', hvSpeed: 'hSpeed', hvDir: 'hDir', hvGust: 'hGust', hvTemp: 'hTemp', hvPres: 'hPres', hvPcp: 'hPcp', hvPcpTot: 'hPcpTot', hvCoord: 'hCoord' };
  function sync() {
    const auto = autoVars();
    for (const k in boxes) $(boxes[k]).checked = settings[k];
    $('hAuto').checked = settings.hoverAuto;
    $('hCompact').checked = settings.hoverStyle === 'compact'; $('hDetailed').checked = settings.hoverStyle === 'detailed';
    $('amsVars').classList.toggle('off', !settings.hoverOn);
    $('amsVars').querySelectorAll('input').forEach(i => i.disabled = !settings.hoverOn);
    // variables implied by the current layer: shown ticked + locked, tagged "auto"
    for (const k in boxes) {
      if (k === 'hoverOn') continue;
      const el = $(boxes[k]), lab = el.parentElement, on = auto.has(k);
      lab.classList.toggle('auto', on);
      if (on) { el.checked = true; el.disabled = true; }
    }
    $('amsSubVars').textContent = settings.hoverAuto ? 'Also show these (items tagged auto are shown automatically for current layer)' : 'Show these values';
  }
  for (const k in boxes) $(boxes[k]).addEventListener('change', () => { settings[k] = $(boxes[k]).checked; saveSettings(); sync(); tip.style.display = 'none'; });
  $('hAuto').addEventListener('change', () => {
    const before = autoVars();                       // turning auto off: keep what was showing as the manual set
    settings.hoverAuto = $('hAuto').checked;
    if (!settings.hoverAuto) before.forEach(k => settings[k] = true);
    saveSettings(); sync(); tip.style.display = 'none';
  });
  ['shadeSel', 'tIsobars'].forEach(id => $(id).addEventListener('change', () => setTimeout(sync, 0)));
  ['hCompact', 'hDetailed'].forEach(id => $(id).addEventListener('change', () => { settings.hoverStyle = $(id).value; saveSettings(); sync(); }));
  $('hReset').onclick = () => { HOVER_KEYS.forEach(k => settings[k] = DEFAULTS[k]); saveSettings(); sync(); tip.style.display = 'none'; };
  sync();
  return { sync };
})();

// ---------- legend ----------
function drawLegend() {
  const c = $('legendBar'), ctx = c.getContext('2d'), ticks = $('legendTicks'), W = c.width;
  ctx.clearRect(0, 0, W, c.height); ticks.innerHTML = '';
  const tick = (x, t) => { const s = document.createElement('span'); s.style.left = x + 'px'; s.textContent = t; ticks.appendChild(s); };
  const mode = settings.shade;
  $('legend').style.display = mode === 'off' ? 'none' : '';
  if (mode === 'speed' || mode === 'gust') {
    for (let x = 0; x < W; x++) { const k = Math.round(x / (W - 1) * 100); ctx.fillStyle = `rgb(${LUT[k*3]},${LUT[k*3+1]},${LUT[k*3+2]})`; ctx.fillRect(x, 0, 1, c.height); }
    const u = UNITS[settings.units], maxVal = 100 / MS2KT * u.f;
    u.ticks.filter(t => t <= maxVal + 1e-6).forEach(t => tick(t / maxVal * W, t));
    $('legendTitle').textContent = (mode === 'gust' ? 'Wind gust' : 'Wind speed') + ' (' + u.name + ')';
  } else if (mode === 'temp') {
    for (let x = 0; x < W; x++) { const k = Math.round(x / (W - 1) * 160); ctx.fillStyle = `rgb(${TLUT[k*3]},${TLUT[k*3+1]},${TLUT[k*3+2]})`; ctx.fillRect(x, 0, 1, c.height); }
    if (settings.tempUnit === 'F') [-40, -20, 0, 20, 40, 60, 80, 100, 120].forEach(t => tick((t + 40) / 160 * W, t));
    else [-40, -30, -20, -10, 0, 10, 20, 30, 40, 48].forEach(t => t !== 48 && tick((t * 9 / 5 + 32 + 40) / 160 * W, t));
    $('legendTitle').textContent = '2 m temperature (°' + settings.tempUnit + ')';
  } else if (mode === 'precip') {
    const per = effPeriod() || settings.precipPeriod, thr = pThresholds(per), bw = W / thr.length;
    thr.forEach((t, k) => { ctx.fillStyle = `rgb(${PCOL[k].join(',')})`; ctx.fillRect(k * bw, 0, bw - 1, c.height); if (k % 2 === 0) tick(k * bw + 2, t); });
    $('legendTitle').textContent = 'Precipitation, ' + (per === 'total' ? 'total since run start' : per + ' h total') + ' (' + settings.precipUnit + ')';
  }
}
(function barbKey() {
  const b = $('barbKey'), bc = b.getContext('2d');
  bc.strokeStyle = bc.fillStyle = '#fff'; bc.lineWidth = 1.3; bc.font = '10px sans-serif'; bc.textAlign = 'center';
  [[5, 'half 5'], [10, 'full 10'], [25, '25'], [50, 'pennant 50'], [65, '65']].forEach(([kt, lab], i) => {
    const x = 22 + i * 52, ms = kt / MS2KT;
    drawBarb(bc, x, 30, ms, 0, 45, 18); // westerly wind: staff points west
    bc.fillText(lab, x - 6, 44);
  });
})();

// ---------- settings panel ----------
(function settingsUI() {
  const btn = $('settingsBtn'), box = $('settings');
  btn.onclick = () => { const open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', open); btn.textContent = open ? '⚙ Settings ▴' : '⚙ Settings ▾'; };
  const els = { units: 'sUnits', tempUnit: 'sTemp', precipUnit: 'sPrecip', speed: 'sSpeed', width: 'sWidth', trail: 'sTrail', density: 'sDensity' };
  const strings = ['units', 'tempUnit', 'precipUnit'];
  const out = { speed: v => v.toFixed(2) + '×', width: v => v.toFixed(2) + ' px', trail: v => String(v), density: v => v.toFixed(2) + '×' };
  function sync() {
    for (const k in els) { $(els[k]).value = settings[k]; if (out[k]) $('o' + els[k].slice(1)).textContent = out[k](settings[k]); }
  }
  function apply(k) {
    if (strings.includes(k)) { drawLegend(); tip.style.display = 'none'; if (k === 'precipUnit') drawShade(); }
    if (k === 'density' || k === 'speed') { if (meta) resetParticles(); }
    if (k === 'width' || k === 'trail') { if (meta) partCv.getContext('2d').clearRect(0, 0, partCv.width, partCv.height); }
  }
  for (const k in els) {
    const el = $(els[k]);
    el.addEventListener(strings.includes(k) ? 'change' : 'input', () => {
      settings[k] = strings.includes(k) ? el.value : parseFloat(el.value);
      sync(); saveSettings(); apply(k);
    });
  }
  $('sReset').onclick = () => {
    Object.assign(settings, DEFAULTS); sync(); saveSettings(); hoverUI.sync();
    $('shadeSel').value = settings.shade; $('pcpSel').value = settings.precipPeriod;
    $('tParticles').checked = settings.particles; $('tBarbs').checked = settings.barbs; $('tIsobars').checked = settings.isobars;
    if (meta) { resetParticles(); redrawStatic(); updateNotes(); } else drawLegend();
  };
  sync();
})();

// ---------- model runs ----------
async function openRun(id, keepValid) {
  const entry = INDEX.runs.find(r => r.id === id);
  const m = await fetch('data/runs/' + id + '/meta.json', { cache: 'no-cache' }).then(r => r.json());
  meta = m; field = null;
  const latest = INDEX.runs[0].id === id;
  $('runinfo').textContent = 'Model run ' + fmtTime(m.run) + (latest ? ' (latest)' : '') + ' · ' + m.res + '° grid';
  const s = $('slider'); s.max = m.steps.length - 1;
  let idx = 0, note = '';
  if (keepValid) {
    const tv = parseT(keepValid).getTime();
    let best = 0, bd = Infinity;
    m.steps.forEach((st, k) => { const dd = Math.abs(parseT(st.valid).getTime() - tv); if (dd < bd) { bd = dd; best = k; } });
    idx = best;
    if (bd === 0) note = 'Same valid time, +' + m.steps[idx].hour + 'h in this run';
    else note = 'That valid time is outside this run (to +' + entry.maxHour + 'h): showing nearest step';
  }
  $('runNote').textContent = note;
  s.value = idx;
  resetParticles();
  await setStep(idx);
}
$('runSel').onchange = e => {
  const keep = meta ? meta.steps[stepIdx].valid : null;
  openRun(e.target.value, keep);
};

// ---------- start ----------
fetch('data/index.json', { cache: 'no-cache' }).then(r => r.json()).then(async ix => {
  INDEX = ix;
  const sel = $('runSel');
  ix.runs.forEach((r, k) => {
    const o = document.createElement('option'); o.value = r.id;
    o.textContent = runLabel(r.run) + ' · to +' + r.maxHour + 'h' + (k === 0 ? ' (latest)' : '');
    sel.appendChild(o);
  });
  drawLegend();
  await openRun(ix.runs[0].id, null);
  loop();
});
window._app = { map, settings, osm };   // shared with draw.js
window._windDebug = { map, sample, sampleGust, sampleTemp, samplePres, samplePcp, settings, openRun,
  get stepIdx() { return stepIdx; }, get field() { return field; }, get meta() { return meta; }, get index() { return INDEX; } };
})();
