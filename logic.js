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
    // start-overlayはプリロード完了後にユーザー操作で消去します

    players = [
        new VideoPlayer("player-1"),
        new VideoPlayer("player-2"),
        new VideoPlayer("player-3"),
        new VideoPlayer("player-4", true) 
    ];

    // 動画音声トグルボタンのイベントリスナー設定
    const audioToggleBtn = document.getElementById("toggle-video-audio");
    if (audioToggleBtn) {
        audioToggleBtn.addEventListener("click", () => {
            window.videosMuted = !window.videosMuted;
            players.forEach(p => p.setMute(window.videosMuted));
            audioToggleBtn.textContent = `Video Audio: ${window.videosMuted ? "OFF" : "ON"}`;
            audioToggleBtn.style.borderColor = window.videosMuted ? "rgba(255,255,255,0.1)" : "#00ffaa";
            addDecisionLog(`Video Audio toggled to: ${window.videosMuted ? "OFF (Muted)" : "ON (Unmuted)"}`, "info");
        });
        // 初期化状態の適用
        audioToggleBtn.textContent = `Video Audio: ${window.videosMuted ? "OFF" : "ON"}`;
        audioToggleBtn.style.borderColor = window.videosMuted ? "rgba(255,255,255,0.1)" : "#00ffaa";
    }

    // 動画ゲインスライダーのイベントリスナー設定
    const gainSlider = document.getElementById("video-gain-slider");
    const gainVal = document.getElementById("video-gain-val");
    if (gainSlider) {
        gainSlider.addEventListener("input", () => {
            const val = parseFloat(gainSlider.value);
            window.videoGainVolume = val;
            if (gainVal) gainVal.textContent = `${val.toFixed(1)}x`;
            players.forEach(p => p.setGain(val));
        });
        // 初期状態の適用
        const initialVal = window.videoGainVolume || 1.0;
        gainSlider.value = initialVal;
        if (gainVal) gainVal.textContent = `${initialVal.toFixed(1)}x`;
    }

    try {
        // Local videos folder auto-detection
        try {
            const testRes = await fetch("videos/05-Sss720p.mp4", { method: 'HEAD' });
            if (testRes.ok) {
                console.log("[logic] Local /videos/ folder detected. Using local videos same-origin source.");
                VIDEO_BASE_PATH = "videos/";
                addDecisionLog("Local videos folder detected. Using local videos (no CORS restriction, 50x Web Audio boost active).", "success");
            }
        } catch (e) {
            console.log("[logic] Local videos not found. Using Cloudflare R2.");
        }

        // プリロード用の動画要素プールを初期化
        players.forEach(p => p.initializePool(VIDEO_BASE_PATH));

        // 1. メタデータ (logic_weights.json) のロード
        let resWeights;
        try {
            resWeights = await fetch('logic_weights.json');
            if (!resWeights.ok) throw new Error();
        } catch (e) {
            console.warn('[fallback] Failed to fetch logic_weights.json locally, trying R2 fallback...');
            resWeights = await fetch(R2_BASE_URL + 'logic_weights.json');
        }
        metadataPool = await resWeights.json();
        console.log(`[logic] Loaded ${metadataPool.length} video metadata records.`);

        // 2. 動画の4レベル分類
        classifyVideos();

        // 3. 音響メタデータ (sound_metadata.json) のロード
        let resAudio;
        try {
            resAudio = await fetch('Audio%20analysis%20data/sound_metadata.json');
            if (!resAudio.ok) throw new Error();
        } catch (e) {
            console.warn('[fallback] Failed to fetch sound_metadata.json locally, trying R2 fallback...');
            resAudio = await fetch(R2_BASE_URL + 'Audio%20analysis%20data/sound_metadata.json');
        }
        audioMetadataPool = await resAudio.json();
        console.log(`[logic] Loaded ${audioMetadataPool.length} audio metadata records.`);

        // 3.5 フリーズフレーム情報のロード
        await window.loadFreezeFrames();

        // 4. ビデオのBlobプリロードを一括開始
        const preloadStatus = document.getElementById("preload-status");
        const preloadProgress = document.getElementById("preload-progress");
        const startBtnEl = document.getElementById("start-btn-el");
        
        await window.preloadAllVideos(VIDEO_BASE_PATH, (loaded, total) => {
            const pct = Math.round((loaded / total) * 100);
            if (preloadProgress) preloadProgress.textContent = `${pct}% (${loaded}/${total})`;
        });
        
        if (preloadStatus) {
            preloadStatus.style.color = "#00ffaa";
            preloadProgress.textContent = "Complete!";
            setTimeout(() => {
                preloadStatus.style.display = "none";
                if (startBtnEl) {
                    startBtnEl.style.display = "block";
                    startBtnEl.addEventListener('click', () => {
                        document.getElementById('start-overlay').style.display = 'none';
                        // グローバルシーケンスの開始
                        runGlobalSequence();
                    }, { once: true });
                }
            }, 800);
        } else {
            if (startBtnEl) {
                startBtnEl.style.display = "block";
                startBtnEl.addEventListener('click', () => {
                    document.getElementById('start-overlay').style.display = 'none';
                    // グローバルシーケンスの開始
                    runGlobalSequence();
                }, { once: true });
            }
        }
    } catch (e) {
        console.error("JSONの読み込みまたは初期化に失敗しました:", e);
    }
}

// 動画をActivityスコアに基づいて4レベルに分類する
// しきい値は、音響トリガーの実データ(strength分布)がどのレベルに何%の頻度で
// 落ちるかを実測し、その比率(L1:11%, L2:22%, L3:21%, L4:45%)に動画プールの
// 本数比が一致するように、Weight/Time/Space/Hardnessの4軸スコアから逆算した値。
// (旧しきい値はSpaceを score計算から除外しており、かつ絶対値固定だったため
//  L4プールが12本しかないのに全トリガーの45%を担うという偏りが生じていた)
function classifyVideos() {
    videoPools = { 1: [], 2: [], 3: [], 4: [] };
    metadataPool.forEach(v => {
        const weight = v[IDX.WEIGHT] || 0;
        const time = v[IDX.TIME] || 0;
        const space = v[IDX.SPACE] || 0;
        const hardness = v[IDX.HARD] || 0;
        const activity = (weight + time + space + hardness) / 4;
        v.activity = activity;

        if (activity <= 1.75) {
            videoPools[1].push(v);
        } else if (activity <= 2.25) {
            videoPools[2].push(v);
        } else if (activity <= 2.75) {
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
        addDecisionLog(`Screen ${screenNum}: LOCKED (Skipped)`, "warning");
        return;
    }

    // レベルに対応した映像を選択
    const videoData = selectVideoByLevel(audioLevel, chosenInTrigger);
    if (!videoData) return;

    // トリガーが成功したため、21秒の無音検出タイマーをリセット
    resetIdleTimer();

    const videoFileName = videoData[IDX.FNAME];
    chosenInTrigger.add(videoFileName);

    // キャラクター遷移に合わせた回転角の計算 (90度 or 270度)
    const originalDir = videoData[IDX.DIR] || "S";
    let rotationAngle = 90;
    
    if (flowDirection === 1) {
        if (originalDir === "L2R") {
            rotationAngle = 90;
        } else if (originalDir === "R2L") {
            rotationAngle = 270;
        } else {
            rotationAngle = 90;
        }
    } else {
        if (originalDir === "L2R") {
            rotationAngle = 270;
        } else if (originalDir === "R2L") {
            rotationAngle = 90;
        } else {
            rotationAngle = 90;
        }
    }

    // モニター用の再生情報をプレイヤーにセット
    player.currentVideoData = videoData;
    player.currentRotationAngle = rotationAngle;
    player.currentFlowDir = flowDirection;

    // CSSの回転プロパティを適用
    videoEl.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`;
    console.log(`[logic] React Screen ${screenNum} with ${videoFileName} (Level ${audioLevel}, Rotate ${rotationAngle}deg, FlowDir ${flowDirection})`);
    
    // アクションログを追記
    const lmaText = `W:${videoData[IDX.WEIGHT]} T:${videoData[IDX.TIME]} S:${videoData[IDX.SPACE]} H:${videoData[IDX.HARD]}`;
    addDecisionLog(`Screen ${screenNum} Triggered: Play ${videoFileName} (L${audioLevel}, ${rotationAngle}°, LMA: ${lmaText}, Flow:${flowDirection > 0 ? "L→R" : "R→L"})`, "info");

    const onPlaybackDone = () => {
        player.currentVideoData = null;
    };

    // レベルに応じた再生ロジックを実行
    if (audioLevel === 1) {
        player.playLevel1(videoFileName).then(onPlaybackDone);
    } else if (audioLevel === 2) {
        const weight = videoData[IDX.WEIGHT] || 0;
        const fadeTime = getFibonacciFadeTime(weight);
        player.playLevel2(videoFileName, fadeTime).then(onPlaybackDone);
    } else if (audioLevel === 3) {
        player.playLevel3(videoFileName).then(onPlaybackDone);
    } else if (audioLevel === 4) {
        player.playLevel4(videoFileName).then(onPlaybackDone);
    }
}

// プレイリストのトラック定義
const NORMAL_TRACKS = [
    "scene2End00.mp3", "scene2End01.mp3", "scene2End02.mp3",
    "T510.mp3", "T511.mp3", "T512.mp3", 
    "T513.mp3", "T514.mp3", "T515.mp3", "T516.mp3", "T517.mp3", 
    "T518.mp3", "T519.mp3", "T520.mp3", "T521.mp3", "T522.mp3", 
    "T523.mp3", "T524.mp3", "T525.mp3", "T526.mp3", 
    "T528.mp3", "T529.mp3", "T530.mp3", "T531.mp3", "T532.mp3", 
    "T533.mp3", "T535.mp3", "T536.mp3", "T537.mp3", 
    "T540.mp3", "T541.mp3"
];

const RARE_TRACKS = [
    "T538.mp3", "T538_00.mp3", "T538_0.mp3", "T538_01.mp3", 
    "T538_1.mp3", "T538_02.mp3", "T538_2.mp3"
];

let lastTrackFileName = null;
let lastWasRare = false;

let idleTimer = null;

function resetIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    // 21秒後に無音時自動トリガーを実行
    idleTimer = setTimeout(() => {
        triggerIdleFallbackVideo();
    }, 21000);
}

function triggerIdleFallbackVideo() {
    console.log("[logic] 21 seconds of inactivity detected. Triggering idle fallback video.");
    addDecisionLog("21s Inactivity: Triggering idle fallback video to maintain motion.", "success");
    
    // 現在ロックされておらず、再生中でない画面を選ぶ
    const availableScreens = [1, 2, 3].filter(screenNum => {
        const p = players[screenNum - 1];
        return p && !p.isLocked;
    });
    
    // すべてロックされている場合は、ランダムに画面を1つ選ぶ
    const targetScreen = availableScreens.length > 0 
        ? availableScreens[Math.floor(Math.random() * availableScreens.length)] 
        : Math.floor(Math.random() * 3) + 1;
        
    const fallbackEvent = {
        id: `idle_fallback_${Date.now()}`,
        time_sec: 0,
        type: "静寂",
        strength: 0.1,
        onomatopoeia: "しんしん"
    };
    
    let chosenInTrigger = new Set();
    reactScreenWithVideo(targetScreen, fallbackEvent, chosenInTrigger);
    
    // 再度タイマーをセット
    resetIdleTimer();
}

// 音声トリガー駆動のグローバルループ
async function runGlobalSequence() {
    console.log("[logic] Trigger-driven sequence started.");

    const audioEl = document.getElementById("player-4");
    if (!audioEl) {
        console.error("[logic] player-4 element not found!");
        return;
    }

    while (true) {
        cycleCount++;
        
        // 新しいサイクルの開始時にタイマーを一度クリア
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        
        let audioFileName = "";
        let selectedTrack = null;
        
        // 適切なトラック選択ループ
        let attempts = 0;
        while (attempts < 100) {
            attempts++;
            // 稀に出るトラック（RARE_TRACKS）の抽選条件：前回が稀でなく、かつ10%の確率
            const useRare = !lastWasRare && (Math.random() < 0.10);
            const pool = useRare ? RARE_TRACKS : NORMAL_TRACKS;
            
            const candidateName = pool[Math.floor(Math.random() * pool.length)];
            
            // 前回と同じ曲は連続使用しない
            if (candidateName !== lastTrackFileName) {
                // sound_metadata.json から該当ファイルを探す (.mp4/.mp3 の拡張子揺れや .aif 揺れに対応)
                selectedTrack = audioMetadataPool.find(t => {
                    const normFileId = t.file_id.replace(/\.(aif|aiff|mp3)$/i, '').toLowerCase();
                    const normCandName = candidateName.replace(/\.mp3$/i, '').toLowerCase();
                    return normFileId === normCandName;
                });
                
                if (selectedTrack) {
                    audioFileName = candidateName;
                    lastWasRare = useRare;
                    break;
                }
            }
        }
        
        // フォールバック（万が一見つからなかった場合はデフォルトでscene2End00を再生）
        if (!selectedTrack) {
            audioFileName = "scene2End00.mp3";
            selectedTrack = audioMetadataPool.find(t => t.file_id.includes("scene2End00"));
            lastWasRare = false;
        }
        
        lastTrackFileName = audioFileName;
        
        console.log(`\n--- [Cycle ${cycleCount}] Playing: ${audioFileName} (Rare: ${lastWasRare}) ---`);
        
        // トラック名表示を更新
        const trackNameEl = document.getElementById("ana-track-name");
        if (trackNameEl) trackNameEl.textContent = audioFileName;
        
        addDecisionLog(`--- [Cycle ${cycleCount}] Loaded track: ${audioFileName} ---`, "success");

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

        // タイムライン冒頭の黒画面を防ぐため、初期状態で全画面にLevel 1（静寂）動画をロード
        const initialQuietEvent = {
            id: "initial_quiet",
            time_sec: 0,
            type: "静寂",
            strength: 0.1,
            onomatopoeia: "しんしん"
        };
        let startChosen = new Set();
        [1, 2, 3].forEach(screenNum => {
            reactScreenWithVideo(screenNum, initialQuietEvent, startChosen);
        });

        // 高精度再生監視ループ
        await new Promise((resolveTrackFinished) => {
            function updateLoop() {
                if (audioEl.paused || audioEl.ended) {
                    resolveTrackFinished();
                    return;
                }

                const currentTime = audioEl.currentTime;
                const duration = audioEl.duration || 0;

                // タイムライン描画とモニター表示の更新
                drawTimeline(currentTime, duration, currentTrackEvents);
                updateMonitorUI();
                
                const timeEl = document.getElementById("ana-time");
                if (timeEl) timeEl.textContent = `${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`;

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

                        // 意思決定ログにイベント出力
                        addDecisionLog(`AUDIO ONSET: ${event.onomatopoeia} (Time: ${event.time_sec.toFixed(1)}s, Level ${audioLevel}, Strength: ${event.strength.toFixed(2)}) -> Triggering ${numScreens} screens`, "warning");

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
        addDecisionLog(`--- Track Finished ---`, "success");
        
        // トラック終了時にタイマーをクリア（次のトラックが始まるまでの3秒間の誤トリガーを防ぐ）
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        
        // 曲の終了後に次の曲まで3秒待機する
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

// タイムライン描画 (Canvas)
function drawTimeline(currentTime, duration, events) {
    const canvas = document.getElementById("timeline-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    
    ctx.clearRect(0, 0, width, height);
    
    // 背景
    ctx.fillStyle = "rgba(10, 10, 15, 0.4)";
    ctx.fillRect(0, 0, width, height);
    
    // 中央の軸線
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    if (duration <= 0) return;
    
    // トリガープット
    events.forEach(e => {
        const x = (e.time_sec / duration) * width;
        let color = "#555577";
        let radius = 3;
        let lineH = 10;
        let level = 1;
        
        if (e.strength >= 0.75 || e.type === "アタック") {
            level = 4;
            color = "#ff7700";
            radius = 5;
            lineH = 30;
        } else if (e.strength >= 0.5) {
            level = 3;
            color = "#00bfff";
            radius = 4.5;
            lineH = 22;
        } else if (e.strength >= 0.25) {
            level = 2;
            color = "#00ffaa";
            radius = 4;
            lineH = 16;
        }
        
        ctx.strokeStyle = color;
        ctx.lineWidth = level >= 3 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, (height - lineH) / 2);
        ctx.lineTo(x, (height + lineH) / 2);
        ctx.stroke();
        
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, height / 2, radius, 0, Math.PI * 2);
        ctx.fill();
        
        if (e.time_sec <= currentTime) {
            ctx.fillStyle = color + "22";
            ctx.beginPath();
            ctx.arc(x, height / 2, radius * 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });
    
    // 現在時間のインジケーター (プレイヘッド)
    const playheadX = (currentTime / duration) * width;
    ctx.strokeStyle = "#ff3366";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    
    ctx.fillStyle = "#ff3366";
    ctx.beginPath();
    ctx.moveTo(playheadX - 6, 0);
    ctx.lineTo(playheadX + 6, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();
}

// スクリーンステータスの更新
function updateMonitorUI() {
    players.forEach((player, index) => {
        const screenNum = index + 1;
        if (screenNum > 3) return; // 音声プレイヤー除外
        
        const stateEl = document.getElementById(`scr${screenNum}-state`);
        const videoEl = document.getElementById(`scr${screenNum}-video`);
        const lmaEl = document.getElementById(`scr${screenNum}-lma`);
        const actEl = document.getElementById(`scr${screenNum}-activity`);
        const rotEl = document.getElementById(`scr${screenNum}-rot`);
        const freezeEl = document.getElementById(`scr${screenNum}-freezes`);
        
        if (!stateEl) return;
        
        // 1. 状態表示
        let stateText = "IDLE";
        let stateColor = "#8892b0";
        if (player.isLocked) {
            stateText = "LOCKED (L3)";
            stateColor = "#00bfff";
        } else if (player.mediaEl.paused) {
            if (player.freezeTimeout) {
                stateText = "FREEZING";
                stateColor = "#ff7700";
            } else if (player.mediaEl.src && player.mediaEl.currentTime > 0) {
                stateText = "PAUSED";
                stateColor = "#ffaa00";
            } else {
                stateText = "IDLE";
            }
        } else {
            stateText = "PLAYING";
            stateColor = "#00ffaa";
        }
        stateEl.textContent = stateText;
        stateEl.style.color = stateColor;
        
        // 2. メタデータ表示
        if (player.currentVideoData) {
            const vData = player.currentVideoData;
            videoEl.textContent = vData[0];
            
            const w = vData[IDX.WEIGHT];
            const t = vData[IDX.TIME];
            const s = vData[IDX.SPACE];
            const h = vData[IDX.HARD] || 0;
            lmaEl.textContent = `W:${w} T:${t} S:${s} H:${h}`;

            const actScore = vData.activity !== undefined ? vData.activity : (w + t + s + h) / 4;
            actEl.textContent = `${actScore.toFixed(2)}`;
            
            const rot = player.currentRotationAngle || 90;
            const origDir = vData[IDX.DIR] || "S";
            rotEl.textContent = `${rot}° / ${origDir} (Flow:${player.currentFlowDir > 0 ? "L→R" : "R→L"})`;
            
            const freezes = window.freezeFramesPool ? (window.freezeFramesPool[vData[0]] || []) : [];
            if (freezes.length > 0) {
                freezeEl.textContent = freezes.map(sec => `${(sec * 30).toFixed(0)}f (${sec.toFixed(1)}s)`).join(", ");
            } else {
                freezeEl.textContent = "None";
            }
        } else {
            videoEl.textContent = "-";
            lmaEl.textContent = "-";
            actEl.textContent = "-";
            rotEl.textContent = "-";
            freezeEl.textContent = "-";
        }
    });
}

// 意思決定ログに追記する関数
function addDecisionLog(message, type = "info") {
    const logEl = document.getElementById("decision-log");
    if (!logEl) return;
    
    const timeStr = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${timeStr}] ${message}`;
    
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    
    while (logEl.children.length > 100) {
        logEl.removeChild(logEl.firstChild);
    }
}
window.addDecisionLog = addDecisionLog; // player.jsからも呼べるようにグローバル化

window.addEventListener('load', initSkinslides);
