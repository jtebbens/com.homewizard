#!/usr/bin/env python3
"""
KNMI surface_solar_irradiance (pySTEPS satellite nowcast) point fetcher.

Replaces fetcher.py (which read the heavy msg_cpp_products NetCDF observation).
This pulls KNMI's ready-made 0-4h FORECAST instead: dataset surface_solar_irradiance
v1.0, ~30 MB GRIB2, variable ssrd (accumulated J/m^2, 16x15-min steps from issue).

Every run (15-min systemd timer): download the latest FCST GRIB2, extract the 16
accumulated ssrd values at one lat/lon with eccodes (grib_get -l), de-accumulate to a
0-4h W/m^2 curve (diff/900s), write latest.json (Homey app) + append log.csv (offline
skill validation vs the app's recorded actual-PV). Deletes the ~30 MB GRIB2 after.

Validated end-to-end 2026-06-16: 16 msgs, validityTime 15-min, de-accum matches the
live cloud-dip (570->549 W/m^2). vs SC: same class (pySTEPS ~ optical-flow), fresher
(15-min vs SC free-tier 10/day), free/unlimited.

v2 (2026-06-23): 11x11 advection grid, motion vector + upwind prediction per step.
Center mean/std still from 3x3 (denoising). Motion vector via cross-correlation of
consecutive frames. Upwind pixel at step 0 predicts center at step k (travel time).

v3 (2026-06-24): kt normalization uses KNMI clear-sky model via WCS instead of
Haurwitz 1945. Haurwitz overestimates CS by +32% at low sun, causing false spatial
gradient in kt that corrupted motion vectors. Falls back to Haurwitz if WCS unavailable.

v4 (2026-06-28): multi-location support. Reads /var/www/api/sat_locations.json,
writes per-location {lat:.2f}_{lon:.2f}.json + latest.json for first/canonical location.

v5 (2026-06-28): GRIB read once via eccodes Python (not grib_get subprocess per point).
All locations extracted from in-memory arrays; OM wind cached per 1° cell.
Scales to 60+ locations without deadlocking the 15-min timer.

Deps:  python3-eccodes (apt), eccodes CLI no longer needed for main path
Env:   MSGCPP_KEY  (required, KNMI Open Data API key)
       WCS_KEY     (optional, for KNMI WCS clear-sky; falls back to MSGCPP_KEY then Haurwitz)
       LAT, LON    (default IJsselstein 52.02, 5.04)
       OUTDIR      (default /var/www/msgcpp ; needs latest.json + log.csv writable)
"""
import os, sys, json, csv, tempfile, math, urllib.request, statistics, eccodes
from datetime import datetime, timedelta, timezone

API  = "https://api.dataplatform.knmi.nl/open-data/v1/datasets/surface_solar_irradiance/versions/1.0"
KEY  = os.environ.get("KNMI_OPENDATA_KEY") or os.environ.get("MSGCPP_KEY")
WCS_KEY = os.environ.get("KNMI_WCS_KEY") or os.environ.get("WCS_KEY")
LAT  = float(os.environ.get("LAT", "52.02"))
LON  = float(os.environ.get("LON", "5.04"))
OUT  = os.environ.get("OUTDIR", "/var/www/msgcpp")
GRB  = os.environ.get("GRB_FILE", "/tmp/ssi.grb2")
STEP = 900.0
DLL  = 0.05
CNEIGH = 1   # center denoising radius (3x3)
ANEIGH = 7   # advection radius (15x15 = ~84x51 km, covers ~30min upwind at 50km/h)
WCS_URL = "https://api.dataplatform.knmi.nl/wms/adaguc-server"
WCS_DS  = "msg_cpp_products"
ASIDE  = 2 * ANEIGH + 1  # 15
KM_LAT = DLL * 111.0
KM_LON = DLL * 111.0 * math.cos(math.radians(52.0))

LOC_FILE = '/var/www/api/sat_locations.json'

def log(*a): print(datetime.now(timezone.utc).isoformat(timespec="seconds"), *a, flush=True)


def _snap(v, step=0.05):
    return round(round(v / step) * step, 2)


def _load_locations():
    """Load per-location list from LOC_FILE; fallback to default LAT/LON."""
    try:
        with open(LOC_FILE) as f:
            return json.load(f)
    except Exception:
        return [{'lat': LAT, 'lon': LON}]


# ── GRIB reading ──

def read_grib_all(path):
    """Read all GRIB messages into memory using eccodes Python bindings.
    Returns list of message dicts with values arrays. One read per run, all locations share."""
    msgs = []
    with open(path, 'rb') as f:
        while True:
            msg = eccodes.codes_grib_new_from_file(f)
            if msg is None:
                break
            d = {
                'date':   str(eccodes.codes_get(msg, 'dataDate')),
                'time':   str(eccodes.codes_get(msg, 'dataTime')),
                'vtime':  str(eccodes.codes_get(msg, 'validityTime')),
                'lat1':   eccodes.codes_get(msg, 'latitudeOfFirstGridPointInDegrees'),
                'lon1':   eccodes.codes_get(msg, 'longitudeOfFirstGridPointInDegrees'),
                'dlat':   eccodes.codes_get(msg, 'jDirectionIncrementInDegrees'),
                'dlon':   eccodes.codes_get(msg, 'iDirectionIncrementInDegrees'),
                'ni':     eccodes.codes_get(msg, 'Ni'),
                'nj':     eccodes.codes_get(msg, 'Nj'),
                'values': eccodes.codes_get_values(msg),
            }
            eccodes.codes_release(msg)
            msgs.append(d)
    return msgs


def _norm_lon(lon, lon1):
    """Normalize lon into GRIB lon1 range (e.g. 349–391° for a grid starting at 349°)."""
    return lon + 360.0 if lon < lon1 else lon


def extract(msgs, lat, lon):
    """Extract ASIDE×ASIDE advection grid from pre-loaded GRIB messages.
    Returns (base, pixel_accums) — same format as old grib_get-based extract."""
    m0 = msgs[0]
    ni, nj = m0['ni'], m0['nj']
    lat1, lon1 = m0['lat1'], m0['lon1']
    dlat, dlon = m0['dlat'], m0['dlon']

    ci = round((lat - lat1) / dlat)
    cj = round((_norm_lon(lon, lon1) - lon1) / dlon)

    # Pre-compute flat indices for ASIDE×ASIDE grid, clamped to GRIB bounds
    indices = []
    for di in range(-ANEIGH, ANEIGH + 1):
        for dj in range(-ANEIGH, ANEIGH + 1):
            r = max(0, min(nj - 1, ci + di))
            c = max(0, min(ni - 1, cj + dj))
            indices.append(r * ni + c)

    pixel_accums = []
    for msg in msgs:
        vals = msg['values']
        pixel_accums.append([vals[idx] for idx in indices])

    base = [(msg['date'], msg['time'], msg['vtime'], pixel_accums[k][len(indices) // 2])
            for k, msg in enumerate(msgs)]
    return base, pixel_accums


# ── OM wind (cached per 1° cell) ──

_om_wind_cache = {}  # (hour_str, lat_1deg, lon_1deg) → result or None

def fetch_om_wind(issue_dt, lat, lon):
    """Fetch OM 80m wind for the issue hour. Cached per 1° cell — synoptic wind
    uniform across NL at this scale; reduces 60-location run from 60 to ~6 OM calls."""
    ck = (issue_dt.strftime("%Y-%m-%dT%H:00"), round(lat), round(lon))
    if ck in _om_wind_cache:
        return _om_wind_cache[ck]

    result = None
    try:
        date_str = issue_dt.strftime("%Y-%m-%d")
        hour_str = ck[0]
        clat, clon = ck[1], ck[2]
        url = (f"https://api.open-meteo.com/v1/forecast?"
               f"latitude={clat}&longitude={clon}"
               f"&hourly=wind_speed_80m,wind_direction_80m"
               f"&wind_speed_unit=kmh"
               f"&start_date={date_str}&end_date={date_str}"
               f"&timezone=UTC")
        with urllib.request.urlopen(url, timeout=10) as r:
            d = json.load(r)
        times = d["hourly"]["time"]
        speeds = d["hourly"]["wind_speed_80m"]
        dirs   = d["hourly"]["wind_direction_80m"]
        for i, t in enumerate(times):
            if t == hour_str:
                wd, ws = dirs[i], speeds[i]
                if ws is not None and wd is not None:
                    result = {"speed_kmh": ws, "from_deg": wd,
                              "cloud_dir_deg": (wd + 180) % 360}
                break
    except Exception as e:
        log(f"fetch_om_wind failed: {e}")

    _om_wind_cache[ck] = result
    return result


def api_get(url):
    req = urllib.request.Request(url, headers={"Authorization": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

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

def latest_file():
    j = api_get(f"{API}/files?maxKeys=1&orderBy=created&sorting=desc")
    return j["files"][0]["filename"]

def download(filename):
    url = api_get(f"{API}/files/{filename}/url")["temporaryDownloadUrl"]
    urllib.request.urlretrieve(url, GRB)
    return os.path.getsize(GRB)

def _center_indices():
    """Flat indices of center 3x3 sub-grid within ASIDE×ASIDE."""
    idx = []
    for i in range(ANEIGH - CNEIGH, ANEIGH + CNEIGH + 1):
        for j in range(ANEIGH - CNEIGH, ANEIGH + CNEIGH + 1):
            idx.append(i * ASIDE + j)
    return idx

def _deaccum_frames(pixel_accums):
    """De-accumulate all pixels → list of 2D frames (W/m²). Frame[k][i][j]."""
    npx = len(pixel_accums[0])
    prev = [0.0] * npx
    frames = []
    for k in range(len(pixel_accums)):
        flat = [max(0.0, (pixel_accums[k][p] - prev[p]) / STEP) for p in range(npx)]
        prev = list(pixel_accums[k])
        grid = [flat[i * ASIDE:(i + 1) * ASIDE] for i in range(ASIDE)]
        frames.append(grid)
    return frames

def build_curve(rows, pixel_accums):
    """Center 3x3 spatial mean + std per step (unchanged behavior)."""
    issue = datetime.strptime(rows[0][0] + rows[0][1].zfill(4), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    cidx = _center_indices()
    npx = len(pixel_accums[0])
    prev = [0.0] * npx
    curve = []
    for k in range(len(rows)):
        pw = [max(0.0, (pixel_accums[k][p] - prev[p]) / STEP) for p in range(npx)]
        prev = list(pixel_accums[k])
        cpw = [pw[i] for i in cidx]
        mean = sum(cpw) / len(cpw)
        var = sum((w - mean) ** 2 for w in cpw) / len(cpw)
        t = issue + timedelta(seconds=(k + 1) * STEP)
        curve.append({"t": t.isoformat(), "wm2": round(mean, 1), "wm2_sstd": round(var ** 0.5, 1)})
    return issue, curve

def _clear_sky_ghi(elev_deg):
    """Simplified clear-sky GHI from solar elevation (Haurwitz 1945). Fallback only."""
    if elev_deg <= 0:
        return 0.0
    sin_e = math.sin(math.radians(elev_deg))
    return 1098.0 * sin_e * math.exp(-0.057 / sin_e)

def _fetch_cs_grid(time_iso, lat, lon):
    """Fetch KNMI clear-sky 15x15 grid via WCS aaigrid for given lat/lon. Returns [[float]] or None."""
    if not WCS_KEY:
        return None
    half = ANEIGH * DLL + DLL / 2  # match GRIB bbox
    bbox = f"{lon-half},{lat-half},{lon+half},{lat+half}"
    url = (f"{WCS_URL}?dataset={WCS_DS}&service=WCS&version=1.0.0&request=GetCoverage"
           f"&coverage=surface_downwelling_shortwave_flux_in_air_assuming_clear_sky"
           f"&CRS=EPSG:4326&BBOX={bbox}&width={ASIDE}&height={ASIDE}"
           f"&format=aaigrid&time={time_iso}")
    try:
        req = urllib.request.Request(url, headers={"Authorization": WCS_KEY})
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read().decode("utf-8")
        grid = []
        for line in text.strip().split("\n"):
            if line[0].isalpha():  # header line
                continue
            grid.append([float(v) for v in line.split()])
        if len(grid) == ASIDE and all(len(row) == ASIDE for row in grid):
            return grid
    except Exception as e:
        log(f"WCS CS fetch failed: {e} — falling back to Haurwitz")
    return None

_cs_cache = {}  # (time_iso, lat, lon) -> grid or None (per run)

def _get_cs_grid(time_iso, lat, lon):
    """Get clear-sky grid, cached per timestamp+location within a run."""
    k = (time_iso, lat, lon)
    if k not in _cs_cache:
        _cs_cache[k] = _fetch_cs_grid(time_iso, lat, lon)
    return _cs_cache[k]

def _normalize_to_kt(frames, issue, lat, lon):
    """Normalize W/m² frames to clear-sky index kt. Removes sun-angle gradient.
    Uses KNMI WCS clear-sky model if available, falls back to Haurwitz."""
    kt_frames = []
    grid_lats = [lat + i * DLL for i in range(-ANEIGH, ANEIGH + 1)]
    grid_lons = [lon + j * DLL for j in range(-ANEIGH, ANEIGH + 1)]
    t0_round = issue.replace(minute=(issue.minute // 15) * 15, second=0, microsecond=0)
    cs_grid_shared = _get_cs_grid(t0_round.strftime("%Y-%m-%dT%H:%M:%SZ"), lat, lon)
    if cs_grid_shared:
        log(f"kt-norm: KNMI-CS grid (center={cs_grid_shared[ANEIGH][ANEIGH]:.0f}W/m²)")
    else:
        log("kt-norm: Haurwitz fallback")
    for k, frame in enumerate(frames):
        t = issue + timedelta(seconds=(k + 1) * STEP)
        kt_grid = []
        for i, row in enumerate(frame):
            kt_row = []
            for j, val in enumerate(row):
                if cs_grid_shared:
                    cs = cs_grid_shared[i][j]
                else:
                    elev = solar_elevation(grid_lats[i], grid_lons[j], t)
                    cs = _clear_sky_ghi(elev)
                kt_row.append(val / cs if cs > 30 else 0.0)
            kt_grid.append(kt_row)
        kt_frames.append(kt_grid)
    return kt_frames

def _xcorr_shift(fa, fb, max_s=4):
    """Find (dy, dx) maximizing correlation between shifted 2D frames."""
    best_r, best_dy, best_dx = -999, 0, 0
    s = ASIDE
    for dy in range(-max_s, max_s + 1):
        for dx in range(-max_s, max_s + 1):
            ya1, ya2 = max(0, -dy), min(s, s - dy)
            xa1, xa2 = max(0, -dx), min(s, s - dx)
            va, vb = [], []
            for yi, yj in zip(range(ya1, ya2), range(ya1 + dy, ya2 + dy)):
                for xi, xj in zip(range(xa1, xa2), range(xa1 + dx, xa2 + dx)):
                    va.append(fa[yi][xi])
                    vb.append(fb[yj][xj])
            if len(va) < 9:
                continue
            ma, mb = statistics.mean(va), statistics.mean(vb)
            cov = sum((a - ma) * (b - mb) for a, b in zip(va, vb)) / len(va)
            sa = (sum((a - ma) ** 2 for a in va) / len(va)) ** 0.5
            sb = (sum((b - mb) ** 2 for b in vb) / len(vb)) ** 0.5
            r = cov / (sa * sb) if sa > 0 and sb > 0 else 0
            if r > best_r:
                best_r, best_dy, best_dx = r, dy, dx
    return best_dy, best_dx, best_r

def _kt_has_signal(kt_frame, min_std=0.08):
    """Check if kt frame has enough spatial variability (clouds present)."""
    vals = [v for row in kt_frame for v in row if v > 0]
    if len(vals) < 50:
        return False
    m = sum(vals) / len(vals)
    std = (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5
    return std >= min_std

def compute_advection(frames, issue=None, om_wind=None, lat=None, lon=None):
    """Compute motion vector + upwind prediction from ASIDE×ASIDE de-accumulated frames."""
    c = ANEIGH
    _lat = lat if lat is not None else LAT
    _lon = lon if lon is not None else LON

    if om_wind and om_wind["speed_kmh"] > 0:
        cd_rad   = math.radians(om_wind["cloud_dir_deg"])
        speed    = om_wind["speed_kmh"]
        north_km = math.cos(cd_rad) * speed / 4
        east_km  = math.sin(cd_rad) * speed / 4
        mean_dy  = north_km / KM_LAT
        mean_dx  = east_km  / KM_LON
        dirn     = om_wind["cloud_dir_deg"]
        source   = "om_wind"
        xcorr_note = ""
    else:
        kt = _normalize_to_kt(frames, issue, _lat, _lon) if issue else frames
        vecs = []
        for k in range(1, len(kt)):
            flat_a = [v for row in frames[k - 1] for v in row]
            flat_b = [v for row in frames[k] for v in row]
            if max(flat_a) < 30 and max(flat_b) < 30:
                continue
            if not _kt_has_signal(kt[k - 1]) or not _kt_has_signal(kt[k]):
                continue
            dy, dx, corr = _xcorr_shift(kt[k - 1], kt[k])
            if corr > 0.3:
                vecs.append((dy, dx, corr))
        if len(vecs) < 3:
            return None, [None] * len(frames)
        sw = sum(v[2] for v in vecs)
        mean_dy = sum(v[0] * v[2] for v in vecs) / sw
        mean_dx = sum(v[1] * v[2] for v in vecs) / sw
        mean_corr = sw / len(vecs)
        speed = ((mean_dy * KM_LAT) ** 2 + (mean_dx * KM_LON) ** 2) ** 0.5 * 4
        dirn = math.degrees(math.atan2(mean_dx * KM_LON, mean_dy * KM_LAT)) % 360 if (abs(mean_dy) > 0.01 or abs(mean_dx) > 0.01) else 0
        source = "xcorr"
        xcorr_note = f"corr={mean_corr:.3f} n={len(vecs)}"

    upwind = []
    max_step = 0
    for k in range(len(frames)):
        if k == 0:
            upwind.append(round(frames[0][c][c], 1))
            continue
        ui = c - round(mean_dy * k)
        uj = c - round(mean_dx * k)
        if 0 <= ui < ASIDE and 0 <= uj < ASIDE:
            upwind.append(round(frames[0][ui][uj], 1))
            max_step = k
        else:
            upwind.append(None)

    motion = {
        "dy": round(mean_dy, 2), "dx": round(mean_dx, 2),
        "speed_kmh": round(speed, 0), "dir_deg": round(dirn, 0),
        "source": source,
        "max_upwind_min": max_step * 15,
    }
    if xcorr_note:
        motion["xcorr_note"] = xcorr_note
    return motion, upwind

def write_outputs(issue, curve, motion, upwind, lat, lon, write_latest=True):
    if solar_elevation(lat, lon, datetime.now(timezone.utc)) > 3 and all(p["wm2"] == 0 for p in curve):
        log(f"[{lat},{lon}] daylight all-zero curve — keeping previous output (bad upstream file)")
        return
    os.makedirs(OUT, exist_ok=True)

    if upwind:
        for k, p in enumerate(curve):
            if k < len(upwind) and upwind[k] is not None:
                p["upwind_wm2"] = upwind[k]

    rec = {"issue": issue.isoformat(), "lat": lat, "lon": lon,
           "fetched_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "curve": curve}
    if motion:
        rec["motion"] = motion

    body = json.dumps(rec)

    loc_path = os.path.join(OUT, f"{lat:.2f}_{lon:.2f}.json")
    fd, tmp = tempfile.mkstemp(dir=OUT)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(tmp, 0o644)
    os.replace(tmp, loc_path)

    if write_latest:
        fd2, tmp2 = tempfile.mkstemp(dir=OUT)
        with os.fdopen(fd2, "w") as f:
            f.write(body)
        os.chmod(tmp2, 0o644)
        os.replace(tmp2, os.path.join(OUT, "latest.json"))

    csvp = os.path.join(OUT, "log.csv")
    new = not os.path.exists(csvp)
    with open(csvp, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["fetched_utc", "issue", "valid_t", "lat", "lon", "wm2", "wm2_sstd",
                         "upwind_wm2", "motion_speed", "motion_dir"])
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        spd = motion["speed_kmh"] if motion else ""
        mdir = motion["dir_deg"] if motion else ""
        for k, p in enumerate(curve):
            uw = upwind[k] if upwind and k < len(upwind) else ""
            w.writerow([now, issue.isoformat(), p["t"], lat, lon,
                        p["wm2"], p.get("wm2_sstd", ""), uw, spd, mdir])

def main():
    dry = "--dry" in sys.argv
    if not dry and not KEY:
        log("ERROR: MSGCPP_KEY not set"); sys.exit(1)
    now = datetime.now(timezone.utc)
    elev = solar_elevation(LAT, LON, now)
    if not dry and elev < -1:
        log(f"night (sun elev {elev:.1f}deg) — skip"); return
    try:
        if dry:
            log(f"DRY-RUN extract from {GRB}")
        else:
            fn = latest_file()
            mb = download(fn) / 1e6

        msgs = read_grib_all(GRB)
        log(f"GRIB: {len(msgs)} msgs, grid {msgs[0]['ni']}×{msgs[0]['nj']}")

        locations = _load_locations()
        log(f"locations: {len(locations)}")
        first = True
        for loc in locations:
            lat = _snap(loc['lat'])
            lon = _snap(loc['lon'])
            try:
                rows, pixel_accums = extract(msgs, lat, lon)
                issue, curve = build_curve(rows, pixel_accums)
                frames = _deaccum_frames(pixel_accums)
                om_wind = fetch_om_wind(issue, lat, lon)
                if om_wind:
                    log(f"[{lat},{lon}] OM wind: {om_wind['speed_kmh']:.0f}km/h from {om_wind['from_deg']:.0f}° "
                        f"→ clouds {om_wind['cloud_dir_deg']:.0f}°")
                motion, upwind = compute_advection(frames, issue, om_wind=om_wind, lat=lat, lon=lon)
                if dry:
                    for k, p in enumerate(curve):
                        uw = upwind[k] if upwind and k < len(upwind) and upwind[k] is not None else "-"
                        print(f"  [{lat},{lon}] {p['t'][11:16]}  wm2={p['wm2']:7.1f}  sstd={p['wm2_sstd']:5.1f}  upwind={uw}")
                    if motion:
                        print(f"  [{lat},{lon}] motion: {motion['speed_kmh']:.0f}km/h dir={motion['dir_deg']:.0f}°")
                    log(f"DRY-RUN ok [{lat},{lon}]: {len(curve)} steps, {ASIDE}x{ASIDE} grid, "
                        f"peak={max(p['wm2'] for p in curve)}")
                    first = False
                    continue
                write_outputs(issue, curve, motion, upwind, lat, lon, write_latest=first)
                mv = f" vec={motion['speed_kmh']:.0f}km/h@{motion['dir_deg']:.0f}°" if motion else ""
                log(f"[{lat},{lon}] ok issue={issue:%H:%MZ} steps={len(curve)} "
                    f"now={curve[0]['wm2']} peak={max(p['wm2'] for p in curve)} sun={elev:.0f}deg{mv}")
            except Exception as e:
                import traceback; log(f"[{lat},{lon}] ERROR: {e}\n{traceback.format_exc()}")
            first = False
    finally:
        if not dry and os.path.exists(GRB):
            os.replace(GRB, GRB.replace(".grb2", "_last.grb2"))

if __name__ == "__main__":
    main()
