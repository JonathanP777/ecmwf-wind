#!/usr/bin/env python3
"""Fetch the latest ECMWF open-data IFS 0.25deg 10 m wind forecast and
convert each forecast step into a small PNG "wind texture" for the website.

Each PNG is the full global 0.25deg grid (1440 x 721 pixels):
  red channel   = east-west wind (u) scaled to 0..255
  green channel = north-south wind (v) scaled to 0..255
The scaling numbers are written to data/meta.json.
"""
import json, os, sys, datetime as dt
import numpy as np
import xarray as xr
from PIL import Image
from ecmwf.opendata import Client

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
STEPS = list(range(0, 73, 3))          # 0,3,6,...,72 h
GRIB = os.path.join(DATA, "wind.grib2")

def main():
    os.makedirs(DATA, exist_ok=True)
    client = Client(source="ecmwf", model="ifs", resol="0p25")
    res = client.retrieve(type="fc", param=["10u", "10v"], step=STEPS, target=GRIB)
    run = res.datetime  # model run time (UTC)
    print("Model run:", run)

    ds = xr.open_dataset(GRIB, engine="cfgrib", backend_kwargs={"indexpath": ""})
    lat = ds.latitude.values; lon = ds.longitude.values
    # make longitudes -180..179.75 and latitudes 90..-90
    lon = ((lon + 180) % 360) - 180
    order = np.argsort(lon)
    lon = lon[order]
    flip = lat[0] < lat[-1]
    if flip: lat = lat[::-1]
    steps_out = []
    for i, st in enumerate(ds.step.values):
        hours = int(st / np.timedelta64(1, "h"))
        u = ds["u10"].isel(step=i).values[:, order]
        v = ds["v10"].isel(step=i).values[:, order]
        if flip: u, v = u[::-1], v[::-1]
        umin, umax = float(np.floor(u.min())), float(np.ceil(u.max()))
        vmin, vmax = float(np.floor(v.min())), float(np.ceil(v.max()))
        r = np.round((u - umin) / (umax - umin) * 255).astype(np.uint8)
        g = np.round((v - vmin) / (vmax - vmin) * 255).astype(np.uint8)
        img = np.dstack([r, g, np.zeros_like(r)])
        name = f"wind_{hours:03d}.png"
        Image.fromarray(img, "RGB").save(os.path.join(DATA, name), optimize=True)
        valid = run + dt.timedelta(hours=hours)
        steps_out.append({"hour": hours, "file": name, "valid": valid.strftime("%Y-%m-%dT%H:%MZ"),
                          "uMin": umin, "uMax": umax, "vMin": vmin, "vMax": vmax})
        print(f"  +{hours:3d}h -> {name}")
    meta = {"model": "ECMWF IFS open data 0.25deg", "run": run.strftime("%Y-%m-%dT%H:%MZ"),
            "width": int(len(lon)), "height": int(len(lat)),
            "lon0": float(lon[0]), "lat0": float(lat[0]), "dlon": float(lon[1] - lon[0]),
            "dlat": float(lat[0] - lat[1]), "steps": steps_out,
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), indent=1)
    os.remove(GRIB)
    print("Done:", len(steps_out), "steps")

if __name__ == "__main__":
    main()
