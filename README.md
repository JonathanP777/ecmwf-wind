# ECMWF Wind Viewer (prototype)

A zoomable weather map showing the latest forecasts of four models — ECMWF IFS and AIFS
(global) and NOAA HRRR and RRFS (3 km, contiguous US) — with animated "flowing" wind
particles, proper meteorological wind barbs, colour layers (wind, gust, temperature,
precipitation, radar), isobars and a forecast-hour slider. Each model keeps its 10 newest runs.

## What's in here

| File | What it does |
|------|--------------|
| `index.html`, `app.js`, `style.css` | The website itself (one page, no server code needed). |
| `update_data.py` | Downloads the newest forecast runs of each model and turns them into small images in `data/`. |
| `hires.py` | HRRR/RRFS helpers: Lambert-conformal grid → lat/lon reprojection, wind rotation, `.idx` byte ranges, regional isobars. |
| `data/` | `index.json` (list of runs) + run folders with images per forecast step and `meta.json`. Generated, not stored in git; uploaded to Cloudflare R2. |
| `config.js` | `window.DATA_BASE`: where the site loads forecast data from (the R2 public URL). |
| `r2_sync.py` | `upload`: puts new run folders in the Cloudflare R2 bucket. `publish`: uploads `index.json` last, then deletes runs that rolled off. |
| `vendor/` | Leaflet map library + Natural Earth coastlines/borders, stored locally. |
| `screenshot.py` | Opens the site in a hidden browser and saves pictures to `screenshots/`. |

## How it works (plain language)

1. **The data.** ECMWF (the European weather centre) publishes part of its
   main forecast model (IFS) for free, on a grid with a point every 0.25°
   (~28 km). `update_data.py` downloads the east-west (`10u`) and north-south
   (`10v`) wind for every 3 hours from now out to 72 hours.
2. **Packing it for the browser.** Each forecast hour is saved as a picture
   the size of the model grid (1440 × 721 pixels). The red colour of a
   pixel stores the east-west wind, green stores the north-south wind. Pictures
   compress well, so a whole global, full-resolution forecast hour is ~0.9 MB.
3. **Drawing it.** The web page loads that picture, turns the colours back
   into wind numbers, and draws three layers on top of a normal web map:
   - **Speed colours** – blue = calm through green/yellow/red/purple = strong.
   - **Particles** – thousands of little streaks that move with the wind.
   - **Barbs** – standard weather-map symbols. The line points to where the
     wind is coming *from*; a half line = 5 knots, full line = 10 knots,
     triangle (pennant) = 50 knots; a circle means calm. Barbs sit on real model
     grid points and thin out automatically as you zoom out.
   Hover anywhere to read the wind speed (knots and m/s) and direction.

## Running it on your own computer

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt   # includes playwright for screenshots
python update_data.py local hrrr   # build runs of one or more models into data/ (all 4 if none named)
python -m http.server 8765         # then open http://localhost:8765 with window.DATA_BASE = 'data/' in config.js
```

`BUILD_BUDGET_MIN=5` limits how long a build may run (newest runs first; the rest are skipped).

## Forecast data, runs and layers

Every model keeps its **10 newest complete runs**. Pick one with the "Run" menu.
Switching runs (or models) keeps the same *valid time* where possible, so you compare like with like.

| Model | Area / grid | Runs kept | Steps | New run |
|---|---|---|---|---|
| ECMWF IFS | global, 0.25° newest / 0.5° older | 10 (2.5 days) | 00/12Z: 0–144 h 3-hourly + 150–360 h 6-hourly (85 steps); 06/18Z: 0–144 h (49 steps) | every 6 h, ~7–9 h after run time |
| ECMWF AIFS | global, 0.25° / 0.5° | 10 (2.5 days) | 0–360 h, 6-hourly (61 steps) | every 6 h |
| NOAA HRRR | contiguous US, ~3 km newest / ~6 km older | 10 (the last 10 hours) | hourly; 0–18 h, or 0–48 h for 00/06/12/18Z | hourly, ~1.5–2 h after run time |
| NOAA RRFS | contiguous US, ~3 km / ~6 km | 10 (3-hourly runs, ~30 h) | hourly; 0–84 h for 00/06/12/18Z, 0–18 h for 03/09/15/21Z | every 3 h, ~2–3 h after run time |

ECMWF's server keeps about 3–4 days of runs; NOAA's AWS buckets keep months.

Layers ("Colours" menu; particles and barbs are always the sustained 10 m wind). Layers a
model doesn't have are greyed out in its menus.

**ECMWF** (IFS; AIFS has no gust and is 6-hourly):

| Layer | ECMWF param | Notes |
|---|---|---|
| Wind speed | `10u`, `10v` | knots / mph / km/h / m/s |
| Wind gust | `10fg` (max previous 1 h to +90 h, previous 6 h after +144 h), `10fg3` (previous 3 h, +93…+144 h) | none at +0 h |
| Temperature (2 m) | `2t` | °F (default) or °C |
| Precipitation | `tp` (accumulated from run start) | 3 h (only to +144 h), 6 h (from +6 h), 24 h (from +24 h) totals by differencing, or total since run start. 1 h isn't possible: ECMWF's free data is 3-hourly at best. Inches (default) or mm |
| Isobars (overlay) | `msl` | every 4 hPa, labelled, with H/L centres; can be combined with any colour layer |

**HRRR / RRFS** (fields fetched from the NOAA GRIB2 files with `.idx` byte ranges, so only these
~7 fields are downloaded, not the whole ~100 MB file):

| Layer | GRIB2 field | Notes |
|---|---|---|
| Wind speed | `UGRD`/`VGRD` 10 m | rotated from the Lambert grid to true east/north |
| Wind gust | `GUST` surface | gust at the valid time (also at +0 h) |
| Temperature (2 m) | `TMP` 2 m | |
| Precipitation | `APCP` (since run start) | **1 h**, 3 h, 6 h, 24 h totals by differencing, or total since run start |
| Radar (reflectivity) | `REFC` | simulated composite reflectivity, dBZ, NWS colours (≥ 5 dBZ) |
| Isobars | `MSLMA` (HRRR), `MSLET` (RRFS) | every 4 hPa with H/L |

The native 3 km Lambert-conformal grid (1799 × 1059) is resampled to a 0.04° × 0.03° lat/lon grid
(1832 × 1051 pixels, about native detail); points outside the model area are transparent. The map
draws the model's area as a dashed yellow outline, and switching to HRRR/RRFS zooms to the US if
the view is elsewhere.

### How the data is stored (size)

For every run and step there are three small PNG images where the colour channels hold
8-bit scaled values: `wind_XXX.png` (u, v, gust), `met_XXX.png` (temperature, pressure,
precip since run start) and `pcp_XXX.png` (3/6/24 h precip, loaded only when the precip
layer is on). HRRR/RRFS also have `rad_XXX.png` (R = reflectivity, G = 1 h precip) and use the
alpha channel of `wind_XXX.png` to mark the model area. There is also `isobars_XXX.json`
(contour lines and H/L, compact encoding).

- The **newest run** of each model is published at full resolution (0.25° or ~3 km).
- The **9 older runs** are published at half resolution (0.5° or ~6 km, every other grid point).

Approximate sizes: IFS ~0.9 GB, AIFS ~0.7 GB, HRRR ~0.5 GB, RRFS ~0.9 GB for 10 runs each
(about 3 GB in total, ~4 GB at the peak of a refresh, well inside R2's 10 GB free storage).

## Live website

Hosted free on GitHub Pages: https://jonathanp777.github.io/ecmwf-wind/

The workflow in `.github/workflows/deploy.yml` runs every hour (at :20), on every push to
`main`, and on demand (Actions tab -> "Run workflow"):

1. **One job per model** (`ifs`, `aifs`, `hrrr`, `rrfs`, side by side). Each reads the live
   `index.json` from R2, works out the model's 10 newest complete runs, builds only the run
   folders that are missing (newest first, stopping after 35 minutes — anything left is built by
   the next hourly job), and uploads them. A failing model doesn't stop the others.
2. **Publish**: merges the models into `index.json` (a model whose job failed keeps its previous
   entry), checks every listed folder is really in the bucket, uploads `index.json` last, then
   deletes folders no longer needed.
3. **Site**: the web page itself (code only) goes to GitHub Pages — only on pushes and manual
   runs, not on the hourly schedule. Forecast data is never committed to git.

### Forecast data on Cloudflare R2

- Bucket `ecmwf-wind-data`, public URL https://pub-797c80c27d0f42d6ad578c6ed6044be2.r2.dev/
  (so the index is at `…r2.dev/index.json`). CORS allows GET from jonathanp777.github.io and localhost.
- The workflow needs two repository secrets: `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
  (an R2 API token with Object Read & Write on that bucket only).
- Run folders never change after upload (a run that drops to half resolution uses its other
  folder), so each refresh only uploads new files. Folders from the previous index are kept for one
  more refresh so visitors with the page open don't break, then deleted.
- R2 operations: roughly 0.4 million writes (Class A) a month — mostly HRRR's hourly runs —
  against the free 1 million; reads depend on visitors (free 10 million a month).
- To use another host (e.g. a custom domain on the bucket), change `DATA_BASE` in `config.js`.

## Credits / licences

- Forecast data: © ECMWF, open data, licence CC BY 4.0 (attribution required, shown on the map).
  HRRR and RRFS: NOAA/NCEP, public domain, via the NOAA Open Data Dissemination program on AWS
  (`noaa-hrrr-bdp-pds`, `noaa-rrfs-ops-pds`).
- Basemap: Esri Dark Gray Canvas (free with attribution); OpenStreetMap selectable.
  (CARTO's free dark basemap now needs an API key, so it isn't used.)
- Coastlines/borders: Natural Earth (public domain). Map library: Leaflet.

## Known limitations of this prototype

- Wind values are stored with 8-bit precision (about 0.1–0.3 m/s steps): fine for display.
- RRFS (operational since 14 Oct 2026) publishes its full hourly US output on AWS only for the
  3-hourly runs, so the site uses those (the in-between hourly runs only have 15-minute files).
- On first start, and after a long outage, the 10 runs per model are rebuilt over a few hourly jobs.
- Mountain areas show wiggly isobars in HRRR/RRFS (sea-level pressure over high ground is an estimate).
- Particles pause while you drag/zoom and restart when you stop.
- Coastline lines don't repeat when you scroll past the date line onto a second copy of the world.

## Drawing tools

Open **Additional Map Settings → Drawing tools** (bottom left). You can use:
- a freehand pen
- lines and arrows
- rectangles, circles and polygons
- text labels
- cold, warm, stationary and occluded fronts, and troughs (front symbols sit on the left of the direction you draw; **Flip** swaps the side)
- H and L markers.

**Select** lets you move or edit a drawing. Press **Esc**, or click the active tool again, to go back to panning the map.

Drawings are saved in your browser. You can export them as a GeoJSON file and import them again. **Save image (PNG)** downloads the current view with a caption showing the model run, valid time and layer. Drawing uses [Leaflet-Geoman](https://github.com/geoman-io/leaflet-geoman) (MIT), stored locally in `vendor/`.

## Models

Use the **Model** menu to switch between:
- **ECMWF IFS**, ECMWF's main physics model. Data is 3-hourly up to +144 h.
- **ECMWF AIFS**, ECMWF's AI model ([aifs-single](https://www.ecmwf.int/en/forecasts/dataset/aifs-machine-learning-data)). Every run goes to +360 h in 6-hourly steps. AIFS has no wind-gust data and no 1 h or 3 h precipitation totals, so those menu items are greyed out.
- **NOAA HRRR** ([High-Resolution Rapid Refresh](https://rapidrefresh.noaa.gov/hrrr/)), 3 km, contiguous US, new run every hour.
- **NOAA RRFS** ([Rapid Refresh Forecast System](https://registry.opendata.aws/noaa-rrfs-ops/)), 3 km, contiguous US; NOAA's new convection-allowing model that replaced the NAM, HiresW, HREF and SREF in October 2026.

Each model's menus only offer what that model has. When you switch models, the map tries to stay on the same valid time. The site also remembers the last model you picked. A link with `?model=aifs` (or `hrrr`, `rrfs`) opens that model directly. Outside the HRRR/RRFS area the readout says so.

Data layout (made by `update_data.py`):
- `index.json` (`"layout": 3`) keeps `generated` and `runs` (the IFS runs, for older pages). It also has `models`, with one entry per model: `key`, `name`, `path` (relative: `runs/`, `aifs/runs/`, `hrrr/runs/`, `rrfs/runs/`), `gust`, `refl`, `pcp`, `global`, `region` (regional models: `name`, `bounds`, `outline`) and `runs`.
- Every run entry has `dir` (the folder the site shows: `<run id>/0p25` or `0p50` for ECMWF, `<run id>/3km` or `6km` for HRRR/RRFS), `dirs` (all folders kept for that run), `res`, `resLabel`, `nSteps` and `maxHour`. A run's files are at `DATA_BASE + path + dir + '/'`, e.g. `hrrr/runs/2026110301/3km/meta.json`.
- Health check: each model should have up to 10 runs, the newest with a full-resolution `dir`; `generated` should be less than ~2 h old.

To add another model, add an entry to `MODELS` in `update_data.py`, to `MODEL_INFO` in `app.js` and to the job list in the workflow.
