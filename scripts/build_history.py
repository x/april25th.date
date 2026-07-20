#!/usr/bin/env python3
"""Build the compact per-station history used by the click-a-cell chart.

data/history.bin layout (little-endian):
  uint32  station count
  uint16  first year (1930)
  uint16  year count (96)
  then per station:
    float32 lat, float32 lon
    int8 × yearCount  mean temp on April 25 (°F, rounded); -128 = no data

~104 bytes per station, ~2.3MB total. Run: python3 scripts/build_history.py
"""

import csv
import struct
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "april25_gsod.csv"
OUT = ROOT / "data" / "history.bin"

YEAR0 = 1930
YEARS = list(range(YEAR0, 2026))
TEMP_MIN, TEMP_MAX = -130.0, 140.0


def main():
    stations = {}
    with open(SOURCE, newline="") as f:
        for row in csv.DictReader(f):
            lat, lon = float(row["lat"]), float(row["lon"])
            temp = float(row["temp"])
            if (
                (lat == 0.0 and lon == 0.0)
                or not (-90.0 <= lat <= 90.0)
                or not (-180.0 <= lon <= 180.0)
                or not (TEMP_MIN <= temp <= TEMP_MAX)
            ):
                continue
            key = (row["usaf"], row["wban"])
            st = stations.setdefault(
                key, {"lat": lat, "lon": lon, "temps": defaultdict(list)}
            )
            st["temps"][int(row["year"])].append(temp)

    with open(OUT, "wb") as f:
        f.write(struct.pack("<IHH", len(stations), YEAR0, len(YEARS)))
        for st in stations.values():
            f.write(struct.pack("<ff", st["lat"], st["lon"]))
            row = bytearray()
            for y in YEARS:
                vals = st["temps"].get(y)
                if vals:
                    v = round(sum(vals) / len(vals))
                    row.append(max(-127, min(127, v)) & 0xFF)
                else:
                    row.append(0x80)  # -128 sentinel
            f.write(row)
    print(f"{OUT.name}: {len(stations)} stations, {OUT.stat().st_size / 1e6:.1f}MB")


if __name__ == "__main__":
    main()
