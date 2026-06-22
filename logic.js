// logic.js - skinslides Trigger-driven Interactive Video Player Logic
// [ファイル名, 秒数, 姿勢, 方向, Weight, Time, Space, Hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

let metadataPool = [];
let audioMetadataPool = [];
let players = [];
let cycleCount = 0;

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

        // 2. 音響メタデータ (sound_metadata.json) のロード
        const resAudio = await fetch('Audio%20analysis%20data/sound_metadata.json');
        audioMetadataPool = await resAudio.json();
        console.log(`[logic] Loaded ${audioMetadataPool.length} audio metadata records.`);

        // 3. グローバルシーケンスの開始
        runGlobalSequence();
    } catch (e) {
        console.error("JSONの読み込みまたは初期化に失敗しました:", e);
    }
}

// 映像特徴からトリガータイプに応じた動画を抽出する
function selectMatchingVideo(type, excludeSet = new Set()) {
    if (!metadataPool || metadataPool.length === 0) return null;

    let candidates = [];
    if (type === "アタック") {
        candidates = metadataPool.filter(v => v[IDX.WEIGHT] >= 6 && v[IDX.TIME] >= 6);
        if (candidates.length === 0) {
            candidates = [...metadataPool].sort((a, b) => (b[IDX.WEIGHT] + b[IDX.TIME]) - (a[IDX.WEIGHT] + a[IDX.TIME]));
        }
    } 
    else if (type === "うねり") {
        candidates = metadataPool.filter(v => v[IDX.SPACE] >= 6 && v[IDX.TIME] <= 4);
        if (candidates.length === 0) {
            candidates = [...metadataPool].sort((a, b) => (b[IDX.SPACE] - b[IDX.TIME]) - (a[IDX.SPACE] - a[IDX.TIME]));
        }
    } 
    else {
        // 刻み (Roll)
        candidates = metadataPool.filter(v => v[IDX.HARDNESS] >= 6 || v[IDX.HARD] >= 6);
        if (candidates.length === 0) {
            candidates = [...metadataPool].sort((a, b) => b[IDX.HARD] - a[IDX.HARD]);
        }
    }

    // 重複を避けるため除外リストにない候補をフィルタリング
    let filtered = candidates.filter(v => !excludeSet.has(v[IDX.FNAME]));
    if (filtered.length === 0) {
        filtered = candidates; // すべて除外されている場合はフォールバック
    }

    // 上位5つの候補からランダムに決定
    const index = Math.floor(Math.random() * Math.min(filtered.length, 5));
    return filtered[index];
}

// 特定の画面に動画を再生させるリアクション処理
function reactScreenWithVideo(screenNum, event, chosenInTrigger) {
    const player = players[screenNum - 1];
    if (!player) return;

    const videoEl = player.mediaEl;
    if (!videoEl) return;

    // トリガーの種類に合致する動画を選択
    const videoData = selectMatchingVideo(event.type, chosenInTrigger);
    if (videoData) {
        const videoFileName = videoData[IDX.FNAME];
        chosenInTrigger.add(videoFileName); // このトリガーイベント内で重複を避けるために登録

        let finalVideoName = videoFileName;
        const match = videoFileName.match(/(\d+)\.(mov|mp4)/i);
        if (match) {
            finalVideoName = `${match[1]}-Sss720p.mp4`;
        }

        // 動画のパスを設定し、再生してクラスを付与
        videoEl.src = VIDEO_BASE_PATH + finalVideoName;
        videoEl.play().then(() => {
            videoEl.classList.add("playing");
        }).catch(err => {
            console.warn(`[logic] Video play failed: ${finalVideoName}`, err);
        });

        // 再生終了時に非表示・リセット
        videoEl.onended = () => {
            videoEl.classList.remove("playing");
            videoEl.src = "";
        };
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
        let screenIndex = 0;

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

                        // 音の盛り上がり（Strength）とタイプに応じて表示する画面数（1〜3）を決定
                        let numScreens = 1;
                        if (event.type === "アタック" || event.strength >= 0.75) {
                            numScreens = 3; // 音の盛り上がり（アタック・大音量）で全3画面に絵を映し出す
                        } else if (event.type === "刻み" || event.strength >= 0.45) {
                            numScreens = 2; // 動きのある音が連続・中音量時は2画面
                        }

                        // 各画面の映像が重ならないように排他制御用のセットを作成
                        let chosenInTrigger = new Set();

                        // 順次画面を回転させてトリガー
                        for (let k = 0; k < numScreens; k++) {
                            const activeScreenNum = ((screenIndex + k) % 3) + 1;
                            reactScreenWithVideo(activeScreenNum, event, chosenInTrigger);
                        }
                        screenIndex = (screenIndex + numScreens) % 3;
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
