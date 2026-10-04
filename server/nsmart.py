"""One announcement request. The auth header name and value stay in the environment."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from config import require

TIMEOUT_SECONDS = 15


def fetch_announcement(station_uid: int) -> list:
    url = require("NSMART_API_URL").format(station_uid=station_uid)
    header = require("NSMART_AUTH_HEADER")
    value = require("NSMART_AUTH_VALUE")
    request = urllib.request.Request(
        url,
        headers={
            header: value,
            "Accept": "application/json",
            "User-Agent": "nsbus-server",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read(180).decode("utf-8", "replace").strip()
        raise RuntimeError(f"HTTP {error.code} {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(str(error.reason)) from error

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"response was not JSON: {error}") from error
    if not isinstance(payload, list):
        raise RuntimeError(f"response was {type(payload).__name__}, expected a list")
    return payload
