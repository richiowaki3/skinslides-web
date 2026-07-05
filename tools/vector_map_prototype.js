// tools/vector_map_prototype.js
// 検討用プロトタイプ: オノマトペ辞書(10軸)を共通空間として、
// 映像解析(metadata_cv2.json + metadata.json + logic_weights.json + pauseTime.xml)を
// 音響解析と同じベクトル空間に射影し、距離ベースの動画選択が成立するかを検証する。
//
//   node tools/vector_map_prototype.js          // マップ構築 + 選択シミュレーション
//   node tools/vector_map_prototype.js --map    // 各動画のベクトルと最近傍オノマトペ一覧を表示
//
// 軸定義は Audio analysis data/onoma_analyzer_v6.py の DIST_AXES と同一:
//   x1 Weight, x2 Time, x3 Space, x4 Flow, x5 Hardness,
//   x6 Moisture, x7 Frequency, x8 Decay, x9 Reynolds, x16 Regularity
// 距離重みも同一 (1.0, 1.0, 0.4, 0.5, 1.0, 0.8, 1.0, 1.0, 0.7, 0.6)

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

// ---- 辞書ロード (onoma_analyzer_v6.py の load_dictionary と同じ列を使う) ----
const AXES = [
  ["x1", "x1", 1.0], ["x2", "x2", 1.0], ["x3", "x3", 0.4], ["x4", "x4", 0.5],
  ["x5", "x5", 1.0], ["x6", "x6", 0.8], ["x7", "x7_norm", 1.0], ["x8", "x8", 1.0],
  ["x9", "x9_norm", 0.7], ["x16", "x16_regularity", 0.6],
];

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去 (python側はutf-8-sigで読んでいる)
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const header = lines[0].split(",");
  return lines.slice(1).map(l => {
    const cells = l.split(",");
    const row = {};
    header.forEach((h, i) => row[h] = cells[i]);
    return row;
  });
}

const dictRows = parseCSV(fs.readFileSync(path.join(ROOT, "Audio analysis data/onomatopoeia_dictionary.csv"), "utf8"));
const words = [];
for (const row of dictRows) {
  const vec = {};
  let ok = true;
  for (const [ax, col] of AXES) {
    const v = parseFloat(row[col]);
    if (!Number.isFinite(v)) { ok = false; break; }
    vec[ax] = v;
  }
  if (ok) words.push({ word: row.word, vec, generated: row.generated === "True" });
}

function wdist(a, b) {
  let s = 0;
  for (const [ax, , w] of AXES) { const d = a[ax] - b[ax]; s += w * d * d; }
  return Math.sqrt(s);
}
// 映像が絡む距離では Frequency(x7=音高) を無視する。映像には音高情報が無いため、
// 速度等で代用すると「じーじー(きしみ)」と「ぬー(遅い)」のような同速・別音高を
// 誤って揃えてしまう。音側どうしの距離(wdist)は辞書本来の10軸のまま。
const VID_IGNORE = new Set(["x7"]);
function wdistVid(vidVec, wordVec) {
  let s = 0;
  for (const [ax, , w] of AXES) { if (VID_IGNORE.has(ax)) continue; const d = vidVec[ax] - wordVec[ax]; s += w * d * d; }
  return Math.sqrt(s);
}
function nearestWords(vec, k, realOnly) {
  const pool = realOnly ? words.filter(w => !w.generated) : words;
  return pool.map(w => ({ w: w.word, d: wdistVid(vec, w.vec), gen: w.generated }))
    .sort((a, b) => a.d - b.d).slice(0, k);
}

// ---- 映像データロード ----
const cv2 = JSON.parse(fs.readFileSync(path.join(ROOT, "Video analysis data/metadata_cv2.json"), "utf8"));
const mp = JSON.parse(fs.readFileSync(path.join(ROOT, "Video analysis data/metadata.json"), "utf8"));
const lw = JSON.parse(fs.readFileSync(path.join(ROOT, "logic_weights.json"), "utf8"));
const pauseXml = fs.readFileSync(path.join(ROOT, "pauseTime.xml"), "utf8");

const num = f => { const m = String(f).match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
const mpBy = {}; mp.forEach(v => mpBy[num(v.id)] = v);
const lwBy = {}; lw.forEach(v => lwBy[num(v[0])] = v);
// pauseTime.xml: <S05.MOV><PAUSE>n</PAUSE>...</S05.MOV> 形式からフリーズ数を拾う
const freezeBy = {};
for (const m of pauseXml.matchAll(/<s(\d+)\.mov>([\s\S]*?)<\/s\1\.mov>/gi)) {
  const n = parseInt(m[1], 10);
  freezeBy[n] = (m[2].match(/<PAUSE>/gi) || []).length;
}

// 正規化: 音響側(SB/DB)と同様に分布に基づく相対値 (p10-p90)
function bounds(vals, lo = 10, hi = 90) {
  const s = [...vals].sort((a, b) => a - b);
  const pc = p => { const i = (s.length - 1) * p / 100; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };
  return [pc(lo), pc(hi)];
}
const rel = (v, [lo, hi]) => hi <= lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
const clamp = v => Math.max(0, Math.min(9, v));

const B = {
  vel: bounds(cv2.map(v => v.avg_body_velocity_px)),
  contact: bounds(cv2.map(v => v.avg_contact_area_px)),
  limb: bounds(cv2.map(v => v.avg_limb_islands)),
  limbMax: bounds(cv2.map(v => v.max_limb_islands)),
  ext: bounds(cv2.map(v => (mpBy[num(v.id)] || {}).avg_extension || 0)),
  pchg: bounds(cv2.map(v => { const m = mpBy[num(v.id)]; return m ? (m.posture_changes || []).length / v.duration_seconds * 60 : 0; })),
  com: bounds(cv2.map(v => (mpBy[num(v.id)] || {}).com_movement || 0)),
  freeze: bounds(cv2.map(v => (freezeBy[num(v.id)] || 0) / v.duration_seconds * 60)),
  intens: bounds(cv2.map(v => (mpBy[num(v.id)] || {}).max_intensity || 0)),
};

// ---- 映像 → 10軸射影 (検討用初期式。音響側 signature_to_vec と対をなす) ----
function videoToVec(v) {
  const n = num(v.id);
  const m = mpBy[n] || {};
  const w4 = lwBy[n] || [null, 0, "st", "S", 0, 0, 0, 0]; // [fname,dur,pos,dir,W,T,S,H]
  const vel_r = rel(v.avg_body_velocity_px, B.vel);
  const contact_r = rel(v.avg_contact_area_px, B.contact);
  const limb_r = rel(v.avg_limb_islands, B.limb);
  const limbMax_r = rel(v.max_limb_islands, B.limbMax);
  const ext_r = rel(m.avg_extension || 0, B.ext);
  const pchg_r = rel((m.posture_changes || []).length / v.duration_seconds * 60, B.pchg);
  const com_r = rel(m.com_movement || 0, B.com);
  const freeze_r = rel((freezeBy[n] || 0) / v.duration_seconds * 60, B.freeze);
  const intens_r = rel(m.max_intensity || 0, B.intens);
  const [W, T, S, H] = [w4[4] || 0, w4[5] || 0, w4[6] || 0, w4[7] || 0];

  // v2: Moisture を Hardness の鏡映から独立信号(黒い接触面積=肌の密着=ねっとり)へ変更。
  //     鏡映式は低Hardness動画30本を湿りコーナーへ固め、生成語クラスタに吸着させていた。
  // v3: Frequency(音高)は映像から測れないため中立固定＋距離で無視(wdistVid)。
  //     四肢オレンジ発光数は Space(空間的広がり) へ移した。
  const x1 = clamp(0.6 * W + 0.4 * (1 - vel_r) * 9);        // Weight ← 人手W + 遅さ(接地・重み)
  const x2 = clamp(0.5 * T + 0.5 * vel_r * 9);              // Time ← 運動量+人手T
  const x3 = clamp(0.4 * S + 0.4 * ext_r * 9 + 0.2 * limb_r * 9); // Space ← 伸展+人手S+四肢展開
  const x4 = clamp(((1 - freeze_r) * 0.5 + com_r * 0.5) * 9); // Flow ← 重心移動 vs フリーズ
  const x5 = clamp(0.5 * H + 0.5 * intens_r * 9);           // Hardness ← 最大強度+人手H
  const x6 = clamp(contact_r * 9);                           // Moisture ← 黒い接触面積(肌の密着=ねっとり)
  const x7 = 4.5;                                             // Frequency ← 中立(映像は音高を判定しない)
  const x8 = clamp((freeze_r * 0.6 + intens_r * 0.4) * 9);  // Decay ← フリーズ頻度=スタッカート性
  const x9 = clamp((pchg_r * 0.6 + limbMax_r * 0.4) * 9);   // Reynolds ← 姿勢乱流+四肢分裂
  const x16 = clamp(pchg_r * 9);                              // Regularity(不規則性) ← 姿勢変化率
  return { x1, x2, x3, x4, x5, x6, x7, x8, x9, x16 };
}

const videoVecs = cv2.map(v => ({
  id: v.id, num: num(v.id), in_side: v.in_side, out_side: v.out_side,
  vec: videoToVec(v),
}));

// ---- 検証1: マップの散らばり(動画同士が空間内で分離しているか) ----
const dists = [];
for (let i = 0; i < videoVecs.length; i++)
  for (let j = i + 1; j < videoVecs.length; j++)
    dists.push(wdistVid(videoVecs[i].vec, videoVecs[j].vec));
dists.sort((a, b) => a - b);

// ---- 検証2: 音響イベント(オノマトペ語)→最近傍動画の選択分布 ----
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "Audio analysis data/sound_metadata.json"), "utf8"));
const wordVec = {}; words.forEach(w => wordVec[w.word] = w.vec);
let evTotal = 0, evMatched = 0;
const playCount = {};
const K = 3; // 最近傍K件からランダムで1本 (K=1だと同語=常に同一動画で固定化するため)
for (const t of meta) {
  for (const e of (t.triggers.events || [])) {
    evTotal++;
    const wv = wordVec[e.onomatopoeia];
    if (!wv) continue;
    evMatched++;
    const near = videoVecs.map(v => ({ id: v.id, d: wdistVid(v.vec, wv) }))
      .sort((a, b) => a.d - b.d).slice(0, K);
    const pick = near[Math.floor(Math.random() * near.length)];
    playCount[pick.id] = (playCount[pick.id] || 0) + 1;
  }
}
const counts = Object.entries(playCount).sort((a, b) => b[1] - a[1]);
const totalPlays = counts.reduce((a, [, c]) => a + c, 0);
const top10 = counts.slice(0, 10).reduce((a, [, c]) => a + c, 0);
const unused = videoVecs.filter(v => !playCount[v.id]).length;

if (process.argv.includes("--map")) {
  console.log("=== 各動画のベクトルと最近傍オノマトペ(実在語のみ) ===");
  console.log("軸順: W,Time,Space,Flow,Hard,Moist,Freq,Decay,Reyn,Reg");
  let farCount = 0;
  for (const v of videoVecs) {
    const nw = nearestWords(v.vec, 3, true); // 実在語のみ
    const label = nw.map(x => `${x.w}(${x.d.toFixed(1)})`).join(" ");
    const vec = Object.values(v.vec).map(x => x.toFixed(0)).join(",");
    const fit = nw[0].d <= 4 ? "  " : nw[0].d <= 6 ? " ~" : " ⚠"; // 当てはまりの目安
    if (nw[0].d > 6) farCount++;
    console.log(`${v.id}  [${vec}]  in:${v.in_side} out:${v.out_side} →${fit} ${label}`);
  }
  console.log(`\n当てはまり悪(最近傍実在語 > 6.0): ${farCount}/52`);
} else if (process.argv.includes("--v2a")) {
  // 逆方向: いま画面に出ている映像から、質感の近い/遠いトラックを次の音として選ぶ
  console.log("=== 逆方向: 映像→音 (同一辞書空間でのトラック選択) ===");
  // 各トラックの代表ベクトル = full_vector_0_9 を辞書10軸へ写像
  const trackVec = t => {
    const fv = ((t.profile || {}).timbre || {}).full_vector_0_9;
    if (!fv) return null;
    return { x1: fv.Weight, x2: fv.Time, x3: fv.Space, x4: fv.Flow, x5: fv.Hardness,
             x6: fv.Moisture, x7: fv.Frequency, x8: fv.Decay, x9: fv.Reynolds, x16: fv.Regularity };
  };
  const tracks = meta.map(t => ({ id: t.file_id, vec: trackVec(t) })).filter(t => t.vec);
  // シナリオ: 3画面に出ている動画の重心から、近いトラック/遠いトラックを提示
  const sample = [videoVecs[12], videoVecs[10], videoVecs[50]]; // 13,11,51番あたり
  const centroid = {};
  for (const [ax] of AXES) centroid[ax] = sample.reduce((s, v) => s + v.vec[ax], 0) / sample.length;
  console.log("画面の3動画:", sample.map(v => v.id).join(", "));
  console.log("その重心ベクトル:", Object.values(centroid).map(x => x.toFixed(1)).join(","));
  const ranked = tracks.map(t => ({ id: t.id, d: wdistVid(centroid, t.vec) })).sort((a, b) => a.d - b.d);
  console.log("\n質感が近い音(継続・調和):", ranked.slice(0, 3).map(t => `${t.id}(${t.d.toFixed(1)})`).join("  "));
  console.log("質感が遠い音(対比・転換):", ranked.slice(-3).map(t => `${t.id}(${t.d.toFixed(1)})`).join("  "));
} else {
  console.log("=== 検証1: 動画52本のマップ内分離度 ===");
  console.log("ペア距離 min:", dists[0].toFixed(2), " median:", dists[Math.floor(dists.length / 2)].toFixed(2), " max:", dists[dists.length - 1].toFixed(2));
  console.log("(median が語彙間距離と同程度なら、動画が空間内で十分散っている)");
  console.log();
  console.log("=== 検証2: 音響イベントのオノマトペ → 最近傍動画選択 (K=" + K + ") ===");
  console.log("イベント総数:", evTotal, " 辞書に語が見つかった率:", (evMatched / evTotal * 100).toFixed(1) + "%");
  console.log("top10Share:", (top10 / totalPlays * 100).toFixed(1) + "%", " unused:", unused + "/" + videoVecs.length);
  console.log("最頻5本:", counts.slice(0, 5).map(([f, c]) => `${f}(${c})`).join(" "));
}
