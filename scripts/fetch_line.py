"""Fetch one GSPNS line (route shape, stops, departures) into src/data/<code>.json.

Usage: python scripts/fetch_line.py 4A 7 "4*"
       <code> <mreza id>  <red-voznje option value>
"""

import json
import math
import re
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://www.gspns.rs"
UA = "nsbus-pet-project/0.1"
DAYS = {"workday": "R", "saturday": "S", "sunday": "N"}
# Corporate TLS interception makes verification fail; this is a public read-only site.
CTX = ssl._create_unverified_context()


def get(path: str, params: dict[str, str]) -> str:
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60, context=CTX) as resp:
        return resp.read().decode("utf-8")


def get_json(path: str, params: dict[str, str]):
    body = get(path, params)
    return json.loads(body[body.index("[") :])


def route_points(mreza_id: str) -> list[tuple[float, float]]:
    raw = get_json("/mreza-get-linija-tacke", {"linija": mreza_id})
    points = []
    for item in raw:
        item = item.strip()
        if not item:
            continue
        lat, lon = item.split(",")
        points.append((float(lat), float(lon)))
    return points


def route_stops(mreza_id: str) -> list[dict]:
    raw = get_json("/mreza-get-stajalista-tacke", {"linija": mreza_id})
    stops, seen = [], set()
    for item in raw:
        parts = item.split("|")
        key = (parts[2], parts[1])
        if key in seen:  # the feed repeats some stops
            continue
        seen.add(key)
        stops.append({"name": parts[3].title(), "lat": float(parts[2]), "lon": float(parts[1])})
    return stops


def departures(rv: str, valid_from: str, day: str, option: str) -> dict[str, list[str]]:
    html = get(
        "/red-voznje/ispis-polazaka",
        {"rv": rv, "vaziod": valid_from, "dan": day, "linija[]": option},
    )
    # Each direction is one <td>; inside it hours are <b>HH</b> and minutes <span>MM</span>.
    out = {}
    for name, cell in zip(("A", "B"), re.findall(r"<td[^>]*width='50%'>(.*?)</td>", html, re.S)):
        times, hour = [], None
        for tag, value in re.findall(r"<b>(\d{2})</b>|<span[^>]*>(\d{2})", cell):
            if tag:
                hour = tag
            elif hour is not None:
                times.append(f"{hour}:{value}")
        out[name] = times
    return out


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def order_along_route(stops: list[dict], points: list[tuple[float, float]]) -> list[dict]:
    """Sort stops by how far along the route shape their nearest shape point sits."""
    cumulative = [0.0]
    for i in range(1, len(points)):
        cumulative.append(cumulative[-1] + haversine(points[i - 1], points[i]))

    for stop in stops:
        here = (stop["lat"], stop["lon"])
        nearest = min(range(len(points)), key=lambda i: haversine(here, points[i]))
        stop["along"] = cumulative[nearest]

    return sorted(stops, key=lambda s: s["along"])


def main() -> None:
    code, mreza_id, option = sys.argv[1], sys.argv[2], sys.argv[3]
    direction = code[-1] if code[-1] in "AB" else "A"
    rv = "rvg"
    valid_from = "2026-09-01"

    points = route_points(mreza_id)
    if "--reverse" in sys.argv:
        points.reverse()
    stops = order_along_route(route_stops(mreza_id), points)

    times = {}
    for label, day in DAYS.items():
        times[label] = departures(rv, valid_from, day, option)[direction]

    total = stops[-1]["along"] - stops[0]["along"]
    line = {
        "id": code,
        "name": " – ".join([stops[0]["name"], stops[-1]["name"]]),
        "source": f"{BASE}/mreza + {BASE}/red-voznje/gradski",
        "tripSeconds": round(total / (18 * 1000 / 3600)),  # ~18 km/h average
        "shape": [[lat, lon] for lat, lon in points],
        "stops": [
            {
                "name": s["name"],
                "lat": s["lat"],
                "lon": s["lon"],
                "along": round(s["along"], 1),  # metres along the shape
            }
            for s in stops
        ],
        "departures": times,
    }

    out = Path(__file__).resolve().parents[1] / "src" / "data" / f"{code}.json"
    out.write_text(json.dumps(line, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{out.name}: {len(line['stops'])} stops, {len(points)} shape points, "
          f"{ {k: len(v) for k, v in times.items()} }")


if __name__ == "__main__":
    main()
