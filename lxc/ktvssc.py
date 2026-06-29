#!/usr/bin/env python3
"""ktvssc.py — compare NEIGH=1 sat GHI (log.csv) vs measured panel power (Homey Insights).
Usage: ssh jeroen@10.0.0.6 cat /var/www/api/log.csv | python3 ktvssc.py
"""
import sys, csv
from collections import defaultdict
from datetime import datetime, timezone

# Panel power from Homey Insights Solar logic variable (hourly UTC averages, W)
PANEL = {
    "2026-06-23T06": 1404.62, "2026-06-23T07": 2272.22, "2026-06-23T08": 1983.82,
    "2026-06-23T09": 2495.40, "2026-06-23T10": 2275.65, "2026-06-23T11": 2649.29,
    "2026-06-23T12": 2360.57, "2026-06-23T13": 1940.77, "2026-06-23T14": 1387.93,
    "2026-06-23T15":  664.77, "2026-06-23T16":  230.44, "2026-06-23T17":  144.86,
    "2026-06-24T06": 1616.22, "2026-06-24T07": 2141.22, "2026-06-24T08": 2527.36,
    "2026-06-24T09": 2707.70, "2026-06-24T10": 2738.12, "2026-06-24T11": 2606.40,
    "2026-06-24T12": 2301.33, "2026-06-24T13": 1869.10, "2026-06-24T14": 1302.69,
    "2026-06-24T15":  653.00, "2026-06-24T16":  205.52, "2026-06-24T17":  130.03,
    "2026-06-25T06": 1585.57, "2026-06-25T07": 2157.72, "2026-06-25T08": 2520.41,
    "2026-06-25T09": 2739.73, "2026-06-25T10": 2738.68, "2026-06-25T11": 2592.31,
    "2026-06-25T12": 2296.14, "2026-06-25T13": 1864.40, "2026-06-25T14": 1302.16,
    "2026-06-25T15":  666.06, "2026-06-25T16":  223.96, "2026-06-25T17":  147.00,
    "2026-06-26T06": 1405.31, "2026-06-26T07": 2186.79, "2026-06-26T08": 2570.23,
    "2026-06-26T09": 2765.74, "2026-06-26T10": 2545.13, "2026-06-26T11": 2577.40,
    "2026-06-26T12": 2330.42, "2026-06-26T13": 1732.92, "2026-06-26T14": 1304.53,
    "2026-06-26T15":  645.00, "2026-06-26T16":  228.43, "2026-06-26T17":  151.12,
    "2026-06-27T06": 1516.42, "2026-06-27T07": 2000.16, "2026-06-27T08": 1646.97,
    "2026-06-27T09": 1640.24, "2026-06-27T10": 1942.80, "2026-06-27T11": 1902.84,
    "2026-06-27T12": 2060.27, "2026-06-27T13": 1584.15, "2026-06-27T14": 1186.68,
    "2026-06-27T15":  864.40, "2026-06-27T16":  349.29, "2026-06-27T17":  170.24,
    "2026-06-28T06": 1686.38, "2026-06-28T07": 2207.15, "2026-06-28T08": 2581.51,
    "2026-06-28T09": 2859.75, "2026-06-28T10": 2828.19, "2026-06-28T11": 2066.81,
    "2026-06-28T12": 1757.65, "2026-06-28T13": 1382.84, "2026-06-28T14": 1036.77,
    "2026-06-28T15":  801.42, "2026-06-28T16":  396.21, "2026-06-28T17":  157.93,
    "2026-06-29T04":   67.0,  "2026-06-29T05":  450.0,  "2026-06-29T06":  841.24,
}

SAT_YF = {
    4: 2.553, 5: 4.815, 6: 5.288, 7: 4.711, 8: 4.204, 9: 3.806,
    10: 3.640, 11: 3.112, 12: 2.790, 13: 2.477, 14: 1.881, 15: 1.302,
    16: 1.037, 17: 0.707, 18: 1.001,
}

# Aggregate 15-min sat GHI → hourly buckets
sat_wm2   = defaultdict(list)
sat_sstd  = defaultdict(list)

reader = csv.DictReader(sys.stdin)
for row in reader:
    try:
        t = row['valid_t'].strip()
        dt = datetime.fromisoformat(t).astimezone(timezone.utc)
        key = f"{dt.strftime('%Y-%m-%d')}T{dt.strftime('%H')}"
        w = float(row['wm2'])
        s = float(row['wm2_sstd']) if row['wm2_sstd'].strip() else 0.0
        sat_wm2[key].append(w)
        sat_sstd[key].append(s)
    except Exception:
        pass

# Join and report
print(f"{'Date-H':15s} {'SatGHI':>7s} {'sstd':>6s} {'PanelW':>7s} {'YF_obs':>7s} {'YF_tab':>7s} {'PredW':>7s} {'ErrW':>6s} {'Err%':>5s}")
print('-' * 80)

abs_errors = []
daily = defaultdict(list)
hr_obs   = defaultdict(list)
hr_pred  = defaultdict(list)

for key in sorted(PANEL):
    if key not in sat_wm2:
        continue
    sat_ghi = sum(sat_wm2[key]) / len(sat_wm2[key])
    if sat_ghi < 50:
        continue
    panel_w = PANEL[key]
    if panel_w < 50:
        continue

    sstd     = sum(sat_sstd[key]) / len(sat_sstd[key])
    yf_obs   = panel_w / sat_ghi
    h        = int(key[11:13])
    yf_tab   = SAT_YF.get(h)
    pred_w   = sat_ghi * yf_tab if yf_tab is not None else None
    err_w    = (pred_w - panel_w) if pred_w is not None else float('nan')
    err_pct  = 100 * err_w / panel_w if pred_w is not None else float('nan')

    date = key[:10]
    print(f"{key:15s} {sat_ghi:7.0f} {sstd:6.1f} {panel_w:7.0f} {yf_obs:7.3f} {yf_tab or 0:7.3f} {pred_w or 0:7.0f} {err_w:6.0f} {err_pct:5.1f}%")

    if pred_w is not None:
        abs_errors.append(abs(err_w))
        daily[date].append((err_w, abs(err_w)))
        hr_obs[h].append(yf_obs)
        hr_pred[h].append(yf_tab)

print()
if abs_errors:
    mae = sum(abs_errors) / len(abs_errors)
    bias = sum(e for d in daily.values() for e, _ in d) / len(abs_errors)
    print(f"Overall  MAE={mae:.0f} W  bias={bias:+.0f} W  n={len(abs_errors)}")
    print()
    for d, rows in sorted(daily.items()):
        errs = [e for e, _ in rows]
        aes  = [a for _, a in rows]
        print(f"  {d}  MAE={sum(aes)/len(aes):.0f} W  bias={sum(errs)/len(errs):+.0f} W  n={len(rows)}")

print()
print(f"{'Hour':>4s} {'YF_obs_avg':>10s} {'YF_tab':>7s} {'Ratio':>6s}  (ratio=obs/tab, >1=underpredict)")
print('-' * 45)
for h in sorted(hr_obs):
    avg_obs = sum(hr_obs[h]) / len(hr_obs[h])
    tab     = SAT_YF.get(h, 0)
    ratio   = avg_obs / tab if tab else float('nan')
    print(f"  h={h:02d}  {avg_obs:10.3f}  {tab:7.3f}  {ratio:6.3f}")
