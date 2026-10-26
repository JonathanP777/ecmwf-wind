# ECMWF Wind Viewer (prototype)

A zoomable world weather map showing the latest ECMWF forecast of wind 10 m
above the ground, with animated "flowing" wind particles, proper
meteorological wind barbs, wind-speed colours and a forecast-hour slider.

## What's in here

| File | What it does |
|------|--------------|
| `index.html`, `app.js`, `style.css` | The website itself (one page, no server code needed). |
| `update_data.py` | Downloads the newest ECMWF forecast and turns it into small images in `data/`. |
| `data/` | `index.json` (list of runs) + `runs/<run>/` with images per forecast step and `meta.json`. Generated, not stored in git. |
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
python update_data.py          # get the latest forecast (takes 1–2 minutes)
python -m http.server 8765     # then open http://localhost:8765
```

ECMWF runs the model 4 times a day (00, 06, 12, 18 UTC); open data appears
roughly 7–9 hours after the run time. Re-running `update_data.py` always grabs
the newest available run.

## Forecast data, runs and layers

`update_data.py` reads ECMWF's open-data index files directly (data.ecmwf.int keeps
about 4 days of runs) and shows the **5 newest complete runs**. Pick one with the "Run" menu.
Switching runs keeps the same *valid time* where possible, so you compare like with like.

- **00 and 12 UTC runs:** 0–144 h every 3 h, then 150–360 h every 6 h (85 steps, 15 days).
- **06 and 18 UTC runs:** 0–144 h every 3 h (49 steps, 6 days).

Layers ("Colours" menu; particles and barbs are always the sustained 10 m wind):

| Layer | ECMWF param | Notes |
|---|---|---|
| Wind speed | `10u`, `10v` | knots / mph / km/h / m/s |
| Wind gust | `10fg` (max previous 1 h to +90 h, previous 6 h after +144 h), `10fg3` (previous 3 h, +93…+144 h) | none at +0 h |
| Temperature (2 m) | `2t` | °F (default) or °C |
| Precipitation | `tp` (accumulated from run start) | 3 h (only to +144 h), 6 h (from +6 h), 24 h (from +24 h) totals by differencing, or total since run start. 1 h isn't possible: ECMWF's free data is 3-hourly at best. Inches (default) or mm |
| Isobars (overlay) | `msl` | every 4 hPa, labelled, with H/L centres; can be combined with any colour layer |

### How the data is stored (size)

For every run and step there are three small PNG images where the colour channels hold
8-bit scaled values: `wind_XXX.png` (u, v, gust), `met_XXX.png` (temperature, pressure,
precip since run start) and `pcp_XXX.png` (3/6/24 h precip, loaded only when the precip
layer is on). There is also `isobars_XXX.json` (contour lines and H/L, compact encoding).

- The **newest run** is published at full 0.25° resolution.
- The **4 older runs** are published at 0.5° (every other grid point) to keep the site
  well under GitHub Pages' 1 GB limit.

Built runs are stored in the GitHub Actions cache (one cache entry per run), so each
6-hourly job only downloads the run that is new.

## Live website

Hosted free on GitHub Pages: https://jonathanp777.github.io/ecmwf-wind/

The workflow in `.github/workflows/deploy.yml` runs every 6 hours (01:30, 07:30,
13:30, 19:30 UTC), on every push to `main`, and on demand (Actions tab ->
"Run workflow"). It runs `update_data.py` to download the newest ECMWF run and
publishes the site with the fresh `data/` folder. Forecast data is never
committed to git.

## Credits / licences

- Forecast data: © ECMWF, open data, licence CC BY 4.0 (attribution required, shown on the map).
- Basemap: Esri Dark Gray Canvas (free with attribution); OpenStreetMap selectable.
  (CARTO's free dark basemap now needs an API key, so it isn't used.)
- Coastlines/borders: Natural Earth (public domain). Map library: Leaflet.

## Known limitations of this prototype

- Wind values are stored with 8-bit precision (about 0.1–0.3 m/s steps): fine for display.
- Only 10 m wind for now; temperature, pressure, gusts, etc. can be added the same way.
- Particles pause while you drag/zoom and restart when you stop.
- Coastline lines don't repeat when you scroll past the date line onto a second copy of the world.
