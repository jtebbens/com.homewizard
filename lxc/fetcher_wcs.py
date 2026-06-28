#!/usr/bin/env python3
"""
WCS observation fetcher: COT grid + KNMI clear-sky for motion tracking & kt calibration.

Fetches from KNMI Dataplatform WCS (msg_cpp_products) every 15 min:
  - Cloud Optical Thickness (COT) 15x15 grid — direct cloud structure for xcorr motion
  - Clear-sky SDS 15x15 grid — KNMI's own CS model (replaces Haurwitz for kt normalization)

Output: /var/www/api/wcs_log.jsonl  (one JSON object per fetch, ~2KB/line)
Each line: {"t": "...", "cot": [[15x15]], "cs": [[15x15]]}

Uses WCS aaigrid format — zero Python deps beyond stdlib.
Runs alongside fetcher_ssi.py (SSI forecast); this is observation-only.

Env:  WCS_KEY   (KNMI Dataplatform API key; falls back to MSGCPP_KEY)
      LAT, LON  (default IJsselstein 52.02, 5.04)
      OUTDIR    (default /var/www/msgcpp)
"""
import os, sys, json, math, urllib.request
from datetime import datetime, timezone

KEY = os.environ.get("KNMI_WCS_KEY") or os.environ.get("WCS_KEY")
LAT = float(os.environ.get("LAT", "52.02"))
LON = float(os.environ.get("LON", "5.04"))
OUT = os.environ.get("OUTDIR", "/var/www/msgcpp")
SIDE = 15
HALF = 0.75  # degrees half-width of bbox

WCS = "https://api.dataplatform.knmi.nl/wms/adaguc-server"
DS  = "msg_cpp_products"

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

def fetch_aaigrid(coverage, time_str):
    bbox = f"{LON-HALF},{LAT-HALF},{LON+HALF},{LAT+HALF}"
    url = (f"{WCS}?dataset={DS}&service=WCS&version=1.0.0&request=GetCoverage"
           f"&coverage={coverage}&CRS=EPSG:4326&BBOX={bbox}"
           f"&width={SIDE}&height={SIDE}&format=aaigrid&time={time_str}")
    req = urllib.request.Request(url, headers={"Authorization": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")

def parse_aaigrid(text):
    lines = text.strip().split("\n")
    nodata = None
    data_start = 0
    for i, line in enumerate(lines):
        if line.strip().startswith("NODATA"):
            nodata = float(line.split()[1])
            data_start = i + 1
            break
    grid = []
    for line in lines[data_start:]:
        row = []
        for v in line.split():
            f = float(v)
            row.append(round(f, 1) if nodata is None or abs(f - nodata) > 0.01 else None)
        grid.append(row)
    return grid

def latest_time():
    """Get the most recent available timestamp from WCS capabilities (time end)."""
    url = (f"{WCS}?dataset={DS}&service=WCS&version=1.0.0"
           f"&request=DescribeCoverage&coverage=atmosphere_optical_thickness_due_to_cloud")
    req = urllib.request.Request(url, headers={"Authorization": KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        xml = r.read().decode("utf-8")
    # <gml:end>2026-06-24T06:45:00Z</gml:end>
    import re
    m = re.search(r"<gml:end>([^<]+)</gml:end>", xml)
    return m.group(1) if m else None

def main():
    if not KEY:
        log("ERROR: WCS_KEY/MSGCPP_KEY not set"); sys.exit(1)

    now = datetime.now(timezone.utc)
    elev = solar_elevation(LAT, LON, now)
    if elev < 5:
        log(f"night (sun elev {elev:.1f}deg) — skip"); return

    t = latest_time()
    if not t:
        log("ERROR: could not get latest time from WCS"); sys.exit(1)

    log(f"fetching COT + CS for {t} ...")
    cot_raw = fetch_aaigrid("atmosphere_optical_thickness_due_to_cloud", t)
    cs_raw  = fetch_aaigrid("surface_downwelling_shortwave_flux_in_air_assuming_clear_sky", t)

    cot = parse_aaigrid(cot_raw)
    cs  = parse_aaigrid(cs_raw)

    # center pixel stats
    cy, cx = SIDE // 2, SIDE // 2
    cot_center = cot[cy][cx] if cot[cy][cx] is not None else 0
    cs_center  = cs[cy][cx]  if cs[cy][cx]  is not None else 0

    # COT stats
    flat = [v for row in cot for v in row if v is not None]
    cot_mean = sum(flat) / len(flat) if flat else 0
    cot_max  = max(flat) if flat else 0
    cot_nonzero = sum(1 for v in flat if v > 0)

    rec = {
        "t": t,
        "fetched": now.isoformat(timespec="seconds"),
        "sun_elev": round(elev, 1),
        "cot": cot,
        "cs": cs,
        "cot_center": cot_center,
        "cs_center": cs_center,
        "cot_mean": round(cot_mean, 1),
        "cot_max": round(cot_max, 1),
        "cot_cloudy_px": cot_nonzero,
    }

    outf = os.path.join(OUT, "wcs_log.jsonl")
    with open(outf, "a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    log(f"ok t={t} cot_center={cot_center} cs={cs_center:.0f}W/m² "
        f"cloud_px={cot_nonzero}/{SIDE*SIDE} cot_max={cot_max} sun={elev:.0f}°")

if __name__ == "__main__":
    main()
