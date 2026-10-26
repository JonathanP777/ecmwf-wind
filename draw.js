// Drawing toolkit: pen, lines/arrows, shapes, text, weather fronts, H/L, select/edit,
// undo/redo, GeoJSON import/export, PNG export.
// Geometry is handled by Leaflet-Geoman (free); fronts and arrows are rendered here.
// Uses the map, settings and OSM layer exported by app.js (window._app).
(function () {
'use strict';
const { map, settings, osm } = window._app;
const $ = id => document.getElementById(id);
const STORE = 'windDrawings', OPTS = 'windDrawOpts';
const COL = { cold: '#3d7bff', warm: '#ff4040', occl: '#b65cff' };
const FRONTS = ['cold', 'warm', 'stat', 'occl', 'trough'];
const FREEHAND = ['pen'].concat(FRONTS);
const SHAPES = ['rect', 'circle', 'polygon'];
const NAMES = { select: 'Select / move', pen: 'Freehand pen', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', circle: 'Circle',
  polygon: 'Polygon', text: 'Text label', cold: 'Cold front', warm: 'Warm front', stat: 'Stationary front', occl: 'Occluded front',
  trough: 'Trough', H: 'High (H)', L: 'Low (L)' };
const HINTS = {
  select: 'Click a drawing to select it, then drag it or its points. Del deletes it.',
  pen: 'Press and drag to draw.',
  line: 'Click to add points. Double-click or Finish to end.',
  arrow: 'Click to add points; the arrowhead goes on the last point. Double-click or Finish to end.',
  rect: 'Click two opposite corners.', circle: 'Click the centre, then click again to set the radius.',
  polygon: 'Click to add corners. Click the first point, double-click or Finish to close.',
  text: 'Click where the label goes, then type. Use Select to edit it later.',
  H: 'Click to place a High.', L: 'Click to place a Low.',
  front: 'Press and drag to draw a smooth front. The symbols go on the left of the direction you draw; Flip swaps sides.'
};

const opts = Object.assign({ color: '#ffd166', width: 3, fill: true, opacity: 0.25, flip: false, visible: true },
  (() => { try { return JSON.parse(localStorage.getItem(OPTS) || '{}'); } catch (e) { return {}; } })());
const saveOpts = () => { try { localStorage.setItem(OPTS, JSON.stringify(opts)); } catch (e) {} };

// ---------- panes & groups ----------
map.createPane('drawings'); map.getPane('drawings').style.zIndex = 460;
map.createPane('drawmarks'); map.getPane('drawmarks').style.zIndex = 470;
const R = L.svg({ pane: 'drawings', padding: 0.5 });
const group = L.featureGroup();      // the editable drawings
const decoGroup = L.layerGroup();    // fronts / arrowheads (rebuilt on zoom)
if (opts.visible) { group.addTo(map); decoGroup.addTo(map); }
map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: true, layersToCut: [] });

let tool = null, selected = null, undoStack = [], redoStack = [], restoring = false;

// ---------- geometry helpers (layer-pixel space) ----------
const toPx = ll => map.latLngToLayerPoint(ll);
const toLL = p => map.layerPointToLatLng(L.point(p.x, p.y));
function catmull(pts, seg) {       // smooth curve through points
  if (pts.length < 3) return pts.slice();
  const out = [], P = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const n = Math.max(2, Math.min(seg, Math.ceil(p1.distanceTo(p2) / 4)));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push(L.point(
        0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function walker(pts) {             // arc-length sampler along a pixel path
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const len = cum[cum.length - 1];
  function at(d) {
    d = Math.max(0, Math.min(len, d));
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1], b = pts[i], sl = (cum[i] - cum[i - 1]) || 1, f = (d - cum[i - 1]) / sl;
    const tx = (b.x - a.x) / sl, ty = (b.y - a.y) / sl;
    return { p: L.point(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f), t: L.point(tx, ty) };
  }
  function slice(d0, d1) {
    const out = [at(d0).p];
    for (let i = 0; i < cum.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(pts[i]);
    out.push(at(d1).p); return out;
  }
  return { len, at, slice };
}
const add = (p, v, k) => L.point(p.x + v.x * k, p.y + v.y * k);
function tri(w, c, s, side) {      // triangle sitting on the path, apex on `side`
  const a = w.at(c - s).p, b = w.at(c + s).p, m = w.at(c), n = L.point(m.t.y * side, -m.t.x * side);
  return [a, add(m.p, n, s * 1.5), b];
}
function semi(w, c, s, side) {     // semicircle on the path, bulging to `side`
  const m = w.at(c), n = L.point(m.t.y * side, -m.t.x * side), out = [];
  for (let k = 0; k <= 12; k++) { const th = Math.PI * k / 12; out.push(L.point(m.p.x + s * (Math.cos(th) * m.t.x + Math.sin(th) * n.x), m.p.y + s * (Math.cos(th) * m.t.y + Math.sin(th) * n.y))); }
  return out;
}

// ---------- decorations ----------
const decos = new Map();
function deco(layer) {
  const old = decos.get(layer); if (old) { decoGroup.removeLayer(old); decos.delete(layer); }
  const d = layer._d; if (!d || !(FRONTS.includes(d.kind) || d.kind === 'arrow')) return;
  const ll = layer.getLatLngs(); if (ll.length < 2) return;
  const g = L.layerGroup(), w0 = d.width, o = { renderer: R, interactive: false, pmIgnore: true };
  const pl = (pts, st) => L.polyline(pts.map(toLL), Object.assign({}, o, { lineCap: 'round', lineJoin: 'round' }, st)).addTo(g);
  const pg = (pts, col) => L.polygon(pts.map(toLL), Object.assign({}, o, { stroke: false, fill: true, fillColor: col, fillOpacity: 1 })).addTo(g);
  if (d.kind === 'arrow') {
    const w = walker(ll.map(toPx)), h = 6 + w0 * 2.5, e = w.at(w.len), b = w.at(Math.max(0, w.len - h));
    const t = L.point(e.p.x - b.p.x, e.p.y - b.p.y), tl = Math.hypot(t.x, t.y) || 1, u = L.point(t.x / tl, t.y / tl), n = L.point(-u.y, u.x);
    pg([e.p, add(add(e.p, u, -h), n, h * 0.55), add(add(e.p, u, -h), n, -h * 0.55)], d.color);
  } else {
    const px = catmull(ll.map(toPx), 12), w = walker(px), side = d.flip ? -1 : 1;
    const s = 4 + w0 * 1.4, sp = s * 6.5;
    if (d.kind === 'trough') pl(px, { color: d.color, weight: w0, dashArray: `${w0 * 3} ${w0 * 2.5}`, lineCap: 'butt' });
    else if (d.kind === 'stat') {
      for (let k = 0, c0 = 0; c0 < w.len; k++, c0 += sp) {
        const c1 = Math.min(w.len, c0 + sp), col = k % 2 ? COL.warm : COL.cold;
        pl(w.slice(c0, c1), { color: col, weight: w0, lineCap: 'butt' });
        if (c1 - c0 > 2.4 * s) pg(k % 2 ? semi(w, (c0 + c1) / 2, s, -side) : tri(w, (c0 + c1) / 2, s, side), col);
      }
    } else {
      const col = COL[d.kind];
      pl(px, { color: col, weight: w0 });
      let k = 0;
      for (let c = sp / 2; c + s <= w.len; c += sp, k++) {
        const isTri = d.kind === 'cold' || (d.kind === 'occl' && k % 2 === 0);
        pg(isTri ? tri(w, c, s, side) : semi(w, c, s, side), col);
      }
    }
  }
  g.addTo(decoGroup); decos.set(layer, g);
}
const redecorateAll = () => group.eachLayer(deco);
map.on('zoomend viewreset', redecorateAll);

// ---------- build layers from features ----------
function styleOf(d) {
  if (FRONTS.includes(d.kind)) return { color: '#ffffff', weight: Math.max(14, d.width + 10), opacity: 0, fill: false };
  const st = { color: d.color, weight: d.width, opacity: 1, lineCap: 'round', lineJoin: 'round' };
  if (SHAPES.includes(d.kind)) Object.assign(st, { fill: !!d.fill, fillColor: d.color, fillOpacity: d.fillOpacity });
  return st;
}
function hlIcon(k) { return L.divIcon({ className: 'drw-hl drw-' + k, html: '<span>' + k + '</span>', iconSize: [36, 36], iconAnchor: [18, 18] }); }
function textStyle(layer) {
  const ta = layer.pm && layer.pm.textArea; if (!ta) return;
  ta.style.color = layer._d.color; ta.style.fontSize = (11 + layer._d.width * 2) + 'px';
  layer.pm._autoResize && layer.pm._autoResize();
}
function makeLayer(f) {
  const g = f.geometry, p = Object.assign({}, f.properties || {});
  const d = { kind: p.kind, color: p.color || opts.color, width: +p.width || opts.width, fill: p.fill !== undefined ? !!p.fill : opts.fill,
    fillOpacity: p.fillOpacity !== undefined ? +p.fillOpacity : opts.opacity, flip: !!p.flip, text: p.text || '' };
  const ll = c => L.latLng(c[1], c[0]);
  let layer;
  if (!g) return null;
  if (g.type === 'LineString') {
    if (!d.kind || !['pen', 'line', 'arrow'].concat(FRONTS).includes(d.kind)) d.kind = 'line';
    layer = L.polyline(g.coordinates.map(ll), Object.assign({ renderer: R }, styleOf(d)));
  } else if (g.type === 'Polygon') {
    if (d.kind !== 'rect') d.kind = 'polygon';
    const ring = g.coordinates[0].map(ll); if (ring.length > 1 && ring[0].equals(ring[ring.length - 1])) ring.pop();
    layer = d.kind === 'rect' ? L.rectangle(L.latLngBounds(ring), Object.assign({ renderer: R }, styleOf(d)))
                              : L.polygon(ring, Object.assign({ renderer: R }, styleOf(d)));
  } else if (g.type === 'Point') {
    const at = ll(g.coordinates);
    if (d.kind === 'circle' && p.radius) layer = L.circle(at, Object.assign({ renderer: R, radius: +p.radius }, styleOf(d)));
    else if (d.kind === 'H' || d.kind === 'L') layer = L.marker(at, { icon: hlIcon(d.kind), pane: 'drawmarks' });
    else {
      d.kind = 'text'; d.text = d.text || p.name || p.label || '';
      if (!d.text) return null;
      layer = L.marker(at, { textMarker: true, text: d.text, pane: 'drawmarks' });
    }
  } else return null;
  layer._d = d;
  return layer;
}
function addLayer(layer) {
  layer.addTo(group);
  if (layer._d.kind === 'text') { textStyle(layer); layer.on('pm:textchange', () => { layer._d.text = layer.pm.getText(); }); layer.on('pm:textblur', commitSoon); }
  layer.on('click', e => { if (tool === 'select') { L.DomEvent.stop(e); select(layer); } });
  layer.on('pm:edit pm:dragend', () => { deco(layer); commitSoon(); });
  layer.on('pm:markerdrag pm:drag', () => requestAnimationFrame(() => deco(layer)));
  deco(layer);
  return layer;
}
function featureOf(layer) {
  const d = layer._d, P = Object.assign({}, d);
  if (d.kind === 'text') { P.text = layer.pm ? layer.pm.getText() : d.text; if (!P.text) return null; }
  else delete P.text;
  if (!FRONTS.includes(d.kind)) delete P.flip;
  if (!SHAPES.includes(d.kind)) { delete P.fill; delete P.fillOpacity; }
  const c = l => [+l.lng.toFixed(5), +l.lat.toFixed(5)];
  let geometry;
  if (layer instanceof L.Circle) { geometry = { type: 'Point', coordinates: c(layer.getLatLng()) }; P.radius = Math.round(layer.getRadius()); }
  else if (layer instanceof L.Marker) geometry = { type: 'Point', coordinates: c(layer.getLatLng()) };
  else if (layer instanceof L.Polygon) { const r = layer.getLatLngs()[0].map(c); r.push(r[0]); geometry = { type: 'Polygon', coordinates: [r] }; }
  else geometry = { type: 'LineString', coordinates: layer.getLatLngs().map(c) };
  return { type: 'Feature', properties: P, geometry };
}
const serialize = () => JSON.stringify({ type: 'FeatureCollection', features: group.getLayers().map(featureOf).filter(Boolean) });

// ---------- history / persistence ----------
function commit() {
  if (restoring) return;
  const s = serialize();
  if (undoStack[undoStack.length - 1] !== s) { undoStack.push(s); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
  try { localStorage.setItem(STORE, s); } catch (e) {}
  updateButtons();
}
let commitT = 0;
function commitSoon() { clearTimeout(commitT); commitT = setTimeout(commit, 60); }
function restore(s) {
  restoring = true; deselect();
  group.clearLayers(); decoGroup.clearLayers(); decos.clear();
  try { JSON.parse(s).features.forEach(f => { const l = makeLayer(f); if (l) addLayer(l); }); } catch (e) { console.warn('drawings', e); }
  restoring = false;
  try { localStorage.setItem(STORE, s); } catch (e) {}
  updateButtons();
}
function undo() { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); restore(undoStack[undoStack.length - 1]); }
function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); restore(s); }

// ---------- selection ----------
function select(layer) {
  if (selected === layer) return;
  deselect(); selected = layer;
  const k = layer._d.kind;
  if (k === 'pen') layer.pm.enableLayerDrag();
  else layer.pm.enable({ draggable: true, snappable: false });
  if (k === 'text') { try { layer.pm.focus(); } catch (e) {} }
  if (FRONTS.includes(k)) layer.setStyle({ opacity: 0.5, weight: 2, dashArray: '4 4' });
  const el = layer.getElement && layer.getElement(); if (el) el.classList.add('drw-selected');
  syncOptsFrom(layer); updateButtons();
}
function deselect() {
  const l = selected; if (!l) return; selected = null;
  try { if (l.pm.layerDragEnabled && l.pm.layerDragEnabled()) l.pm.disableLayerDrag(); if (l.pm.enabled()) l.pm.disable(); } catch (e) {}
  if (FRONTS.includes(l._d.kind)) l.setStyle(styleOf(l._d));
  const el = l.getElement && l.getElement(); if (el) el.classList.remove('drw-selected');
  if (l._d.kind === 'text' && l._map && !l.pm.getText()) { removeLayer(l); }
  updateButtons();
}
function removeLayer(l) {
  if (selected === l) { selected = null; try { l.pm.disable(); } catch (e) {} }
  const dg = decos.get(l); if (dg) { decoGroup.removeLayer(dg); decos.delete(l); }
  group.removeLayer(l); commit();
}

// ---------- tools ----------
const bar = $('drawBar');
function setTool(t) {
  if (t && t === tool) t = null;          // pressing the active tool again = back to pan
  map.pm.disableDraw(); stopFreehand(); deselect();
  tool = t;
  bar.querySelectorAll('.dt').forEach(b => b.classList.toggle('on', b.dataset.t === tool));
  map.getContainer().classList.toggle('draw-select', tool === 'select');
  map.getContainer().classList.toggle('draw-active', !!tool && tool !== 'select');
  if (tool && !opts.visible) setVisible(true);
  const freehand = FREEHAND.includes(tool);
  if (freehand) { map.dragging.disable(); map.touchZoom.disable(); } else { map.dragging.enable(); map.touchZoom.enable(); }
  if (tool && tool !== 'select') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  const pathOptions = { color: opts.color, weight: opts.width, fillColor: opts.color, fillOpacity: opts.fill ? opts.opacity : 0, fill: opts.fill };
  const common = { snappable: false, continueDrawing: true, pathOptions, templineStyle: { color: opts.color, weight: opts.width },
    hintlineStyle: { color: opts.color, dashArray: '5 5', weight: 1.5 }, tooltips: false, finishOn: 'dblclick' };
  if (tool === 'line' || tool === 'arrow') map.pm.enableDraw('Line', common);
  else if (tool === 'polygon') map.pm.enableDraw('Polygon', common);
  else if (tool === 'rect') map.pm.enableDraw('Rectangle', Object.assign({}, common, { finishOn: null }));
  else if (tool === 'circle') map.pm.enableDraw('Circle', Object.assign({}, common, { finishOn: null }));
  $('dbHint').textContent = tool ? NAMES[tool] + ': ' + (FRONTS.includes(tool) ? HINTS.front : HINTS[tool]) + ' Esc or the tool button again = pan.'
                                 : 'Pick a tool. The map pans normally when no tool is selected.';
  $('dFinish').hidden = !['line', 'arrow', 'polygon'].includes(tool);
  updateButtons();
}
map.on('pm:create', e => {
  const shape = e.shape, lyr = e.layer;
  const kind = { Line: tool === 'arrow' ? 'arrow' : 'line', Polygon: 'polygon', Rectangle: 'rect', Circle: 'circle' }[shape];
  const f = lyr.toGeoJSON(); lyr.remove();
  if (!kind) return;
  f.properties = { kind, color: opts.color, width: opts.width, fill: opts.fill, fillOpacity: opts.opacity };
  if (shape === 'Circle') f.properties.radius = lyr.getRadius();
  const l = makeLayer(f); if (l) { addLayer(l); commit(); }
});
map.on('click', e => {
  if (tool === 'select') { deselect(); return; }
  if (tool === 'H' || tool === 'L') {
    const l = makeLayer({ geometry: { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] }, properties: { kind: tool } });
    addLayer(l); commit();
  } else if (tool === 'text') {
    const l = makeLayer({ geometry: { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] }, properties: { kind: 'text', text: ' ' } });
    addLayer(l);
    // jump into Select so the new label can be typed right away
    setTool('select'); select(l);
    l.pm.setText(''); try { l.pm.focus(); } catch (err) {}
  }
});

// freehand (pen and fronts), mouse + touch via pointer events
let fh = null;
const mc = map.getContainer();
function stopFreehand() { if (fh) { fh.temp.remove(); fh = null; } }
mc.addEventListener('pointerdown', e => {
  if (!FREEHAND.includes(tool) || e.button > 0 || e.target.closest('.leaflet-control')) return;
  e.preventDefault(); mc.setPointerCapture && mc.setPointerCapture(e.pointerId);
  const ll = map.mouseEventToLatLng(e);
  const col = tool === 'pen' || tool === 'trough' ? opts.color : COL[tool] || COL.cold;
  fh = { pts: [ll], id: e.pointerId, temp: L.polyline([ll], { renderer: R, color: col, weight: opts.width, opacity: 0.8, interactive: false, pmIgnore: true, dashArray: tool === 'trough' ? '6 5' : null }).addTo(map) };
});
mc.addEventListener('pointermove', e => {
  if (!fh || e.pointerId !== fh.id) return;
  const ll = map.mouseEventToLatLng(e), last = fh.pts[fh.pts.length - 1];
  if (map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 2) return;
  fh.pts.push(ll); fh.temp.addLatLng(ll);
});
function endFreehand(e) {
  if (!fh || (e && e.pointerId !== fh.id)) return;
  const pts = fh.pts.map(toPx); stopFreehand();
  let s = L.LineUtil.simplify(pts, tool === 'pen' ? 1.2 : 5);
  if (s.length < 2 || walker(s).len < 8) return;
  const f = { geometry: { type: 'LineString', coordinates: s.map(toLL).map(l => [l.lng, l.lat]) },
    properties: { kind: tool, color: opts.color, width: opts.width, flip: opts.flip } };
  addLayer(makeLayer(f)); commit();
}
mc.addEventListener('pointerup', endFreehand);
mc.addEventListener('pointercancel', endFreehand);

document.addEventListener('keydown', e => {
  if (e.target.matches('textarea, input, select')) { if (e.key === 'Escape') e.target.blur(); else return; }
  if (e.key === 'Escape' && (tool || selected)) { setTool(null); e.preventDefault(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { removeLayer(selected); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !bar.hidden) { e.shiftKey ? redo() : undo(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !bar.hidden) { redo(); e.preventDefault(); }
});

// ---------- style controls ----------
function syncOptsFrom(layer) {
  const d = layer._d;
  if (!FRONTS.includes(d.kind) || d.kind === 'trough') { opts.color = d.color; }
  opts.width = d.width; if (SHAPES.includes(d.kind)) { opts.fill = d.fill; opts.opacity = d.fillOpacity; }
  if (FRONTS.includes(d.kind)) opts.flip = d.flip;
  syncControls();
}
function syncControls() {
  $('dColor').value = opts.color; $('dWidth').value = opts.width; $('oWidthD').textContent = opts.width;
  $('dFill').checked = opts.fill; $('dOpac').value = opts.opacity; $('dOpac').disabled = !opts.fill;
  $('dFlip').classList.toggle('on', opts.flip);
  $('dVis').textContent = opts.visible ? '👁 Hide' : '👁 Show';
}
function applyToSelected(prop) {
  const l = selected; if (!l) return;
  const d = l._d;
  if (prop === 'color') d.color = opts.color;
  if (prop === 'width') d.width = opts.width;
  if (prop === 'fill' && SHAPES.includes(d.kind)) { d.fill = opts.fill; d.fillOpacity = opts.opacity; }
  if (prop === 'flip' && FRONTS.includes(d.kind)) d.flip = opts.flip;
  if (d.kind === 'text') textStyle(l);
  else if (l.setStyle) { l.setStyle(styleOf(d)); if (FRONTS.includes(d.kind)) l.setStyle({ opacity: 0.5, weight: 2, dashArray: '4 4' }); }
  deco(l); commitSoon();
}
function onOpt(prop, fn) { return () => { fn(); saveOpts(); syncControls(); applyToSelected(prop);
  if (tool && !FREEHAND.includes(tool) && !['select', 'text', 'H', 'L'].includes(tool)) { const t = tool; tool = null; setTool(t); } }; }
$('dColor').addEventListener('input', onOpt('color', () => opts.color = $('dColor').value));
$('dWidth').addEventListener('input', onOpt('width', () => opts.width = +$('dWidth').value));
$('dFill').addEventListener('change', onOpt('fill', () => opts.fill = $('dFill').checked));
$('dOpac').addEventListener('input', onOpt('fill', () => opts.opacity = +$('dOpac').value));
$('dFlip').addEventListener('click', onOpt('flip', () => opts.flip = !opts.flip));

// ---------- actions ----------
function setVisible(v) {
  opts.visible = v; saveOpts(); syncControls();
  if (v) { group.addTo(map); decoGroup.addTo(map); } else { setTool(null); group.remove(); decoGroup.remove(); }
}
function updateButtons() {
  $('dUndo').disabled = undoStack.length < 2; $('dRedo').disabled = !redoStack.length;
  $('dDel').disabled = !selected; $('dClear').disabled = !group.getLayers().length;
  $('dCount').textContent = group.getLayers().length ? group.getLayers().length + ' item' + (group.getLayers().length > 1 ? 's' : '') : 'empty';
}
bar.querySelectorAll('.dt').forEach(b => { b.title = NAMES[b.dataset.t]; b.onclick = () => setTool(b.dataset.t); });
$('dUndo').onclick = undo; $('dRedo').onclick = redo;
$('dDel').onclick = () => selected && removeLayer(selected);
$('dFinish').onclick = () => { const d = map.pm.Draw[tool === 'polygon' ? 'Polygon' : 'Line']; try { if (d._enabled) d._finishShape(); } catch (e) {} };
$('dVis').onclick = () => setVisible(!opts.visible);
$('dClear').onclick = () => {
  if (!group.getLayers().length) return;
  if (!confirm('Delete all ' + group.getLayers().length + ' drawings? (You can still Undo.)')) return;
  deselect(); group.clearLayers(); decoGroup.clearLayers(); decos.clear(); commit();
};
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function stamp() {
  const run = $('runSel').value || 'run', h = ($('stepLabel').textContent || '').replace(/[^0-9]/g, '');
  return 'ecmwf_' + run + '_f' + h.padStart(3, '0');
}
$('dExport').onclick = () => download(new Blob([JSON.stringify(JSON.parse(serialize()), null, 1)], { type: 'application/geo+json' }), stamp() + '_drawings.geojson');
$('dImport').onclick = () => $('dFile').click();
$('dFile').onchange = async () => {
  const f = $('dFile').files[0]; $('dFile').value = ''; if (!f) return;
  try {
    const gj = JSON.parse(await f.text());
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [];
    let n = 0; feats.forEach(ft => { const l = makeLayer(ft); if (l) { addLayer(l); n++; } });
    commit(); flash('Imported ' + n + ' drawing' + (n === 1 ? '' : 's') + '.');
    if (n) { setVisible(true); try { map.fitBounds(group.getBounds().pad(0.2), { maxZoom: 6 }); } catch (e) {} }
  } catch (e) { flash('Could not read that file (expected GeoJSON).'); }
};
function flash(msg) { $('dbHint').textContent = msg; }

// ---------- PNG export of the current view ----------
function textNodesOf(root) {
  const out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; if (n.textContent.trim()) out.push(n); }
  return out;
}
function drawDomText(ctx, root, ox, oy) {      // draw HTML text (legend) in place
  textNodesOf(root).forEach(n => {
    const el = n.parentElement, cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return;
    const r = document.createRange(); r.selectNodeContents(n); const rr = r.getBoundingClientRect(); if (!rr.width) return;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(n.textContent.replace(/\s+/g, ' ').trim(), rr.left - ox, rr.top + rr.height / 2 - oy);
  });
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function svgImage(svg) {
  return new Promise(res => {
    const c = svg.cloneNode(true), r = svg.getBoundingClientRect();
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c.setAttribute('width', r.width); c.setAttribute('height', r.height);
    c.removeAttribute('style');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(c)], { type: 'image/svg+xml' }));
    const img = new Image(); img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); }; img.onerror = () => res(null); img.src = url;
  });
}
function paneZ(el) {
  for (let e = el; e && e !== mc; e = e.parentElement) if (e.classList.contains('leaflet-pane') && !e.classList.contains('leaflet-map-pane')) {
    // nested pane (e.g. tile pane) -> its own z-index; take the outermost custom/standard pane under the map pane
    let top = e; while (top.parentElement && top.parentElement !== mc && !top.parentElement.classList.contains('leaflet-map-pane')) top = top.parentElement;
    return +getComputedStyle(top).zIndex || 0;
  }
  return 0;
}
function opacityOf(el) { let o = 1; for (let e = el; e && e !== mc.parentElement; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; }
async function renderPNG(withTiles) {
  const MR = mc.getBoundingClientRect(), W = Math.round(MR.width), H = Math.round(MR.height), dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, W, H);
  const els = [...mc.querySelectorAll('.leaflet-map-pane img.leaflet-tile, .leaflet-map-pane canvas, .leaflet-map-pane svg, .leaflet-drawmarks-pane .leaflet-marker-icon')]
    .filter(el => { const z = paneZ(el); return z < 600 && getComputedStyle(el).display !== 'none' && (withTiles || !el.classList.contains('leaflet-tile')); })
    .map((el, i) => ({ el, i, z: paneZ(el) })).sort((a, b) => a.z - b.z || a.i - b.i);
  for (const { el } of els) {
    const r = el.getBoundingClientRect(), x = r.left - MR.left, y = r.top - MR.top;
    if (r.right < MR.left || r.left > MR.right || r.bottom < MR.top || r.top > MR.bottom || !r.width) continue;
    ctx.save(); ctx.globalAlpha = opacityOf(el);
    if (el.tagName === 'IMG') { if (el.complete && el.naturalWidth) ctx.drawImage(el, x, y, r.width, r.height); }
    else if (el.tagName === 'CANVAS') { if (el.width && el.height) ctx.drawImage(el, x, y, r.width, r.height); }
    else if (el.tagName.toLowerCase() === 'svg') { const img = await svgImage(el); if (img) ctx.drawImage(img, x, y, r.width, r.height); }
    else if (el.classList.contains('drw-hl')) {
      const sp = el.querySelector('span'), cs = getComputedStyle(sp);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(sp.textContent, x + r.width / 2, y + r.height / 2 + 1);
      ctx.fillStyle = cs.color; ctx.fillText(sp.textContent, x + r.width / 2, y + r.height / 2 + 1);
    } else {
      const ta = el.querySelector('textarea'); if (ta && ta.value) {
        const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2, tr = ta.getBoundingClientRect();
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ta.value.split('\n').forEach((line, k) => {
          const tx = tr.left - MR.left + parseFloat(cs.paddingLeft), ty = tr.top - MR.top + parseFloat(cs.paddingTop) + lh * (k + 0.5);
          ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineJoin = 'round'; ctx.strokeText(line, tx, ty);
          ctx.fillStyle = cs.color; ctx.fillText(line, tx, ty);
        });
      }
    }
    ctx.restore();
  }
  // legend (as on screen)
  const lg = $('legend');
  if (lg && getComputedStyle(lg).display !== 'none' && !document.body.classList.contains('drawing-mobile')) {
    const r = lg.getBoundingClientRect(), x = r.left - MR.left, y = r.top - MR.top;
    if (x >= 0 && y >= 0 && !getComputedStyle(lg).transform.startsWith('matrix(0')) {
      ctx.fillStyle = 'rgba(20,22,28,.88)'; rrect(ctx, x, y, r.width, r.height, 8); ctx.fill();
      lg.querySelectorAll('canvas').forEach(c => { const q = c.getBoundingClientRect(); ctx.drawImage(c, q.left - MR.left, q.top - MR.top, q.width, q.height); });
      drawDomText(ctx, lg, MR.left, MR.top);
    }
  }
  // caption: model run, valid time, layer
  const shadeTxt = settings.shade === 'off' ? 'Wind (particles/barbs)' : $('legendTitle').textContent;
  const l1 = 'ECMWF IFS · ' + $('validtime').textContent + ' (' + $('stepLabel').textContent + ')';
  const l2 = $('runinfo').textContent.replace(/ · .*$/, '').replace('(latest)', '').trim() + ' · ' + shadeTxt + (settings.isobars ? ' · MSLP isobars (hPa)' : '');
  ctx.font = '600 14px system-ui, sans-serif'; const w1 = ctx.measureText(l1).width;
  ctx.font = '12px system-ui, sans-serif'; const w2 = ctx.measureText(l2).width;
  const cw = Math.min(W - 20, Math.max(w1, w2) + 20);
  ctx.fillStyle = 'rgba(12,14,18,.85)'; rrect(ctx, 10, 10, cw, 46, 7); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd166'; ctx.font = '600 14px system-ui, sans-serif'; ctx.fillText(l1, 20, 25, cw - 20);
  ctx.fillStyle = '#dfe5ec'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(l2, 20, 43, cw - 20);
  // credits
  const cr = 'Data: ECMWF open data (CC BY 4.0)' + (withTiles ? (map.hasLayer(osm) ? ' · Basemap © OpenStreetMap contributors' : ' · Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors') : '') + ' · Coastlines: Natural Earth';
  ctx.font = '10px system-ui, sans-serif'; const crw = ctx.measureText(cr).width + 12;
  ctx.fillStyle = 'rgba(12,14,18,.75)'; ctx.fillRect(W - crw, H - 15, crw, 15);
  ctx.fillStyle = '#c8ced6'; ctx.textAlign = 'right'; ctx.fillText(cr, W - 6, H - 7.5);
  return new Promise((res, rej) => { try { cv.toBlob(b => b ? res(b) : rej(new Error('empty')), 'image/png'); } catch (e) { rej(e); } });
}
async function savePNG() {
  const btn = $('dPng'); btn.disabled = true; const prevTool = tool; deselect();
  let blob = null, basemap = true;
  try { blob = await renderPNG(true); }
  catch (e) { basemap = false; try { blob = await renderPNG(false); } catch (e2) { blob = null; } }
  btn.disabled = false;
  if (!blob) { flash('Sorry, the image could not be created in this browser.'); return { ok: false }; }
  download(blob, stamp() + '.png');
  flash(basemap ? 'Saved ' + stamp() + '.png' : 'Saved ' + stamp() + '.png without the basemap (the tile server blocked image export).');
  if (prevTool === 'select') setTool('select');
  return { ok: true, basemap, size: blob.size };
}
$('dPng').onclick = savePNG;

// ---------- open/close the toolbar (lives under "Additional Map Settings") ----------
function openBar(open) {
  bar.hidden = !open;
  document.body.classList.toggle('drawing', open);
  if (open) {
    if (!$('amsBody').hidden) $('amsBtn').click();
    if (!$('settings').hidden) $('settingsBtn').click();
    syncControls(); updateButtons(); if (!tool) setTool(null);
  } else setTool(null);
}
$('openDraw').onclick = () => openBar(true);
$('dbClose').onclick = () => openBar(false);
$('amsBtn').addEventListener('click', () => { if (!bar.hidden && !$('amsBody').hidden) openBar(false); });
$('settingsBtn').addEventListener('click', () => setTimeout(() => { if (!$('settings').hidden && !bar.hidden) openBar(false); }, 0));

// ---------- start ----------
restore(localStorage.getItem(STORE) || '{"type":"FeatureCollection","features":[]}');
undoStack = [serialize()]; redoStack = [];
syncControls(); updateButtons();
window._drawDebug = { group, decoGroup, setTool, select, deselect, undo, redo, serialize, restore, savePNG, renderPNG, openBar, opts,
  get tool() { return tool; }, get selected() { return selected; } };
})();
