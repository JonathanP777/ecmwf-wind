#!/usr/bin/env python3
"""Fetch the latest complete ECMWF open-data IFS 0.25deg forecast run
(10 m wind + 10 m wind gust, every available forecast step) and convert each
step into one small PNG "wind texture" for the website.

What ECMWF open data offers (checked Oct 2026 against data.ecmwf.int index files):
  * 00 and 12 UTC runs ("oper" stream): 0-144 h every 3 h, then 150-360 h every 6 h
    -> 85 steps, out to 15 days.
  * 06 and 18 UTC runs (also published under "oper"): 0-144 h every 3 h -> 49 steps.
  * Gust: param "10fg" = max 10 m gust since the previous post-processing hour
    (steps 3-90: previous 1 h; steps 150-360: previous 6 h), and "10fg3" = max gust
    in the previous 3 h (steps 93-144). At step 0 the gust field is undefined (all 0).

Each PNG is the full global 0.25deg grid (1440 x 721 pixels):
  red   = east-west wind (u), green = north-south wind (v), blue = gust speed,
  each scaled to 0..255 with per-step min/max stored in data/meta.json.

The newest run whose LAST step has been published is used, so 06/18 UTC runs give
a 6-day forecast and 00/12 UTC runs a 15-day forecast.
"""
import json, os, sys, shutil, time, datetime as dt, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import eccodes
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BASE = "https://data.ecmwf.int/forecasts"
LONG_STEPS = list(range(0, 145, 3)) + list(range(150, 361, 6))
SHORT_STEPS = list(range(0, 145, 3))
GUST_PARAMS = ("10fg", "10fg3", "10fg6")

def http(url, rng=None, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ecmwf-wind-map"})
            if rng: req.add_header("Range", "bytes=%d-%d" % rng)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            err = e
        except Exception as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"failed {url}: {err}")

def url(run, step, ext):
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    return f"{BASE}/{d}/{h}z/ifs/0p25/oper/{run.strftime('%Y%m%d%H%M%S')}-{step}h-oper-fc.{ext}"

def latest_run():
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    t = now.replace(hour=now.hour // 6 * 6)
    for _ in range(12):  # look back 3 days
        steps = LONG_STEPS if t.hour in (0, 12) else SHORT_STEPS
        if http(url(t, steps[-1], "index")) is not None:
            return t, steps
        t -= dt.timedelta(hours=6)
    raise SystemExit("No complete ECMWF run found")

def fetch_step(run, step):
    idx = http(url(run, step, "index"))
    if idx is None: raise RuntimeError(f"missing index for step {step}")
    want = {}
    for line in idx.decode().splitlines():
        e = json.loads(line)
        if e.get("levtype") != "sfc": continue
        p = e["param"]
        if p in ("10u", "10v") or (p in GUST_PARAMS and step > 0):
            want["gust" if p in GUST_PARAMS else p] = e
    if "10u" not in want or "10v" not in want: raise RuntimeError(f"no wind in step {step}")
    out = {}
    for name, e in want.items():
        o, l = e["_offset"], e["_length"]
        raw = http(url(run, step, "grib2"), (o, o + l - 1))
        g = eccodes.codes_new_from_message(raw)
        try:
            ni, nj = eccodes.codes_get(g, "Ni"), eccodes.codes_get(g, "Nj")
            vals = eccodes.codes_get_values(g).reshape(nj, ni)
            if eccodes.codes_get(g, "jScansPositively"): vals = vals[::-1]
            lon0 = eccodes.codes_get(g, "longitudeOfFirstGridPointInDegrees")
            dlon = eccodes.codes_get(g, "iDirectionIncrementInDegrees")
            lat0 = max(eccodes.codes_get(g, "latitudeOfFirstGridPointInDegrees"),
                       eccodes.codes_get(g, "latitudeOfLastGridPointInDegrees"))
            info = {"param": e["param"], "stepRange": eccodes.codes_get_string(g, "stepRange")}
        finally:
            eccodes.codes_release(g)
        lons = ((lon0 + np.arange(ni) * dlon + 180) % 360) - 180
        order = np.argsort(lons)
        out[name] = (vals[:, order].astype(np.float32), info)
        out["_grid"] = (lons[order], lat0, dlon, ni, nj)
    return out

def scale(a):
    lo, hi = float(np.floor(a.min())), float(np.ceil(a.max()))
    if hi <= lo: hi = lo + 1
    return np.round((a - lo) / (hi - lo) * 255).astype(np.uint8), lo, hi

def process(run, step, tmp):
    d = fetch_step(run, step)
    u, v = d["10u"][0], d["10v"][0]
    r, umin, umax = scale(u); g, vmin, vmax = scale(v)
    st = {"hour": step, "file": f"wind_{step:03d}.png",
          "valid": (run + dt.timedelta(hours=step)).strftime("%Y-%m-%dT%H:%MZ"),
          "uMin": umin, "uMax": umax, "vMin": vmin, "vMax": vmax}
    if "gust" in d:
        gust, info = d["gust"]
        b, gmin, gmax = scale(np.maximum(gust, 0))
        a, bb = (int(x) for x in info["stepRange"].split("-"))
        st.update({"gMin": gmin, "gMax": gmax, "gustParam": info["param"], "gustPeriod": bb - a})
    else:
        b = np.zeros_like(r)
    Image.fromarray(np.dstack([r, g, b]), "RGB").save(os.path.join(tmp, st["file"]), optimize=True)
    return st, d["_grid"]

def main():
    t0 = time.time()
    run, steps = latest_run()
    print("Model run:", run, "steps:", len(steps), "max lead:", steps[-1], "h")
    tmp = DATA + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda s: process(run, s, tmp), steps))
    steps_out = [r[0] for r in results]
    lons, lat0, dlon, ni, nj = results[0][1]
    for st in steps_out:
        print(f"  +{st['hour']:3d}h {st['file']} gust={st.get('gustParam', '-')}/{st.get('gustPeriod', '-')}h")
    meta = {"model": "ECMWF IFS open data 0.25deg", "run": run.strftime("%Y-%m-%dT%H:%MZ"),
            "width": int(ni), "height": int(nj), "lon0": float(lons[0]), "lat0": float(lat0),
            "dlon": float(dlon), "dlat": float(dlon), "steps": steps_out,
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    json.dump(meta, open(os.path.join(tmp, "meta.json"), "w"), indent=1)
    shutil.rmtree(DATA, ignore_errors=True); os.rename(tmp, DATA)
    size = sum(os.path.getsize(os.path.join(DATA, f)) for f in os.listdir(DATA))
    print(f"Done: {len(steps_out)} steps, {size / 1e6:.1f} MB, {time.time() - t0:.0f} s")

if __name__ == "__main__":
    main()
