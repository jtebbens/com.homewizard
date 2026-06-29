#!/usr/bin/env python3
"""ktvssc.py — compare NEIGH=1 sat GHI (log.csv) vs measured panel power (Homey Insights).
Usage: ssh jeroen@10.0.0.6 cat /var/www/api/log.csv | python3 lxc/ktvssc.py
Source: SDM230 device dfa15233 energy_power (1:1 with PV inverter), hourly UTC averages W.
"""
import sys, csv
from collections import defaultdict
from datetime import datetime, timezone

# Panel power from SDM230 (dfa15233:energy_power), hourly UTC averages in W
PANEL = {
    "2026-06-23T04":   39.51, "2026-06-23T05":  292.86,
    "2026-06-23T06": 1670.33, "2026-06-23T07": 2244.70, "2026-06-23T08": 2099.62,
    "2026-06-23T09": 2707.22, "2026-06-23T10": 2507.58, "2026-06-23T11": 2631.40,
    "2026-06-23T12": 2325.65, "2026-06-23T13": 1896.59, "2026-06-23T14": 1320.31,
    "2026-06-23T15":  618.14, "2026-06-23T16":  214.70, "2026-06-23T17":  140.45,
    "2026-06-24T04":  253.92, "2026-06-24T05":  976.52,
    "2026-06-24T06": 1666.23, "2026-06-24T07": 2213.49, "2026-06-24T08": 2554.08,
    "2026-06-24T09": 2720.71, "2026-06-24T10": 2732.21, "2026-06-24T11": 2584.26,
    "2026-06-24T12": 2271.55, "2026-06-24T13": 1822.11, "2026-06-24T14": 1250.32,
    "2026-06-24T15":  601.79, "2026-06-24T16":  191.97, "2026-06-24T17":  132.54,
    "2026-06-25T04":  241.65, "2026-06-25T05":  945.31,
    "2026-06-25T06": 1636.63, "2026-06-25T07": 2193.71, "2026-06-25T08": 2549.93,
    "2026-06-25T09": 2746.81, "2026-06-25T10": 2734.23, "2026-06-25T11": 2573.41,
    "2026-06-25T12": 2270.16, "2026-06-25T13": 1818.11, "2026-06-25T14": 1243.47,
    "2026-06-25T15":  616.65, "2026-06-25T16":  209.44, "2026-06-25T17":  142.63,
    "2026-06-26T04":  204.41, "2026-06-26T05":  848.94,
    "2026-06-26T06": 1441.29, "2026-06-26T07": 2250.84, "2026-06-26T08": 2583.74,
    "2026-06-26T09": 2768.05, "2026-06-26T10": 2529.96, "2026-06-26T11": 2566.51,
    "2026-06-26T12": 2247.52, "2026-06-26T13": 1729.23, "2026-06-26T14": 1227.01,
    "2026-06-26T15":  608.98, "2026-06-26T16":  216.19, "2026-06-26T17":  147.10,
    "2026-06-27T04":  258.31, "2026-06-27T05":  979.00,
    "2026-06-27T06": 1538.18, "2026-06-27T07": 2055.51, "2026-06-27T08": 1671.17,
    "2026-06-27T09": 1605.85, "2026-06-27T10": 1998.29, "2026-06-27T11": 1811.78,
    "2026-06-27T12": 2105.65, "2026-06-27T13": 1551.82, "2026-06-27T14": 1179.37,
    "2026-06-27T15":  785.65, "2026-06-27T16":  307.34, "2026-06-27T17":  163.18,
    "2026-06-28T04":  168.42, "2026-06-28T05": 1002.38,
    "2026-06-28T06": 1732.58, "2026-06-28T07": 2248.11, "2026-06-28T08": 2600.92,
    "2026-06-28T09": 2691.73, "2026-06-28T10": 2808.63, "2026-06-28T11": 1762.89,
    "2026-06-28T12": 1849.49, "2026-06-28T13": 1246.99, "2026-06-28T14": 1010.11,
    "2026-06-28T15":  795.73, "2026-06-28T16":  359.33, "2026-06-28T17":  148.56,
    "2026-06-29T04":   60.64, "2026-06-29T05":  506.97, "2026-06-29T06": 1316.60,
}

# Must match SAT_YIELD_FACTORS in weather-forecaster.js
SAT_YF = {
    4: 2.553, 5: 4.815, 6: 5.288, 7: 4.711, 8: 4.204, 9: 3.806,
    10: 3.640, 11: 3.112, 12: 2.790, 13: 2.477, 14: 1.881, 15: 1.121,
    16: 0.498, 17: 0.496, 18: 1.001,
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
