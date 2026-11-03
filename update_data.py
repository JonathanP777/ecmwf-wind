#!/usr/bin/env python3
"""Build the forecast data for the website from ECMWF open data (IFS and AIFS, 0.25deg).

Usage:
  python update_data.py plan    # list the newest complete runs of each model (writes GitHub step outputs)
  python update_data.py build   # make sure each of those runs is in cache/, then assemble data/
  python update_data.py         # plan + build

Models (see MODELS below; add a new entry there to add a model):
  ifs   ECMWF IFS (physics model), 5 newest runs: newest at 0.25deg, older 4 at 0.5deg.
        Site data: data/runs/<run id>/   (unchanged from before AIFS was added)
  aifs  ECMWF AIFS Single (machine-learning model), 2 newest runs: newest 0.25deg, other 0.5deg.
        Every run (00/06/12/18 UTC) goes 0-360 h every 6 h (61 steps). No gust parameter.
        tp is in kg m-2 (= mm), accumulated from the run start. Site data: data/aifs/runs/<run id>/

What ECMWF IFS open data offers (checked Oct 2026 against data.ecmwf.int index files):
  * 00/12 UTC runs: 0-144 h every 3 h, then 150-360 h every 6 h (85 steps).
  * 06/18 UTC runs (stream "oper" too): 0-144 h every 3 h (49 steps).
  * data.ecmwf.int keeps about 4 days of runs, so the 5 newest runs (~30 h) are always there.
  * Gust: "10fg" = max gust over the previous 1 h (+3..+90 h) or 6 h (+150..+360 h);
    "10fg3" = max over the previous 3 h (+93..+144 h). Undefined at +0 h.
  * tp (total precipitation, metres) is accumulated from the start of the run.

Per run and forecast step we write (all 8-bit, scaled with per-step min/max in meta.json):
  wind_XXX.png  RGB: u, v, gust
  met_XXX.png   RGB: 2 m temperature, mean sea level pressure, precip accumulated since run start
  pcp_XXX.png   RGB: precip in the previous 3 h, 6 h, 24 h (from differencing tp; 3 h only to +144 h,
                6 h from +6 h, 24 h from +24 h). Precip channels use sqrt scaling (fine near 0).
  (1 h totals are not possible: open data steps are 3-hourly at best.)
  isobars_XXX.json  MSLP contour lines every 4 hPa + H/L centres (computed on a smoothed 0.5deg grid;
                    points as [lon*10, lat*10] integers, delta encoded)
Each run is built at full 0.25deg resolution ("full") and also subsampled to 0.5deg ("half").
The newest run is published at full resolution, the 4 older runs at 0.5deg to keep the site small.
Built runs are kept in cache/<run id>/ (GitHub Actions cache), so each scheduled job only
downloads runs it has not seen before.
"""
import json, os, sys, shutil, time, datetime as dt, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import eccodes
from PIL import Image
from scipy import ndimage
import contourpy

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(HERE, "cache")
BASE = "https://data.ecmwf.int/forecasts"
LONG_STEPS = list(range(0, 145, 3)) + list(range(150, 361, 6))
SHORT_STEPS = list(range(0, 145, 3))
AIFS_STEPS = list(range(0, 361, 6))
GUST_PARAMS = ("10fg", "10fg3", "10fg6")
# Per-model settings. "pcp" = precip periods the site can offer; "gust" = has a gust layer.
MODELS = {
    "ifs":  {"name": "ECMWF IFS", "long": "ECMWF IFS open data", "dir": "ifs", "nRuns": 5,
             "steps": lambda run: LONG_STEPS if run.hour in (0, 12) else SHORT_STEPS,
             "cache": "", "site": "runs", "gust": True, "pcp": ["3", "6", "24", "total"]},
    "aifs": {"name": "ECMWF AIFS", "long": "ECMWF AIFS Single open data", "dir": "aifs-single", "nRuns": 2,
             "steps": lambda run: AIFS_STEPS,
             "cache": "aifs-", "site": "aifs/runs", "gust": False, "pcp": ["6", "24", "total"]},
}
N_RUNS = 5   # IFS runs (kept for the GitHub step outputs run1..run5)
FORMAT = 3   # bump to invalidate cached runs when the file format changes

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
    return (f"{BASE}/{run:%Y%m%d}/{run:%H}z/{MODELS[model]['dir']}/0p25/oper/"
            f"{run:%Y%m%d%H%M%S}-{step}h-oper-fc.{ext}")

def steps_for(run, model="ifs"): return MODELS[model]["steps"](run)
def run_id(run): return run.strftime("%Y%m%d%H")
def cache_dir(run, model): return os.path.join(CACHE, MODELS[model]["cache"] + run_id(run))

def plan(model="ifs"):
    """The newest runs of a model whose last step is published (newest first)."""
    n = MODELS[model]["nRuns"]
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    t = now.replace(hour=now.hour // 6 * 6)
    runs = []
    for _ in range(16):
        if http(url(t, steps_for(t, model)[-1], "index", model)) is not None:
            runs.append(t)
            if len(runs) == n: break
        elif runs:
            print(f"warning: gap in available {model} runs at", t)
        t -= dt.timedelta(hours=6)
    if not runs:
        if model == "ifs": raise SystemExit("No complete ECMWF IFS run found")
        print(f"warning: no complete {model} run found")
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
    with ThreadPoolExecutor(8) as ex:
        tpall = dict(ex.map(lambda st: fetch_tp(run, st, model), steps))   # accumulated precip, mm
        sts = list(ex.map(lambda i: process_step(run, steps, i, out, tpall, model), range(len(steps))))
    del tpall
    json.dump({"run": f"{run:%Y-%m-%dT%H:%MZ}", "id": rid, "steps": sts}, open(os.path.join(out, "steps.json"), "w"))
    open(os.path.join(out, "DONE"), "w").write(str(FORMAT))
    print(f"{model} run {rid}: built {len(steps)} steps in {time.time() - t0:.0f} s")

def assemble(plans):
    """plans: {model: [runs newest first]}. Writes data/ (atomically replaced)."""
    tmp = DATA + ".tmp"; shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    gen = f"{dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%MZ}"
    models = []
    for model, runs in plans.items():
        cfg = MODELS[model]; idx = []
        for run in runs:
            if not is_built(run, model): print(f"warning: {model} run {run_id(run)} not built, skipped"); continue
            rid = run_id(run); src = cache_dir(run, model); dst = os.path.join(tmp, cfg["site"], rid)
            res = "full" if not idx else "half"          # newest available run at full resolution
            shutil.copytree(os.path.join(src, res), dst)
            shutil.copytree(os.path.join(src, "isobars"), dst, dirs_exist_ok=True)
            info = json.load(open(os.path.join(src, "steps.json")))
            f = 1 if res == "full" else 2
            meta = {"model": cfg["long"], "modelKey": model, "id": rid, "run": info["run"], "res": 0.25 * f,
                    "width": 1440 // f, "height": 721 if f == 1 else 361, "lon0": -180.0, "lat0": 90.0,
                    "dlon": 0.25 * f, "dlat": 0.25 * f, "steps": info["steps"], "generated": gen}
            json.dump(meta, open(os.path.join(dst, "meta.json"), "w"), separators=(",", ":"))
            idx.append({"id": rid, "run": info["run"], "res": meta["res"], "nSteps": len(info["steps"]),
                        "maxHour": info["steps"][-1]["hour"]})
        if model == "ifs" and not idx: raise SystemExit("no IFS run built")
        models.append({"key": model, "name": cfg["name"], "path": f"data/{cfg['site']}/",
                       "gust": cfg["gust"], "pcp": cfg["pcp"], "runs": idx})
    ifs = next(m for m in models if m["key"] == "ifs")
    # "runs" (top level) = IFS runs, same as before AIFS was added; "models" lists every model
    json.dump({"generated": gen, "runs": ifs["runs"], "models": models},
              open(os.path.join(tmp, "index.json"), "w"), indent=1)
    shutil.rmtree(DATA, ignore_errors=True); os.rename(tmp, DATA)
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(DATA) for f in fs)
    print(f"Site data: {size / 1e6:.0f} MB")
    for m in models:
        for r in m["runs"]: print("  ", m["key"], r)

def run_list(env, model):
    if os.environ.get("RUNS"):   # CI: same run list as the "plan" step
        return [dt.datetime.strptime(r, "%Y%m%d%H") for r in os.environ.get(env, "").split()]
    return plan(model)

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode == "build":
        plans = {"ifs": run_list("RUNS", "ifs"), "aifs": run_list("AIFS_RUNS", "aifs")}
    else:
        plans = {m: plan(m) for m in MODELS}
    for m, runs in plans.items(): print(f"{m} runs:", ", ".join(run_id(r) for r in runs) or "none")
    if mode in ("plan", "all") and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            runs = plans["ifs"]
            for k in range(N_RUNS):
                f.write(f"run{k + 1}={run_id(runs[k]) if k < len(runs) else 'none'}\n")
            f.write("runs=" + " ".join(run_id(r) for r in runs) + "\n")
            ar = plans["aifs"]
            for k in range(MODELS["aifs"]["nRuns"]):
                f.write(f"aifs{k + 1}={'aifs-' + run_id(ar[k]) if k < len(ar) else 'none'}\n")
            f.write("aifs_runs=" + " ".join(run_id(r) for r in ar) + "\n")
    if mode == "plan": return
    t0 = time.time()
    for run in plans["ifs"]: build_run(run, "ifs")
    for run in plans["aifs"]:
        # AIFS problems must not stop the IFS site from updating: skip the run and carry on
        try: build_run(run, "aifs")
        except Exception as e: print(f"warning: AIFS run {run_id(run)} failed: {e}")
    # drop cache dirs of runs that are no longer needed (keeps local disk tidy)
    keep = {os.path.basename(cache_dir(r, m)) for m, rs in plans.items() for r in rs}
    if os.path.isdir(CACHE):
        for d in os.listdir(CACHE):
            if d not in keep: shutil.rmtree(os.path.join(CACHE, d), ignore_errors=True)
    assemble(plans)
    print(f"Total {time.time() - t0:.0f} s")

if __name__ == "__main__":
    main()
