// lexicon_live.js
// Plan B のライブ質感ベクトルマップ。tools/lexicon_map_data.json（映像52・音47・語82を
// 共通10軸空間へ射影したPCA座標＋関係）を読み、#lexmap-canvas に力学配置マップを描画する。
// 再生中は window.LexMap.flash(videoNum, onomatopoeia) / setTrack(agent, trackName) で
// 現在鳴っている音・語・映像を発光させ、三者関係(映像—語—音)を光らせる。
// 表示専用。選択ロジックには一切関与しない。TODO: メイン統合時は core 側へ寄せる。
(function () {
  const COL = { video: '#ff5b6a', track: '#f2a63a', word: '#37c9c1' };
  const SHAPE = { video: 'square', track: 'square', word: 'circle' };
  const W = 1500, H = 1080;

  let DATA = null, nodes = [], byId = new Map(), adj = new Map();
  const wordByLabel = new Map(), trackByBase = new Map();
  let cv, ctx, VW = 0, VH = 0, DPR = 1;
  let cam = { x: 0, y: 0, s: 1 };       // 現在のカメラ
  let fitCam = { x: 0, y: 0, s: 1 };    // 全体がウィンドウに収まる俯瞰
  let camTarget = { x: 0, y: 0, s: 1 }; // カメラが滑らかに寄っていく目標
  let userHoldUntil = 0;                // 手動操作後、この時刻まで自動追従を止める
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const activeTrack = { A: null, B: null };
  let liveLinks = []; // 現在鳴っているトリオを明示的に結ぶ一時的な線（映像↔語↔音）
  let hoverId = null, running = false;

  const normTrack = s => String(s).replace(/\.(aif|aiff|mp3|wav)$/i, '').toLowerCase();
  const hexA = (hex, a) => {
    const h = hex.replace('#', '');
    return `rgba(${parseInt(h.substr(0,2),16)},${parseInt(h.substr(2,2),16)},${parseInt(h.substr(4,2),16)},${a})`;
  };
  const toScreen = n => ({ x: n.wx * cam.s + cam.x, y: n.wy * cam.s + cam.y });

  async function boot() {
    try {
      const res = await fetch('tools/lexicon_map_data.json');
      if (!res.ok) throw new Error('http ' + res.status);
      DATA = await res.json();
    } catch (e) { console.warn('[lexmap] data load failed:', e); return; }

    nodes = DATA.nodes.map(n => ({ ...n, heat: 0 }));
    byId = new Map(nodes.map(n => [n.id, n]));
    adj = new Map(nodes.map(n => [n.id, []]));
    DATA.edges.forEach(e => { if (byId.has(e.s) && byId.has(e.t)) { adj.get(e.s).push(e); adj.get(e.t).push(e); } });
    nodes.forEach(n => {
      n.r = n.type === 'word' ? 3.4 + Math.sqrt(n.weight) * 1.15
          : n.type === 'track' ? 4.2 + Math.sqrt(n.weight) * 0.7 : 5.2;
      n.wx = 80 + n.x * (W - 160); n.wy = 70 + n.y * (H - 140);
      n.sx = n.wx; n.sy = n.wy; n.vx = 0; n.vy = 0;
      if (n.type === 'word') wordByLabel.set(n.label, n);
      if (n.type === 'track') trackByBase.set(normTrack(n.label), n);
    });
    let alpha = 1; for (let i = 0; i < 260; i++) { tick(alpha); alpha *= 0.985; }

    cv = document.getElementById('lexmap-canvas');
    if (!cv) { console.warn('[lexmap] #lexmap-canvas not found'); return; }
    ctx = cv.getContext('2d');
    window.addEventListener('resize', resize);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', () => { hoverId = null; });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('wheel', onWheel, { passive: false });
    resize();
    running = true;
    requestAnimationFrame(loop);
    window.LexMap = { flash, setTrack, clearAll };
    console.log('[lexmap] ready:', nodes.length, 'nodes,', DATA.edges.length, 'edges');
  }

  function tick(k) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.wx - b.wx, dy = a.wy - b.wy, d2 = dx*dx + dy*dy || 0.01;
        if (d2 < 90000) {
          const d = Math.sqrt(d2), minD = a.r + b.r + 8;
          let f = (1600 / d2) * k; if (d < minD) f += (minD - d) * 0.05;
          const ux = dx/d, uy = dy/d;
          a.vx += ux*f; a.vy += uy*f; b.vx -= ux*f; b.vy -= uy*f;
        }
      }
    }
    DATA.edges.forEach(e => {
      const a = byId.get(e.s), b = byId.get(e.t); if (!a || !b) return;
      const dx = b.wx - a.wx, dy = b.wy - a.wy, d = Math.hypot(dx, dy) || 0.01;
      const L = e.kind === 'nearest' ? 46 : 58, f = (d - L) * 0.012 * k;
      const ux = dx/d, uy = dy/d;
      a.vx += ux*f; a.vy += uy*f; b.vx -= ux*f; b.vy -= uy*f;
    });
    nodes.forEach(n => {
      n.vx += (n.sx - n.wx) * 0.02 * k; n.vy += (n.sy - n.wy) * 0.02 * k;
      n.wx += n.vx; n.wy += n.vy; n.vx *= 0.82; n.vy *= 0.82;
    });
  }

  function resize() {
    if (!cv) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    VW = cv.clientWidth; VH = cv.clientHeight;
    cv.width = VW * DPR; cv.height = VH * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const pad = 40;
    const s = Math.min((VW - pad*2) / W, (VH - pad*2) / H);
    fitCam = { s, x: (VW - W*s) / 2, y: (VH - H*s) / 2 };
    cam = { ...fitCam };            // リサイズ時は俯瞰へスナップ
    camTarget = { ...fitCam };
  }

  // 光っているトリオ（heat中のノード＋再生中トラック）へカメラを寄せる目標を計算。
  // 何も光っていなければ全体俯瞰(fitCam)へ戻る。手動操作直後は追従を止める。
  function updateCamera() {
    if (pan) return;
    if (nowMs() < userHoldUntil) return;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, cnt = 0;
    const consider = id => {
      const n = byId.get(id); if (!n) return;
      minx = Math.min(minx, n.wx - n.r); miny = Math.min(miny, n.wy - n.r);
      maxx = Math.max(maxx, n.wx + n.r); maxy = Math.max(maxy, n.wy + n.r); cnt++;
    };
    nodes.forEach(n => { if (n.heat > 0.15) consider(n.id); });
    if (activeTrack.A) consider(activeTrack.A);
    if (activeTrack.B) consider(activeTrack.B);
    if (cnt > 0) {
      const pad = 110;
      let s = Math.min((VW - pad*2) / Math.max(60, maxx - minx), (VH - pad*2) / Math.max(60, maxy - miny));
      s = Math.max(fitCam.s, Math.min(fitCam.s * 2.6, s)); // 俯瞰より引かない・寄りすぎない
      const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
      camTarget = { s, x: VW/2 - cx*s, y: VH/2 - cy*s };
    } else {
      camTarget = { ...fitCam };
    }
  }

  // ---- live API ----
  const agentKey = a => (a === 'AgentA' || a === 'A') ? 'A' : 'B';
  function flash(videoNum, onomatopoeia, agent) {
    const v = byId.get('v' + videoNum); if (v) v.heat = 1;
    let w = null;
    if (onomatopoeia) { w = wordByLabel.get(onomatopoeia); if (w) w.heat = 1; }
    // この映像・語・音は「今」同時に起きている → 三者を明示的な線で結ぶ（既存エッジの有無に依らず）
    if (v && w) liveLinks.push({ a: v.id, b: w.id, c: COL.video, heat: 1 });
    const tId = agent ? activeTrack[agentKey(agent)] : null;
    if (w && tId) liveLinks.push({ a: w.id, b: tId, c: COL.track, heat: 1 });
  }
  function setTrack(agent, trackName) {
    const t = trackByBase.get(normTrack(trackName));
    activeTrack[agentKey(agent)] = t ? t.id : null;
    if (t) t.heat = Math.max(t.heat, 0.7);
  }
  function clearAll() { nodes.forEach(n => n.heat = 0); activeTrack.A = activeTrack.B = null; liveLinks = []; }

  // relay corpus: two-hop triad through the shared word (for hover)
  function relationSet(id) {
    const node = byId.get(id), set = new Set([id]);
    const words = node.type === 'word' ? [id]
      : adj.get(id).map(e => e.s === id ? e.t : e.s).filter(x => byId.get(x).type === 'word');
    words.forEach(w => { set.add(w); adj.get(w).forEach(e => { set.add(e.s); set.add(e.t); }); });
    return set;
  }
  function litSet() {
    const s = new Set();
    nodes.forEach(n => { if (n.heat > 0.05) s.add(n.id); });
    if (activeTrack.A) s.add(activeTrack.A);
    if (activeTrack.B) s.add(activeTrack.B);
    return s;
  }

  function loop() {
    if (!running) return;
    nodes.forEach(n => {
      const floor = (n.id === activeTrack.A || n.id === activeTrack.B) ? 0.55 : 0; // playing track stays lit
      if (n.heat > floor) n.heat = Math.max(floor, n.heat - 0.014); // ~1.2s flash fade
    });
    if (liveLinks.length) { liveLinks.forEach(l => l.heat -= 0.014); liveLinks = liveLinks.filter(l => l.heat > 0.02); }
    updateCamera();
    if (!pan) { // 目標へ滑らかに寄る（ドラッグ中は直接操作なので触らない）
      cam.x += (camTarget.x - cam.x) * 0.07;
      cam.y += (camTarget.y - cam.y) * 0.07;
      cam.s += (camTarget.s - cam.s) * 0.07;
    }
    render();
    requestAnimationFrame(loop);
  }

  function render() {
    ctx.clearRect(0, 0, VW, VH);
    const lit = litSet();
    const hl = hoverId ? relationSet(hoverId) : null;

    // edges
    ctx.lineWidth = 1;
    DATA.edges.forEach(e => {
      const a = byId.get(e.s), b = byId.get(e.t); if (!a || !b) return;
      const triad = lit.has(e.s) && lit.has(e.t);
      const onHover = hl && hl.has(e.s) && hl.has(e.t);
      let op;
      if (triad) op = 0.75;
      else if (onHover) op = 0.5;
      else if (hl) op = 0.04;
      else op = e.kind === 'nearest' ? 0.07 : 0.09;
      const p = toScreen(a), q = toScreen(b);
      ctx.strokeStyle = hexA(e.kind === 'nearest' ? COL.video : COL.track, op);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    });

    // live triad links: the video/word/sound happening right now, drawn bright on top
    liveLinks.forEach(l => {
      const a = byId.get(l.a), b = byId.get(l.b); if (!a || !b) return;
      const p = toScreen(a), q = toScreen(b);
      ctx.strokeStyle = hexA(l.c, Math.min(0.9, l.heat));
      ctx.lineWidth = 1 + l.heat * 2.2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    });
    ctx.lineWidth = 1;

    // nodes
    nodes.forEach(n => {
      const p = toScreen(n), r = n.r * cam.s, col = COL[n.type];
      const active = lit.has(n.id) || n.heat > 0.02;
      const dim = hl && !hl.has(n.id) && !active;
      const heat = Math.min(1.4, n.heat);
      // 明るさ: 発光/ホバー関係=100%、ホバー時の非関係=25%、それ以外の「使用していない」ノード=50%
      const bright = active || (hl && hl.has(n.id)) ? 1 : (dim ? 0.25 : 0.5);
      const gr = r * (2.4 + heat * 3.2);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, gr);
      g.addColorStop(0, hexA(col, bright * 0.28 + heat * 0.5)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, gr, 0, 7); ctx.fill();

      const rr = r * (1 + Math.min(heat, 1) * 0.7);
      ctx.fillStyle = hexA(col, bright);
      if (SHAPE[n.type] === 'square') ctx.fillRect(p.x - rr, p.y - rr, rr*2, rr*2);
      else { ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 7); ctx.fill(); }

      if (heat > 0.5 || n.id === hoverId) {
        ctx.strokeStyle = hexA('#ffffff', Math.min(1, heat)); ctx.lineWidth = 1.5;
        if (SHAPE[n.type] === 'square') ctx.strokeRect(p.x - rr - 3, p.y - rr - 3, (rr+3)*2, (rr+3)*2);
        else { ctx.beginPath(); ctx.arc(p.x, p.y, rr + 3, 0, 7); ctx.stroke(); }
      }

      const big = n.type === 'word' && n.weight >= 60;
      const showLabel = active || n.heat > 0.15 || n.id === hoverId || (hl && hl.has(n.id)) || (!hl && big);
      if (showLabel) {
        ctx.font = '12px "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = (n.heat > 0.15 || active) ? '#ffffff' : '#c3c7d2';
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
        ctx.fillText(n.label, p.x, p.y + rr + 3); ctx.shadowBlur = 0;
      }
    });
  }

  // ---- pan / zoom / hover ----
  function localXY(ev) { const rc = cv.getBoundingClientRect(); return { x: ev.clientX - rc.left, y: ev.clientY - rc.top }; }
  function pick(mx, my) {
    let best = null, bd = 16;
    for (const n of nodes) {
      const p = toScreen(n), d = Math.hypot(p.x - mx, p.y - my);
      const rr = Math.max(n.r * cam.s, 5) + 4;
      if (d < rr && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  let pan = null;
  function onMove(ev) {
    const { x, y } = localXY(ev);
    if (pan) { cam.x = pan.cx + (ev.clientX - pan.x); cam.y = pan.cy + (ev.clientY - pan.y); return; }
    const n = pick(x, y); hoverId = n ? n.id : null;
    cv.style.cursor = n ? 'pointer' : 'grab';
  }
  function onDown(ev) {
    pan = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y };
    const up = () => {
      pan = null;
      camTarget = { x: cam.x, y: cam.y, s: cam.s };
      userHoldUntil = nowMs() + 6000; // 手動操作後6秒は自動追従を止める
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointerup', up);
  }
  function onWheel(ev) {
    ev.preventDefault();
    const { x, y } = localXY(ev);
    const ns = Math.max(0.3, Math.min(3.4, cam.s * Math.exp(-ev.deltaY * 0.0012)));
    const k = ns / cam.s; cam.x = x - (x - cam.x) * k; cam.y = y - (y - cam.y) * k; cam.s = ns;
    camTarget = { x: cam.x, y: cam.y, s: cam.s };
    userHoldUntil = nowMs() + 6000;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
