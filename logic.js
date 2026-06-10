// [ファイル名, 秒数, 姿勢, 方向, Weight, Time, Space, Hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

// フィボナッチ（休符・1秒〜21秒）
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

let metadataPool = [];
let players = [];
let previousSelections = [null, null, null, null]; 
let cycleCount = 0;

async function initSkinslides() {
    document.getElementById('start-overlay').style.display = 'none';

    players = [
        new VideoPlayer("player-1"),
        new VideoPlayer("player-2"),
        new VideoPlayer("player-3"),
        new VideoPlayer("player-4", true) 
    ];

    try {
        const res = await fetch('logic_weights.json');
        metadataPool = await res.json();
        console.log(`[logic] Loaded ${metadataPool.length} metadata records.`);
        runGlobalSequence();
    } catch (e) {
        console.error("JSONの読み込みに失敗しました:", e);
    }
}

function selectIntelligentVideo(playerIndex) {
    const prev = previousSelections[playerIndex];
    let candidates = [...metadataPool];

    if (prev) {
        // 同じ姿勢は避ける
        let filtered = candidates.filter(v => v[IDX.POS] !== prev[IDX.POS]);
        
        // 前回の動作が大地ベタ付き（Hardness高）なら、空間の広がり（Space）を持つ映像へ
        if (prev[IDX.HARD] > 5) {
            filtered.sort((a, b) => b[IDX.SPACE] - a[IDX.SPACE]);
            filtered = filtered.slice(0, Math.max(1, Math.floor(filtered.length * 0.3)));
        }
        
        // フォールバック
        if (filtered.length > 5) candidates = filtered;
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    previousSelections[playerIndex] = selected;
    return selected;
}

async function runGlobalSequence() {
    while (true) {
        cycleCount++;
        console.log(`\n--- [Cycle ${cycleCount}] ---`);
        let syncTasks = [];

        for (let i = 0; i < 4; i++) {
            const videoData = selectIntelligentVideo(i);
            const fileName = videoData[IDX.FNAME];
            const weightScore = videoData[IDX.WEIGHT];   
            
            // 激しさ（Weight）をインデックスにして、それに伴う余韻をフィボナッチから決定
            const fibIndex = Math.min(weightScore, FIBONACCI.length - 1);
            const pauseDelays = FIBONACCI[fibIndex];

            console.log(`[Screen ${i+1}] Chosen: ${fileName} | Weight=${weightScore} -> Wait: ${pauseDelays}s`);

            // タイマー発動型のPromiseタスクをスタック
            syncTasks.push(players[i].playSequence(fileName, pauseDelays));
        }

        // 4画面すべての「動画」＋「余韻（フィボナッチ休符）」が完全に終わるまで、ここで無限待機する
        await Promise.all(syncTasks);
        console.log(`--- Cycle ${cycleCount} Fully Synced ---`);
    }
}

document.getElementById('start-overlay').addEventListener('click', initSkinslides, { once: true });
