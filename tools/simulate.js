// tools/simulate.js
// 再生動態シミュレーション。分類・しきい値・選択ロジックを変更したら必ず実行し、
// 変更前後で指標を比較すること。
//
//   node tools/simulate.js planA old    // Plan A / 旧分類 (W+T+H)/3, <1.0/<2.5/<4.0
//   node tools/simulate.js planA new    // Plan A / 再較正分類 (W+T+S+H)/4, <=1.75/<=2.25/<=2.75
//   node tools/simulate.js planB old
//   node tools/simulate.js planB new
//
// 指標:
//   top10Share   上位10本の動画が全再生に占める割合（偏りの指標。目標 25%以下）
//   skipRate     ロック衝突で破棄されたトリガーの割合
//   unused       8時間で一度も再生されない動画の本数（目標 0）
//   spawnPerSec  (Plan Bのみ) コラージュ生成レート → 4スロット÷レート = 滞在秒数

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const vids = JSON.parse(fs.readFileSync(path.join(ROOT, "logic_weights.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "Audio analysis data/sound_metadata.json"), "utf8"));
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, W: 4, T: 5, S: 6, H: 7 };

const NORMAL = ["scene2End00.mp3","scene2End01.mp3","scene2End02.mp3","T510.mp3","T511.mp3","T512.mp3","T513.mp3","T514.mp3","T515.mp3","T516.mp3","T517.mp3","T518.mp3","T519.mp3","T520.mp3","T521.mp3","T522.mp3","T523.mp3","T524.mp3","T525.mp3","T526.mp3","T528.mp3","T529.mp3","T530.mp3","T531.mp3","T532.mp3","T533.mp3","T535.mp3","T536.mp3","T537.mp3","T540.mp3","T541.mp3"];
const RARE = ["T538.mp3","T538_00.mp3","T538_0.mp3","T538_01.mp3","T538_1.mp3","T538_02.mp3","T538_2.mp3"];

const findTrack = n => meta.find(t =>
  t.file_id.replace(/\.(aif|aiff|mp3)$/i, "").toLowerCase() === n.replace(/\.mp3$/i, "").toLowerCase());

function classify(mode) {
  const pools = { 1: [], 2: [], 3: [], 4: [] };
  vids.forEach(v => {
    let a, lvl;
    if (mode === "old") {
      a = (v[IDX.W] + v[IDX.T] + v[IDX.H]) / 3;
      lvl = a < 1.0 ? 1 : a < 2.5 ? 2 : a < 4.0 ? 3 : 4;
    } else {
      a = (v[IDX.W] + v[IDX.T] + v[IDX.S] + v[IDX.H]) / 4;
      lvl = a <= 1.75 ? 1 : a <= 2.25 ? 2 : a <= 2.75 ? 3 : 4;
    }
    pools[lvl].push(v);
  });
  return pools;
}

const lvlOf = e => (e.strength >= 0.75 || e.type === "アタック") ? 4 : e.strength >= 0.5 ? 3 : e.strength >= 0.25 ? 2 : 1;

function report(playCount, extras) {
  const counts = Object.entries(playCount).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((a, [, c]) => a + c, 0);
  const top10 = counts.slice(0, 10).reduce((a, [, c]) => a + c, 0);
  const unused = vids.filter(v => !playCount[v[0]]).length;
  console.log("totalPlays:", total);
  console.log("top10Share:", (top10 / total * 100).toFixed(1) + "%");
  console.log("unused:", unused + "/" + vids.length);
  console.log("mostPlayed:", counts.slice(0, 5).map(([f, c]) => `${f}(${c})`).join(" "));
  Object.entries(extras || {}).forEach(([k, v]) => console.log(k + ":", v));
}

function simulatePlanA(mode, hours) {
  const pools = classify(mode);
  const playCount = {};
  let skips = 0, fires = 0;
  const scr = [{ lock: 0 }, { lock: 0 }, { lock: 0 }];
  let cur = 1, dir = 1, now = 0, lastTrack = null, lastRare = false;

  const pick = (lvl, excl) => {
    let p = pools[lvl].filter(v => !excl.has(v[0]));
    if (!p.length) p = pools[lvl].length ? pools[lvl] : vids;
    return p[Math.floor(Math.random() * p.length)];
  };
  const react = (s, lvl, excl) => {
    const S = scr[s - 1];
    if (now < S.lock) { skips++; return; }
    fires++;
    const v = pick(lvl, excl); excl.add(v[0]);
    playCount[v[0]] = (playCount[v[0]] || 0) + 1;
    S.lock = lvl === 4 ? now + 1.2 : now + v[IDX.DUR]; // L1-L3は動画終了までロック
  };
  const getScreens = n => {
    if (n === 3) return [1, 2, 3];
    const sel = []; let ts = cur, td = dir;
    for (let i = 0; i < n; i++) {
      let att = 0, found = false;
      while (att < 6) {
        let nx = ts + td;
        if (nx > 3) { td = -1; nx = 2; } else if (nx < 1) { td = 1; nx = 2; }
        if (!sel.includes(nx) && now >= scr[nx - 1].lock) { ts = nx; sel.push(nx); found = true; break; }
        ts = nx; att++;
      }
      if (!found) {
        for (let s = 1; s <= 3; s++) if (!sel.includes(s) && now >= scr[s - 1].lock) { sel.push(s); ts = s; break; }
        if (sel.length <= i) for (let s = 1; s <= 3; s++) if (!sel.includes(s)) { sel.push(s); ts = s; break; }
      }
    }
    cur = ts; dir = td; return sel;
  };

  const end = hours * 3600;
  while (now < end) {
    let name, tr;
    for (let a = 0; a < 100; a++) {
      const useR = !lastRare && Math.random() < 0.10;
      const pool = useR ? RARE : NORMAL;
      const c = pool[Math.floor(Math.random() * pool.length)];
      if (c !== lastTrack) { tr = findTrack(c); if (tr) { name = c; lastRare = useR; break; } }
    }
    lastTrack = name;
    const evs = (tr.triggers.events || []).slice().sort((a, b) => a.time_sec - b.time_sec);
    const t0 = now;
    const ex0 = new Set();
    [1, 2, 3].forEach(s => react(s, 1, ex0)); // 冒頭の静寂イベント
    for (const e of evs) {
      now = t0 + e.time_sec;
      if (now > end) break;
      const lvl = lvlOf(e);
      const ex = new Set();
      getScreens(lvl === 4 ? 3 : lvl === 3 ? 2 : 1).forEach(s => react(s, lvl, ex));
    }
    now = t0 + (evs.length ? evs[evs.length - 1].time_sec : 60) + 3;
  }
  report(playCount, { skipRate: (skips / (skips + fires) * 100).toFixed(0) + "%" });
}

function simulatePlanB(mode, iters) {
  const pools = classify(mode);
  const ALLOWED = new Set([...NORMAL, ...RARE, "T538.mp3"].map(f => f.replace(/\.mp3$/i, "").toLowerCase()));
  const tracks = meta.filter(t => ALLOWED.has(t.file_id.replace(/\.(aif|aiff|mp3)$/i, "").toLowerCase()));
  const FIB = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  const playCount = {};
  let totalEvents = 0, totalSliceSec = 0;

  for (let i = 0; i < iters; i++) {
    const agent = i % 2 === 0 ? "A" : "B";
    const tr = tracks[Math.floor(Math.random() * tracks.length)];
    const dur = (tr.notes && tr.notes.duration_sec) ||
      (tr.triggers.events.length ? Math.max(...tr.triggers.events.map(e => e.time_sec)) : 60);
    const valid = FIB.filter(f => f <= dur); if (!valid.length) valid.push(1);
    const split = Math.max(1, Math.floor(valid.length / 2));
    let d;
    if (agent === "A") { const p = valid.slice(0, Math.min(valid.length, split + 1)); d = p[Math.floor(Math.random() * p.length)]; }
    else { const p = valid.slice(split); d = p.length ? p[Math.floor(Math.random() * p.length)] : valid[valid.length - 1]; }
    const evs = tr.triggers.events || [];
    let start;
    if (!evs.length) { start = Math.random() * Math.max(0.1, dur - d); }
    else {
      let ch;
      if (agent === "A") { const a = evs.filter(e => e.type === "アタック"); ch = a.length ? a[Math.floor(Math.random() * a.length)] : evs[Math.floor(Math.random() * evs.length)]; start = Math.max(0, ch.time_sec - 0.1 - Math.random() * 0.2); }
      else { const am = evs.filter(e => e.type === "うねり" || e.type === "静寂"); ch = am.length ? am[Math.floor(Math.random() * am.length)] : evs[Math.floor(Math.random() * evs.length)]; start = Math.max(0, ch.time_sec - 1.0 - Math.random() * 2.0); }
      if (start + d > dur) start = Math.max(0, dur - d);
    }
    evs.filter(e => e.time_sec >= start && e.time_sec <= start + d).forEach(e => {
      const lvl = lvlOf(e);
      const pool = pools[lvl].length ? pools[lvl] : vids;
      const v = pool[Math.floor(Math.random() * pool.length)]; // 除外セットなし（現行仕様準拠）
      playCount[v[0]] = (playCount[v[0]] || 0) + 1;
      totalEvents++;
    });
    totalSliceSec += d;
  }
  const spawnPerSec = totalEvents / totalSliceSec * 2; // 2エージェント並行
  report(playCount, {
    spawnPerSec: spawnPerSec.toFixed(2),
    slotDwellSec: (4 / spawnPerSec).toFixed(1) + "s"
  });
}

const [plan, mode] = process.argv.slice(2);
if (plan === "planA") simulatePlanA(mode || "old", 8);
else if (plan === "planB") simulatePlanB(mode || "old", 20000);
else console.log("usage: node tools/simulate.js planA|planB old|new");
