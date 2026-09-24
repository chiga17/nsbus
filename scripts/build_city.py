"""Build src/data/lines.json from a saved GSPNS timetable dump + mreža geometry.

Update timetable:
  1. Open http://www.gspns.rs/red-voznje/gradski
  2. Select all linija, click PRIKAŽI
  3. Save the ispis-polazaka Network response as src/data/red-voznje-resp.html
  4. python scripts/build_city.py
"""

from __future__ import annotations

import html as html_lib
import json
import math
import re
import ssl
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "data"
CACHE = ROOT / "scratch" / "mreza"
HTML_PATH = DATA / "red-voznje-resp.html"
OUT_PATH = DATA / "lines.json"

BASE = "http://www.gspns.rs"
UA = "nsbus-pet-project/0.1"
CTX = ssl._create_unverified_context()
SPEED_MPS = 18 * 1000 / 3600  # ~18 km/h


def get(path: str, params: dict[str, str] | None = None) -> str:
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as resp:
                return resp.read().decode("utf-8")
        except Exception as err:
            last_error = err
            time.sleep(1.5 * (attempt + 1))
    raise last_error  # type: ignore[misc]


def get_json(path: str, params: dict[str, str]):
    body = get(path, params)
    return json.loads(body[body.index("[") :])


ALIASES = [
    ("ZEL.STANICA", "ZELEZNICKA STANICA"),
    ("ZELE.STANICA", "ZELEZNICKA STANICA"),
    ("Z.STANICA", "ZELEZNICKA STANICA"),
    ("Z.STAN", "ZELEZNICKA STANICA"),
    ("N.NASELJE", "NOVO NASELJE"),
    ("F.PIJA", "FUTOSKA PIJACA"),
    ("LIMAN4", "LIMAN 4"),
    ("LIMAN IV", "LIMAN 4"),
    ("LIMAN I", "LIMAN 1"),
    ("AVIJATICAR.NASELJE", "AVIJATICARSKO NASELJE"),
    ("INDUST.ZONA", "INDUSTRIJSKA ZONA"),
    ("INDUSTR.ZONA", "INDUSTRIJSKA ZONA"),
    ("BIG TC", "BIG"),
]


def fold(text: str) -> str:
    text = text.replace("&quot;", " ").upper()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("Đ", "DJ")
    for src, dst in ALIASES:
        text = text.replace(src, dst)
    return re.sub(r"[^A-Z0-9]+", " ", text).strip()


def tokens(text: str) -> set[str]:
    stop = {"A", "B", "I", "IV", "O", "S", "DO", "OD", "ZA", "NS"}
    return {t for t in fold(text).split() if t not in stop and len(t) > 1}


def ends(text: str) -> tuple[str, str]:
    parts = [p for p in re.split(r"\s*-\s*", text) if fold(p)]
    if not parts:
        return "", ""
    first = [t for t in fold(parts[0]).split() if len(t) > 1]
    last = [t for t in fold(parts[-1]).split() if len(t) > 1]
    return (first[0] if first else "", last[0] if last else "")


def score(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    value = len(ta & tb) / len(ta | tb)
    ea, eb = ends(a), ends(b)
    if ea[0] and ea[0] == eb[0]:
        value += 0.3
    if ea[1] and ea[1] == eb[1]:
        value += 0.3
    if ea[0] and ea[0] == eb[1] and ea[1] == eb[0]:
        value -= 0.5
    return value


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def parse_times(cell: str) -> list[str]:
    times, hour = [], None
    for tag, minute in re.findall(r"<b>(\d{2})</b>|<span[^>]*>\s*(\d{2})", cell):
        if tag:
            hour = tag
        elif hour is not None:
            times.append(f"{hour}:{minute}")
    return times


def parse_timetable(html: str) -> list[dict]:
    blocks = re.split(r'<div class=table-title[^>]*>', html)[1:]
    out = []
    for block in blocks:
        title_m = re.search(r":\s*([^<]+)", block)
        if not title_m:
            continue
        title = html_lib.unescape(re.sub(r"\s+", " ", title_m.group(1)).strip())
        code, _, name = title.partition(" ")
        headers = re.findall(
            r"<th>\s*Смер\s*([AB])\s*:\s*(.*?)</th>",
            block,
            re.S,
        )
        cells = re.findall(r"<td[^>]*width='50%'>(.*?)</td>", block, re.S)
        directions = []
        for (smer, route), cell in zip(headers, cells):
            route = html_lib.unescape(re.sub(r"\s+", " ", route).strip())
            directions.append(
                {"smer": smer, "route": route, "times": parse_times(cell)}
            )
        out.append({"code": code, "name": name.strip(), "directions": directions})
    return out


def parse_mreza(html: str) -> list[dict]:
    rows = re.findall(
        r'<a id="(\d+)"[^>]*class="button-linija grad[^"]*"[^>]*title="([^"]*)"[^>]*>\s*(\S+)\s*</a>',
        html,
    )
    return [{"id": i, "title": t, "code": c} for i, t, c in rows]


def cached_json(name: str, path: str, params: dict[str, str]):
    CACHE.mkdir(parents=True, exist_ok=True)
    file = CACHE / name
    if file.exists():
        return json.loads(file.read_text(encoding="utf-8"))
    data = get_json(path, params)
    file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    time.sleep(0.15)
    return data


def route_points(mreza_id: str) -> list[list[float]]:
    raw = cached_json(f"{mreza_id}-shape.json", "/mreza-get-linija-tacke", {"linija": mreza_id})
    points = []
    for item in raw:
        item = item.strip()
        if not item or "," not in item:
            continue
        lat, lon = item.split(",")
        points.append([float(lat), float(lon)])
    return points


def route_stops(mreza_id: str) -> list[dict]:
    raw = cached_json(f"{mreza_id}-stops.json", "/mreza-get-stajalista-tacke", {"linija": mreza_id})
    stops, seen = [], set()
    for item in raw:
        parts = item.split("|")
        key = (parts[2], parts[1])
        if key in seen:
            continue
        seen.add(key)
        stops.append({"name": parts[3].title(), "lat": float(parts[2]), "lon": float(parts[1])})
    return stops


def order_along_route(stops: list[dict], points: list[list[float]]) -> list[dict]:
    pts = [(p[0], p[1]) for p in points]
    cumulative = [0.0]
    for i in range(1, len(pts)):
        cumulative.append(cumulative[-1] + haversine(pts[i - 1], pts[i]))
    for stop in stops:
        here = (stop["lat"], stop["lon"])
        nearest = min(range(len(pts)), key=lambda i: haversine(here, pts[i]))
        stop["along"] = round(cumulative[nearest], 1)
    return sorted(stops, key=lambda s: s["along"])


def orient(points: list[list[float]], stops: list[dict], route: str) -> tuple[list[list[float]], list[dict]]:
    """Reverse the shape if the timetable start terminus sits nearer the end."""
    start, end = ends(route)
    if not stops:
        return points, stops

    def mean_along(word: str) -> float | None:
        hits = [s for s in stops if word and word in fold(s["name"])]
        if not hits:
            return None
        return sum(s["along"] for s in hits) / len(hits)

    a0, a1 = mean_along(start), mean_along(end)
    should_reverse = False
    if a0 is not None and a1 is not None:
        should_reverse = a0 > a1
    elif a1 is not None:
        should_reverse = a1 < (stops[0]["along"] + stops[-1]["along"]) / 2
    elif a0 is not None:
        should_reverse = a0 > (stops[0]["along"] + stops[-1]["along"]) / 2

    if should_reverse:
        points = list(reversed(points))
        length = stops[-1]["along"]
        for s in stops:
            s["along"] = round(length - s["along"], 1)
        stops = sorted(stops, key=lambda s: s["along"])
    return points, stops


def pick_mreza(route: str, catalog: list[dict], used: set[str], code: str, smer: str) -> dict | None:
    unused = [row for row in catalog if row["code"] not in used]
    if not unused:
        return None
    by_code = {row["code"]: row for row in unused}
    if code in by_code:
        return by_code[code]
    if code[-1:] not in "AB" and f"{code}{smer}" in by_code:
        return by_code[f"{code}{smer}"]
    return max(unused, key=lambda row: score(route, row["title"]))


def build_line(code: str, name: str, route: str, times: list[str], mreza: dict) -> dict | None:
    points = route_points(mreza["id"])
    stops = order_along_route(route_stops(mreza["id"]), points)
    if len(points) < 2 or len(stops) < 2:
        print(f"  skip {code}: not enough geometry ({mreza['code']})")
        return None
    points, stops = orient(points, stops, route)
    length = max(s["along"] for s in stops) - min(s["along"] for s in stops)
    if length < 50:
        length = sum(
            haversine((points[i][0], points[i][1]), (points[i + 1][0], points[i + 1][1]))
            for i in range(len(points) - 1)
        )
    return {
        "id": code,
        "name": name,
        "route": route,
        "mrezaId": mreza["id"],
        "mrezaCode": mreza["code"],
        "source": "src/data/red-voznje-resp.html + gspns.rs/mreza",
        "tripSeconds": max(60, round(length / SPEED_MPS)),
        "shape": points,
        "stops": stops,
        "departures": {
            "workday": times,
            "saturday": times,
            "sunday": times,
        },
    }


def line_id(_timetable_code: str, _smer: str, mreza_code: str) -> str:
    return mreza_code


def main() -> None:
    html = HTML_PATH.read_text(encoding="utf-8")
    tables = parse_timetable(html)
    print(f"timetable blocks: {len(tables)}")

    mreza_path = ROOT / "scratch" / "mreza.html"
    if not mreza_path.exists():
        mreza_path.parent.mkdir(parents=True, exist_ok=True)
        mreza_path.write_text(get("/mreza"), encoding="utf-8")
    catalog = parse_mreza(mreza_path.read_text(encoding="utf-8"))
    print(f"mreža city routes: {len(catalog)}")

    lines = []
    used: set[str] = set()
    for table in tables:
        for direction in table["directions"]:
            mreza = pick_mreza(direction["route"], catalog, used, table["code"], direction["smer"])
            if not mreza:
                print(f"  no mreža match for {table['code']} {direction['smer']}")
                continue
            used.add(mreza["code"])
            lid = line_id(table["code"], direction["smer"], mreza["code"])
            print(f"{table['code']} {direction['smer']} → {mreza['code']} (id {mreza['id']}) as {lid}  {direction['route']}")
            built = build_line(
                lid,
                table["name"],
                direction["route"],
                direction["times"],
                mreza,
            )
            if built:
                lines.append(built)

    OUT_PATH.write_text(json.dumps(lines, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({len(lines)} directions)")


if __name__ == "__main__":
    main()
