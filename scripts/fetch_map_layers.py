#!/usr/bin/env python3
"""Fetch and slim the map layers used for borders and labels.

Downloads (build-time only, outputs are committed):
  world-atlas countries-50m + land-50m     -> data/ (as-is)
  Natural Earth admin-1 boundary lines     -> data/admin1-lines.json (stripped)
  Natural Earth admin-1 polygons           -> data/states.csv (name + centroid)
  Natural Earth populated places           -> data/cities.csv (name,lat,lon,pop,rank)

Run from the repo root: python3 scripts/fetch_map_layers.py
"""

import csv
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = Path(__file__).resolve().parent / "cache"

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
SOURCES = {
    "countries-50m.json": "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json",
    "admin1-lines-raw.json": f"{NE}/ne_50m_admin_1_states_provinces_lines.geojson",
    "admin1-polys-raw.json": f"{NE}/ne_50m_admin_1_states_provinces.geojson",
    "places-raw.json": f"{NE}/ne_10m_populated_places_simple.geojson",
}


def fetch(name):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"downloading {SOURCES[name]} ...")
        urllib.request.urlretrieve(SOURCES[name], path)
    return path


def round_coords(coords, nd=3):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    return [round_coords(c, nd) for c in coords]


def ring_centroid(ring):
    """Area-weighted centroid of a polygon ring (planar shoelace)."""
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-12:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a)


def main():
    # 1. world-atlas topojson, committed as-is (includes a merged land object)
    for name in ("countries-50m.json",):
        (DATA / name).write_bytes(fetch(name).read_bytes())
        print(f"data/{name} written")

    # 2. admin-1 boundary lines: strip properties, round coordinates
    raw = json.loads(fetch("admin1-lines-raw.json").read_text())
    feats = []
    for f in raw["features"]:
        feats.append(
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": f["geometry"]["type"],
                    "coordinates": round_coords(f["geometry"]["coordinates"]),
                },
            }
        )
    out = {"type": "FeatureCollection", "features": feats}
    with open(DATA / "admin1-lines.json", "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"data/admin1-lines.json written ({len(feats)} lines)")

    # 3. state/province label points: largest-ring centroid
    raw = json.loads(fetch("admin1-polys-raw.json").read_text())
    rows = []
    for f in raw["features"]:
        name = f["properties"].get("name") or ""
        if not name:
            continue
        g = f["geometry"]
        if g is None:
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        best = None
        for poly in polys:
            cx, cy, area = ring_centroid(poly[0])
            if best is None or area > best[2]:
                best = (cx, cy, area)
        rows.append((name, round(best[1], 3), round(best[0], 3)))
    with open(DATA / "states.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "lat", "lon"])
        w.writerows(rows)
    print(f"data/states.csv written ({len(rows)} states)")

    # 4. cities: name, lat, lon, population, scalerank
    raw = json.loads(fetch("places-raw.json").read_text())
    rows = []
    for f in raw["features"]:
        p = f["properties"]
        name = p.get("name") or ""
        if not name:
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        rows.append(
            (
                name,
                round(lat, 3),
                round(lon, 3),
                int(p.get("pop_max") or 0),
                int(p.get("scalerank") if p.get("scalerank") is not None else 10),
            )
        )
    rows.sort(key=lambda r: (r[4], -r[3]))
    with open(DATA / "cities.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "lat", "lon", "pop", "rank"])
        w.writerows(rows)
    print(f"data/cities.csv written ({len(rows)} cities)")


if __name__ == "__main__":
    main()
