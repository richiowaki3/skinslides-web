// [ファイル名, 秒数, 姿勢, 方向, Weight, Time, Space, Hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

// フィボナッチ（休符・1秒〜21秒）
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

// 同期モード設定
// 'clip'       : 映像が終了したら音声をフェードアウトし、次のサイクルへ進む（推奨）
// 'continuous' : 音声はバックグラウンドで独立して再生し続け、映像サイクルとは同期しない
// 'full_sync'  : 音声が完全に再生終了するまで、映像画面は黒画面のまま待機する
const AUDIO_SYNC_MODE = 'clip';

let metadataPool = [];
let audioMetadataPool = []; // 音響解析データプール
let players = [];
let previousSelections = [null, null, null, null]; // インデックス 0,1,2 は映像、3 は音声
let cycleCount = 0;
let lastAudioFileId = null; // 直前に再生された音声ファイル名（重複回避用）

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

        // 2. 音響メタデータ (sound_metadata.json) のロード
        const resAudio = await fetch('Audio%20analysis%20data/sound_metadata.json');
        audioMetadataPool = await resAudio.json();
        console.log(`[logic] Loaded ${audioMetadataPool.length} audio metadata records.`);

        // 3. ペア・単独連携設定 (sss-abc.csv) のロードとパース
        await loadPairConfig();

        // 4. グローバルシーケンスの開始
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

        // 追加ルール: 最後の映像画面 (playerIndex === 2) で未処理のペア相方がない場合、
        // このサイクル内での解決が不可能なため、新規のペア動画の投入を防ぐ (ベース重みを 0 に)
        if (playerIndex === 2 && !pendingPairPartner && pairMap[fname]) {
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
            if (playerIndex === 2 && !pendingPairPartner && pairMap[c.data[IDX.FNAME]]) {
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

// 映像特徴の平均ベクトルに最も近い音響ファイルをインテリジェントに選択する
function selectIntelligentAudio(avgWeight, avgTime, avgSpace, avgHardness) {
    if (!audioMetadataPool || audioMetadataPool.length === 0) {
        console.warn("[audio] Metadata pool is empty. No audio will play.");
        return null;
    }

    // 4つの次元（Weight, Time, Space, Hardness）でEuclidean距離を算出
    const scored = audioMetadataPool.map(track => {
        const timbre = track.profile.timbre.full_vector_0_9;
        const dist = Math.sqrt(
            Math.pow(avgWeight - timbre.Weight, 2) +
            Math.pow(avgTime - timbre.Time, 2) +
            Math.pow(avgSpace - timbre.Space, 2) +
            Math.pow(avgHardness - timbre.Hardness, 2)
        );
        return { track, dist };
    });

    // 距離の近い順（最も親和性が高い順）にソート
    scored.sort((a, b) => a.dist - b.dist);

    // 演出の多様性を担保するため、最も近い上位5つの候補から選択する
    const topCandidates = scored.slice(0, Math.min(5, scored.length));
    
    // 直前に流れた音声との重複を回避
    let bestIndex = 0;
    while (bestIndex < topCandidates.length && topCandidates[bestIndex].track.file_id === lastAudioFileId) {
        bestIndex++;
    }
    if (bestIndex >= topCandidates.length) {
        bestIndex = 0; // 重複回避できない場合はフォールバック
    }

    const selected = topCandidates[bestIndex].track;
    lastAudioFileId = selected.file_id;
    return selected;
}

// バックグラウンドで音声を連続再生するための独立ループ（continuousモード用）
async function runContinuousAudioLoop() {
    console.log("[Audio Loop] Continuous background audio sequence started.");
    while (true) {
        // 現在（または直前）に選択されている3画面の映像パラメータの平均をクエリにする
        let sumWeight = 0, sumTime = 0, sumSpace = 0, sumHard = 0;
        let count = 0;
        for (let k = 0; k < 3; k++) {
            const v = previousSelections[k];
            if (v) {
                sumWeight += v[IDX.WEIGHT];
                sumTime += v[IDX.TIME];
                sumSpace += v[IDX.SPACE];
                sumHard += v[IDX.HARD];
                count++;
            }
        }
        
        // 映像がまだ再生されていない場合は標準値 (4.5) とする
        const avgW = count > 0 ? sumWeight / count : 4.5;
        const avgT = count > 0 ? sumTime / count : 4.5;
        const avgS = count > 0 ? sumSpace / count : 4.5;
        const avgH = count > 0 ? sumHard / count : 4.5;

        const audioData = selectIntelligentAudio(avgW, avgT, avgS, avgH);
        if (!audioData) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        const audioFileName = audioData.file_id.replace(/\.(aif|aiff)$/i, '.mp3');
        console.log(`[Audio Loop] Playing: ${audioFileName} | Dynamism: ${audioData.profile.amount.dynamism_score} (continuous)`);
        
        // 音響ファイルをフル再生（待機ディレイは0）
        previousSelections[3] = audioData;
        await players[3].playSequence(audioFileName, 0);
    }
}

async function runGlobalSequence() {
    // バックグラウンド連続再生（continuous）の場合は、音声ループを別スレッドで走らせる
    if (AUDIO_SYNC_MODE === 'continuous') {
        runContinuousAudioLoop();
    }

    while (true) {
        cycleCount++;
        console.log(`\n--- [Cycle ${cycleCount}] ---`);
        
        let currentCycleSelections = [null, null, null, null];
        let chosenFileNames = new Set();
        
        // 1. 3画面分 (player 1〜3) の映像を従来通り連携選択
        for (let i = 0; i < 3; i++) {
            const videoData = selectIntelligentVideoForCycle(i, currentCycleSelections, chosenFileNames);
            currentCycleSelections[i] = videoData;
            chosenFileNames.add(videoData[IDX.FNAME]);
        }

        // 2. 映像3画面の特徴の平均値を算出
        let sumWeight = 0, sumTime = 0, sumSpace = 0, sumHard = 0;
        for (let i = 0; i < 3; i++) {
            const v = currentCycleSelections[i];
            sumWeight += v[IDX.WEIGHT];
            sumTime += v[IDX.TIME];
            sumSpace += v[IDX.SPACE];
            sumHard += v[IDX.HARD];
        }
        const avgWeight = sumWeight / 3.0;
        const avgTime = sumTime / 3.0;
        const avgSpace = sumSpace / 3.0;
        const avgHardness = sumHard / 3.0;

        // 3. 同期再生タスクの構成
        let syncTasks = [];

        // 映像タスクの開始
        for (let i = 0; i < 3; i++) {
            const videoData = currentCycleSelections[i];
            const fileName = videoData[IDX.FNAME];
            const weightScore = videoData[IDX.WEIGHT];   
            
            const fibIndex = Math.min(weightScore, FIBONACCI.length - 1);
            const pauseDelays = FIBONACCI[fibIndex];

            console.log(`[Screen ${i+1}] Chosen: ${fileName} | Weight=${weightScore} -> Wait: ${pauseDelays}s`);
            syncTasks.push(players[i].playSequence(fileName, pauseDelays));
        }

        // 同期モードに応じた音声タスクの実行と待機制御
        if (AUDIO_SYNC_MODE === 'continuous') {
            // バックグラウンド連続再生モード：映像タスクの終了のみを同期待機
            await Promise.all(syncTasks);
            console.log(`--- Cycle ${cycleCount} Video Synced (Audio playing in background) ---`);
        } 
        else if (AUDIO_SYNC_MODE === 'clip') {
            // カットアウト（フェードアウト）モード：
            const audioData = selectIntelligentAudio(avgWeight, avgTime, avgSpace, avgHardness);
            if (audioData) {
                const audioFileName = audioData.file_id.replace(/\.(aif|aiff)$/i, '.mp3');
                console.log(`[Audio] Chosen: ${audioFileName} | Matching avg (W:${avgWeight.toFixed(1)}, T:${avgTime.toFixed(1)}, S:${avgSpace.toFixed(1)}, H:${avgHardness.toFixed(1)})`);
                
                // 音声再生を開始（ブロックしない）
                players[3].playSequence(audioFileName, 0);
                
                // 映像タスク（映像再生＋フィボナッチ待機）が完了するのを待つ
                await Promise.all(syncTasks);
                
                // 映像サイクルが終わったら音声を1.5秒でフェードアウトして停止
                console.log(`[Audio] Video cycle finished. Fading out audio...`);
                await players[3].fadeOut(1500);
                players[3].stop();
            } else {
                await Promise.all(syncTasks);
            }
            console.log(`--- Cycle ${cycleCount} Synced (Audio clipped) ---`);
        } 
        else if (AUDIO_SYNC_MODE === 'full_sync') {
            // 完全同期モード：
            const audioData = selectIntelligentAudio(avgWeight, avgTime, avgSpace, avgHardness);
            if (audioData) {
                const audioFileName = audioData.file_id.replace(/\.(aif|aiff)$/i, '.mp3');
                console.log(`[Audio] Chosen: ${audioFileName} | Weight=${audioData.profile.timbre.full_vector_0_9.Weight} (full sync)`);
                
                // 映像タスクと音声タスクの両方の終了を待機する
                const audioTask = players[3].playSequence(audioFileName, 0);
                await Promise.all([...syncTasks, audioTask]);
            } else {
                await Promise.all(syncTasks);
            }
            console.log(`--- Cycle ${cycleCount} Fully Synced (All assets finished) ---`);
        }
    }
}

document.getElementById('start-overlay').addEventListener('click', initSkinslides, { once: true });

