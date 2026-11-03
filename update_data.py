#!/usr/bin/env python3
"""Build the forecast data for the website and keep the Cloudflare R2 bucket up to date.

Models (see MODELS below; add a new entry there + a line in MODEL_INFO in app.js to add a model):
  ifs   ECMWF IFS (physics model, global), 10 newest runs (00/06/12/18 UTC).
  aifs  ECMWF AIFS Single (AI model, global), 10 newest runs, 0-360 h every 6 h, no gust.
  hrrr  NOAA HRRR (3 km, contiguous US), 10 newest hourly runs: 0-18 h hourly (0-48 h at 00/06/12/18 UTC).
  rrfs  NOAA RRFS v1 (3 km, contiguous US subset), 10 newest runs of the cycles with full hourly output
        on AWS (00/03/06/.../21 UTC): 0-84 h hourly at 00/06/12/18 UTC, 0-18 h at 03/09/15/21 UTC.
        (RRFS also runs every hour, but for the other hours AWS only has 15-minute "subh" files.)
  For each model the newest run is published at full resolution (ECMWF 0.25 deg, NOAA ~3 km) and
  every run also at half resolution (0.5 deg / ~6 km); older runs are shown at half resolution.

Usage:
  python update_data.py model <key>   # build the runs of one model that are not in the bucket yet,
                                      # stage them in data/ and (with R2 secrets) upload them;
                                      # writes frag/<key>.json (this model's entry for index.json)
  python update_data.py publish       # merge frag/*.json with the current index.json -> data/index.json
                                      # (upload + clean-up of old runs: r2_sync.py publish data)
  python update_data.py local [keys]  # local testing without R2: build everything into data/

The bucket is the store: run folders never change once uploaded (<model path><run id>/<res>/), so each
job only builds runs that are new. index.json (uploaded last) says which runs the site shows.
Where the "current index" comes from: env DATA_URL (public bucket URL) or, if not set, data/index.json.
A failure in one model never blocks the others (separate jobs; the old entry is kept on failure).

ECMWF IFS open data (checked Oct/Nov 2026 against data.ecmwf.int):
  * 00/12 UTC runs: 0-144 h every 3 h, then 150-360 h every 6 h (85 steps); 06/18 UTC: 0-144 h every 3 h.
  * data.ecmwf.int keeps about 3 days of runs (12 runs), so 10 runs can be built from scratch.
  * Gust "10fg" = max over previous 1 h (+3..+90 h) / 6 h (+150..), "10fg3" = previous 3 h (+93..+144 h).
  * tp (total precipitation, m) is accumulated from the run start (AIFS: kg m-2 = mm).
NOAA HRRR/RRFS: AWS open data (noaa-hrrr-bdp-pds, noaa-rrfs-ops-pds), several weeks of history; see hires.py.

Per run and forecast step we write (8-bit, scaled with per-step min/max in meta.json):
  wind_XXX.png  RGB(A): u, v, gust (A = inside model domain, regional models only)
  met_XXX.png   RGB: 2 m temperature, mean sea level pressure, precip accumulated since run start
  pcp_XXX.png   RGB: precip in the previous 3 h, 6 h, 24 h (sqrt scaling)
  rad_XXX.png   RGB: composite reflectivity, precip in the previous 1 h (NOAA models only)
  isobars_XXX.json  MSLP contour lines every 4 hPa + H/L centres
"""
import json, os, sys, shutil, time, datetime as dt, urllib.request, urllib.error, glob
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import eccodes
from PIL import Image
from scipy import ndimage
import contourpy
import hires

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(HERE, "cache")
FRAG = os.path.join(HERE, "frag")
BASE = "https://data.ecmwf.int/forecasts"
LONG_STEPS = list(range(0, 145, 3)) + list(range(150, 361, 6))
SHORT_STEPS = list(range(0, 145, 3))
AIFS_STEPS = list(range(0, 361, 6))
GUST_PARAMS = ("10fg", "10fg3", "10fg6")
HRRR_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{d:%Y%m%d}/conus/hrrr.t{d:%H}z.wrfsfcf{s:02d}.grib2"
RRFS_URL = "https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.{d:%Y%m%d}/{d:%H}/rrfs.t{d:%H}z.2dfld.3km.f{s:03d}.conus.grib2"
# Per-model settings. "pcp" = precip periods the site can offer; "gust" = has a gust layer; "refl" = radar layer.
# "cycle" = hours between runs; "search" = how many hours back to look for runs; "res" = folder names (full, half).
MODELS = {
    "ifs":  {"name": "ECMWF IFS", "long": "ECMWF IFS open data", "kind": "ecmwf", "dir": "ifs", "nRuns": 10,
             "steps": lambda run: LONG_STEPS if run.hour in (0, 12) else SHORT_STEPS, "cycle": 6, "search": 96,
             "cache": "", "site": "runs", "gust": True, "refl": False, "pcp": ["3", "6", "24", "total"],
             "res": ("0p25", "0p50")},
    "aifs": {"name": "ECMWF AIFS", "long": "ECMWF AIFS Single open data", "kind": "ecmwf", "dir": "aifs-single", "nRuns": 10,
             "steps": lambda run: AIFS_STEPS, "cycle": 6, "search": 96,
             "cache": "aifs-", "site": "aifs/runs", "gust": False, "refl": False, "pcp": ["6", "24", "total"],
             "res": ("0p25", "0p50")},
    "hrrr": {"name": "NOAA HRRR", "long": "NOAA HRRR (AWS open data)", "kind": "noaa", "url": HRRR_URL, "msl": "MSLMA",
             "nRuns": 10, "steps": lambda run: list(range(0, 49 if run.hour % 6 == 0 else 19)), "cycle": 1, "search": 18,
             "cache": "hrrr-", "site": "hrrr/runs", "gust": True, "refl": True, "pcp": ["1", "3", "6", "24", "total"],
             "res": ("3km", "6km")},
    "rrfs": {"name": "NOAA RRFS", "long": "NOAA RRFS v1 (AWS open data)", "kind": "noaa", "url": RRFS_URL, "msl": "MSLET",
             "nRuns": 10, "steps": lambda run: list(range(0, 85 if run.hour % 6 == 0 else 19)), "cycle": 3, "search": 45,
             "cache": "rrfs-", "site": "rrfs/runs", "gust": True, "refl": True, "pcp": ["1", "3", "6", "24", "total"],
             "res": ("3km", "6km")},
}
FORMAT = 3   # bump to invalidate cached runs when the file format changes
DEFAULT_DATA_URL = "https://pub-797c80c27d0f42d6ad578c6ed6044be2.r2.dev/"

def http(url, rng=None, tries=5):
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ecmwf-wind-map"})
            if rng: req.add_header("Range", "bytes=%d-%d" % rng)
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            err = e
        except Exception as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"failed {url}: {err}")

def url(run, step, ext, model="ifs"):
    cfg = MODELS[model]
    if cfg["kind"] == "noaa":
        return cfg["url"].format(d=run, s=step) + (".idx" if ext == "index" else "")
    return (f"{BASE}/{run:%Y%m%d}/{run:%H}z/{cfg['dir']}/0p25/oper/"
            f"{run:%Y%m%d%H%M%S}-{step}h-oper-fc.{ext}")

def steps_for(run, model="ifs"): return MODELS[model]["steps"](run)
def run_id(run): return run.strftime("%Y%m%d%H")
def cache_dir(run, model): return os.path.join(CACHE, MODELS[model]["cache"] + run_id(run))

def exists(u):
    """HEAD request: True if the file is there"""
    for k in range(4):
        try:
            req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": "ecmwf-wind-map"})
            with urllib.request.urlopen(req, timeout=30): return True
        except urllib.error.HTTPError as e:
            if e.code in (403, 404): return False
        except Exception: pass
        time.sleep(2 * (k + 1))
    return False

def plan(model="ifs"):
    """The newest runs of a model whose last step is published (newest first)."""
    cfg = MODELS[model]; n, cyc = cfg["nRuns"], cfg["cycle"]
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    t = now.replace(hour=now.hour // cyc * cyc)
    cands = []
    while t >= now - dt.timedelta(hours=cfg["search"]):
        cands.append(t); t -= dt.timedelta(hours=cyc)
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(lambda r: exists(url(r, steps_for(r, model)[-1], "index", model)), cands))
    runs = [r for r, o in zip(cands, ok) if o][:n]
    if not runs: print(f"warning: no complete {model} run found")
    return runs

# ---------------------------------------------------------------- downloading
def read_grib(raw):
    g = eccodes.codes_new_from_message(raw)
    try:
        ni, nj = eccodes.codes_get(g, "Ni"), eccodes.codes_get(g, "Nj")
        vals = eccodes.codes_get_values(g).reshape(nj, ni)
        if eccodes.codes_get(g, "jScansPositively"): vals = vals[::-1]
        lon0 = eccodes.codes_get(g, "longitudeOfFirstGridPointInDegrees")
        dlon = eccodes.codes_get(g, "iDirectionIncrementInDegrees")
        step_range = eccodes.codes_get_string(g, "stepRange")
        units = eccodes.codes_get_string(g, "units")
    finally:
        eccodes.codes_release(g)
    lons = ((lon0 + np.arange(ni) * dlon + 180) % 360) - 180
    order = np.argsort(lons)
    return vals[:, order].astype(np.float32), step_range, units

def index(run, step, model="ifs"):
    idx = http(url(run, step, "index", model))
    if idx is None: raise RuntimeError(f"missing index {run} +{step}h")
    out = {}
    for line in idx.decode().splitlines():
        e = json.loads(line)
        if e.get("levtype") == "sfc": out[e["param"]] = e
    return out

def get_field(run, step, entry, model="ifs", units=False):
    o, l = entry["_offset"], entry["_length"]
    r = read_grib(http(url(run, step, "grib2", model), (o, o + l - 1)))
    return r if units else r[:2]

def q8(a, lo=None, hi=None):
    lo = float(np.floor(a.min())) if lo is None else lo
    hi = float(np.ceil(a.max())) if hi is None else hi
    if hi <= lo: hi = lo + 1
    return np.clip(np.round((a - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8), lo, hi

def qsqrt(a):
    """precip (mm) -> 8 bit with sqrt scaling, exact zero; returns bytes, max"""
    a = np.maximum(a, 0); a[a < 0.01] = 0
    mx = max(1.0, float(np.ceil(a.max())))
    return np.round(np.sqrt(a / mx) * 255).astype(np.uint8), mx

def isobars(msl_hpa):
    """contours every 4 hPa + H/L on a smoothed 0.5deg grid; lon wrapped"""
    z = ndimage.gaussian_filter(msl_hpa[::2, ::2], sigma=1.5, mode=("nearest", "wrap"))
    lats = 90 - 0.5 * np.arange(z.shape[0]); lons = -180 + 0.5 * np.arange(z.shape[1] + 1)
    zw = np.concatenate([z, z[:, :1]], axis=1)
    gen = contourpy.contour_generator(lons, lats, zw, line_type=contourpy.LineType.Separate)
    lines = []
    lo, hi = int(np.floor(z.min() / 4) * 4), int(np.ceil(z.max() / 4) * 4)
    for lev in range(lo, hi + 1, 4):
        for ln in gen.lines(lev):
            if len(ln) < 5: continue
            ln = ln[np.abs(ln[:, 1]) <= 85]
            if len(ln) < 5: continue
            closed = np.allclose(ln[0], ln[-1])
            ln = np.vstack([ln[:-1:2], ln[-1:]])          # keep every 2nd point (~1 deg spacing)
            if closed: ln[-1] = ln[0]
            if len(ln) < 5: continue
            # compact: integer tenths of a degree, delta encoded (first point absolute)
            q = np.round(ln * 10).astype(int)
            d = np.vstack([q[:1], np.diff(q, axis=0)])
            lines.append({"v": lev, "d": d.ravel().tolist()})
    zs = ndimage.gaussian_filter(z, sigma=2, mode=("nearest", "wrap"))
    hl = []
    for kind, filt, cond in (("H", ndimage.maximum_filter, lambda v: v >= 1015),
                             ("L", ndimage.minimum_filter, lambda v: v <= 1008)):
        ext = filt(zs, size=25, mode=("nearest", "wrap"))
        ys, xs = np.nonzero(zs == ext)
        seen = []
        for y, x in zip(ys, xs):
            lat, lon = 90 - 0.5 * y, -180 + 0.5 * x
            if abs(lat) > 75 or not cond(zs[y, x]): continue
            if any(abs(lat - a) < 6 and abs(lon - b) < 6 for a, b in seen): continue
            seen.append((lat, lon))
            hl.append({"t": kind, "v": int(round(float(z[y, x]))), "lat": lat, "lon": lon})
    return {"lines": lines, "hl": hl}

def save_png(arr, path):
    Image.fromarray(arr).save(path, optimize=True)

def process_step(run, steps, i, out, tpall, model="ifs"):
    step = steps[i]
    ix = index(run, step, model)
    gf = lambda p: get_field(run, step, ix[p], model)
    u, _ = gf("10u"); v, _ = gf("10v")
    t2, _ = gf("2t"); msl, _ = gf("msl")
    tp = tpall[step]
    st = {"hour": step, "valid": f"{run + dt.timedelta(hours=step):%Y-%m-%dT%H:%MZ}"}
    r, st["uMin"], st["uMax"] = q8(u); g, st["vMin"], st["vMax"] = q8(v)
    gust = [p for p in GUST_PARAMS if p in ix] if MODELS[model]["gust"] else []
    if step > 0 and gust:
        gu, sr = gf(gust[0])
        b, st["gMin"], st["gMax"] = q8(np.maximum(gu, 0))
        a0, a1 = (int(x) for x in sr.split("-"))
        st["gustParam"], st["gustPeriod"] = gust[0], a1 - a0
    else:
        b = np.zeros_like(r)
    wind = np.dstack([r, g, b])
    tq, st["tMin"], st["tMax"] = q8(t2 - 273.15)
    pq, st["pMin"], st["pMax"] = q8(msl / 100.0)
    aq, st["aMax"] = qsqrt(tp)
    met = np.dstack([tq, pq, aq])
    pch = []
    for hrs, key in ((3, "r3Max"), (6, "r6Max"), (24, "r24Max")):
        if step - hrs in tpall and step >= hrs:
            q, st[key] = qsqrt(tp - tpall[step - hrs]); pch.append(q)
        else:
            st[key] = None; pch.append(np.zeros_like(tq))
    pcp = np.dstack(pch)
    name = f"{step:03d}"
    for res, sl in (("full", np.s_[:, :]), ("half", np.s_[::2, ::2])):
        d = os.path.join(out, res)
        save_png(wind[sl], os.path.join(d, f"wind_{name}.png"))
        save_png(met[sl], os.path.join(d, f"met_{name}.png"))
        save_png(pcp[sl], os.path.join(d, f"pcp_{name}.png"))
    json.dump(isobars(msl / 100.0), open(os.path.join(out, "isobars", f"isobars_{name}.json"), "w"),
              separators=(",", ":"))
    return st

def fetch_tp(run, step, model="ifs"):
    a, _, units = get_field(run, step, index(run, step, model)["tp"], model, units=True)
    # IFS gives metres of water; AIFS gives kg m-2 (= mm)
    return step, a * (1000.0 if units.strip() == "m" else 1.0)

# ---------------------------------------------------------------- NOAA HRRR / RRFS
def noaa_inventory(run, step, model):
    txt = http(url(run, step, "index", model))
    if txt is None: raise RuntimeError(f"missing {model} index {run_id(run)} +{step}h")
    return hires.parse_idx(txt.decode())

def noaa_field(run, step, rng, model):
    raw = http(url(run, step, "grib2", model), (rng[0], rng[1]) if rng[1] is not None else (rng[0], rng[0] + 50_000_000))
    g = eccodes.codes_new_from_message(raw)
    try:
        nx, ny = eccodes.codes_get(g, "Nx"), eccodes.codes_get(g, "Ny")
        if (nx, ny) != (hires.NX, hires.NY): raise RuntimeError(f"unexpected {model} grid {nx}x{ny}")
        vals = eccodes.codes_get_values(g).reshape(ny, nx)
        if not eccodes.codes_get(g, "jScansPositively"): vals = vals[::-1]
    finally:
        eccodes.codes_release(g)
    return hires.regrid(vals)

def noaa_tp(run, step, model):
    if step == 0: return step, None
    inv = noaa_inventory(run, step, model)
    return step, noaa_field(run, step, hires.pick(inv, "APCP", "surface", step, acc=True), model).astype(np.float32)

def process_noaa_step(run, steps, i, out, tpall, model):
    cfg, step = MODELS[model], steps[i]
    inv = noaa_inventory(run, step, model)
    f = lambda var, lev: noaa_field(run, step, hires.pick(inv, var, lev, step), model)
    g = hires.grid(); ins = g["inside"]
    ug, vg = f("UGRD", "10 m above ground"), f("VGRD", "10 m above ground")
    u, v = hires.rotate_wind(ug, vg)
    gust, t2, msl, refc = f("GUST", "surface"), f("TMP", "2 m above ground"), f(cfg["msl"], "mean sea level"), f("REFC", "entire atmosphere")
    st = {"hour": step, "valid": f"{run + dt.timedelta(hours=step):%Y-%m-%dT%H:%MZ}"}
    r, st["uMin"], st["uMax"] = q8(u[ins]); gg, st["vMin"], st["vMax"] = q8(v[ins]); b, st["gMin"], st["gMax"] = q8(np.maximum(gust[ins], 0))
    st["gustPeriod"] = 0          # HRRR/RRFS gust = gust at the valid time
    put = lambda q: _fill(q, ins)
    wind = np.dstack([put(r), put(gg), put(b), (ins * 255).astype(np.uint8)])
    tq, st["tMin"], st["tMax"] = q8(t2[ins] - 273.15); pq, st["pMin"], st["pMax"] = q8(msl[ins] / 100.0)
    tp = tpall[step] if tpall[step] is not None else np.zeros(ins.shape, np.float32)
    aq, st["aMax"] = qsqrt(np.nan_to_num(tp[ins]))
    met = np.dstack([put(tq), put(pq), put(aq)])
    pch = []
    for hrs, key in ((1, "r1Max"), (3, "r3Max"), (6, "r6Max"), (24, "r24Max")):
        if step >= hrs and (step - hrs) in tpall:
            prev = tpall[step - hrs]
            q, st[key] = qsqrt(np.nan_to_num(tp[ins] - (prev[ins] if prev is not None else 0))); pch.append(put(q))
        else:
            st[key] = None; pch.append(np.zeros(ins.shape, np.uint8))
    pcp = np.dstack(pch[1:])
    # composite reflectivity, fixed scale: byte = 2 * (dBZ + 32); below 5 dBZ stored as 0 ("no echo")
    dbz = np.nan_to_num(refc, nan=-32)
    rq = np.where(dbz < 5, 0, np.clip(np.round((dbz + 32) * 2), 0, 255)).astype(np.uint8); rq[~ins] = 0
    rad = np.dstack([rq, pch[0], np.zeros(ins.shape, np.uint8)])
    name = f"{step:03d}"
    for res, sl in (("full", np.s_[:, :]), ("half", np.s_[::2, ::2])):
        d = os.path.join(out, res)
        save_png(wind[sl], os.path.join(d, f"wind_{name}.png")); save_png(met[sl], os.path.join(d, f"met_{name}.png"))
        save_png(pcp[sl], os.path.join(d, f"pcp_{name}.png")); save_png(rad[sl], os.path.join(d, f"rad_{name}.png"))
    iso = hires.isobars_regional(msl / 100.0, ins, g["lon0"], g["lat0"], hires.DLON, hires.DLAT)
    json.dump(iso, open(os.path.join(out, "isobars", f"isobars_{name}.json"), "w"), separators=(",", ":"))
    return st

def _fill(q, ins):
    a = np.zeros(ins.shape, np.uint8); a[ins] = q; return a

# ---------------------------------------------------------------- building runs
def is_built(run, model):
    done = os.path.join(cache_dir(run, model), "DONE")
    return os.path.exists(done) and open(done).read().strip() == str(FORMAT)

def build_run(run, model="ifs"):
    rid = run_id(run); out = cache_dir(run, model)
    if is_built(run, model):
        print(f"{model} run {rid}: cached"); return
    t0 = time.time()
    shutil.rmtree(out, ignore_errors=True)
    for d in ("full", "half", "isobars"): os.makedirs(os.path.join(out, d))
    steps = steps_for(run, model)
    noaa = MODELS[model]["kind"] == "noaa"
    with ThreadPoolExecutor(6 if noaa else 8) as ex:
        if noaa:
            tpall = dict(ex.map(lambda st: noaa_tp(run, st, model), steps))
            sts = list(ex.map(lambda i: process_noaa_step(run, steps, i, out, tpall, model), range(len(steps))))
        else:
            tpall = dict(ex.map(lambda st: fetch_tp(run, st, model), steps))   # accumulated precip, mm
            sts = list(ex.map(lambda i: process_step(run, steps, i, out, tpall, model), range(len(steps))))
    del tpall
    json.dump({"run": f"{run:%Y-%m-%dT%H:%MZ}", "id": rid, "steps": sts}, open(os.path.join(out, "steps.json"), "w"))
    open(os.path.join(out, "DONE"), "w").write(str(FORMAT))
    print(f"{model} run {rid}: built {len(steps)} steps in {time.time() - t0:.0f} s", flush=True)

def grid_meta(model, res):
    """map grid of a published folder"""
    f = 1 if res == "full" else 2
    if MODELS[model]["kind"] == "noaa":
        g = hires.grid()
        return {"res": round(hires.DLON * f, 3), "resLabel": f"~{3 * f} km", "width": (g["W"] + f - 1) // f,
                "height": (g["H"] + f - 1) // f, "lon0": g["lon0"], "lat0": g["lat0"],
                "dlon": round(hires.DLON * f, 4), "dlat": round(hires.DLAT * f, 4), "global": False}
    return {"res": 0.25 * f, "resLabel": f"{0.25 * f}°", "width": 1440 // f, "height": 721 if f == 1 else 361,
            "lon0": -180.0, "lat0": 90.0, "dlon": 0.25 * f, "dlat": 0.25 * f, "global": True}

def region(model):
    """bounds + outline of a regional model (None for global models)"""
    if MODELS[model]["kind"] != "noaa": return None
    o = hires.domain_outline(60)
    lats, lons = [p[0] for p in o], [p[1] for p in o]
    return {"name": "contiguous US", "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]], "outline": o}

def stage(run, model, res, gen):
    """copy a built run folder (one resolution) into data/ with its meta.json; returns the folder name"""
    cfg = MODELS[model]; rid = run_id(run); src = cache_dir(run, model)
    rdir = f"{rid}/{cfg['res'][0 if res == 'full' else 1]}"
    dst = os.path.join(DATA, cfg["site"], rdir)
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(os.path.join(src, res), dst)
    shutil.copytree(os.path.join(src, "isobars"), dst, dirs_exist_ok=True)
    info = json.load(open(os.path.join(src, "steps.json")))
    meta = {"model": cfg["long"], "modelKey": model, "id": rid, "run": info["run"], **grid_meta(model, res),
            "steps": info["steps"], "generated": gen}
    if cfg["kind"] == "noaa": meta["masked"] = True
    json.dump(meta, open(os.path.join(dst, "meta.json"), "w"), separators=(",", ":"))
    return rdir, meta

# ---------------------------------------------------------------- index.json
def current_index():
    """the index.json the site uses now (bucket via DATA_URL, else local data/index.json)"""
    u = os.environ.get("DATA_URL")
    try:
        if u:
            raw = http(u.rstrip("/") + "/index.json?t=%d" % time.time())
            return json.loads(raw) if raw else None
        p = os.path.join(DATA, "index.json")
        return json.load(open(p)) if os.path.exists(p) else None
    except Exception as e:
        print("warning: could not read current index.json:", e); return None

def model_entry(model, runs):
    cfg = MODELS[model]
    e = {"key": model, "name": cfg["name"], "path": f"{cfg['site']}/", "gust": cfg["gust"], "refl": cfg["refl"],
         "pcp": cfg["pcp"], "global": cfg["kind"] != "noaa", "runs": runs}
    if region(model): e["region"] = region(model)
    return e

def run_model(model):
    """build + stage + upload the runs of one model that are missing in the bucket; write frag/<model>.json"""
    t0 = time.time(); budget = float(os.environ.get("BUILD_BUDGET_MIN", "35")) * 60
    cfg = MODELS[model]; full_n, half_n = cfg["res"]
    gen = f"{dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%MZ}"
    ix = current_index() or {}
    old = next((m for m in ix.get("models", []) if m["key"] == model), None)
    have = {}                                     # run id -> {folder name: run entry}
    for r in (old or {}).get("runs", []):
        for d in r.get("dirs", [r.get("dir", r["id"])]):
            have.setdefault(r["id"], {})[d.split("/")[-1]] = r
    runs = plan(model)
    print(f"{model} runs:", ", ".join(run_id(r) for r in runs) or "none", flush=True)
    os.makedirs(FRAG, exist_ok=True); entries = []
    for k, run in enumerate(runs):
        rid = run_id(run); got = have.get(rid, {})
        need = [half_n] + ([full_n] if k == 0 else [])
        missing = [n for n in need if n not in got]
        new = {}
        if missing:
            if time.time() - t0 > budget:
                print(f"{model} run {rid}: time budget used up, will be built by a later job")
            else:
                try:
                    build_run(run, model)
                    for n in missing:
                        new[n] = stage(run, model, "full" if n == full_n else "half", gen)
                except Exception as e:
                    print(f"warning: {model} run {rid} failed: {e}", flush=True)
        avail = set(got) | set(new)
        if not avail: continue
        show = full_n if (not entries and full_n in avail) else (half_n if half_n in avail else full_n)
        if show in new:
            rdir, meta = new[show]; steps = meta["steps"]
            e = {"id": rid, "dir": rdir, "run": meta["run"], "res": meta["res"], "resLabel": meta["resLabel"],
                 "nSteps": len(steps), "maxHour": steps[-1]["hour"]}
        else:
            e = dict(got[show]); e["dir"] = f"{rid}/{show}"
            # resolution of a folder built by an earlier job: derive it from the folder name
            e["res"] = grid_meta(model, "full" if show == full_n else "half")["res"]
            e["resLabel"] = grid_meta(model, "full" if show == full_n else "half")["resLabel"]
        # keep only what is needed: newest run = full + half, older runs = half (the old full folder is
        # deleted by the garbage collection one refresh later)
        keep = [n for n in need if n in avail] or [show]
        e["dirs"] = sorted(f"{rid}/{n}" for n in keep)
        entries.append(e)
        # free disk: the staged copy in data/ is what gets uploaded; the build cache is not needed again
        if new and not os.environ.get("KEEP_CACHE"): shutil.rmtree(cache_dir(run, model), ignore_errors=True)
    entry = model_entry(model, entries)
    json.dump(entry, open(os.path.join(FRAG, model + ".json"), "w"), indent=1)
    print(f"{model}: {len(entries)} of {len(runs)} runs available, took {time.time() - t0:.0f} s")
    return entry

def publish():
    """data/index.json = new model entries (frag/) + unchanged entries of models whose job failed"""
    ix = current_index() or {}
    old = {m["key"]: m for m in ix.get("models", [])}
    models = []
    for key in MODELS:
        p = os.path.join(FRAG, key + ".json")
        if os.path.exists(p):
            e = json.load(open(p))
            if not e["runs"] and key in old: e = old[key]; print(f"{key}: no runs now, keeping previous entry")
        elif key in old:
            e = old[key]; print(f"warning: {key}: no new entry (job failed?), keeping previous entry")
        else: continue
        if e["runs"]: models.append(e)
    if not models: raise SystemExit("no model has any run")
    ifs = next((m for m in models if m["key"] == "ifs"), {"runs": []})
    gen = f"{dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%MZ}"
    os.makedirs(DATA, exist_ok=True)
    # "runs" (top level) = IFS runs (as in the first versions of the site); "models" lists every model.
    # paths are relative to the data root (Cloudflare R2 bucket); a run's files are at path + dir + "/".
    json.dump({"generated": gen, "layout": 3, "runs": ifs["runs"], "models": models},
              open(os.path.join(DATA, "index.json"), "w"), indent=1)
    for m in models:
        print(f"  {m['key']}: {len(m['runs'])} runs, newest {m['runs'][0]['id']} ({m['runs'][0]['resLabel'] if 'resLabel' in m['runs'][0] else m['runs'][0]['res']})")

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "local"
    if mode == "model":
        run_model(sys.argv[2])
    elif mode == "publish":
        publish()
    elif mode == "local":
        keys = sys.argv[2:] or list(MODELS)
        for k in keys: run_model(k)
        publish()
    else:
        raise SystemExit(__doc__)

if __name__ == "__main__":
    main()
