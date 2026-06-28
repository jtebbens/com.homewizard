#!/usr/bin/env python3
"""
EDR GHI vs OM GHI logger — prerequisite for edr_ghi_ratio validator.

Every 15 min: fetch EDR qg (W/m²) from nearest KNMI station + OM shortwave_radiation
forecast for the current hour. Append to edr_ghi_log.csv.

After ~1 week of data: compute median(edr_qg / om_ghi) per hour to judge whether
the ratio is a stable signal (target: <0.7 = OM overschat, >1.3 = OM onderschat).

Env: KNMI_EDR_KEY (required), LAT, LON, OUTDIR
"""
import os, json, csv, math, time, urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

EDR_KEY = os.environ.get("KNMI_EDR_KEY")
LAT     = float(os.environ.get("LAT", "52.02"))
LON     = float(os.environ.get("LON", "5.04"))
OUT     = os.environ.get("OUTDIR", "/var/www/api")
LOG     = os.path.join(OUT, "edr_ghi_log.csv")
STATION_CACHE = "/tmp/edr_station_cache.json"
STATION_TTL   = 86400  # refresh daily

EDR_BASE = "https://api.dataplatform.knmi.nl/edr/v1/collections/10-minute-in-situ-meteorological-observations"

COLS = ["t_utc", "station", "dist_km", "edr_qg_wm2", "om_ghi_wm2", "sun_elev"]


def log(*a):
    print(datetime.now(timezone.utc).isoformat(timespec="seconds"), *a, flush=True)


def solar_elevation(lat, lon, when):
    n = (when - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0
    g = math.radians((357.529 + 0.98560028 * n) % 360)
    q = (280.459 + 0.98564736 * n) % 360
    L = math.radians((q + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) % 360)
    e = math.radians(23.439 - 3.6e-7 * n)
    ra = math.atan2(math.cos(e) * math.sin(L), math.cos(L))
    dec = math.asin(math.sin(e) * math.sin(L))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    lst = math.radians((gmst * 15 + lon) % 360)
    ha = lst - ra
    la = math.radians(lat)
    return math.degrees(math.asin(math.sin(la) * math.sin(dec) +
                                  math.cos(la) * math.cos(dec) * math.cos(ha)))


def _load_station():
    """Return nearest station dict from cache or EDR API."""
    if os.path.exists(STATION_CACHE):
        try:
            with open(STATION_CACHE) as f:
                c = json.load(f)
            if time.time() - c.get("_ts", 0) < STATION_TTL:
                return c
        except Exception:
            pass

    url = f"{EDR_BASE}/locations?parameter-name=qg"
    req = urllib.request.Request(url, headers={"Authorization": EDR_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)

    stations = []
    for f in data.get("features", []):
        coords = f.get("geometry", {}).get("coordinates", [])
        if len(coords) >= 2:
            stations.append({"id": f["id"],
                              "name": f.get("properties", {}).get("name", ""),
                              "lon": coords[0], "lat": coords[1]})
    if not stations:
        raise RuntimeError("no stations with qg")

    best = min(stations, key=lambda s:
               (s["lat"] - LAT)**2 + ((s["lon"] - LON) * math.cos(math.radians(LAT)))**2)
    dlat = (best["lat"] - LAT) * 111.0
    dlon = (best["lon"] - LON) * 111.0 * math.cos(math.radians(LAT))
    best["dist_km"] = round(math.sqrt(dlat**2 + dlon**2), 1)
    best["_ts"] = time.time()

    with open(STATION_CACHE, "w") as f:
        json.dump(best, f)
    return best


def fetch_edr_qg(station):
    """Latest completed 10-min qg reading. Returns (t_utc_str, wm2) or None."""
    now = datetime.now(timezone.utc)
    t_end   = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    t_start = t_end - timedelta(minutes=30)
    dt_range = (f"{t_start.strftime('%Y-%m-%dT%H:%M:%SZ')}/"
                f"{t_end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    sid = quote(station["id"], safe="")
    url = f"{EDR_BASE}/locations/{sid}?parameter-name=qg&datetime={dt_range}"
    req = urllib.request.Request(url, headers={"Authorization": EDR_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)

    covs = data.get("coverages", [])
    if not covs:
        return None
    cov = covs[0]
    times = cov["domain"]["axes"]["t"]["values"]
    vals  = cov["ranges"]["qg"]["values"]
    for t, v in reversed(list(zip(times, vals))):
        if v is not None:
            return t, round(float(v), 1)
    return None


def fetch_om_ghi(dt_hour):
    """OM shortwave_radiation forecast for dt_hour (UTC). Returns W/m² or None."""
    date_str = dt_hour.strftime("%Y-%m-%d")
    hour_str = dt_hour.strftime("%Y-%m-%dT%H:00")
    url = (f"https://api.open-meteo.com/v1/forecast?"
           f"latitude={LAT}&longitude={LON}"
           f"&hourly=shortwave_radiation"
           f"&start_date={date_str}&end_date={date_str}"
           f"&timezone=UTC")
    with urllib.request.urlopen(url, timeout=10) as r:
        d = json.load(r)
    for t, v in zip(d["hourly"]["time"], d["hourly"]["shortwave_radiation"]):
        if t == hour_str:
            return round(float(v), 1) if v is not None else None
    return None


def main():
    if not EDR_KEY:
        log("ERROR: KNMI_EDR_KEY not set")
        raise SystemExit(1)

    now  = datetime.now(timezone.utc)
    elev = solar_elevation(LAT, LON, now)
    if elev < 3.0:
        log(f"sun_elev={elev:.1f}° — skip (night)")
        return

    try:
        station = _load_station()
    except Exception as e:
        log(f"station load failed: {e}")
        raise SystemExit(1)

    try:
        edr = fetch_edr_qg(station)
    except Exception as e:
        log(f"EDR qg fetch failed: {e}")
        edr = None

    try:
        dt_hour = now.replace(minute=0, second=0, microsecond=0)
        om_ghi = fetch_om_ghi(dt_hour)
    except Exception as e:
        log(f"OM GHI fetch failed: {e}")
        om_ghi = None

    if edr is None and om_ghi is None:
        log("both fetches failed — skip")
        return

    t_utc, edr_qg = edr if edr else (now.strftime("%Y-%m-%dT%H:%M:%SZ"), None)

    row = {
        "t_utc":      t_utc,
        "station":    station["name"],
        "dist_km":    station["dist_km"],
        "edr_qg_wm2": edr_qg,
        "om_ghi_wm2": om_ghi,
        "sun_elev":   round(elev, 1),
    }

    write_header = not os.path.exists(LOG) or os.path.getsize(LOG) == 0
    with open(LOG, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        if write_header:
            w.writeheader()
        w.writerow(row)

    ratio = round(edr_qg / om_ghi, 3) if edr_qg and om_ghi and om_ghi > 10 else None
    log(f"station={station['name']} dist={station['dist_km']}km "
        f"edr={edr_qg} om={om_ghi} ratio={ratio} elev={elev:.1f}°")


if __name__ == "__main__":
    main()
