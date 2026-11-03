/* Borders & lines: coastlines, country borders, states/provinces, US counties, lakes, rivers, cities, lat/lon grid,
   plus basemap opacity/labels. All drawn on canvases in the 'coast' pane (above the colour shading), so the
   PNG export (draw.js) picks them up. Settings are saved in localStorage ('windLines').
   Data files in vendor/lines/*.json are delta-encoded polylines: {"s":scale,"l":[[x0,y0,dx1,dy1,...],...]}
   (lon/lat * scale as integers); built by tools/build_lines.sh from Natural Earth + US Census (public domain). */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const { map, dark, darkRef, osm, hoverUI } = window._app;

// ---------- layer definitions (defaults keep the original look: coastlines + countries + states on) ----------
const LAYERS = [
  { k: 'grid',      name: 'Lat/lon grid',       kind: 'grid',  def: { on: false, color: '#ffffff', width: 0.6, opacity: 0.35, dash: 'dotted' } },
  { k: 'rivers',    name: 'Rivers',             src: 'vendor/lines/rivers.json',      def: { on: false, color: '#4a9be0', width: 0.7, opacity: 0.6, dash: 'solid' } },
  { k: 'lakes',     name: 'Lakes',              src: 'vendor/lines/lakes.json',       def: { on: false, color: '#6db8f0', width: 0.8, opacity: 0.7, dash: 'solid' } },
  { k: 'counties',  name: 'US counties',        src: 'vendor/lines/us_counties.json', minZoom: 5, def: { on: false, color: '#9a9a9a', width: 0.6, opacity: 0.6, dash: 'solid' } },
  { k: 'states',    name: 'States / provinces', src: 'vendor/lines/admin1.json',      def: { on: true, color: '#a6a6a6', width: 0.6, opacity: 0.5, dash: 'solid' } },
  { k: 'countries', name: 'Country borders',    src: 'vendor/borders.geojson',        def: { on: true, color: '#bbbbbb', width: 0.7, opacity: 0.55, dash: 'dashed' } },
  { k: 'coast',     name: 'Coastlines',         src: 'vendor/coast.geojson',          def: { on: true, color: '#e8e8e8', width: 1, opacity: 0.75, dash: 'solid' } },
  { k: 'cities',    name: 'City names',         kind: 'cities', src: 'vendor/lines/cities.json', def: { on: false, color: '#ffffff', width: 1, opacity: 0.9, dash: 'solid' } }
];
const UI_ORDER = ['coast', 'countries', 'states', 'counties', 'lakes', 'rivers', 'cities', 'grid'];
const PRESETS = ['#ffffff', '#bbbbbb', '#000000', '#ffd54a', '#ff4d4d', '#4fd1ff', '#5ee07a', '#ff5ad1'];
const DASHES = ['solid', 'dashed', 'dotted'];
const GEN_DEF = { above: false, bmOpacity: 1, bmLabels: true };
const byKey = {}; LAYERS.forEach(L_ => byKey[L_.k] = L_);

// ---------- settings ----------
function defaults() {
  const o = Object.assign({}, GEN_DEF, { layers: {} });
  LAYERS.forEach(l => o.layers[l.k] = Object.assign({}, l.def));
  return o;
}
const cfg = defaults();
try {
  const saved = JSON.parse(localStorage.getItem('windLines') || '{}');
  for (const k in GEN_DEF) if (typeof saved[k] === typeof GEN_DEF[k]) cfg[k] = saved[k];
  cfg.bmOpacity = Math.min(1, Math.max(0, cfg.bmOpacity));
  if (saved.layers) LAYERS.forEach(l => {
    const s = saved.layers[l.k] || {}, d = cfg.layers[l.k];
    if (typeof s.on === 'boolean') d.on = s.on;
    if (typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)) d.color = s.color;
    if (typeof s.width === 'number' && s.width >= 0.25 && s.width <= 4) d.width = s.width;
    if (typeof s.opacity === 'number' && s.opacity >= 0.05 && s.opacity <= 1) d.opacity = s.opacity;
    if (DASHES.includes(s.dash)) d.dash = s.dash;
  });
} catch (e) {}
function save() { try { localStorage.setItem('windLines', JSON.stringify(cfg)); } catch (e) {} }

// ---------- data loading (lazy: a file is fetched the first time its layer is switched on) ----------
function decode(j) {   // -> array of [[lat,lng],...]
  const s = j.s, out = [];
  for (const a of j.l) {
    let x = a[0], y = a[1]; const ln = [[y / s, x / s]];
    for (let i = 2; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; ln.push([y / s, x / s]); }
    out.push(ln);
  }
  return out;
}
function fromGeoJSON(g) {
  const out = [], geoms = g.type === 'FeatureCollection' ? g.features.map(f => f.geometry) : g.type === 'Feature' ? [g.geometry] : g.type === 'GeometryCollection' ? g.geometries : [g];
  geoms.forEach(gm => {
    if (!gm) return;
    const cs = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : [];
    cs.forEach(c => out.push(c.map(p => [p[1], p[0]])));
  });
  return out;
}
// group lines into 10° tiles so the canvas renderer can skip what is off screen
function bucket(lines) {
  const b = new Map();
  lines.forEach(ln => { const p = ln[0], key = Math.floor(p[0] / 10) + ':' + Math.floor(p[1] / 10); if (!b.has(key)) b.set(key, []); b.get(key).push(ln); });
  return [...b.values()];
}
const renderer = L.canvas({ pane: 'coast', padding: 0.3 });
const state = {};   // k -> { loading, group, data }
function dashArray(c) {
  const w = Math.max(c.width, 0.5);
  return c.dash === 'dashed' ? [Math.max(3, 4 * w), Math.max(2.5, 3 * w)].map(v => v.toFixed(1)).join(' ')
       : c.dash === 'dotted' ? [Math.max(0.8, w), Math.max(2.5, 2.6 * w)].map(v => v.toFixed(1)).join(' ') : null;
}
function styleOf(k) { const c = cfg.layers[k]; return { color: c.color, weight: c.width, opacity: c.opacity, dashArray: dashArray(c), lineCap: c.dash === 'dotted' ? 'round' : 'butt', interactive: false }; }
function load(l) {
  const st = state[l.k] || (state[l.k] = {});
  if (st.loading) return st.loading;
  st.loading = fetch(l.src).then(r => { if (!r.ok) throw new Error(l.src + ' ' + r.status); return r.json(); }).then(j => {
    if (l.kind === 'cities') { st.data = j; return; }
    const lines = j.l ? decode(j) : fromGeoJSON(j);
    st.group = L.layerGroup(bucket(lines).map(ls => L.polyline(ls, Object.assign({ renderer, smoothFactor: 1 }, styleOf(l.k)))));
  }).catch(e => { console.warn('lines: could not load', l.k, e); st.failed = true; });
  return st.loading;
}
function visible(l) { const c = cfg.layers[l.k]; return c.on && !(l.minZoom && map.getZoom() < l.minZoom); }
let applying = 0;
function applyLines() {
  const my = ++applying; zoomVis = zoomKey();
  const need = LAYERS.filter(l => l.src && l.kind !== 'cities' && visible(l));
  Promise.all(need.map(load)).then(() => {
    if (my !== applying) return;
    // re-add in definition order so the stacking is always grid < rivers < lakes < counties < states < countries < coast
    LAYERS.forEach(l => { const st = state[l.k]; if (st && st.group && map.hasLayer(st.group)) map.removeLayer(st.group); });
    LAYERS.forEach(l => {
      const st = state[l.k]; if (!st || !st.group || !visible(l)) return;
      st.group.eachLayer(p => p.setStyle(styleOf(l.k)));
      st.group.addTo(map);
    });
    drawOverlay(); syncNotes();
  });
  if (cfg.layers.cities.on) load(byKey.cities).then(() => { if (my === applying) drawOverlay(); });
  drawOverlay(); syncNotes();
  updateAttrib();
}

// ---------- overlay canvas: lat/lon grid + city names ----------
const ov = L.DomUtil.create('canvas', 'wind-canvas', map.getPane('coast'));
const dpr = Math.min(window.devicePixelRatio || 1, 2);
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function gridStep(z) { return z <= 2 ? 30 : z <= 3 ? 20 : z <= 4 ? 10 : z <= 6 ? 5 : z <= 7 ? 2 : z <= 9 ? 1 : 0.5; }
function fmtDeg(v, pos, neg) { const a = Math.abs(v); return (Number.isInteger(a) ? a : a.toFixed(1)) + '°' + (v === 0 ? '' : v > 0 ? pos : neg); }
function drawOverlay() {
  const s = map.getSize();
  ov.width = Math.round(s.x * dpr); ov.height = Math.round(s.y * dpr);
  ov.style.width = s.x + 'px'; ov.style.height = s.y + 'px';
  L.DomUtil.setPosition(ov, map.containerPointToLayerPoint([0, 0]));
  const ctx = ov.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, s.x, s.y);
  const g = cfg.layers.grid;
  if (g.on) {
    const b = map.getBounds(), z = map.getZoom(), st = gridStep(z);
    ctx.strokeStyle = rgba(g.color, g.opacity); ctx.lineWidth = g.width;
    const da = dashArray(g); ctx.setLineDash(da ? da.split(' ').map(Number) : []); ctx.lineCap = g.dash === 'dotted' ? 'round' : 'butt';
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = rgba(g.color, Math.min(1, g.opacity + 0.35));
    const lat0 = Math.max(-85, Math.ceil(b.getSouth() / st) * st), lat1 = Math.min(85, b.getNorth());
    const lon0 = Math.ceil(b.getWest() / st) * st, lon1 = b.getEast();
    ctx.beginPath();
    for (let la = lat0; la <= lat1 + 1e-9; la += st) { const y = map.latLngToContainerPoint([la, b.getWest()]).y; ctx.moveTo(0, y); ctx.lineTo(s.x, y); }
    let n = 0;
    for (let lo = lon0; lo <= lon1 + 1e-9 && n < 400; lo += st, n++) { const x = map.latLngToContainerPoint([b.getCenter().lat, lo]).x; ctx.moveTo(x, 0); ctx.lineTo(x, s.y); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    for (let la = lat0; la <= lat1 + 1e-9; la += st) { const y = map.latLngToContainerPoint([la, b.getWest()]).y; if (y > 14 && y < s.y - 4) ctx.fillText(fmtDeg(+la.toFixed(2), 'N', 'S'), 4, y - 1); }
    ctx.textAlign = 'center'; n = 0;
    for (let lo = lon0; lo <= lon1 + 1e-9 && n < 400; lo += st, n++) {
      const x = map.latLngToContainerPoint([b.getCenter().lat, lo]).x, w = ((lo + 540) % 360) - 180;
      if (x > 30 && x < s.x - 20) ctx.fillText(fmtDeg(+w.toFixed(2), 'E', 'W'), x, s.y - 18);
    }
  }
  const c = cfg.layers.cities, cd = state.cities && state.cities.data;
  if (c.on && cd) {
    const z = map.getZoom(), size = Math.round(11 * c.width), placed = [], b = map.getBounds().pad(0.05);
    ctx.font = `600 ${size}px system-ui, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
    let count = 0;
    for (const r of cd) {   // [name, lat, lon, minZoom], sorted most important first
      if (r[3] > z + 1.2) break;
      // world copies: pick the copy of this longitude nearest the view centre
      const cl = map.getCenter().lng, lon = r[2] + Math.round((cl - r[2]) / 360) * 360;
      if (!b.contains([r[1], lon])) continue;
      const p = map.latLngToContainerPoint([r[1], lon]), w = ctx.measureText(r[0]).width;
      const box = [p.x - 3, p.y - size / 2 - 2, p.x + w + 8, p.y + size / 2 + 2];
      if (placed.some(q => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      ctx.globalAlpha = c.opacity;
      ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, 2.2 * c.width), 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(r[0], p.x + 5, p.y);
      ctx.fillText(r[0], p.x + 5, p.y);
      if (++count > 350) break;
    }
    ctx.globalAlpha = 1;
  }
}
map.on('moveend zoomend resize viewreset', drawOverlay);
let zoomVis = '';
function zoomKey() { return LAYERS.filter(l => l.minZoom).map(l => visible(l) ? 1 : 0).join(''); }
map.on('zoomend', () => { const zk = zoomKey(); if (zk !== zoomVis) { zoomVis = zk; applyLines(); } else syncNotes(); });

// ---------- basemap + stacking ----------
function applyGeneral() {
  map.getPane('coast').style.zIndex = cfg.above ? 435 : 400;   // 435: above particles (420), isobars (425), barbs (430); below labels/readout/drawings
  map.getPane('tilePane').style.opacity = cfg.bmOpacity;
  if (cfg.bmLabels) { if (!dark.hasLayer(darkRef)) dark.addLayer(darkRef); }
  else if (dark.hasLayer(darkRef)) dark.removeLayer(darkRef);
}
let censusOn = false;
function updateAttrib() {
  const want = cfg.layers.counties.on;
  if (want && !censusOn) map.attributionControl.addAttribution('US counties: US Census Bureau');
  if (!want && censusOn) map.attributionControl.removeAttribution('US counties: US Census Bureau');
  censusOn = want;
}

// ---------- UI ----------
const panel = $('linesBody'), list = $('lnList');
function el(tag, attrs, html) { const e = document.createElement(tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
const rows = {};
UI_ORDER.forEach(k => {
  const l = byKey[k], row = el('div', { class: 'ln', 'data-k': k });
  const isCity = k === 'cities';
  row.innerHTML =
    `<div class="lnTop"><label class="lnName"><input type="checkbox" class="lnOn"> ${l.name}</label><span class="lnNote"></span>` +
    `<input type="color" class="lnColor" title="Colour"><button class="lnMore" aria-expanded="false" title="More options for ${l.name}">▸</button></div>` +
    `<div class="lnOpts" hidden>` +
    `<div class="lnPresets">${PRESETS.map(c => `<button class="lnSw" data-c="${c}" style="background:${c}" title="${c}" aria-label="colour ${c}"></button>`).join('')}</div>` +
    `<div class="srow"><label>${isCity ? 'Text size' : 'Width'}</label><input type="range" class="lnW" min="${isCity ? 0.6 : 0.25}" max="${isCity ? 2 : 4}" step="${isCity ? 0.1 : 0.25}"><output class="oW"></output></div>` +
    `<div class="srow"><label>Opacity</label><input type="range" class="lnO" min="0.05" max="1" step="0.05"><output class="oO"></output></div>` +
    (isCity ? '' : `<div class="srow"><label>Line style</label><select class="lnD"><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></div>`) +
    `</div>`;
  list.appendChild(row); rows[k] = row;
  const q = s => row.querySelector(s), c = () => cfg.layers[k];
  const changed = restyle => { save(); syncRow(k); if (k === 'grid' || k === 'cities') drawOverlay(); if (!restyle) applyLines(); else restyleLayer(k); };
  q('.lnOn').onchange = e => { c().on = e.target.checked; changed(false); };
  q('.lnColor').oninput = e => { c().color = e.target.value; changed(true); };
  q('.lnMore').onclick = () => { const o = q('.lnOpts'); o.hidden = !o.hidden; q('.lnMore').textContent = o.hidden ? '▸' : '▾'; q('.lnMore').setAttribute('aria-expanded', !o.hidden); };
  row.querySelectorAll('.lnSw').forEach(b => b.onclick = () => { c().color = b.dataset.c; changed(true); });
  q('.lnW').oninput = e => { c().width = parseFloat(e.target.value); changed(true); };
  q('.lnO').oninput = e => { c().opacity = parseFloat(e.target.value); changed(true); };
  if (q('.lnD')) q('.lnD').onchange = e => { c().dash = e.target.value; changed(true); };
});
function restyleLayer(k) { const st = state[k]; if (st && st.group) st.group.eachLayer(p => p.setStyle(styleOf(k))); }
function syncRow(k) {
  const row = rows[k], c = cfg.layers[k], q = s => row.querySelector(s);
  q('.lnOn').checked = c.on; q('.lnColor').value = c.color;
  q('.lnW').value = c.width; q('.oW').textContent = k === 'cities' ? c.width.toFixed(1) + '×' : c.width.toFixed(2) + ' px';
  q('.lnO').value = c.opacity; q('.oO').textContent = Math.round(c.opacity * 100) + '%';
  if (q('.lnD')) q('.lnD').value = c.dash;
  row.querySelectorAll('.lnSw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === c.color.toLowerCase()));
  row.classList.toggle('off', !c.on);
}
function syncNotes() {
  UI_ORDER.forEach(k => {
    const l = byKey[k], st = state[k], n = rows[k].querySelector('.lnNote'), c = cfg.layers[k];
    n.textContent = !c.on ? '' : st && st.failed ? 'failed to load' : st && st.loading && !st.group && !st.data && visible(l) ? 'loading…'
      : l.minZoom && map.getZoom() < l.minZoom ? 'zoom in to see' : '';
  });
}
function syncGeneral() {
  $('lnAbove').checked = cfg.above; $('lnBm').value = cfg.bmOpacity; $('oLnBm').textContent = Math.round(cfg.bmOpacity * 100) + '%';
  $('lnLabels').checked = cfg.bmLabels;
  $('lnLabelsNote').textContent = map.hasLayer(osm) ? '(OpenStreetMap has its labels built in)' : '';
}
function syncAll() { UI_ORDER.forEach(syncRow); syncGeneral(); syncNotes(); }
$('lnAbove').onchange = e => { cfg.above = e.target.checked; save(); applyGeneral(); };
$('lnBm').oninput = e => { cfg.bmOpacity = parseFloat(e.target.value); save(); syncGeneral(); applyGeneral(); };
$('lnLabels').onchange = e => { cfg.bmLabels = e.target.checked; save(); applyGeneral(); };
map.on('baselayerchange', () => { applyGeneral(); syncGeneral(); });
$('lnAllOff').onclick = () => { LAYERS.forEach(l => cfg.layers[l.k].on = false); save(); syncAll(); applyLines(); };
$('lnReset').onclick = () => { Object.assign(cfg, defaults()); save(); syncAll(); applyGeneral(); applyLines(); };

// open / close: the sub-menu replaces the "Additional Map Settings" body
function openLines(open) {
  panel.hidden = !open;
  if (open) { $('amsBody').hidden = true; $('amsBtn').setAttribute('aria-expanded', true); $('amsArrow').textContent = '▾'; syncAll(); }
}
// keep the menus clear of the main panel / map buttons (they would overlap on phones and short screens)
function fitMenus() {
  let top = $('panel').getBoundingClientRect().bottom;
  document.querySelectorAll('.leaflet-top.leaflet-left .leaflet-control').forEach(c => { const r = c.getBoundingClientRect(); if (r.width && r.right > 8) top = Math.max(top, r.bottom); });
  const bottom = $('amsBtn').getBoundingClientRect().top - 6, h = Math.max(160, Math.floor(bottom - top - 8)) + 'px';
  $('amsBody').style.maxHeight = h; panel.style.maxHeight = h;
  document.body.classList.toggle('lines-open', !panel.hidden);
}
window.addEventListener('resize', fitMenus);
['amsBtn', 'settingsBtn', 'openLines', 'lnBack', 'lnClose'].forEach(id => $(id).addEventListener('click', () => setTimeout(fitMenus, 20)));
$('openLines').onclick = () => openLines(true);
$('lnBack').onclick = () => { openLines(false); hoverUI.setOpen(true); };
$('lnClose').onclick = () => { openLines(false); hoverUI.setOpen(false); };

applyGeneral(); syncAll(); applyLines(); fitMenus();
window._lines = {
  cfg, state, applyLines, open: openLines,
  get credit() { return 'Borders: Natural Earth' + (cfg.layers.counties.on ? ' · Counties: US Census Bureau' : ''); }
};
})();
