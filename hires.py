"""NOAA high-resolution models (HRRR, RRFS) for the website.

Both are on NOAA's 3 km Lambert conformal CONUS grid (1799 x 1059 points, true latitude 38.5N,
centre longitude 97.5W, spherical earth R = 6371229 m). We download only the needed fields with
HTTP byte ranges (from the .idx inventory files) and resample them to a regular lat/lon grid
(0.04 deg lon x 0.03 deg lat, about 3-4 km, i.e. roughly the native detail) so the website can
treat them like the global models. Points outside the model domain are transparent (alpha 0 in
the wind image). The winds in the files are relative to the model grid; they are rotated to
true east/north here.

Per forecast step we write (8-bit images, scales in meta.json like the ECMWF models):
  wind_XXX.png  RGBA: u, v, gust (instantaneous gust at valid time), alpha = inside model domain
  met_XXX.png   RGB : 2 m temperature, MSL pressure, precip since run start
  pcp_XXX.png   RGB : precip in previous 3 h, 6 h, 24 h
  rad_XXX.png   RGB : composite reflectivity (dBZ = value/2 - 32), precip in previous 1 h, 0
  isobars_XXX.json  as for the global models (tenths of a degree, delta encoded)
"""
import os, json, numpy as np
from scipy import ndimage
import contourpy

R_EARTH = 6371229.0
LAT1, LOV = 38.5, -97.5
NX, NY, DX = 1799, 1059, 3000.0
LAT_FIRST, LON_FIRST = 21.138123, 237.280472 - 360
N_LCC = np.sin(np.radians(LAT1))
F_LCC = np.cos(np.radians(LAT1)) * np.tan(np.pi / 4 + np.radians(LAT1) / 2) ** N_LCC / N_LCC
RHO0 = R_EARTH * F_LCC / np.tan(np.pi / 4 + np.radians(LAT1) / 2) ** N_LCC

def lcc_fwd(lat, lon):
    rho = R_EARTH * F_LCC / np.tan(np.pi / 4 + np.radians(lat) / 2) ** N_LCC
    th = N_LCC * np.radians(((lon - LOV + 180) % 360) - 180)
    return rho * np.sin(th), RHO0 - rho * np.cos(th)

def lcc_inv(x, y):
    rho = np.hypot(x, RHO0 - y); th = np.arctan2(x, RHO0 - y)
    lat = np.degrees(2 * np.arctan((R_EARTH * F_LCC / rho) ** (1 / N_LCC)) - np.pi / 2)
    return lat, LOV + np.degrees(th / N_LCC)

X0, Y0 = lcc_fwd(LAT_FIRST, LON_FIRST)
# target lat/lon grid ("full"); "half" = every 2nd point of it
DLON, DLAT = 0.04, 0.03

def domain_outline(step=40):
    """model domain border as [[lat, lon], ...] (for drawing the coverage on the map)"""
    i = np.r_[np.arange(0, NX - 1, step), [NX - 1] * len(range(0, NY - 1, step)), np.arange(NX - 1, 0, -step), [0] * len(range(NY - 1, 0, -step))]
    j = np.r_[[0] * len(range(0, NX - 1, step)), np.arange(0, NY - 1, step), [NY - 1] * len(range(NX - 1, 0, -step)), np.arange(NY - 1, 0, -step)]
    lat, lon = lcc_inv(X0 + i * DX, Y0 + j * DX)
    pts = [[round(float(a), 3), round(float(b), 3)] for a, b in zip(lat, lon)]
    return pts + [pts[0]]

_GRID = None
def grid():
    """target grid + where each target point falls in the native grid (computed once)"""
    global _GRID
    if _GRID is None:
        o = np.array(domain_outline(5))
        lat0 = np.ceil(o[:, 0].max() / DLAT) * DLAT; lat1 = np.floor(o[:, 0].min() / DLAT) * DLAT
        lon0 = np.floor(o[:, 1].min() / DLON) * DLON; lon1 = np.ceil(o[:, 1].max() / DLON) * DLON
        W = int(round((lon1 - lon0) / DLON)) + 1; H = int(round((lat0 - lat1) / DLAT)) + 1
        lons = lon0 + DLON * np.arange(W); lats = lat0 - DLAT * np.arange(H)
        LA, LO = np.meshgrid(lats, lons, indexing="ij")
        x, y = lcc_fwd(LA, LO)
        fi, fj = (x - X0) / DX, (y - Y0) / DX
        inside = (fi >= 0) & (fi <= NX - 1) & (fj >= 0) & (fj <= NY - 1)
        ang = N_LCC * np.radians(LO - LOV)       # grid-relative -> earth-relative wind rotation
        _GRID = {"lon0": round(float(lon0), 4), "lat0": round(float(lat0), 4), "W": W, "H": H,
                 "coords": np.array([fj.ravel(), fi.ravel()]), "inside": inside,
                 "cos": np.cos(ang).astype(np.float32), "sin": np.sin(ang).astype(np.float32)}
    return _GRID

def regrid(native):
    """native (NY, NX) array, row 0 = south -> target (H, W) float32 (NaN outside the domain)"""
    g = grid()
    out = ndimage.map_coordinates(native.astype(np.float32), g["coords"], order=1, mode="nearest")
    out = out.reshape(g["H"], g["W"]); out[~g["inside"]] = np.nan
    return out

def rotate_wind(u, v):
    g = grid(); c, s = g["cos"], g["sin"]
    return c * u + s * v, -s * u + c * v

def fill_nan(a):
    """replace NaN by the nearest valid value (for smoothing / contouring near the domain edge)"""
    m = np.isnan(a)
    if not m.any(): return a
    idx = ndimage.distance_transform_edt(m, return_distances=False, return_indices=True)
    return a[tuple(idx)]

def isobars_regional(msl_hpa, inside, lon0, lat0, dlon, dlat, sub=3):
    z = fill_nan(msl_hpa[::sub, ::sub]); ins = inside[::sub, ::sub]
    z = ndimage.gaussian_filter(z, sigma=2.0, mode="nearest")
    dlo, dla = dlon * sub, dlat * sub
    lats = lat0 - dla * np.arange(z.shape[0]); lons = lon0 + dlo * np.arange(z.shape[1])
    # don't draw contours outside the model domain
    zm = np.ma.array(z, mask=~ndimage.binary_erosion(ins, iterations=1))
    gen = contourpy.contour_generator(lons, lats, zm, line_type=contourpy.LineType.Separate)
    lines = []
    lo, hi = int(np.floor(z[ins].min() / 4) * 4), int(np.ceil(z[ins].max() / 4) * 4)
    for lev in range(lo, hi + 1, 4):
        for ln in gen.lines(lev):
            if len(ln) < 4: continue
            q = np.round(ln * 10).astype(int)
            keep = np.r_[True, np.any(np.diff(q, axis=0) != 0, axis=1)]
            q = q[keep]
            if len(q) < 4: continue
            d = np.vstack([q[:1], np.diff(q, axis=0)])
            lines.append({"v": lev, "d": d.ravel().tolist()})
    # H/L centres: extremes over ~6 deg windows, away from the domain edge
    far = ndimage.distance_transform_edt(ins) * dla > 1.5
    hl = []
    size = (max(3, int(6 / dla)), max(3, int(6 / dlo)))
    for kind, filt in (("H", ndimage.maximum_filter), ("L", ndimage.minimum_filter)):
        ext = filt(z, size=size, mode="nearest")
        ys, xs = np.nonzero((z == ext) & far)
        seen = []
        for y, x in zip(ys, xs):
            lat, lon = float(lats[y]), float(lons[x])
            if any(abs(lat - a) < 4 and abs(lon - b) < 4 for a, b in seen): continue
            seen.append((lat, lon))
            hl.append({"t": kind, "v": int(round(float(z[y, x]))), "lat": round(lat, 2), "lon": round(lon, 2)})
    return {"lines": lines, "hl": hl}

def parse_idx(text):
    """.idx inventory -> list of (var, level, timestr, offset, length)"""
    rows = [l.split(":") for l in text.splitlines() if l.strip()]
    out = []
    for k, r in enumerate(rows):
        off = int(r[1]); end = int(rows[k + 1][1]) - 1 if k + 1 < len(rows) else None
        out.append((r[3], r[4], r[5], off, end))
    return out

def pick(inv, var, level, step, acc=False):
    for v, lev, t, off, end in inv:
        if v != var or not lev.startswith(level): continue
        if acc:
            # wgrib2 writes whole days as days: "0-24 hour" appears as "0-1 day acc fcst"
            if t == f"0-{step} hour acc fcst" or (step % 24 == 0 and t == f"0-{step // 24} day acc fcst"): return off, end
        elif t == ("anl" if step == 0 else f"{step} hour fcst") or (step and step % 24 == 0 and t == f"{step // 24} day fcst"):
            return off, end
    raise KeyError(f"{var} {level} +{step}h not in inventory")
