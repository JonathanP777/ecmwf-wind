/* ECMWF wind viewer: Leaflet map + three canvas layers (speed colours, particles, barbs). */
(function () {
'use strict';
const MS2KT = 1.943844;
let meta = null, field = null, stepIdx = 0;
const cache = {};

// ---------- map & basemap ----------
const map = L.map('map', { center: [30, 0], zoom: 2, minZoom: 1, maxZoom: 12, worldCopyJump: true, preferCanvas: true });
map.createPane('shade'); map.getPane('shade').style.zIndex = 350;
map.createPane('particles'); map.getPane('particles').style.zIndex = 420;
map.createPane('barbs'); map.getPane('barbs').style.zIndex = 430;
map.createPane('labels'); map.getPane('labels').style.zIndex = 440; map.getPane('labels').style.pointerEvents = 'none';
map.createPane('coast'); map.getPane('coast').style.zIndex = 400; map.getPane('coast').style.pointerEvents = 'none';
const dataAttrib = 'Wind data: <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF open data</a> (CC BY 4.0) | Coastlines: Natural Earth';
const esriAttrib = 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
const dark = L.layerGroup([
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: esriAttrib + ' | ' + dataAttrib, maxZoom: 16 }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'labels' })
]).addTo(map);
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | ' + dataAttrib, maxZoom: 19 });
L.control.layers({ 'Dark (Esri)': dark, 'OpenStreetMap': osm }, null, { position: 'topright' }).addTo(map);
// coastlines + borders drawn above the colour shading so land/sea stay readable
const coastRenderer = L.canvas({ pane: 'coast', padding: 0.3 });
fetch('vendor/coast.geojson').then(r => r.json()).then(g => L.geoJSON(g, { renderer: coastRenderer, interactive: false, style: { color: '#e8e8e8', weight: 1, opacity: 0.75 } }).addTo(map));
fetch('vendor/borders.geojson').then(r => r.json()).then(g => L.geoJSON(g, { renderer: coastRenderer, interactive: false, style: { color: '#bbbbbb', weight: 0.7, opacity: 0.55, dashArray: '3 3' } }).addTo(map));

// ---------- canvas layer helper ----------
function makeCanvas(pane) {
  const c = L.DomUtil.create('canvas', 'wind-canvas', map.getPane(pane));
  return c;
}
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const shadeCv = makeCanvas('shade'), partCv = makeCanvas('particles'), barbCv = makeCanvas('barbs');
function fitCanvas(c, ratio) {
  const s = map.getSize();
  c.width = Math.round(s.x * ratio); c.height = Math.round(s.y * ratio);
  c.style.width = s.x + 'px'; c.style.height = s.y + 'px';
  L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
}

// ---------- field sampling ----------
function decode(img, st) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  const n = img.width * img.height, u = new Float32Array(n), v = new Float32Array(n);
  const ur = (st.uMax - st.uMin) / 255, vr = (st.vMax - st.vMin) / 255;
  for (let i = 0; i < n; i++) { u[i] = st.uMin + px[i * 4] * ur; v[i] = st.vMin + px[i * 4 + 1] * vr; }
  return { u, v, w: img.width, h: img.height };
}
function loadStep(i) {
  if (cache[i]) return Promise.resolve(cache[i]);
  const st = meta.steps[i];
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { cache[i] = decode(img, st); res(cache[i]); };
    img.onerror = rej;
    img.src = 'data/' + st.file + '?r=' + encodeURIComponent(meta.run);
  });
}
// bilinear interpolation; returns [u,v] m/s or null
function sample(lat, lon) {
  if (!field || lat > 90 || lat < -90) return null;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const x = (lon - meta.lon0) / meta.dlon, y = (meta.lat0 - lat) / meta.dlat;
  const x0 = Math.floor(x), y0 = Math.min(Math.floor(y), field.h - 2), fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % field.w, W = field.w;
  const i00 = y0 * W + x0, i10 = y0 * W + x1, i01 = (y0 + 1) * W + x0, i11 = (y0 + 1) * W + x1;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  return [field.u[i00] * a + field.u[i10] * b + field.u[i01] * c + field.u[i11] * d,
          field.v[i00] * a + field.v[i10] * b + field.v[i01] * c + field.v[i11] * d];
}
// screen geometry helpers: in Web Mercator, lon is linear in x and lat depends only on y
function viewGeom() {
  const s = map.getSize();
  const lonL = map.containerPointToLatLng([0, 0]).lng, lonR = map.containerPointToLatLng([s.x, 0]).lng;
  const rowLat = new Float32Array(s.y + 1);
  for (let y = 0; y <= s.y; y++) rowLat[y] = map.containerPointToLatLng([0, y]).lat;
  return { w: s.x, h: s.y, lonL, dLon: (lonR - lonL) / s.x, rowLat };
}

// ---------- colour scale (knots) ----------
const SCALE = [[0,[98,113,183]],[5,[57,97,159]],[10,[74,148,169]],[15,[77,141,123]],[20,[83,165,83]],[25,[53,159,53]],
  [30,[167,157,81]],[35,[159,127,58]],[40,[161,108,92]],[50,[129,58,78]],[60,[175,80,136]],[70,[117,74,147]],[85,[109,97,163]],[100,[230,230,230]]];
const LUT = new Uint8Array(101 * 3);
for (let k = 0; k <= 100; k++) {
  let j = 0; while (j < SCALE.length - 2 && k > SCALE[j + 1][0]) j++;
  const [k0, c0] = SCALE[j], [k1, c1] = SCALE[j + 1], t = Math.min(1, Math.max(0, (k - k0) / (k1 - k0)));
  for (let ch = 0; ch < 3; ch++) LUT[k * 3 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * t);
}

// ---------- speed shading ----------
function drawShade() {
  fitCanvas(shadeCv, 1);
  const ctx = shadeCv.getContext('2d'); ctx.clearRect(0, 0, shadeCv.width, shadeCv.height);
  if (!field || !document.getElementById('tShade').checked) return;
  const g = viewGeom(), R = 3, sw = Math.ceil(g.w / R), sh = Math.ceil(g.h / R);
  const off = document.createElement('canvas'); off.width = sw; off.height = sh;
  const octx = off.getContext('2d'), im = octx.createImageData(sw, sh), d = im.data;
  for (let j = 0; j < sh; j++) {
    const lat = g.rowLat[Math.min(g.h, j * R + 1)];
    for (let i = 0; i < sw; i++) {
      const p = sample(lat, g.lonL + (i * R + 1) * g.dLon), o = (j * sw + i) * 4;
      if (!p) continue;
      const k = Math.min(100, Math.round(Math.hypot(p[0], p[1]) * MS2KT));
      d[o] = LUT[k * 3]; d[o + 1] = LUT[k * 3 + 1]; d[o + 2] = LUT[k * 3 + 2]; d[o + 3] = 150;
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
  if (!field || !document.getElementById('tBarbs').checked) return;
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
  // in latitude use a spacing that keeps vertical gaps similar on screen (Mercator stretch)
  let lat = Math.ceil(latMax / stepDeg) * stepDeg;
  let count = 0;
  while (lat >= latMin && count < 6000) {
    for (let lon = Math.floor(b.getWest() / stepDeg) * stepDeg; lon <= b.getEast(); lon += stepDeg) {
      const p = sample(lat, lon); if (!p) continue;
      const pt = map.latLngToContainerPoint([lat, lon]);
      drawBarb(ctx, pt.x, pt.y, p[0], p[1], lat, size); count++;
    }
    // next row: step so that the on-screen vertical spacing stays ~ the horizontal spacing
    const k = Math.max(1, Math.round(n * Math.cos(lat * Math.PI / 180)));
    lat -= k * meta.dlat;
    lat = Math.round(lat / meta.dlat) * meta.dlat;
  }
}

// ---------- particles ----------
let parts = [], geom = null, animOn = false, moving = false;
const PART_AGE = 90;
function resetParticles() {
  fitCanvas(partCv, 1);
  geom = viewGeom();
  const nP = Math.min(7000, Math.round(geom.w * geom.h / 500));
  parts = [];
  for (let i = 0; i < nP; i++) parts.push(newParticle(Math.random() * PART_AGE | 0));
}
function newParticle(age) { return { x: Math.random() * geom.w, y: Math.random() * geom.h, age: age || 0 }; }
function stepParticles() {
  const ctx = partCv.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = 'rgba(0,0,0,0.90)'; ctx.fillRect(0, 0, partCv.width, partCv.height);
  ctx.globalCompositeOperation = 'source-over';
  if (!field || !document.getElementById('tParticles').checked || moving) return;
  const k = 0.11 * Math.pow(1.15, map.getZoom() - 2);   // pixels per frame per m/s
  ctx.lineWidth = 1.0; ctx.strokeStyle = 'rgba(255,255,255,0.7)';
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

// ---------- UI ----------
function fmtTime(iso) {
  const d = new Date(iso.replace('Z', ':00Z'));
  return d.toUTCString().replace(':00 GMT', ' UTC');
}
function redrawStatic() { drawShade(); drawBarbs(); }
async function setStep(i) {
  stepIdx = i;
  const st = meta.steps[i];
  document.getElementById('stepLabel').textContent = '+' + st.hour + 'h';
  document.getElementById('validtime').textContent = 'Valid ' + fmtTime(st.valid);
  const ld = document.getElementById('loading');
  const t = setTimeout(() => ld.style.display = 'block', 150);
  field = await loadStep(i);
  clearTimeout(t); ld.style.display = 'none';
  if (i !== stepIdx) return;
  redrawStatic();
  // prefetch next step
  if (i + 1 < meta.steps.length) loadStep(i + 1);
}
let playTimer = null;
document.getElementById('play').onclick = function () {
  if (playTimer) { clearInterval(playTimer); playTimer = null; this.textContent = '▶'; return; }
  this.textContent = '❚❚';
  playTimer = setInterval(() => {
    const s = document.getElementById('slider'); const n = (stepIdx + 1) % meta.steps.length;
    s.value = n; setStep(n);
  }, 1200);
};
document.getElementById('slider').oninput = e => setStep(+e.target.value);
document.getElementById('tShade').onchange = drawShade;
document.getElementById('tBarbs').onchange = drawBarbs;
document.getElementById('tParticles').onchange = () => { const c = partCv.getContext('2d'); c.clearRect(0, 0, partCv.width, partCv.height); };

map.on('movestart zoomstart', () => { moving = true; partCv.getContext('2d').clearRect(0, 0, partCv.width, partCv.height); });
map.on('moveend', () => { moving = false; resetParticles(); redrawStatic(); });
map.on('resize', () => { resetParticles(); redrawStatic(); });

// hover readout
const tip = document.getElementById('tooltip');
map.on('mousemove', e => {
  const p = sample(e.latlng.lat, e.latlng.lng);
  if (!p) { tip.style.display = 'none'; return; }
  const ms = Math.hypot(p[0], p[1]), dir = (Math.atan2(-p[0], -p[1]) * 180 / Math.PI + 360) % 360;
  const compass = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(dir / 22.5) % 16];
  const lon = ((e.latlng.lng + 180) % 360 + 360) % 360 - 180;
  tip.innerHTML = `<b>${(ms * MS2KT).toFixed(0)} kt</b> (${ms.toFixed(1)} m/s) from ${dir.toFixed(0)}° ${compass}<br>` +
    `<span style="color:#aaa">${e.latlng.lat.toFixed(2)}°, ${lon.toFixed(2)}°</span>`;
  tip.style.display = 'block';
  tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y + 14) + 'px';
});
map.on('mouseout', () => tip.style.display = 'none');

// legend
(function legend() {
  const c = document.getElementById('legendBar'), ctx = c.getContext('2d');
  for (let x = 0; x < c.width; x++) { const k = Math.round(x / (c.width - 1) * 100); ctx.fillStyle = `rgb(${LUT[k*3]},${LUT[k*3+1]},${LUT[k*3+2]})`; ctx.fillRect(x, 0, 1, c.height); }
  const ticks = document.getElementById('legendTicks');
  [0, 10, 20, 30, 40, 50, 60, 80, 100].forEach(k => { const s = document.createElement('span'); s.style.left = (k / 100 * 260) + 'px'; s.textContent = k; ticks.appendChild(s); });
  const b = document.getElementById('barbKey'), bc = b.getContext('2d');
  bc.strokeStyle = bc.fillStyle = '#fff'; bc.lineWidth = 1.3; bc.font = '10px sans-serif'; bc.textAlign = 'center';
  [[5, 'half 5'], [10, 'full 10'], [25, '25'], [50, 'pennant 50'], [65, '65']].forEach(([kt, lab], i) => {
    const x = 22 + i * 52, ms = kt / MS2KT;
    drawBarb(bc, x, 30, ms, 0, 45, 18); // westerly wind: staff points west
    bc.fillText(lab, x - 6, 44);
  });
})();

// ---------- start ----------
fetch('data/meta.json', { cache: 'no-cache' }).then(r => r.json()).then(m => {
  meta = m;
  document.getElementById('runinfo').textContent = 'Model run ' + fmtTime(m.run) + ' · 0.25° grid';
  const s = document.getElementById('slider'); s.max = m.steps.length - 1; s.value = 0;
  resetParticles();
  setStep(0);
  loop();
});
window._windDebug = { map, sample, get meta() { return meta; } };
})();
