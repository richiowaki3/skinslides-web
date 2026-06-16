// [ファイル名, 秒数, 姿勢, 方向, Weight, Time, Space, Hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

// フィボナッチ（休符・1秒〜21秒）
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

let metadataPool = [];
let players = [];
let previousSelections = [null, null, null, null]; 
let cycleCount = 0;

// ペア連携用のデータ構造
let pairMap = {}; // "01.mov" -> "02.mov", "02.mov" -> "01.mov"
let singleSet = new Set(); // "25.mov", "30.mov" 等

async function initSkinslides() {
    document.getElementById('start-overlay').style.display = 'none';

    players = [
        new VideoPlayer("player-1"),
        new VideoPlayer("player-2"),
        new VideoPlayer("player-3"),
        new VideoPlayer("player-4", true) 
    ];

    try {
        // 1. メタデータ (logic_weights.json) のロード
        const resWeights = await fetch('logic_weights.json');
        metadataPool = await resWeights.json();
        console.log(`[logic] Loaded ${metadataPool.length} metadata records.`);

        // 2. ペア・単独連携設定 (sss-abc.csv) のロードとパース
        await loadPairConfig();

        // 3. グローバルシーケンスの開始
        runGlobalSequence();
    } catch (e) {
        console.error("JSON/CSVの読み込みまたは初期化に失敗しました:", e);
    }
}

async function loadPairConfig() {
    try {
        const res = await fetch('sss-abc.csv');
        const text = await res.text();
        const lines = text.split(/\r?\n/);
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            const cols = line.split(',').map(c => c.trim());
            
            // A列・B列（ペア動画）
            const colA = cols[0];
            const colB = cols[1];
            // C列（単独動画）
            const colC = cols.length > 2 ? cols[2] : "";
            
            const toMovName = (name) => {
                if (!name) return "";
                // "debug_cv2_01" などの名前から "01.mov" に変換する
                const match = name.match(/debug_cv2_(\d+)/);
                if (match) {
                    return match[1] + ".mov";
                }
                return name;
            };
            
            const movA = toMovName(colA);
            const movB = toMovName(colB);
            const movC = toMovName(colC);
            
            if (movA && movB) {
                pairMap[movA] = movB;
                pairMap[movB] = movA;
            }
            
            if (movC) {
                singleSet.add(movC);
            }
        }
        console.log(`[pair] Config parsed. Map Pairs: ${Object.keys(pairMap).length / 2}, Singles: ${singleSet.size}`);
    } catch (e) {
        console.warn("CSVの読み込みに失敗しました。ペア連携なしの独立選択として進めます:", e);
    }
}

function selectIntelligentVideoForCycle(playerIndex, currentCycleSelections, chosenFileNames) {
    const prev = previousSelections[playerIndex];
    let candidates = [...metadataPool];
    
    // --- 先に同じサイクル内の前の画面でペア相方が残っているかチェック ---
    let pendingPairPartner = null;
    for (let k = 0; k < playerIndex; k++) {
        const selectedVideo = currentCycleSelections[k];
        if (selectedVideo) {
            const selectedName = selectedVideo[IDX.FNAME];
            const partner = pairMap[selectedName];
            if (partner && !chosenFileNames.has(partner)) {
                pendingPairPartner = partner;
                break; // 最初の未処理ペア相方を優先ブースト対象にする
            }
        }
    }

    // 各候補動画に対して初期重みを割り当てる
    let scoredCandidates = candidates.map(v => {
        let baseWeight = 1.0;
        const fname = v[IDX.FNAME];
        
        // 基本ルール1: 同じ姿勢は避ける
        if (prev && v[IDX.POS] === prev[IDX.POS]) {
            baseWeight = 0.0;
        }
        
        // 基本ルール2: 前回の動作が大地ベタ付き（Hardness高）なら、空間の広がり（Space）を優先
        if (prev && prev[IDX.HARD] > 5) {
            baseWeight *= (1.0 + v[IDX.SPACE] * 0.5); 
        }
        
        // 同時重複排除: 同じサイクル内で他の画面で既に選択済みの動画は避ける
        if (chosenFileNames.has(fname)) {
            baseWeight = 0.0;
        }

        // 追加ルール: 最後の画面 (playerIndex === 3) で未処理のペア相方がない場合、
        // このサイクル内での解決が不可能なため、新規のペア動画の投入を防ぐ (ベース重みを 0 に)
        if (playerIndex === 3 && !pendingPairPartner && pairMap[fname]) {
            baseWeight = 0.0;
        }
        
        return {
            data: v,
            weight: baseWeight
        };
    });
    
    // 有効な候補のみ抽出
    let filteredCandidates = scoredCandidates.filter(c => c.weight > 0);
    
    // 候補が空になった場合のフォールバック（姿勢重複等の制約を緩和）
    if (filteredCandidates.length === 0) {
        filteredCandidates = scoredCandidates.map(c => {
            let w = chosenFileNames.has(c.data[IDX.FNAME]) ? 0.0 : 1.0;
            // フォールバック中も、可能であれば最後の画面での新規ペア投入を避ける
            if (playerIndex === 3 && !pendingPairPartner && pairMap[c.data[IDX.FNAME]]) {
                w = 0.0;
            }
            return {
                data: c.data,
                weight: w
            };
        }).filter(c => c.weight > 0);
        
        if (filteredCandidates.length === 0) {
            // どうしても候補がない場合の最終的な重複排除ベースフォールバック
            filteredCandidates = scoredCandidates.map(c => ({
                data: c.data,
                weight: chosenFileNames.has(c.data[IDX.FNAME]) ? 0.0 : 1.0
            })).filter(c => c.weight > 0);
        }
    }
    
    // --- ペア動画連携ロジック (A/B列) のブースト適用 ---
    if (pendingPairPartner) {
        let boosted = false;
        filteredCandidates.forEach(c => {
            if (c.data[IDX.FNAME] === pendingPairPartner) {
                c.weight *= 1000.0; // 1000倍に選択確率を跳ね上げる (ブースト)
                boosted = true;
                console.log(`[logic] Boosted partner video ${pendingPairPartner} for Screen ${playerIndex+1}`);
            }
        });
        
        // 姿勢重複制限などで相方動画が除外されていた場合、演出意図を最優先するため制約をバイパスして復帰させる
        if (!boosted) {
            const partnerData = metadataPool.find(v => v[IDX.FNAME] === pendingPairPartner);
            if (partnerData && !chosenFileNames.has(pendingPairPartner)) {
                filteredCandidates.push({
                    data: partnerData,
                    weight: 1000.0 // 強制的に高確率枠で復帰
                });
                console.log(`[logic] Force-restored partner video ${pendingPairPartner} for Screen ${playerIndex+1} (bypassed posture constraint)`);
            }
        }
    }
    
    // --- 重み付きランダム（ルーレット選択） ---
    const totalWeight = filteredCandidates.reduce((sum, c) => sum + c.weight, 0);
    let r = Math.random() * totalWeight;
    let selectedItem = filteredCandidates[filteredCandidates.length - 1]; // デフォルトフォールバック
    
    for (let c of filteredCandidates) {
        r -= c.weight;
        if (r <= 0) {
            selectedItem = c;
            break;
        }
    }
    
    const selected = selectedItem.data;
    previousSelections[playerIndex] = selected;
    return selected;
}

async function runGlobalSequence() {
    while (true) {
        cycleCount++;
        console.log(`\n--- [Cycle ${cycleCount}] ---`);
        
        let currentCycleSelections = [null, null, null, null];
        let chosenFileNames = new Set();
        
        // 1サイクルで再生する4つの動画を連携選択
        for (let i = 0; i < 4; i++) {
            const videoData = selectIntelligentVideoForCycle(i, currentCycleSelections, chosenFileNames);
            currentCycleSelections[i] = videoData;
            chosenFileNames.add(videoData[IDX.FNAME]);
        }
        
        let syncTasks = [];
        for (let i = 0; i < 4; i++) {
            const videoData = currentCycleSelections[i];
            const fileName = videoData[IDX.FNAME];
            const weightScore = videoData[IDX.WEIGHT];   
            
            // 激しさ（Weight）をインデックスにして、それに伴う余韻をフィボナッチから決定
            const fibIndex = Math.min(weightScore, FIBONACCI.length - 1);
            const pauseDelays = FIBONACCI[fibIndex];

            console.log(`[Screen ${i+1}] Chosen: ${fileName} | Weight=${weightScore} -> Wait: ${pauseDelays}s`);

            // 各画面（仮想プレイヤー）の動画＋フィボナッチ余韻待機のPromiseをスタック
            syncTasks.push(players[i].playSequence(fileName, pauseDelays));
        }

        // 4画面すべての「動画」＋「余韻」が終了するまで同期待機
        await Promise.all(syncTasks);
        console.log(`--- Cycle ${cycleCount} Fully Synced ---`);
    }
}

document.getElementById('start-overlay').addEventListener('click', initSkinslides, { once: true });

