"""Match each line's last stop to an NSmart station id and write server/stops.json.

Station ids come from the public line-details page, which embeds the city catalog.
Run from the repo root:

  python server/build_stops.py
"""

from __future__ import annotations

import json
import math
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import LINES_PATH, ROOT, STOPS_PATH
from loguru import logger

CATALOG_URL = "https://online.nsmart.rs/sr/chosen_line/line_details/21432"
CACHE = ROOT / "scratch" / "nsmart" / "catalog.html"
MAX_METRES = 120

STATION = re.compile(
    r'"id":(\d+),"name":"([^"]{0,160})","default_address":\{"address":"","address2":"","address3":"","full_address":"","coordinates":\{"latitude":([0-9.]+),"longitude":([0-9.]+)\}'
)


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    radius = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def decode_name(raw: str) -> str:
    # The page JSON is escaped twice, so "\u0160" arrives as "\\u0160".
    once = json.loads('"' + raw + '"')
    if "\\u" in once or "\\/" in once:
        return json.loads('"' + once + '"')
    return once


def catalog() -> list[dict]:
    if CACHE.exists():
        html = CACHE.read_text(encoding="utf-8")
        logger.info("using cached catalog {}", CACHE)
    else:
        request = urllib.request.Request(CATALOG_URL, headers={"User-Agent": "nsbus-server"})
        with urllib.request.urlopen(request, timeout=40) as response:
            html = response.read().decode("utf-8", "replace")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(html, encoding="utf-8")
        logger.info("downloaded catalog {} bytes", len(html))
    text = html.replace('\\"', '"')
    stations = []
    for uid, name, lat, lon in STATION.findall(text):
        stations.append(
            {
                "uid": int(uid),
                "name": decode_name(name),
                "point": (float(lat), float(lon)),
            }
        )
    if len(stations) < 100:
        raise SystemExit(f"catalog parse found only {len(stations)} stations")
    logger.info("catalog stations {}", len(stations))
    return stations


def last_stops() -> list[dict]:
    lines = json.loads(LINES_PATH.read_text(encoding="utf-8"))
    grouped: dict[tuple, dict] = {}
    for line in lines:
        stop = line["stops"][-1]
        key = (stop["name"], round(stop["lat"], 5), round(stop["lon"], 5))
        row = grouped.get(key)
        if row is None:
            row = {"name": stop["name"], "lat": stop["lat"], "lon": stop["lon"], "lines": []}
            grouped[key] = row
        row["lines"].append(line["id"])
    return list(grouped.values())


def nearest(stop: dict, stations: list[dict]) -> tuple[dict, float]:
    here = (stop["lat"], stop["lon"])
    station = min(stations, key=lambda item: metres(here, item["point"]))
    return station, metres(here, station["point"])


def main() -> None:
    logger.remove()
    logger.add(sys.stderr, format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<7} | {message}")
    stations = catalog()
    matched: dict[int, dict] = {}
    missing = []
    for stop in last_stops():
        station, distance = nearest(stop, stations)
        if distance > MAX_METRES:
            missing.append(f"{stop['name']} [{', '.join(stop['lines'])}]")
            logger.warning(
                "skipped {} lines={} nearest {} uid={} is {:.0f} m away",
                stop["name"],
                ",".join(stop["lines"]),
                station["name"],
                station["uid"],
                distance,
            )
            continue
        row = matched.get(station["uid"])
        if row is None:
            row = {
                "stationUid": station["uid"],
                "name": stop["name"],
                "nsmartName": station["name"],
                "lat": stop["lat"],
                "lon": stop["lon"],
                "lines": [],
            }
            matched[station["uid"]] = row
        row["lines"] = sorted(set(row["lines"]) | set(stop["lines"]))
        logger.info(
            "matched {} -> {} uid={} {:.0f} m lines={}",
            stop["name"],
            station["name"],
            station["uid"],
            distance,
            ",".join(stop["lines"]),
        )
    if not matched:
        raise SystemExit("no last stops matched")
    if missing:
        logger.warning("not in stops.json: {}", ", ".join(missing))
    stops = sorted(matched.values(), key=lambda stop: stop["name"])
    STOPS_PATH.write_text(json.dumps(stops, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info("wrote {} stops to {}", len(stops), STOPS_PATH)


if __name__ == "__main__":
    main()
