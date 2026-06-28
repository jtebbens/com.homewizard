#!/usr/bin/env python3
"""
KNMI proxy: Homey app sends lat/lon, server returns satellite + ground-truth data.

Runs as systemd service on port 8601 (behind nginx reverse proxy).

Endpoints:
  GET /point?lat=52.02&lon=5.04
    → {"t":"...","cot":0.0,"cs_wm2":493.7,"sds_wm2":493.7}
    Satellite observation: cloud optical thickness + clear-sky + observed radiation.

  GET /qg?lat=52.02&lon=5.04
    → {"station":"Cabauw","dist_km":8.2,"qg":[{"t":"...","wm2":415},...],"ss":[...]}
    Ground-truth: 10-min global radiation + sunshine from nearest KNMI station.
    Returns last 3 hours by default; add &hours=N to change.

  GET /sat?lat=52.02&lon=5.04
    → {sat nowcast JSON from fetcher_ssi.py per-location file}
    Returns pre-computed satellite nowcast for the nearest 0.05° grid cell.
    503 if location not yet computed; auto-registers for next fetcher cycle.
"""
import os, json, math, time, urllib.request, re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
from datetime import datetime, timedelta, timezone
from threading import Lock

WCS_KEY = os.environ.get("KNMI_WCS_KEY") or os.environ.get("WCS_KEY")
EDR_KEY = os.environ.get("KNMI_EDR_KEY")
PORT = int(os.environ.get("PROXY_PORT", "8601"))

WCS = "https://api.dataplatform.knmi.nl/wms/adaguc-server"
EDR = "https://api.dataplatform.knmi.nl/edr/v1/collections/10-minute-in-situ-meteorological-observations"
DS = "msg_cpp_products"
LAYERS = {
    "cot": "atmosphere_optical_thickness_due_to_cloud",
    "cs":  "surface_downwelling_shortwave_flux_in_air_assuming_clear_sky",
    "sds": "surface_downwelling_shortwave_flux_in_air",
}

cache = {}
cache_lock = Lock()
CACHE_TTL = 600

_latest_time = {"t": None, "fetched": 0}
LATEST_TTL = 120

# Station list: cached on first qg request
_stations = {"list": None, "fetched": 0}
STATION_TTL = 86400  # refresh daily

# Per-location sat nowcast registration
LOC_FILE = '/var/www/api/sat_locations.json'
_loc_lock = Lock()


def snap(v, step=0.05):
    return round(round(v / step) * step, 3)


def _cache_get(key):
    with cache_lock:
        if key in cache:
            entry = cache[key]
            if time.time() - entry["_ts"] < CACHE_TTL:
                return {k: v for k, v in entry.items() if not k.startswith("_")}
    return None


def _cache_set(key, result):
    with cache_lock:
        cutoff = time.time() - CACHE_TTL * 3
        stale = [k for k, v in cache.items() if v["_ts"] < cutoff]
        for k in stale:
            del cache[k]
        cache[key] = {**result, "_ts": time.time()}


def _register_location(lat, lon):
    """Add lat/lon to sat_locations.json if not already present (thread-safe, idempotent)."""
    with _loc_lock:
        try:
            locs = json.load(open(LOC_FILE)) if os.path.exists(LOC_FILE) else []
        except Exception:
            locs = []
        if not any(abs(l['lat'] - lat) < 0.001 and abs(l['lon'] - lon) < 0.001 for l in locs):
            locs.append({'lat': lat, 'lon': lon})
            with open(LOC_FILE, 'w') as f:
                json.dump(locs, f)


# ── WCS (satellite) ──

def get_latest_time():
    now = time.time()
    if _latest_time["t"] and now - _latest_time["fetched"] < LATEST_TTL:
        return _latest_time["t"]
    url = (f"{WCS}?dataset={DS}&service=WCS&version=1.0.0"
           f"&request=DescribeCoverage&coverage={LAYERS['cot']}")
    req = urllib.request.Request(url, headers={"Authorization": WCS_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        xml = r.read().decode("utf-8")
    m = re.search(r"<gml:end>([^<]+)</gml:end>", xml)
    if m:
        _latest_time["t"] = m.group(1)
        _latest_time["fetched"] = now
    return _latest_time["t"]


def fetch_wcs_point(lat, lon, layer_key, time_str):
    layer = LAYERS[layer_key]
    bx, by = 1.0, 1.0
    bbox = f"{lon-bx},{lat-by},{lon+bx},{lat+by}"
    url = (f"{WCS}?dataset={DS}&service=WMS&version=1.1.1&request=GetFeatureInfo"
           f"&LAYERS={layer}&QUERY_LAYERS={layer}&SRS=EPSG:4326"
           f"&BBOX={bbox}&WIDTH=100&HEIGHT=100&X=50&Y=50"
           f"&INFO_FORMAT=application/json&time={time_str}")
    req = urllib.request.Request(url, headers={"Authorization": WCS_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    if data and "data" in data[0]:
        v = list(data[0]["data"].values())[0]
        return round(float(v), 1)
    return None


def get_point(lat, lon):
    slat, slon = snap(lat), snap(lon)
    t = get_latest_time()
    if not t:
        return None

    ck = f"wcs:{slat},{slon},{t}"
    hit = _cache_get(ck)
    if hit:
        return hit

    cot = fetch_wcs_point(slat, slon, "cot", t)
    cs = fetch_wcs_point(slat, slon, "cs", t)
    sds = fetch_wcs_point(slat, slon, "sds", t)
    result = {"t": t, "cot": cot, "cs_wm2": cs, "sds_wm2": sds}
    _cache_set(ck, result)
    return result


# ── EDR (ground-truth) ──

def _load_stations():
    now = time.time()
    if _stations["list"] and now - _stations["fetched"] < STATION_TTL:
        return _stations["list"]
    url = f"{EDR}/locations?parameter-name=qg"
    req = urllib.request.Request(url, headers={"Authorization": EDR_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    stations = []
    for f in data.get("features", []):
        coords = f.get("geometry", {}).get("coordinates", [])
        if len(coords) >= 2:
            stations.append({
                "id": f.get("id", ""),
                "name": f.get("properties", {}).get("name", ""),
                "lon": coords[0], "lat": coords[1],
            })
    _stations["list"] = stations
    _stations["fetched"] = now
    return stations


def _nearest_station(lat, lon):
    stations = _load_stations()
    if not stations:
        return None
    best = min(stations, key=lambda s:
        (s["lat"] - lat)**2 + ((s["lon"] - lon) * math.cos(math.radians(lat)))**2)
    dlat = (best["lat"] - lat) * 111.0
    dlon = (best["lon"] - lon) * 111.0 * math.cos(math.radians(lat))
    best["dist_km"] = round(math.sqrt(dlat**2 + dlon**2), 1)
    return best


def get_qg(lat, lon, hours=3):
    station = _nearest_station(lat, lon)
    if not station:
        return None

    now = datetime.now(timezone.utc)
    # Round to 10-min boundary
    t_end = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    t_start = t_end - timedelta(hours=hours)

    ck = f"edr:{station['id']},{t_start.strftime('%H%M')},{t_end.strftime('%H%M')}"
    hit = _cache_get(ck)
    if hit:
        return hit

    dt_range = f"{t_start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{t_end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    sid = quote(station["id"], safe="")
    url = f"{EDR}/locations/{sid}?parameter-name=qg,ss,dd,ff,ta,rh&datetime={dt_range}"
    req = urllib.request.Request(url, headers={"Authorization": EDR_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)

    covs = data.get("coverages", [])
    if not covs:
        return None
    cov = covs[0]
    times = cov["domain"]["axes"]["t"]["values"]
    ranges = cov.get("ranges", {})

    def _extract(param, unit_key="v"):
        vals = ranges.get(param, {}).get("values", [])
        if not vals:
            return None
        return [{"t": t, unit_key: round(float(v), 1) if v is not None else None}
                for t, v in zip(times, vals)]

    result = {
        "station": station["name"],
        "station_id": station["id"],
        "dist_km": station["dist_km"],
        "qg": _extract("qg", "wm2") or [],
    }
    for param, key in [("ss", "min"), ("dd", "deg"), ("ff", "ms"),
                        ("ta", "c"), ("rh", "pct")]:
        data = _extract(param, key)
        if data:
            result[param] = data

    _cache_set(ck, result)
    return result


# ── HTTP handler ──

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        try:
            lat = float(qs["lat"][0])
            lon = float(qs["lon"][0])
        except (KeyError, ValueError, IndexError):
            self.send_error(400, "lat and lon required")
            return

        if parsed.path == "/point":
            if not (-82 <= lat <= 82 and -80 <= lon <= 80):
                self.send_error(400, "lat/lon out of MSG coverage")
                return
            try:
                result = get_point(lat, lon)
            except Exception as e:
                self.send_error(502, str(e))
                return

        elif parsed.path == "/qg":
            if not EDR_KEY:
                self.send_error(503, "EDR key not configured")
                return
            hours = int(qs.get("hours", ["3"])[0])
            hours = max(1, min(hours, 48))
            try:
                result = get_qg(lat, lon, hours)
            except Exception as e:
                self.send_error(502, str(e))
                return

        elif parsed.path == "/sat":
            self._handle_sat(lat, lon)
            return

        else:
            self.send_error(404)
            return

        if result is None:
            self.send_error(503, "no data available")
            return

        body = json.dumps(result, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _handle_sat(self, lat, lon):
        slat = round(snap(lat), 2)
        slon = round(snap(lon), 2)
        ck = f"sat:{slat}:{slon}"

        hit = _cache_get(ck)
        if hit:
            body = json.dumps(hit, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "public, max-age=300")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
            return

        fpath = f"/var/www/msgcpp/{slat:.2f}_{slon:.2f}.json"
        if os.path.exists(fpath):
            with open(fpath) as f:
                data = json.load(f)
            _cache_set(ck, data)
            body = json.dumps(data, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "public, max-age=300")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            _register_location(slat, slon)
            body = b'{"error":"not_yet_available"}'
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        print(f"{ts} {args[0]}", flush=True)


def main():
    missing = []
    if not WCS_KEY: missing.append("KNMI_WCS_KEY")
    if not EDR_KEY: missing.append("KNMI_EDR_KEY")
    if missing:
        print(f"WARNING: {', '.join(missing)} not set — some endpoints disabled", flush=True)
    if not WCS_KEY and not EDR_KEY:
        print("ERROR: no API keys configured", flush=True)
        raise SystemExit(1)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"point-proxy listening on 127.0.0.1:{PORT} (WCS={'OK' if WCS_KEY else 'OFF'} EDR={'OK' if EDR_KEY else 'OFF'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
