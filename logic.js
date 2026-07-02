// logic.js - skinslides Trigger-driven Interactive Video Player Logic
// [ファイル名, 秒数, 姿勢, 方向, Weight, Time, Space, Hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

let metadataPool = [];
let audioMetadataPool = [];
let players = [];
let cycleCount = 0;

// 4レベルの動画分類プール
let videoPools = { 1: [], 2: [], 3: [], 4: [] };

// 振付遷移状態
let currentScreen = 1;
let flowDirection = 1; // 1: 左から右（Screen 1 -> 2 -> 3）, -1: 右から左（Screen 3 -> 2 -> 1）

// アプリの初期化とデータロード
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
        console.log(`[logic] Loaded ${metadataPool.length} video metadata records.`);

        // 2. 動画の4レベル分類
        classifyVideos();

        // 3. 音響メタデータ (sound_metadata.json) のロード
        const resAudio = await fetch('Audio%20analysis%20data/sound_metadata.json');
        audioMetadataPool = await resAudio.json();
        console.log(`[logic] Loaded ${audioMetadataPool.length} audio metadata records.`);

        // 3.5 フリーズフレーム情報のロード
        await window.loadFreezeFrames();

        // 4. グローバルシーケンスの開始
        runGlobalSequence();
    } catch (e) {
        console.error("JSONの読み込みまたは初期化に失敗しました:", e);
    }
}

// 動画をActivityスコアに基づいて4レベルに分類する
function classifyVideos() {
    videoPools = { 1: [], 2: [], 3: [], 4: [] };
    metadataPool.forEach(v => {
        const weight = v[IDX.WEIGHT] || 0;
        const time = v[IDX.TIME] || 0;
        const hardness = v[IDX.HARD] || v[IDX.HARDNESS] || 0;
        const activity = (weight + time + hardness) / 3;
        v.activity = activity;
        
        if (activity < 1.0) {
            videoPools[1].push(v);
        } else if (activity < 2.5) {
            videoPools[2].push(v);
        } else if (activity < 4.0) {
            videoPools[3].push(v);
        } else {
            videoPools[4].push(v);
        }
    });
    console.log(`[logic] Classified videos: L1=${videoPools[1].length}, L2=${videoPools[2].length}, L3=${videoPools[3].length}, L4=${videoPools[4].length}`);
}

// 指定したレベルの動画プールからランダムに動画を選択する
function selectVideoByLevel(level, excludeSet = new Set()) {
    const pool = videoPools[level];
    if (!pool || pool.length === 0) {
        console.warn(`[logic] Pool for level ${level} is empty. Falling back to full metadataPool.`);
        return metadataPool[Math.floor(Math.random() * metadataPool.length)];
    }
    
    let filtered = pool.filter(v => !excludeSet.has(v[IDX.FNAME]));
    if (filtered.length === 0) {
        filtered = pool; // すべて除外されている場合はプール全体から選択
    }
    
    return filtered[Math.floor(Math.random() * filtered.length)];
}

// フィボナッチ数列に基づくフェード時間計算
function getFibonacciFadeTime(weight) {
    const fibs = [1, 1, 2, 3, 5, 8, 13];
    let idx = Math.min(Math.max(0, weight - 2), fibs.length - 1);
    if (weight <= 2) idx = 0;
    return fibs[idx];
}

// トリガーされる画面を決定する（境界判定と方向転換）
function getScreensToPlay(numScreens) {
    if (numScreens === 3) {
        return [1, 2, 3];
    }
    
    let selected = [];
    let tempScreen = currentScreen;
    let tempDir = flowDirection;
    
    for (let i = 0; i < numScreens; i++) {
        let attempts = 0;
        let found = false;
        while (attempts < 6) {
            let nextScreen = tempScreen + tempDir;
            if (nextScreen > 3) {
                tempDir = -1;
                nextScreen = 2; // 反転して2に戻る
            } else if (nextScreen < 1) {
                tempDir = 1;
                nextScreen = 2; // 反転して2に戻る
            }
            
            // 同一トリガー内での重複とロック状態を避ける
            if (!selected.includes(nextScreen) && !players[nextScreen - 1].isLocked) {
                tempScreen = nextScreen;
                selected.push(tempScreen);
                found = true;
                break;
            } else {
                tempScreen = nextScreen;
                attempts++;
            }
        }
        if (!found) {
            // ロックされていない他の画面を探す
            for (let s = 1; s <= 3; s++) {
                if (!selected.includes(s) && !players[s - 1].isLocked) {
                    selected.push(s);
                    tempScreen = s;
                    break;
                }
            }
            // それでも足りない場合はロック無視で空いている画面を追加
            if (selected.length <= i) {
                for (let s = 1; s <= 3; s++) {
                    if (!selected.includes(s)) {
                        selected.push(s);
                        tempScreen = s;
                        break;
                    }
                }
            }
        }
    }
    
    currentScreen = tempScreen;
    flowDirection = tempDir;
    return selected;
}

// 特定の画面に動画を再生させるリアクション処理
function reactScreenWithVideo(screenNum, event, chosenInTrigger) {
    const player = players[screenNum - 1];
    if (!player) return;

    const videoEl = player.mediaEl;
    if (!videoEl) return;

    // 音響イベントのレベル分類
    let audioLevel = 1;
    if (event.strength >= 0.75 || event.type === "アタック") {
        audioLevel = 4;
    } else if (event.strength >= 0.5) {
        audioLevel = 3;
    } else if (event.strength >= 0.25) {
        audioLevel = 2;
    } else {
        audioLevel = 1;
    }

    // 上書きロックチェック
    if (player.isLocked) {
        console.log(`[logic] Screen ${screenNum} is locked. Skipping trigger.`);
        return;
    }

    // レベルに対応した映像を選択
    const videoData = selectVideoByLevel(audioLevel, chosenInTrigger);
    if (!videoData) return;

    const videoFileName = videoData[IDX.FNAME];
    chosenInTrigger.add(videoFileName);

    // キャラクター遷移に合わせた回転角の計算 (90度 or 270度)
    // flowDirection === 1 (L2R) の場合は Top-to-Bottom, -1 (R2L) の場合は Bottom-to-Top
    const originalDir = videoData[IDX.DIR] || "S";
    let rotationAngle = 90;
    
    if (flowDirection === 1) {
        // 上から下への動きにする
        if (originalDir === "L2R") {
            rotationAngle = 90;
        } else if (originalDir === "R2L") {
            rotationAngle = 270;
        } else {
            rotationAngle = 90;
        }
    } else {
        // 下から上への動きにする
        if (originalDir === "L2R") {
            rotationAngle = 270;
        } else if (originalDir === "R2L") {
            rotationAngle = 90;
        } else {
            rotationAngle = 90;
        }
    }

    // CSSの回転プロパティを適用
    videoEl.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`;
    console.log(`[logic] React Screen ${screenNum} with ${videoFileName} (Level ${audioLevel}, Rotate ${rotationAngle}deg, FlowDir ${flowDirection})`);

    // レベルに応じた再生ロジックを実行
    if (audioLevel === 1) {
        player.playLevel1(videoFileName);
    } else if (audioLevel === 2) {
        const weight = videoData[IDX.WEIGHT] || 0;
        const fadeTime = getFibonacciFadeTime(weight);
        player.playLevel2(videoFileName, fadeTime);
    } else if (audioLevel === 3) {
        player.playLevel3(videoFileName);
    } else if (audioLevel === 4) {
        player.playLevel4(videoFileName);
    }
}

// 音声トリガー駆動のグローバルループ
async function runGlobalSequence() {
    console.log("[logic] Trigger-driven sequence started.");

    // scene2End00, scene2End01, scene2End02 のみを使用する
    const scene2EndTracks = audioMetadataPool.filter(t => t.file_id.includes("scene2End"));
    if (scene2EndTracks.length === 0) {
        console.error("[logic] No scene2End tracks found in metadata pool!");
        return;
    }

    const audioEl = document.getElementById("player-4");
    if (!audioEl) {
        console.error("[logic] player-4 element not found!");
        return;
    }

    while (true) {
        cycleCount++;
        
        // 3つのファイルをランダムで選択
        const selectedTrack = scene2EndTracks[Math.floor(Math.random() * scene2EndTracks.length)];
        const audioFileName = selectedTrack.file_id.replace(/\.(aif|aiff)$/i, '.mp3');
        
        console.log(`\n--- [Cycle ${cycleCount}] Playing: ${audioFileName} ---`);

        // トリガーイベントの準備
        const currentTrackEvents = selectedTrack.triggers.events.map((e, index) => ({
            id: `event_${index}`,
            time_sec: e.time_sec,
            type: e.type,
            strength: e.strength,
            onomatopoeia: e.onomatopoeia,
            triggered: false
        }));

        let triggeredEventIds = new Set();

        // 音声のロードと再生
        audioEl.src = AUDIO_BASE_PATH + audioFileName;
        audioEl.volume = 1.0;
        audioEl.load();

        await new Promise((resolvePlay) => {
            audioEl.play().then(resolvePlay).catch(err => {
                console.error("[logic] Audio play failed:", err);
                resolvePlay();
            });
        });

        // 高精度再生監視ループ
        await new Promise((resolveTrackFinished) => {
            function updateLoop() {
                if (audioEl.paused || audioEl.ended) {
                    resolveTrackFinished();
                    return;
                }

                const currentTime = audioEl.currentTime;

                currentTrackEvents.forEach(event => {
                    if (event.time_sec <= currentTime && !triggeredEventIds.has(event.id)) {
                        triggeredEventIds.add(event.id);
                        
                        console.log(`[Trigger] Type: ${event.type}, Time: ${event.time_sec.toFixed(1)}s, Strength: ${event.strength.toFixed(2)}, Onoma: ${event.onomatopoeia}`);

                        // 音響レベルの算出
                        let audioLevel = 1;
                        if (event.strength >= 0.75 || event.type === "アタック") {
                            audioLevel = 4;
                        } else if (event.strength >= 0.5) {
                            audioLevel = 3;
                        } else if (event.strength >= 0.25) {
                            audioLevel = 2;
                        } else {
                            audioLevel = 1;
                        }

                        // レベルに応じた画面トリガー数の決定
                        let numScreens = 1;
                        if (audioLevel === 4) {
                            numScreens = 3;
                        } else if (audioLevel === 3) {
                            numScreens = 2;
                        }

                        // 重複除外セット
                        let chosenInTrigger = new Set();

                        // 振付ステートマシンに基づいて対象画面を取得して順次再生
                        const screensToPlay = getScreensToPlay(numScreens);
                        screensToPlay.forEach(activeScreenNum => {
                            reactScreenWithVideo(activeScreenNum, event, chosenInTrigger);
                        });
                    }
                });

                requestAnimationFrame(updateLoop);
            }

            requestAnimationFrame(updateLoop);

            audioEl.onended = () => {
                resolveTrackFinished();
            };
        });

        console.log(`--- [Cycle ${cycleCount}] Track finished ---`);
        // サイクル間に短いブレイクを挟む
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

document.getElementById('start-overlay').addEventListener('click', initSkinslides, { once: true });
