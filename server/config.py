"""Environment for the poller. Values come from the process environment or server/.env."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = Path(__file__).resolve().parent
STOPS_PATH = SERVER / "stops.json"
LINES_PATH = ROOT / "src" / "data" / "lines.json"


def load_env() -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(SERVER / ".env")


def require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"missing environment variable {name} (see server/.env.example)")
    return value


def optional(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def line_filter() -> set[str] | None:
    """None means every line in stops.json."""
    raw = optional("LINES")
    if not raw:
        return None
    return {part.strip().upper() for part in raw.split(",") if part.strip()}


def poll_seconds() -> int:
    raw = optional("POLL_SECONDS", "30")
    try:
        seconds = int(raw)
    except ValueError:
        raise SystemExit(f"POLL_SECONDS must be an integer, got {raw!r}")
    if seconds < 10:
        raise SystemExit("POLL_SECONDS must be at least 10")
    return seconds
