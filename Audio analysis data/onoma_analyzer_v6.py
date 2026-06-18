#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
オノマトペ解析・詩的統合AI  v6（多様性最大化：種類＝チャンス）
==================================================
作者の方針：質感判定でオノマトペの「種類が多いほどチャンス（映像との接点・表現の幅）」。
  → 辞書764語の多様性を資源として、できるだけ多くの異なる語を各ファイルに割り当てる。

v5からの変更（多様性を増やすための核心）：
  - v5は距離計算で重みの大きい x2(突発)・x8(減衰) をファイル全体では中心値4.0に固定し、
    全ファイルが辞書空間の中央に引き寄せられて「うんうん」等に収束していた。
  - v6は x2/x8/x16 にファイル単位の実測値を投入：
      x2 ← onset_rate（47曲コーパス相対の突発密度）
      x8 ← スタッカート性（疎ら＋アタックの鋭さ）
      x16← 不規則性（トリガー間隔のばらつき＋flatness）
    これで高重み軸が散らばり、辞書の広い領域＝多くの異なる語に当たる。
  - 生成語（未開拓56語）も「種類＝チャンス」として既定で活用（除外したければ --no-generated）。
  profile（量/質/音色）と triggers は v5 を踏襲。
"""

import json, csv, math, argparse

DIST_AXES = {
    "x1": ("x1", 1.0), "x2": ("x2", 1.0), "x3": ("x3", 0.4), "x4": ("x4", 0.5),
    "x5": ("x5", 1.0), "x6": ("x6", 0.8), "x7": ("x7_norm", 1.0), "x8": ("x8", 1.0),
    "x9": ("x9_norm", 0.7), "x16": ("x16_regularity", 0.6),
}
AXIS_LABEL = {
    "x1": "Weight", "x2": "Time", "x3": "Space", "x4": "Flow", "x5": "Hardness",
    "x6": "Moisture", "x7": "Frequency", "x8": "Decay", "x9": "Reynolds", "x16": "Regularity",
}

def as_float(v, d=None):
    try: return float(v)
    except (TypeError, ValueError): return d

def load_dictionary(path):
    words = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            try:
                vec = {ax: float(row[col]) for ax, (col, _w) in DIST_AXES.items()}
            except (KeyError, ValueError):
                continue
            words.append({"word": row["word"], "vec": vec,
                          "generated": row.get("generated", "") == "True"})
    if not words:
        raise RuntimeError("辞書が空です: " + path)
    return words

def load_features(path):
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, list): return raw
    if isinstance(raw, dict):
        for key in ("tracks", "files", "items", "results"):
            if isinstance(raw.get(key), list): return raw[key]
        return [raw]
    raise RuntimeError("入力形式不明: " + path)

def _percentile(sorted_vals, p):
    if not sorted_vals: return 0.0
    if len(sorted_vals) == 1: return sorted_vals[0]
    idx = (len(sorted_vals) - 1) * (p / 100.0)
    lo, hi = int(math.floor(idx)), int(math.ceil(idx))
    if lo == hi: return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)

def _mean(xs): return sum(xs) / len(xs) if xs else 0.0
def _std(xs):
    if len(xs) < 2: return 0.0
    m = _mean(xs); return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))
def _clamp(v, a=0.0, b=9.0): return max(a, min(b, v))
def rel(v, lo, hi):
    if hi <= lo: return 0.0
    return max(0.0, min(1.0, (v - lo) / (hi - lo)))
def freq_to_9(hz, top=6000.0):
    return _clamp((math.log10(max(hz, 80)) - math.log10(80)) /
                  (math.log10(top) - math.log10(80)) * 9)

# ---------------------------------------------------------------------------
# ファイル署名（音色：無音除外・音量重み付け）
# ---------------------------------------------------------------------------
def file_signature(feat):
    ts = feat.get("time_series_1s") or []
    rms = [as_float(p.get("rms_intensity"), 0.0) or 0.0 for p in ts]
    fmax = max(rms) if rms else 0.0
    floor = fmax * 0.15
    wsum = cen = zc = fl = bw = ro = f0w = f0sum = 0.0
    active = 0
    for p, r in zip(ts, rms):
        if r < floor or r <= 0: continue
        active += 1; w = r; wsum += w
        cen += w * (as_float(p.get("spectral_centroid"), 0.0) or 0.0)
        zc  += w * (as_float(p.get("zero_crossing_rate"), 0.0) or 0.0)
        fl  += w * (as_float(p.get("spectral_flatness"), 0.0) or 0.0)
        bw  += w * (as_float(p.get("spectral_bandwidth"), 0.0) or 0.0)
        ro  += w * (as_float(p.get("spectral_rolloff"), 0.0) or 0.0)
        f0v = as_float(p.get("f0"), 0.0) or 0.0
        if f0v > 0: f0w += w; f0sum += w * f0v
    if wsum <= 0:
        ap = feat.get("acoustic_physics", {})
        return {"level": fmax, "bright": as_float(ap.get("spectral_centroid"), 2000.0),
                "zcr": as_float(ap.get("zero_crossing_rate"), 0.0),
                "flat": as_float(ap.get("spectral_flatness"), 0.0),
                "bw": as_float(ap.get("spectral_bandwidth"), 1500.0),
                "rolloff": as_float(ap.get("spectral_rolloff"), 3000.0),
                "f0": None, "active_ratio": 0.0, "dyn_range_db": 0.0}
    rmin = min([r for r in rms if r > 0] or [1e-6])
    st = feat.get("statistics", {}).get("rms_intensity", {})
    return {"level": as_float(st.get("p90"), fmax), "bright": cen / wsum,
            "zcr": zc / wsum, "flat": fl / wsum, "bw": bw / wsum, "rolloff": ro / wsum,
            "f0": (f0sum / f0w) if f0w > 0 else None,
            "active_ratio": active / len(rms) if rms else 0.0,
            "dyn_range_db": 20 * math.log10(fmax / rmin) if fmax > 0 and rmin > 0 else 0.0}

# ---------------------------------------------------------------------------
# 音色＋ファイル動態 → リッチな16軸ベクトル（多様性を散らす）
# ---------------------------------------------------------------------------
def signature_to_vec(sig, SB, DB, onset_rate, quality):
    """高重み軸(x2,x8)とx16にファイル単位の実値を入れて、辞書空間に広く散らす。"""
    level_r = rel(sig["level"], *SB["level"])
    zcr_r   = rel(sig["zcr"],   *SB["zcr"])
    flat_r  = rel(sig["flat"],  *SB["flat"])
    bw_r    = rel(sig["bw"],    *SB["bw"])
    onset_r = rel(onset_rate,   *DB["onset"])
    f_hz = sig["f0"] if sig["f0"] else sig["bright"]
    # スタッカート性：疎ら(active低)＋アタック鋭い → 遮断的(x8高)。連続ドローン → 持続(x8低)。
    staccato = (1 - sig["active_ratio"]) * 0.5 + quality["attack_sharpness_0_1"] * 0.5
    # 不規則性：トリガー間隔のばらつき(1-regularity)＋flatness
    irregular = (1 - quality["regularity_0_1"]) * 0.6 + flat_r * 0.4

    x1 = _clamp(level_r * 9)                                   # Weight ← 音量
    x2 = _clamp(onset_r * 9)                                   # Time ← onset密度（実値）
    x5 = _clamp((zcr_r * 0.6 + flat_r * 0.4) * 9)             # Hardness
    x6 = _clamp((1 - (zcr_r * 0.5 + flat_r * 0.5)) * 9)       # Moisture
    x7 = freq_to_9(f_hz, top=(3800.0 if sig["f0"] else 6000.0))  # Frequency
    x8 = _clamp(staccato * 9)                                  # Decay ← スタッカート性（実値）
    x9 = _clamp((flat_r * 0.6 + zcr_r * 0.4) * 9)            # Reynolds
    x16 = _clamp(irregular * 9)                               # Regularity ← 不規則性（実値）
    # x3 Space ← 帯域幅（広帯域=拡散/間接 低い、狭帯域=直接 高い）
    x3 = _clamp((1 - bw_r) * 9 * 0.6 + 2)
    # x4 Flow ← スタッカートなら抑制寄り
    x4 = _clamp(4 + (x8 - 4) * 0.5)
    return {"x1": x1, "x2": x2, "x3": x3, "x4": x4, "x5": x5,
            "x6": x6, "x7": x7, "x8": x8, "x9": x9, "x16": x16}

# ---------------------------------------------------------------------------
# 変化量（量）
# ---------------------------------------------------------------------------
def dynamism_raw(feat, sig):
    ts = feat.get("time_series_1s") or []
    rms = [as_float(p.get("rms_intensity"), 0.0) or 0.0 for p in ts]
    fmax = max(rms) if rms else 0.0
    if fmax <= 0 or len(rms) < 2:
        return {"cov": 0.0, "flux": 0.0, "dyn_db": 0.0, "onset": 0.0}
    m = _mean(rms)
    cov = (_std(rms) / m) if m > 0 else 0.0
    ln = [r / fmax for r in rms]
    flux = _mean([abs(ln[i] - ln[i - 1]) for i in range(1, len(ln))])
    ap = feat.get("acoustic_physics", {})
    return {"cov": cov, "flux": flux, "dyn_db": sig["dyn_range_db"],
            "onset": as_float(ap.get("onset_rate_per_sec"), 0.0) or 0.0}

def dynamism_score(dr, B):
    cov_r   = rel(dr["cov"],   *B["cov"])
    flux_r  = rel(dr["flux"],  *B["flux"])
    dyn_r   = rel(dr["dyn_db"],*B["dyn_db"])
    onset_r = rel(dr["onset"], *B["onset"])
    return round((flux_r * 0.30 + onset_r * 0.30 + cov_r * 0.20 + dyn_r * 0.20) * 100, 1)

# ---------------------------------------------------------------------------
# 適応感度トリガー + 変化の質（音色ベクトルは後で作るのでここでは base を渡せない）
# ---------------------------------------------------------------------------
def nearest(vec, words, k=3, allow_generated=True):
    out = []
    for w in words:
        if not allow_generated and w["generated"]: continue
        s = 0.0
        for ax, (_col, wt) in DIST_AXES.items():
            d = (vec[ax] - w["vec"][ax]) * wt
            s += d * d
        out.append((math.sqrt(s), w))
    out.sort(key=lambda t: t[0])
    return out[:k]

def detect_quality(feat, min_gap=2.0):
    """トリガー候補を集め、変化の質（比率・規則性・鋭さ）と候補リストを返す。
    （オノマトペ付与は音色ベクトル確定後に行うため、ここでは時刻/型/強度のみ）"""
    ts = feat.get("time_series_1s") or []
    empty = {"dominant_motion": None, "attack_ratio": 0.0, "swell_ratio": 0.0,
             "roll_ratio": 0.0, "regularity_0_1": 0.0, "attack_sharpness_0_1": 0.0}
    if len(ts) < 2: return [], 0, empty
    rms = [as_float(p.get("rms_intensity"), 0.0) or 0.0 for p in ts]
    onc = [int(as_float(p.get("onset_count"), 0) or 0) for p in ts]
    times = [as_float(p.get("time_sec"), i) for i, p in enumerate(ts)]
    fmax = max(rms) if rms else 0.0
    if fmax <= 0: return [], 0, empty
    ln = [r / fmax for r in rms]
    active_ln = [x for x in ln if x >= 0.15]
    m, s = _mean(active_ln), _std(active_ln)
    thr = max(0.30, min(0.85, m + 1.0 * s))
    onset_thr = max(4, _percentile(sorted(onc), 90.0))
    cands = []
    last_t = -1e9
    for i in range(len(ts)):
        is_peak = ln[i] >= thr and ln[i] >= max(ln[max(0, i-1):i+2])
        is_burst = onc[i] >= onset_thr
        if not (is_peak or is_burst): continue
        if times[i] - last_t < min_gap: continue
        prev = ln[i-1] if i > 0 else 0.0
        rise = ln[i] - prev
        ttype = "刻み" if is_burst else ("アタック" if rise >= 0.4 else "うねり")
        cands.append({"time_sec": round(times[i], 1), "type": ttype,
                      "strength": round(ln[i], 2), "onset_count": onc[i], "_rise": max(0.0, rise)})
        last_t = times[i]
    total = len(cands)
    if total == 0: return [], 0, empty
    n = {t: sum(1 for c in cands if c["type"] == t) for t in ("アタック", "うねり", "刻み")}
    ct = [c["time_sec"] for c in cands]
    if len(ct) >= 3:
        iv = [ct[i]-ct[i-1] for i in range(1, len(ct))]
        mi = _mean(iv); cov_iv = (_std(iv)/mi) if mi > 0 else 0.0
        regularity = round(max(0.0, 1.0 - min(1.0, cov_iv)), 3)
    else:
        regularity = 0.0
    sharp = round(min(1.0, _mean([c["_rise"] for c in cands]) / 0.5), 3)
    q = {"dominant_motion": max(n, key=n.get), "attack_ratio": round(n["アタック"]/total, 3),
         "swell_ratio": round(n["うねり"]/total, 3), "roll_ratio": round(n["刻み"]/total, 3),
         "regularity_0_1": regularity, "attack_sharpness_0_1": sharp}
    return cands, total, q

def label_triggers(cands, total, vec, words, allow_generated, cap=30):
    """確定した音色ベクトルを土台に、各トリガーへオノマトペを付与。"""
    onset_thr = 4
    out = []
    for c in cands:
        v = dict(vec)
        v["x1"] = _clamp(c["strength"] * 9)
        v["x2"] = _clamp(min(1.0, c["onset_count"] / max(onset_thr, 1)) * 9)
        v["x8"] = _clamp((c["_rise"] * 9) if c["type"] != "うねり" else 3.0)
        tok = nearest(v, words, k=1, allow_generated=allow_generated)[0][1]["word"]
        out.append({"time_sec": c["time_sec"], "type": c["type"],
                    "strength": c["strength"], "onset_count": c["onset_count"], "onomatopoeia": tok})
    if total > cap:
        out = sorted(out, key=lambda e: e["strength"], reverse=True)[:cap]
    out.sort(key=lambda e: e["time_sec"])
    return out

# ---------------------------------------------------------------------------
# 言語化
# ---------------------------------------------------------------------------
def texture_word(vec):
    base = "剛体" if vec["x5"] <= 3 else "半流体" if vec["x5"] <= 6 else "流体"
    if vec["x9"] >= 6: base = "乱れた" + base
    if vec["x6"] >= 6: base = "湿った" + base
    return base

def _remark(sig, dur):
    n = []
    if sig["active_ratio"] < 0.3: n.append("発音はまばら")
    elif sig["active_ratio"] > 0.8: n.append("ほぼ鳴り続ける")
    if sig["dyn_range_db"] >= 40: n.append("ダイナミックレンジが広い")
    n.append("明確なピッチを持つ" if sig["f0"] is not None else "ノイズ的でピッチ不明瞭")
    if dur >= 600: n.append("長尺")
    return "／".join(n)

# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------
def analyze(features_path, dict_path, out_path, k=3, allow_generated=True, cap=30):
    words = load_dictionary(dict_path)
    tracks = load_features(features_path)
    sigs = [file_signature(t) for t in tracks]
    draws = [dynamism_raw(t, s) for t, s in zip(tracks, sigs)]

    def bnd(items, key):
        vals = sorted(x[key] for x in items if x.get(key) is not None)
        if not vals: return (0.0, 1.0)
        lo, hi = _percentile(vals, 5.0), _percentile(vals, 95.0)
        return (lo, hi if hi > lo else lo + 1e-9)
    SB = {k: bnd(sigs, k) for k in ("level", "zcr", "flat", "bw")}
    DB = {k: bnd(draws, k) for k in ("cov", "flux", "dyn_db", "onset")}

    results = []
    for feat, sig, dr in zip(tracks, sigs, draws):
        fid = feat.get("file_id") or feat.get("id") or "track"
        cands, total, q = detect_quality(feat)
        onset_rate = as_float(feat.get("acoustic_physics", {}).get("onset_rate_per_sec"), 0.0) or 0.0
        vec = signature_to_vec(sig, SB, DB, onset_rate, q)
        tokens = [w["word"] for _d, w in nearest(vec, words, k=k, allow_generated=allow_generated)]
        events = label_triggers(cands, total, vec, words, allow_generated, cap=cap)
        score = dynamism_score(dr, DB)
        dur = as_float(feat.get("metadata", {}).get("duration_sec"), 0.0) or 0.0
        tcount = {"アタック": 0, "うねり": 0, "刻み": 0}
        for e in events: tcount[e["type"]] += 1
        density = round(total / (dur / 60.0), 2) if dur > 0 else 0.0

        results.append({
            "file_id": fid,
            "profile": {
                "amount": {"dynamism_score": score, "trigger_per_min": density,
                           "dynamic_range_db": round(sig["dyn_range_db"], 1)},
                "change_quality": {
                    "dominant_motion": q["dominant_motion"],
                    "attack_ratio": q["attack_ratio"], "swell_ratio": q["swell_ratio"],
                    "roll_ratio": q["roll_ratio"], "regularity_0_1": q["regularity_0_1"],
                    "attack_sharpness_0_1": q["attack_sharpness_0_1"]},
                "timbre": {
                    "onomatopoeia": tokens,
                    "frequency_hz": round((sig["f0"] if sig["f0"] else sig["bright"]), 1),
                    "brightness_0_9": round(vec["x7"], 1),
                    "noisiness_0_9": round(vec["x5"], 1),
                    "moisture_0_9": round(vec["x6"], 1),
                    "is_pitched": sig["f0"] is not None,
                    "texture": texture_word(vec),
                    "level_0_9": round(vec["x1"], 1),
                    "full_vector_0_9": {AXIS_LABEL[a]: round(vec[a], 2) for a in vec}},
            },
            "triggers": {"count_total": total, "count_shown": len(events),
                         "by_type": tcount, "events": events},
            "notes": {"duration_sec": round(dur, 1),
                      "active_ratio": round(sig["active_ratio"], 3),
                      "onset_rate_per_sec": onset_rate, "remark": _remark(sig, dur)},
        })
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    return results

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="オノマトペ解析 v6（多様性最大化）")
    ap.add_argument("--input",  default="acoustic_features.json")
    ap.add_argument("--dict",   default="onomatopoeia_dictionary.csv")
    ap.add_argument("--output", default="sound_metadata.json")
    ap.add_argument("-k", type=int, default=3)
    ap.add_argument("--cap", type=int, default=30)
    ap.add_argument("--no-generated", action="store_true")
    args = ap.parse_args()
    res = analyze(args.input, args.dict, args.output, k=args.k,
                  allow_generated=not args.no_generated, cap=args.cap)
    uniq1 = len({r["profile"]["timbre"]["onomatopoeia"][0] for r in res})
    uniqall = len({w for r in res for w in r["profile"]["timbre"]["onomatopoeia"]})
    print(f"[done v6] {len(res)} トラック → {args.output}")
    print(f"  1位ユニーク: {uniq1}/{len(res)}  3語合計ユニーク: {uniqall}")
    for r in sorted(res, key=lambda x: x["profile"]["amount"]["dynamism_score"], reverse=True):
        p = r["profile"]
        print(f"  score={p['amount']['dynamism_score']:5} {r['file_id']:16} "
              f"{p['timbre']['onomatopoeia'][0]:10} {p['timbre']['texture']}")
