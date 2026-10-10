"""Poll NSmart and serve the latest bus list.

Run from the repo root:

  python server/app.py

GET /health is open. GET /buses requires Authorization: Bearer <CLIENT_TOKEN>.
"""

from __future__ import annotations

import hmac
import json
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import STOPS_PATH, line_filter, load_env, optional, poll_seconds, require
from loguru import logger
from nsmart import fetch_announcement

snapshot_lock = threading.Lock()
snapshot: dict = {
    "ready": False,
    "updatedAt": None,
    "lines": [],
    "stops": {"ok": 0, "failed": 0},
    "buses": [],
}
previous_by_stop: dict[int, list[dict]] = {}


def setup_logging() -> None:
    logger.remove()
    logger.add(
        sys.stderr,
        level=optional("LOG_LEVEL", "INFO"),
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<7} | {message}",
        enqueue=True,
    )


def load_stops() -> list[dict]:
    if not STOPS_PATH.exists():
        raise SystemExit(f"missing {STOPS_PATH}. Run: python server/build_stops.py")
    stops = json.loads(STOPS_PATH.read_text(encoding="utf-8"))
    if not isinstance(stops, list) or not stops:
        raise SystemExit(f"{STOPS_PATH} has no stops")
    return stops


def stops_for(lines: set[str] | None, stops: list[dict]) -> list[dict]:
    known = {line for stop in stops for line in stop["lines"]}
    if lines is None:
        logger.info("tracking all {} lines", len(known))
        return stops
    unknown = sorted(lines - known)
    if unknown:
        logger.warning("LINES not in stops.json: {}", ", ".join(unknown))
    selected = [stop for stop in stops if lines & set(stop["lines"])]
    if not selected:
        raise SystemExit("LINES matched no stops")
    logger.info("tracking lines {}", ", ".join(sorted(lines & known)))
    return selected


def as_float(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


# Variants that share both polled stops with the plain direction.
DIRECTION_ALIASES = {
    "6AB": "6A",
    "5NA": "5B",
}


def line_number(line: str) -> str:
    number = []
    for ch in line:
        if not ch.isdigit():
            break
        number.append(ch)
    return "".join(number)


def direction_candidates(nsmart_line: str, stop_lines: list[str]) -> set[str]:
    """Local directions this stop can prove for an NSmart line number.

    "6" at Smederevska matches 6A and 6AB, which both squash to 6A.
    "6" at Filipa Višnjića matches only 6B.
    """
    number = line_number(nsmart_line.upper())
    if not number:
        return set()
    found = set()
    for line in stop_lines:
        if line_number(line) == number:
            found.add(DIRECTION_ALIASES.get(line, line))
    return found


def buses_from(rows: list, stop: dict) -> list[dict]:
    # NSmart line numbers are not our direction ids (a 5B terminus often reports "5").
    # The stop we asked narrows that number to a direction such as 5B or 6A.
    found = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        line = str(row.get("line_number") or "").strip().upper()
        seconds = row.get("seconds_left")
        seconds_left = seconds if isinstance(seconds, int) else None
        vehicles = row.get("vehicles") or []
        for vehicle in vehicles:
            if not isinstance(vehicle, dict):
                continue
            garage = str(vehicle.get("garageNo") or "").strip()
            lat = as_float(vehicle.get("lat"))
            lng = as_float(vehicle.get("lng"))
            if not garage or lat is None or lng is None:
                continue
            if not (44.7 <= lat <= 45.6 and 19.4 <= lng <= 20.5):
                logger.warning(
                    "drop garage={} line={} lat={} lng={} outside the city",
                    garage,
                    line,
                    lat,
                    lng,
                )
                continue
            found.append(
                {
                    "garageNo": garage,
                    "line": line,
                    "candidates": direction_candidates(line, stop["lines"]),
                    "lat": lat,
                    "lng": lng,
                    "secondsLeft": seconds_left,
                    "stopUid": stop["stationUid"],
                    "stopName": stop["name"],
                }
            )
    return found


def closer(left: dict, right: dict) -> dict:
    left_seconds = left["secondsLeft"]
    right_seconds = right["secondsLeft"]
    if left_seconds is None:
        return right
    if right_seconds is None or left_seconds <= right_seconds:
        return left
    return right


def dedupe(buses: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for bus in buses:
        group = grouped.get(bus["garageNo"])
        incoming = set(bus["candidates"])
        if group is None:
            grouped[bus["garageNo"]] = {"best": bus, "candidates": incoming}
            continue
        group["best"] = closer(group["best"], bus)
        if not incoming:
            continue
        if group["candidates"]:
            group["candidates"] &= incoming
        else:
            group["candidates"] = incoming
    merged = []
    dropped = len(buses) - len(grouped)
    for garage, group in grouped.items():
        best = group["best"]
        candidates = group["candidates"]
        line = next(iter(candidates)) if len(candidates) == 1 else best["line"]
        merged.append(
            {
                "garageNo": garage,
                "line": line,
                "lat": best["lat"],
                "lng": best["lng"],
                "secondsLeft": best["secondsLeft"],
                "stopUid": best["stopUid"],
                "stopName": best["stopName"],
            }
        )
    if dropped:
        logger.info("dropped {} duplicate garage records", dropped)
    return sorted(merged, key=lambda bus: (bus["line"], bus["garageNo"]))


def poll_once(stops: list[dict], lines: set[str] | None) -> None:
    started = time.perf_counter()
    ok = 0
    failed = 0
    collected: list[dict] = []
    for stop in stops:
        uid = int(stop["stationUid"])
        tracked = sorted(set(stop["lines"]) if lines is None else set(stop["lines"]) & lines)
        line_list = ",".join(tracked)
        request_started = time.perf_counter()
        try:
            rows = fetch_announcement(uid)
        except Exception as error:
            failed += 1
            logger.error(
                "nsmart stop={} lines={} uid={} failed after {}ms: {}",
                stop["name"],
                line_list,
                uid,
                int((time.perf_counter() - request_started) * 1000),
                error,
            )
            kept = previous_by_stop.get(uid)
            if kept is not None:
                logger.warning("keeping {} previous buses for {}", len(kept), stop["name"])
                collected.extend(kept)
            continue
        buses = buses_from(rows, stop)
        previous_by_stop[uid] = buses
        collected.extend(buses)
        ok += 1
        logger.info(
            "nsmart stop={} lines={} uid={} status=200 ms={} rows={} buses={}",
            stop["name"],
            line_list,
            uid,
            int((time.perf_counter() - request_started) * 1000),
            len(rows),
            len(buses),
        )

    if ok == 0:
        logger.error(
            "poll got no successful stops after {}ms; keeping the previous snapshot",
            int((time.perf_counter() - started) * 1000),
        )
        with snapshot_lock:
            snapshot["ready"] = False
            snapshot["stops"] = {"ok": 0, "failed": failed}
        return

    merged = dedupe(collected)
    seen = sorted({bus["line"] for bus in merged if bus["line"]})
    if seen:
        logger.info("nsmart lines {}", ", ".join(seen))
    body = {
        "ready": True,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lines": sorted(lines) if lines is not None else sorted({line for stop in stops for line in stop["lines"]}),
        "stops": {"ok": ok, "failed": failed},
        "buses": merged,
    }
    with snapshot_lock:
        snapshot.clear()
        snapshot.update(body)
    logger.info(
        "poll done ms={} stops_ok={} stops_failed={} buses={}",
        int((time.perf_counter() - started) * 1000),
        ok,
        failed,
        len(merged),
    )


def poll_loop(stops: list[dict], lines: set[str] | None, seconds: int) -> None:
    while True:
        started = time.perf_counter()
        try:
            poll_once(stops, lines)
        except Exception:
            logger.exception("poll failed")
        remaining = seconds - (time.perf_counter() - started)
        if remaining > 0:
            time.sleep(remaining)


def origin_allowed(origin: str | None, allowed: list[str]) -> bool:
    if not origin:
        return False
    if origin in allowed:
        return True
    parsed = urllib.parse.urlparse(origin)
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}


def authorized(header: str | None, token: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    got = header[7:].strip()
    if len(got) != len(token):
        return False
    return hmac.compare_digest(got, token)


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind the same port.
    allow_reuse_address = sys.platform != "win32"


class Handler(BaseHTTPRequestHandler):
    token = ""
    origins: list[str] = []

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_OPTIONS(self) -> None:
        started = time.perf_counter()
        self._send(204, b"")
        logger.info(
            "{} {} 204 {}ms",
            self.command,
            urllib.parse.urlparse(self.path).path,
            int((time.perf_counter() - started) * 1000),
        )

    def do_GET(self) -> None:
        started = time.perf_counter()
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"ok": True})
            self._logged(path, 200, started)
            return
        if path != "/buses":
            self._send_json(404, {"error": "not found"})
            self._logged(path, 404, started)
            return
        if not authorized(self.headers.get("Authorization"), self.token):
            self._send_json(401, {"error": "unauthorized"})
            logger.warning(
                "GET /buses 401 {}ms from {}",
                int((time.perf_counter() - started) * 1000),
                self.client_address[0],
            )
            return
        with snapshot_lock:
            body = json.loads(json.dumps(snapshot))
        self._send_json(200, body)
        logger.info(
            "GET /buses 200 {}ms buses={}",
            int((time.perf_counter() - started) * 1000),
            len(body["buses"]),
        )

    def _logged(self, path: str, status: int, started: float) -> None:
        logger.info(
            "GET {} {} {}ms",
            path,
            status,
            int((time.perf_counter() - started) * 1000),
        )

    def _send_json(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self._send(status, raw, "application/json; charset=utf-8")

    def _send(self, status: int, raw: bytes, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        request_origin = self.headers.get("Origin")
        if origin_allowed(request_origin, self.origins):
            self.send_header("Access-Control-Allow-Origin", request_origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    load_env()
    setup_logging()
    token = require("CLIENT_TOKEN")
    lines = line_filter()
    seconds = poll_seconds()
    host = optional("HOST", "127.0.0.1")
    port = int(optional("PORT", "8080"))
    stops = stops_for(lines, load_stops())

    Handler.token = token
    Handler.origins = [item.strip() for item in optional("CLIENT_ORIGIN").split(",") if item.strip()]
    threading.Thread(target=poll_loop, args=(stops, lines, seconds), daemon=True).start()

    server = Server((host, port), Handler)
    logger.info("listening on http://{}:{}/buses every {}s", host, port, seconds)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
