#!/usr/bin/env bash
# Rebuilds vendor/lines/*.json (only needed if you want to change detail levels; the files are committed).
# Needs: curl, unzip, python3, mapshaper (npm i -g mapshaper). Sources are public domain.
set -euo pipefail
cd "$(dirname "$0")/.."; T=$(mktemp -d); OUT=vendor/lines; mkdir -p $OUT
ne() { curl -sSL -o $T/$2.zip https://naciscdn.org/naturalearth/$1/$2.zip && unzip -oq $T/$2.zip -d $T/$2; }
ne 10m/cultural ne_10m_admin_1_states_provinces; ne 50m/physical ne_50m_lakes; ne 50m/physical ne_50m_rivers_lake_centerlines
ne 10m/cultural ne_10m_populated_places_simple
curl -sSL -o $T/c.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip && unzip -oq $T/c.zip -d $T/c
# states/provinces: lines between provinces of the same country (country borders are a separate layer)
mapshaper $T/ne_10m_admin_1_states_provinces/*.shp -simplify 5% keep-shapes -innerlines where='A.adm0_a3 == B.adm0_a3' -o $T/a1.json format=geojson precision=0.01
mapshaper $T/c/*.shp -proj wgs84 -simplify 12% keep-shapes -innerlines where='A.STATEFP == B.STATEFP' -o $T/co.json format=geojson precision=0.001
mapshaper $T/ne_50m_lakes/*.shp -filter 'scalerank<=4' -lines -o $T/lk.json format=geojson precision=0.01
mapshaper $T/ne_50m_rivers_lake_centerlines/*.shp -o $T/rv.json format=geojson precision=0.01
mapshaper $T/ne_10m_populated_places_simple/*.shp -filter 'min_zoom<=6.1' -o $T/pp.json format=geojson
python3 tools/encode_lines.py $T/a1.json $OUT/admin1.json 100
python3 tools/encode_lines.py $T/co.json $OUT/us_counties.json 1000
python3 tools/encode_lines.py $T/lk.json $OUT/lakes.json 100
python3 tools/encode_lines.py $T/rv.json $OUT/rivers.json 100
python3 - "$T/pp.json" "$OUT/cities.json" <<'PY'
import json,sys
g=json.load(open(sys.argv[1]))
r=sorted(([f['properties']['name'],round(f['geometry']['coordinates'][1],2),round(f['geometry']['coordinates'][0],2),round(f['properties']['min_zoom'],1),f['properties']['pop_max']] for f in g['features']),key=lambda r:(r[3],-r[4]))
json.dump([x[:4] for x in r],open(sys.argv[2],'w'),separators=(',',':'),ensure_ascii=False)
PY
rm -rf $T
