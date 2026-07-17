#!/usr/bin/env python3
"""Preprocess the raw GSOD April 25th export into per-year CSVs.

Reads april25_gsod.csv (usaf,wban,lat,lon,year,temp,total_precip_inches),
joins station names from NOAA's isd-history.csv (downloaded on first run),
cleans bad rows, dedupes coincident coordinates, and writes:

  data/<year>.csv      lat,lon,temp,precip,name
  data/manifest.json   {"minYear": ..., "maxYear": ..., "counts": {...}}

Run from the repo root: python3 scripts/preprocess.py
"""

import csv
import json
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "april25_gsod.csv"
ISD_HISTORY = Path(__file__).resolve().parent / "isd-history.csv"
ISD_URL = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
DATA_DIR = ROOT / "data"

TEMP_MIN, TEMP_MAX = -130.0, 140.0  # sanity bounds, degrees F


def fetch_isd_history():
    if ISD_HISTORY.exists():
        return
    print(f"downloading {ISD_URL} ...")
    urllib.request.urlretrieve(ISD_URL, ISD_HISTORY)


def load_station_names():
    names = {}
    with open(ISD_HISTORY, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            name = (row.get("STATION NAME") or "").strip()
            if name:
                names[(row["USAF"], row["WBAN"])] = name.title()
    return names


def main():
    fetch_isd_history()
    names = load_station_names()
    print(f"{len(names)} station names loaded")

    # year -> (lat, lon) -> list of (temp, precip, name)
    years = defaultdict(lambda: defaultdict(list))
    dropped = 0
    with open(SOURCE, newline="") as f:
        for row in csv.DictReader(f):
            lat, lon = float(row["lat"]), float(row["lon"])
            temp = float(row["temp"])
            precip = float(row["total_precip_inches"])
            if (
                (lat == 0.0 and lon == 0.0)
                or not (-90.0 <= lat <= 90.0)
                or not (-180.0 <= lon <= 180.0)
                or not (TEMP_MIN <= temp <= TEMP_MAX)
            ):
                dropped += 1
                continue
            key = (round(lat, 3), round(lon, 3))
            name = names.get(
                (row["usaf"], row["wban"]), f"Station {row['usaf']}"
            )
            years[row["year"]][key].append((temp, precip, name))
    print(f"{dropped} rows dropped")

    DATA_DIR.mkdir(exist_ok=True)
    counts = {}
    for year, cells in years.items():
        rows = []
        for (lat, lon), obs in cells.items():
            # average coincident stations (they break Delaunay triangulation)
            temp = sum(o[0] for o in obs) / len(obs)
            precip = sum(o[1] for o in obs) / len(obs)
            rows.append((lat, lon, temp, precip, obs[0][2]))
        rows.sort()
        with open(DATA_DIR / f"{year}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["lat", "lon", "temp", "precip", "name"])
            for lat, lon, temp, precip, name in rows:
                w.writerow([lat, lon, f"{temp:.1f}", f"{precip:.2f}", name])
        counts[year] = len(rows)

    year_nums = sorted(int(y) for y in counts)
    manifest = {
        "minYear": year_nums[0],
        "maxYear": year_nums[-1],
        "counts": {str(y): counts[str(y)] for y in year_nums},
    }
    with open(DATA_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"{len(counts)} years written, {year_nums[0]}-{year_nums[-1]}")


if __name__ == "__main__":
    main()
