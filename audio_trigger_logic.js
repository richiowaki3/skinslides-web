// audio_trigger_logic.js

let videoMetadataPool = [];
let audioMetadataPool = [];
let currentTrackEvents = [];
let triggeredEventIds = new Set();
let isPlaying = false;

// Initialize VideoPlayer instances
const players = [
    new VideoPlayer("video-1"),
    new VideoPlayer("video-2"),
    new VideoPlayer("video-3")
];

// 4レベルの動画分類プール
let videoPools = { 1: [], 2: [], 3: [], 4: [] };

// 振付遷移状態
let currentScreen = 1;
let flowDirection = 1; // 1: L2R, -1: R2L

const audioElement = document.getElementById("audio-element");
const playButton = document.getElementById("play-btn");
const cutupButton = document.getElementById("cutup-btn");
const trackSelect = document.getElementById("track-select");
const currentTimeDisplay = document.getElementById("current-time");
const totalTriggersDisplay = document.getElementById("total-triggers");
const nextTriggerDisplay = document.getElementById("next-trigger");
const progressBar = document.getElementById("progress-bar");
const logPanel = document.getElementById("log-panel");

// New UI bindings for parameters and visualizer (with defensive null checks)
const modeSelect = document.getElementById("mode-select");
const thresholdSlider = document.getElementById("threshold-slider");
const thresholdVal = document.getElementById("threshold-val");
const intervalSlider = document.getElementById("interval-slider");
const intervalVal = document.getElementById("interval-val");
const visualizerCanvas = document.getElementById("visualizer-canvas");
const canvasCtx = visualizerCanvas ? visualizerCanvas.getContext("2d") : null;
const tendencyBadge = document.getElementById("tendency-badge");

// Web Audio API states
let audioCtx = null;
let analyser = null;
let source = null;
let rmsHistory = [];
const RMS_HISTORY_LIMIT = 20; // 330ms history at 60fps
let lastTriggerTimeRealtime = 0;
let trackVocab = [];
let trackDominantMotion = "刻み";

window.audioBufferCache = {}; // filename -> AudioBuffer（遅延デコード・LRU上限つき）

// モバイル/タブレット判定（iPadOSのデスクトップ表示は Mac + マルチタッチで判別）
const IS_MOBILE_DEVICE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform));

// cut-up が選曲に使う全トラックのファイル名リスト（プリロードはしない）
window.cutupTrackFiles = [];
function buildCutupTrackFileList() {
    return Array.from(ALLOWED_TRACKS_SET).map(id => {
        if (id.includes("scene2end")) {
            return id.replace("scene2end", "scene2End") + ".mp3";
        }
        // 先頭の t のみ大文字化して実ファイル名の大小に合わせる（例: t525fix -> T525fix.mp3）
        return id.replace(/^t/, "T") + ".mp3";
    });
}

// --- 音声の遅延デコード ---
// 旧実装は起動時に38曲すべてを AudioBuffer(生PCM) へ展開しており、合計約2GBに達して
// iPhone Safari のタブメモリ上限を超えクラッシュしていた（"A problem repeatedly occurred"）。
// 現在は「そのスライスで鳴らす曲だけ」を取得・デコードし、LRUで上限本数を保つ。
// 圧縮データのHTTPキャッシュはブラウザ任せ（二重キャッシュしない）。
const AUDIO_BUFFER_CACHE_MAX = IS_MOBILE_DEVICE ? 3 : 8;
let audioBufferLRU = []; // 使った順（末尾が最新）
const audioBufferInflight = {}; // filename -> Promise（同時要求のデデュープ）
let decodeCtx = null; // audioCtx 未初期化時のフォールバック用

function touchAudioBufferLRU(file) {
    audioBufferLRU = audioBufferLRU.filter(f => f !== file);
    audioBufferLRU.push(file);
    while (audioBufferLRU.length > AUDIO_BUFFER_CACHE_MAX) {
        const evict = audioBufferLRU.shift();
        delete window.audioBufferCache[evict];
        // 再生中の BufferSource はノード自身が参照を保持しているため、キャッシュから外しても安全
    }
}

async function getAudioBuffer(file) {
    if (window.audioBufferCache[file]) {
        touchAudioBufferLRU(file);
        return window.audioBufferCache[file];
    }
    if (audioBufferInflight[file]) return audioBufferInflight[file];

    const url = AUDIO_BASE_PATH + file + (window.VIDEO_CACHE_BUST || "");
    audioBufferInflight[file] = (async () => {
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            const ctx = audioCtx || decodeCtx
                || (decodeCtx = new (window.AudioContext || window.webkitAudioContext)());
            const decoded = await ctx.decodeAudioData(arrayBuffer);
            window.audioBufferCache[file] = decoded;
            touchAudioBufferLRU(file);
            return decoded;
        } catch (e) {
            console.warn(`[demo] Failed to fetch/decode audio for ${file}:`, e);
            return null;
        } finally {
            delete audioBufferInflight[file];
        }
    })();
    return audioBufferInflight[file];
}

// Fetch metadata files
async function loadMetadata() {
    try {
        // Local videos folder auto-detection
        try {
            // 720p / 360p のどちらかが置いてあればローカルとみなす（縮小版のみの構成にも対応）
            const SUFFIXES = ["Sss720p", "Sss360p"];
            const probes = await Promise.all(
                SUFFIXES.map(sfx =>
                    fetch(`videos/05-${sfx}.mp4`, { method: 'HEAD' }).then(r => r.ok).catch(() => false))
            );
            const localSuffix = SUFFIXES[probes.indexOf(true)];
            if (localSuffix) {
                console.log(`[demo] Local /videos/ folder detected (${localSuffix}). Using local videos same-origin source.`);
                VIDEO_BASE_PATH = "videos/";
                // このページは detectVideoQuality() を持たないため、実在した画質をここで確定させる。
                // (未設定だと全箇所が既定の Sss720p を参照し、360pのみの構成では全て404になる)
                window.VIDEO_QUALITY_SUFFIX = localSuffix;
                addDecisionLog("Local videos folder detected. Using local videos (no CORS restriction, 50x Web Audio boost active).", "success");
            }
        } catch (e) {
            console.log("[demo] Local videos not found. Using Cloudflare R2.");
        }

        // ローカル検出で画質が決まらなかった＝R2経路。モバイルは回線が細く再生開始が遅いので
        // 360pを強制し、コラージュ枠が3秒の猶予内に再生開始できる確率を上げる。
        // (デスクトップのR2経路は未設定のまま→既定の Sss720p を使う)
        if (!window.VIDEO_QUALITY_SUFFIX && IS_MOBILE_DEVICE) {
            window.VIDEO_QUALITY_SUFFIX = "Sss360p";
            console.log("[demo] Mobile device on R2: forcing 360p (Sss360p) for faster start.");
            addDecisionLog("Mobile device: forcing 360p videos (faster start, more tiles visible).", "success");
        }

        // プリロード用の動画要素プールを初期化
        players.forEach(p => p.initializePool(VIDEO_BASE_PATH));

        // Load videos metadata
        const resVideos = await fetch("logic_weights.json");
        videoMetadataPool = await resVideos.json();
        console.log(`[demo] Loaded ${videoMetadataPool.length} videos metadata.`);

        // 実在する動画だけをプールに残す（欠番選択による一瞬の黒画面を防ぐ）
        await filterAvailableVideos(VIDEO_BASE_PATH);

        // パイプ連結用の入り口/出口の辺データ
        await loadPipeEdges();

        // 動画の4レベル分類
        classifyVideos();

        // フリーズフレーム情報のロード
        await window.loadFreezeFrames();

        // Load audios metadata
        let resAudios;
        try {
            resAudios = await fetch("Audio%20analysis%20data/sound_metadata.json");
            if (!resAudios.ok) throw new Error();
        } catch (e) {
            console.warn("[fallback] Failed to fetch sound_metadata.json locally, trying R2 fallback...");
            resAudios = await fetch(R2_BASE_URL + "Audio%20analysis%20data/sound_metadata.json");
        }
        audioMetadataPool = await resAudios.json();
        console.log(`[demo] Loaded ${audioMetadataPool.length} audios metadata.`);

        // ビデオのBlobプリロードを一括開始
        const preloadStatus = document.getElementById("preload-status");
        const preloadProgress = document.getElementById("preload-progress");
        const overlayProgress = document.getElementById("overlay-preload-progress");
        const playBtn = document.getElementById("play-btn");
        const cutupBtn = document.getElementById("cutup-btn");
        
        // cut-up の選曲候補リストを構築（音声本体はスライス再生時に遅延デコードする。
        // 旧来の「全曲事前デコード」は約2GBのPCMを常駐させ、iPhoneでクラッシュしていた）
        window.cutupTrackFiles = buildCutupTrackFileList();

        // FASTモード(?fast=1): プリロードを飛ばして即ボタン表示。test-level2の動作確認用。
        // (test-level2は動画をR2から直接ストリーミングし、動画終了で進むため音声・事前DL不要)
        // モバイル端末でも動画Blobプリロードはスキップ（メモリ節約。直接ストリーミングで再生）
        const FAST_TEST = new URLSearchParams(location.search).has("fast");
        if (!FAST_TEST && !IS_MOBILE_DEVICE) {
            if (preloadProgress) preloadProgress.textContent = "0% (0/18 videos)";
            if (overlayProgress) overlayProgress.textContent = "0%";
            await window.preloadAllVideos(VIDEO_BASE_PATH, (loaded, total) => {
                const pct = Math.round((loaded / total) * 100);
                if (preloadProgress) preloadProgress.textContent = `${pct}% (${loaded}/${total} videos)`;
                if (overlayProgress) overlayProgress.textContent = `${pct}%`;
            });
        } else if (IS_MOBILE_DEVICE) {
            console.warn("[demo] Mobile device: 動画Blob/音声の事前ロードをスキップ（直接ストリーミング+遅延デコード）。");
        } else {
            console.warn("[demo] FAST test mode: プリロードをスキップ(test-level2はR2から直接再生)。");
        }
        
        if (preloadStatus) {
            preloadStatus.style.color = "var(--accent-green)";
            preloadProgress.textContent = "Complete!";
        }
        
        if (overlayProgress) {
            overlayProgress.textContent = "100%";
        }
        
        // Hide loading progress on overlay and show launch buttons (Item 7)
        setTimeout(() => {
            const progressContainer = document.getElementById("overlay-preload-status-container");
            const buttonsContainer = document.getElementById("overlay-buttons-container");
            if (progressContainer) progressContainer.style.display = "none";
            if (buttonsContainer) buttonsContainer.style.display = "flex";
            
            // Wire buttons (Item 7)
            const planABtn = document.getElementById("choose-plan-a");
            const planBBtn = document.getElementById("choose-plan-b");
            const overlay = document.getElementById("start-overlay");

            // 本番(index.html): 起動ボタンは1つだけで、押したら Combination を開始する。
            // テストページ(audio_trigger_demo.html)にはこのボタンが無いので何も起きない。
            const mainBtn = document.getElementById("start-btn-el");
            if (mainBtn) {
                mainBtn.style.display = "block";
                mainBtn.addEventListener("click", () => {
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    startCombination();
                }, { once: true });
            }

            if (planABtn) {
                planABtn.addEventListener("click", () => {
                    // Play A はコンバート対象外。従来の 3840x2160 枠のまま動かす。
                    document.body.classList.add("plan-a");
                    if (window.updateAppScale) window.updateAppScale();
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    if (playBtn) playBtn.style.display = "block";
                    if (cutupBtn) cutupBtn.style.display = "block";
                    playSequence();
                });
            }
            if (planBBtn) {
                planBBtn.addEventListener("click", () => {
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    if (playBtn) playBtn.style.display = "block";
                    if (cutupBtn) cutupBtn.style.display = "block";
                    startCutUpPlayback();
                });
            }
            // special: 動画90/91/92 と音声T525/526/527 を対でループ再生
            const specialBtn = document.getElementById("choose-special");
            if (specialBtn) {
                specialBtn.addEventListener("click", () => {
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    startSpecialScene();
                });
            }
            // Combination: Play B(2分) と test-level2(音声1曲) を交互に、数巡ごとにスペシャル
            const combiBtn = document.getElementById("choose-combination");
            if (combiBtn) {
                combiBtn.addEventListener("click", () => {
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    if (playBtn) playBtn.style.display = "block";
                    startCombination();
                });
            }
            // test-level2: 水道管パイプ (向き付き動画をレベル2 onsetで連結する再生テスト)
            const testL2Btn = document.getElementById("choose-test-level2");
            if (testL2Btn) {
                testL2Btn.addEventListener("click", () => {
                    if (overlay) {
                        overlay.style.opacity = "0";
                        setTimeout(() => { overlay.style.display = "none"; }, 500);
                    }
                    if (playBtn) playBtn.style.display = "block";
                    if (modeSelect) modeSelect.value = "test-level2";
                    enterTestLevel2();
                    playSequence();
                });
            }
        }, 500);

        // Hook up Video Audio Toggle
        const audioToggleBtn = document.getElementById("toggle-video-audio");
        if (audioToggleBtn) {
            audioToggleBtn.addEventListener("click", () => {
                window.videosMuted = !window.videosMuted;
                players.forEach(p => p.setMute(window.videosMuted));
                audioToggleBtn.textContent = `Video Audio: ${window.videosMuted ? "OFF" : "ON"}`;
                audioToggleBtn.style.borderColor = window.videosMuted ? "rgba(255,255,255,0.1)" : "var(--accent-green)";
                addDecisionLog(`Video Audio toggled to: ${window.videosMuted ? "OFF (Muted)" : "ON (Unmuted)"}`, "info");
            });
            audioToggleBtn.textContent = `Video Audio: ${window.videosMuted ? "OFF" : "ON"}`;
            audioToggleBtn.style.borderColor = window.videosMuted ? "rgba(255,255,255,0.1)" : "var(--accent-green)";
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

        // Populate track select dropdown
        populateTrackSelect();
    } catch (e) {
        console.error("[demo] Failed to load metadata files:", e);
        logMessage("SYSTEM", "Failed to load metadata. Check paths.");
    }
}

const ALLOWED_TRACKS_SET = new Set([
    "scene2end00", "scene2end01", "scene2end02",
    "t510", "t511", "t512", "t513", "t514", "t515", "t516", "t517", 
    "t518", "t519", "t520", "t521", "t522", "t523", "t524", "t525", "t526", 
    "t528", "t529", "t530", "t531", "t532", "t533", "t535", "t536", "t537", 
    "t538", "t540", "t541", "t538_00", "t538_0", "t538_01", "t538_1",
    "t538_02", "t538_2",
    "t525fix", "t526fix", "t527fix" // Agent B 専用ノンストップ枠
]);

function populateTrackSelect() {
    if (!trackSelect) return;
    trackSelect.innerHTML = '<option value="" disabled selected>Select an audio track...</option>';
    
    // 許可された音響トラックのみをフィルタリング
    const sortedAudios = [...audioMetadataPool]
        .filter(track => {
            const baseId = track.file_id.replace(/\.(aif|aiff|mp3)$/i, '').toLowerCase();
            return ALLOWED_TRACKS_SET.has(baseId);
        })
        .sort((a, b) => b.profile.amount.dynamism_score - a.profile.amount.dynamism_score);

    sortedAudios.forEach(track => {
        const option = document.createElement("option");
        option.value = track.file_id;
        option.textContent = `${track.file_id} (Dynamism: ${track.profile.amount.dynamism_score})`;
        trackSelect.appendChild(option);
    });

    trackSelect.addEventListener("change", handleTrackChange);
}

// Log viewer helper
function logMessage(type, message) {
    if (!logPanel) return;
    const timeStr = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = "log-entry";
    
    const timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = `[${timeStr}]`;
    
    const typeSpan = document.createElement("span");
    typeSpan.className = `log-type ${type.toLowerCase()}`;
    typeSpan.textContent = `[${type}]`;
    
    const msgSpan = document.createElement("span");
    msgSpan.className = "log-msg";
    msgSpan.textContent = message;
    
    entry.appendChild(timeSpan);
    entry.appendChild(typeSpan);
    entry.appendChild(msgSpan);
    
    logPanel.appendChild(entry);
    logPanel.scrollTop = logPanel.scrollHeight;

    // マップ下の可視ログにもミラー（Play B のライブ活動を表示）
    const dl = document.getElementById("decision-log");
    if (dl) {
        const l = document.createElement("div");
        l.className = "log-line " + type.toLowerCase();
        l.textContent = `[${timeStr}] [${type}] ${message}`;
        dl.appendChild(l);
        dl.scrollTop = dl.scrollHeight;
        while (dl.children.length > 120) dl.removeChild(dl.firstChild);
    }

    // #log-panel 本体にも上限を設け、無制限に溜まってDOMが肥大化→長時間で動画停止するのを防ぐ
    while (logPanel.children.length > 200) {
        logPanel.removeChild(logPanel.firstChild);
    }
}

// Track loader
function loadTrack(fileId) {
    const trackData = audioMetadataPool.find(t => t.file_id === fileId);
    if (!trackData) return;

    // Load MP3 file (mapping .aif to .mp3)
    const mp3FileName = fileId.replace(/\.(aif|aiff)$/i, ".mp3");
    if (audioElement) {
        audioElement.src = AUDIO_BASE_PATH + mp3FileName;
        audioElement.load();
    }

    const trackNameEl = document.getElementById("ana-track-name");
    if (trackNameEl) trackNameEl.textContent = mp3FileName;
    
    // Also update timeline Agent A track label (Item 3)
    const agentLabelA = document.getElementById("timeline-agent-label-a");
    if (agentLabelA) {
        agentLabelA.innerHTML = `Track: <span id="ana-track-name-a" style="color: var(--text-muted); font-weight: normal;">${mp3FileName}</span>`;
    }

    addDecisionLog(`--- Loaded track: ${mp3FileName} ---`, "success");

    // ライブマップ: 読み込んだトラックを点灯させる。これまで Play B の cut-up 経路でしか
    // 呼ばれておらず、test-level2 / special ではマップが暗いままだった。
    if (window.LexMap) LexMap.setTrack("A", mp3FileName);

    // Prepare events
    currentTrackEvents = trackData.triggers.events.map((e, index) => ({
        id: `${fileId}_event_${index}`,
        time_sec: e.time_sec,
        type: e.type,
        strength: e.strength,
        onomatopoeia: e.onomatopoeia,
        triggered: false
    }));

    triggeredEventIds.clear();
    rmsHistory = [];

    // Analyze sound tendency and dynamically adjust settings
    const onsetRate = trackData.notes.onset_rate_per_sec || 0.0;
    trackDominantMotion = trackData.profile.change_quality.dominant_motion || "刻み";
    
    let autoInterval = 250;
    let autoThreshold = 1.35;
    let tendencyText = "";
    
    if (onsetRate > 3.0) {
        autoInterval = 250;
        autoThreshold = 1.20; // More sensitive for clicky sounds
        tendencyText = "Clicky / Rapid (小刻み・速い)";
        if (tendencyBadge) tendencyBadge.style.color = "#00ffaa";
    } else if (onsetRate > 1.5) {
        autoInterval = 500;
        autoThreshold = 1.30;
        tendencyText = "Moderate (標準)";
        if (tendencyBadge) tendencyBadge.style.color = "#00bfff";
    } else if (onsetRate > 0.8) {
        autoInterval = 1000;
        autoThreshold = 1.35;
        tendencyText = "Slower (やや遅い)";
        if (tendencyBadge) tendencyBadge.style.color = "#ffaa00";
    } else {
        autoInterval = 1500;
        autoThreshold = 1.45; // Less sensitive for slow drone swells
        tendencyText = "Drone / Atmospheric (持続音・うねり)";
        if (tendencyBadge) tendencyBadge.style.color = "#ff0055";
    }
    
    if (tendencyBadge) tendencyBadge.textContent = tendencyText;
    
    // Auto-update slider values (with null safety checks)
    if (intervalSlider) {
        intervalSlider.value = autoInterval;
    }
    if (intervalVal) {
        intervalVal.textContent = autoInterval + "ms";
    }
    if (thresholdSlider) {
        thresholdSlider.value = autoThreshold;
    }
    if (thresholdVal) {
        thresholdVal.textContent = autoThreshold.toFixed(2) + "x";
    }

    // Build vocab pool for this track
    const timbreOnomas = trackData.profile.timbre.onomatopoeia || [];
    const eventOnomas = trackData.triggers.events.map(e => e.onomatopoeia);
    trackVocab = [...new Set([...timbreOnomas, ...eventOnomas].filter(Boolean))];
    if (trackVocab.length === 0) {
        trackVocab = ["しーん"];
    }

    // Reset displays
    if (currentTimeDisplay) currentTimeDisplay.textContent = `0.0s / ${trackData.notes.duration_sec}s`;
    if (totalTriggersDisplay) totalTriggersDisplay.textContent = "0";
    if (progressBar) progressBar.style.width = "0%";
    
    if (logPanel) logPanel.innerHTML = "";
    logMessage("SYSTEM", `Loaded track: ${mp3FileName}`);
    logMessage("SYSTEM", `Duration: ${trackData.notes.duration_sec}s, Total Events: ${currentTrackEvents.length}`);

    updateNextTriggerDisplay();
}

// Track change handler
function handleTrackChange() {
    stopSequence();
    if (!trackSelect) return;
    const fileId = trackSelect.value;
    loadTrack(fileId);
}

function updateNextTriggerDisplay() {
    if (!nextTriggerDisplay) return;
    if (!audioElement || !audioElement.duration) {
        nextTriggerDisplay.textContent = "--";
        return;
    }
    
    if (modeSelect && modeSelect.value === "realtime") {
        nextTriggerDisplay.textContent = "Active (リアルタイム解析)";
        return;
    }

    const currentTime = audioElement.currentTime;
    const next = currentTrackEvents.find(e => e.time_sec > currentTime && !triggeredEventIds.has(e.id));
    if (next) {
        nextTriggerDisplay.textContent = `${next.time_sec.toFixed(1)}s [${next.type}]`;
    } else {
        nextTriggerDisplay.textContent = "Finished";
    }
}

// Play/Pause control
if (playButton) {
    playButton.addEventListener("click", () => {
        if (!audioElement || !audioElement.src) {
            alert("Please select a track first!");
            return;
        }

        if (isPlaying) {
            pauseSequence();
        } else {
            playSequence();
        }
    });
}

if (cutupButton) {
    cutupButton.addEventListener("click", () => {
        if (isCutUpPlaying) {
            stopCutUpPlayback();
        } else {
            startCutUpPlayback();
        }
    });
}

function initAudioContext() {
    if (audioCtx) return;
    if (!audioElement) return;
    
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256; // 128 frequency bins
        
        // CORS must be set on audio element to allow Web Audio access to Cloudflare R2
        audioElement.crossOrigin = "anonymous";
        
        source = audioCtx.createMediaElementSource(audioElement);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        
        console.log("[demo] Web Audio API initialized successfully.");
    } catch (e) {
        console.error("[demo] Failed to initialize Web Audio API:", e);
    }
}

function playSequence() {
    if (!audioElement) return;
    
    // Fullscreen clean aesthetic for Art Appreciation
    document.body.classList.add("is-playing");
    
    if (isCutUpPlaying) {
        stopCutUpPlayback();
    }
    
    // Auto-select first available track if none is selected
    if (trackSelect && !trackSelect.value) {
        const firstOption = Array.from(trackSelect.options).find(o => o.value !== "");
        if (firstOption) {
            trackSelect.value = firstOption.value;
            loadTrack(firstOption.value); // Load directly without calling stopSequence()!
        }
    }
    
    // UI統一: 音声レーンBは常時表示(シーン遷移でダッシュボードの高さが跳ねないように)。
    // Play A のみ従来どおり1レーン表示(コンバート対象外・現状維持)。
    const sectionB = document.getElementById("timeline-section-b");
    if (sectionB) sectionB.style.display = document.body.classList.contains("plan-a") ? "none" : "block";
    
    // Initialize Web Audio Context on user interaction
    initAudioContext();
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }

    audioElement.play().then(() => {
        isPlaying = true;
        if (playButton) {
            playButton.textContent = "Pause Sequence";
            playButton.style.background = "linear-gradient(135deg, #ff3366 0%, #ff0055 100%)";
            playButton.style.boxShadow = "0 4px 15px rgba(255, 0, 85, 0.3)";
        }
        logMessage("CONTROL", "Sequence started");
        
        // タイムライン冒頭の黒画面を防ぐため、初期状態で全画面にLevel 1（静寂）動画をロード
        // (test-level2 は独自のパイプ台を使うため、通常3画面の初期ロードはスキップ)
        if (!(modeSelect && modeSelect.value === "test-level2")) {
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
        }
        
        // Start precision loop
        requestAnimationFrame(updateLoop);
    }).catch(e => {
        console.error("Audio play failed:", e);
        alert("Audio playback blocked. Click select / drag track first.");
    });
}

function pauseSequence() {
    if (audioElement) audioElement.pause();
    isPlaying = false;
    // 曲間待機中の自動次曲進行をキャンセル
    if (advanceTimeoutId) { clearTimeout(advanceTimeoutId); advanceTimeoutId = null; }
    if (playButton) {
        playButton.textContent = "Play Sequence";
        playButton.style.background = "linear-gradient(135deg, #0088ff 0%, #00bfff 100%)";
        playButton.style.boxShadow = "0 4px 15px rgba(0, 191, 255, 0.3)";
    }
    logMessage("CONTROL", "Sequence paused");
}

function stopSequence() {
    if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
    }
    isPlaying = false;
    // 曲間待機中の自動次曲進行をキャンセル
    if (advanceTimeoutId) { clearTimeout(advanceTimeoutId); advanceTimeoutId = null; }
    document.body.classList.remove("is-playing");
    if (playButton) {
        playButton.textContent = "Play Sequence";
        playButton.style.background = "linear-gradient(135deg, #0088ff 0%, #00bfff 100%)";
        playButton.style.boxShadow = "none";
    }
    
    // Restore timeline B section
    const sectionB = document.getElementById("timeline-section-b");
    if (sectionB) sectionB.style.display = "block";
    
    // Clear idle timer
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    // Clear screens
    players.forEach((player, idx) => {
        player.stop();
        const wrapper = document.getElementById(`wrapper-${idx + 1}`);
        if (wrapper) wrapper.classList.remove("active");
    });
}

const activeAgentDisplay = document.getElementById("active-agent");
const collageContainer = document.getElementById("duet-collage-container");
const collageWrapper = document.getElementById("duet-collage-wrapper");
const normalScreensContainer = document.getElementById("normal-screens-container");

let collageVideos = [];
let collageZIndex = 1;
let lastBox = null; // 直前に配置された動画の実際の可視バウンディングボックス

// 統一サイズ梯子（全シーン共通・約0.618倍ずつの6段）。
// Play B のタイルも test-level2 のパイプカードもこの梯子の中でリサイズされる。
const SIZE_LADDER = [
    { w: 1240, h: 620 }, { w: 766, h: 383 }, { w: 474, h: 237 },
    { w: 293, h: 146 },  { w: 181, h: 90 },  { w: 112, h: 56 },
];
// Plan Bコラージュのキャンバス寸法（基本画角 16:9 / 最大 1920x1080）
const COLLAGE_W = 1920;
const COLLAGE_H = 1080;

/* ── コラージュの詰まり具合 ──────────────────────────────────────────
 * 「一瞬で消える」は素材の尺が短いからではなく、押し出しが早すぎるために
 * 起きていた(素材は最短4.8秒・中央値36.9秒)。さらに、枠は opacity:0 で
 * 挿入され onplaying で初めて表示されるため、表示される前に押し出されると
 * 一度も絵が出ない = 「絵が出ていない状態」になっていた。
 * → 枠ごとに最低滞在時間を持たせ、それを過ぎた枠から押し出す。
 * ------------------------------------------------------------------ */
// 実測: オンセットは中央値 5.36/秒、A/B 両系統が走るので約 10.7/秒。従来は全オンセットが
// 無条件に発火しており、4枠では1枚あたり約0.37秒しか生きられなかった。ブラウザが再生を
// 開始する前に押し出されるため、一度も絵が出ない枠が大量に発生していた。
// 枠を増やすだけでは足りない(10秒滞在には108枠必要)ため、発火自体を間引く。
//   実効滞在 ≈ COLLAGE_SLOTS × COLLAGE_MIN_GAP_MS
// モバイルは同時デコード本数の上限(特にiOS Safari)が低いため、枠を4に減らして
// 「用意した枠が全部映る」状態に寄せる。デスクトップは従来どおり6枠。
const COLLAGE_SLOTS = IS_MOBILE_DEVICE ? 4 : 6;   // 同時表示数(モバイル4 / デスクトップ6)
const COLLAGE_MIN_GAP_MS = 250;     // 通常イベントの最小発火間隔(軽い debounce)
const COLLAGE_STRONG_GAP_MS = 120;  // 強いイベント(アタック)は詰めて出してよい
let lastCollageSpawnAt = 0;
// 最低滞在は6秒だが、枠が即座に再利用されるとは限らないため実効滞在の中央値は
// 約10〜11秒になる(実オンセット列でのシミュレーション実測)。
const COLLAGE_DWELL_MS = 6000;      // 通常の最低滞在
const COLLAGE_FLASH_MS = 1200;      // 「一瞬で消える」枠の滞在
const COLLAGE_FLASH_RATE = 0.30;    // 一瞬になる割合(実効の一瞬率は約11%に落ち着く)
const COLLAGE_STUCK_MS = 3000;      // 読み込みが詰まった枠を諦めるまでの上限

// この枠を押し出してよくなる時刻。まだ一度も映っていない枠は絵が出るまで待つ。
function collageEvictableAt(w) {
    if (!w) return 0;
    if (w.dataset.state === "FREEZING") return 0;     // 再生し終えた枠はいつでも押し出せる
    if (!w._shownAt) return w._bornAt + COLLAGE_STUCK_MS;
    return w._shownAt + w._dwellMs;
}

// コラージュ用の素材選択。約10秒の尺を厚めにするが、除外はしない(全52本が出うる)。
// Play A 側の selectVideoByLevel は従来のまま(凍結中のため触らない)。
const COLLAGE_TARGET_SEC = 10;
function selectCollageVideo(level, excludeSet = new Set()) {
    const pool = videoPools[level];
    if (!pool || !pool.length) return selectVideoByLevel(level, excludeSet);
    let filtered = pool.filter(v => !excludeSet.has(v[0]));
    if (!filtered.length) filtered = pool;
    let total = 0;
    const ws = filtered.map(v => {
        const sec = parseFloat(v[1]) || 0;
        // 10秒でピーク、離れるほど 0.35 へなだらかに落とす(対数距離のガウス)。
        // さらに短尺(8秒未満)は減衰させる。短い素材は再生し終えて静止画になり、
        // 次のトリガーで即押し出されるため「一瞬で消える」側に寄ってしまうため。
        const r = sec > 0 ? Math.log(sec / COLLAGE_TARGET_SEC) : 0;
        const w = (0.35 + Math.exp(-(r * r) / 1.2)) * Math.pow(Math.min(1, sec / 10), 2);
        total += w;
        return w;
    });
    let t = Math.random() * total;
    for (let i = 0; i < filtered.length; i++) { t -= ws[i]; if (t <= 0) return filtered[i]; }
    return filtered[filtered.length - 1];
}

function resizeCollage() {
    const container = document.getElementById("duet-collage-container");
    const wrapper = document.getElementById("duet-collage-wrapper");
    // 非表示中は clientWidth が 0 になり scale(0) を書き込んでコラージュを消してしまうため、
    // 幅が取れないときは何もしない。
    if (wrapper && container && wrapper.clientWidth > 0) {
        const scale = wrapper.clientWidth / COLLAGE_W;
        container.style.transform = `scale(${scale})`;
    }
}
window.addEventListener("resize", resizeCollage);

let isCutUpPlaying = false;
let selectedPlan = "A";
let activeCollageSlots = new Array(COLLAGE_SLOTS).fill(null); // 同時表示枠のマッピング
let nextSlotIndex = 0;

// Agent A (Slicer) State
let cutUpNodeA = null;
let cutUpTimerA = null;
let cutUpVideoTimeoutsA = [];
let cutUpStartTimeA = 0;
let cutUpDurationA = 0;
let cutUpEventsA = [];
let playbackStartTimeA = 0;

// Agent B (Ambient) State
let cutUpNodeB = null;
let cutUpTimerB = null;
let cutUpVideoTimeoutsB = [];
let cutUpStartTimeB = 0;
let cutUpDurationB = 0;
let cutUpEventsB = [];
let playbackStartTimeB = 0;

function startCutUpPlayback() {
    initAudioContext();
    if (isPlaying) {
        stopSequence();
    }
    
    isCutUpPlaying = true;
    soloBActive = false; // ソロ状態を毎回リセット（前回の途中停止対策）
    document.body.classList.add("is-playing");
    if (cutupButton) {
        cutupButton.textContent = "Stop Cut-up Test";
        cutupButton.style.background = "linear-gradient(135deg, #ff3366 0%, #ff0055 100%)";
        cutupButton.style.boxShadow = "none";
    }
    
    // Show timeline track B and restore Agent label titles (Item 3)
    const sectionB = document.getElementById("timeline-section-b");
    if (sectionB) sectionB.style.display = "block";
    
    const agentLabelA = document.getElementById("timeline-agent-label-a");
    if (agentLabelA) {
        agentLabelA.innerHTML = `Agent A (Slicer / Left): <span id="ana-track-name-a" style="color: var(--text-muted); font-weight: normal;">None</span>`;
    }
    
    // Show duet collage wrapper and hide normal screens container
    // (screen-container の CSS は display:flex !important のため、important付きで上書きしないと隠れない)
    if (collageWrapper) collageWrapper.style.setProperty("display", "block", "important");
    if (normalScreensContainer) normalScreensContainer.style.setProperty("display", "none", "important");
    
    // Adjust scaling immediately
    resizeCollage();
    
    // Clear any previous collage videos and state
    clearCollageVideos();
    lastBox = null;
    activeCollageSlots = new Array(COLLAGE_SLOTS).fill(null);
    nextSlotIndex = 0;
    lastCollageSpawnAt = 0;

    logMessage("CONTROL", "Audio Cut-up Duet started (Twin-Agent Stereo Mode)");
    
    // タイムライン冒頭の黒画面を防ぐため、初期状態で全画面にLevel 1（静寂）動画をロード
    const initialQuietEvent = {
        id: "initial_quiet",
        time_sec: 0,
        type: "静寂",
        strength: 0.1,
        onomatopoeia: "しんしん"
    };
    triggerCollageVideo(initialQuietEvent);

    // Launch both loops concurrently! (Item 5)
    playNextCutUpSlice("AgentA");
    playNextCutUpSlice("AgentB");
    
    requestAnimationFrame(updateCutUpLoop);
}

function stopCutUpPlayback() {
    isCutUpPlaying = false;
    soloBActive = false;
    hideSoloVideo();
    if (window.LexMap) LexMap.clearAll(); // マップを俯瞰へ戻す（発光クリア）
    document.body.classList.remove("is-playing");
    if (cutupButton) {
        cutupButton.textContent = "Start Audio Cut-up Test";
        cutupButton.style.background = "linear-gradient(135deg, #ff7700 0%, #ff8800 100%)";
        cutupButton.style.boxShadow = "none";
    }
    
    if (activeAgentDisplay) {
        activeAgentDisplay.textContent = "IDLE";
        activeAgentDisplay.style.color = "var(--text-muted)";
    }
    
    // Hide duet collage wrapper and show normal screens container
    if (collageWrapper) collageWrapper.style.setProperty("display", "none", "important");
    if (normalScreensContainer) normalScreensContainer.style.setProperty("display", "flex", "important");
    
    // Clear collage videos and state
    clearCollageVideos();
    lastBox = null;
    activeCollageSlots = new Array(COLLAGE_SLOTS).fill(null);
    
    // Clear idle timer
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    
    // Stop Slicer (A)
    if (cutUpNodeA) {
        try { cutUpNodeA.stop(); } catch (e) {}
        cutUpNodeA = null;
    }
    // Stop Ambient (B)
    if (cutUpNodeB) {
        try { cutUpNodeB.stop(); } catch (e) {}
        cutUpNodeB = null;
    }
    
    // Clear Slicer Timer
    if (cutUpTimerA) {
        clearTimeout(cutUpTimerA);
        cutUpTimerA = null;
    }
    // Clear Ambient Timer
    if (cutUpTimerB) {
        clearTimeout(cutUpTimerB);
        cutUpTimerB = null;
    }
    
    cutUpVideoTimeoutsA.forEach(t => clearTimeout(t));
    cutUpVideoTimeoutsA = [];
    cutUpVideoTimeoutsB.forEach(t => clearTimeout(t));
    cutUpVideoTimeoutsB = [];
    
    // Clear screens
    players.forEach((player, idx) => {
        player.stop();
        const wrapper = document.getElementById(`wrapper-${idx + 1}`);
        if (wrapper) wrapper.classList.remove("active");
    });
    
    // Restore monitor UI cards to IDLE
    updateMonitorUI();
    
    logMessage("CONTROL", "Audio Cut-up Test stopped");
}

// Agent B が T525fix/T526fix/T527fix を選んだ間だけ true。この間 Agent A は再生されない。
let soloBActive = false;
const FIX_SOLO_TRACKS = new Set(["t525fix", "t526fix", "t527fix"]);
// fix枠 → センター投影する特殊動画（720p・回転無し）の番号。番号順で対応。
const SOLO_VIDEO_MAP = { "t525fix": "90", "t526fix": "91", "t527fix": "92" };

// ソロ用: 特殊動画を画面センターに投影（コラージュは隠す）。全尺(約7分)再生後は
// 音トラック終了→次スライスで非fixが選ばれてソロ解除され、自動で通常シーンへ戻る。
function showSoloVideo(normName) {
    const wrap = document.getElementById("solo-video-wrap");
    const vid = document.getElementById("solo-video");
    if (!wrap || !vid) return;
    const num = SOLO_VIDEO_MAP[normName] || "90";
    // 90/91/92 も通常ライブラリと同じ p 付き命名 (90-Sss720p.mp4 / 90-Sss360p.mp4) に統一済み。
    // 品質選択(Sss720p/Sss360p)にそのまま追従する。
    const soloSuffix = window.VIDEO_QUALITY_SUFFIX || "Sss720p";
    vid.src = VIDEO_BASE_PATH + `${num}-${soloSuffix}.mp4` + (window.VIDEO_CACHE_BUST || "");
    vid.loop = false;
    wrap.classList.add("active");
    if (collageContainer) collageContainer.style.opacity = "0";
    vid.play().catch(e => console.warn("[demo] solo video play failed:", e));
}
function hideSoloVideo() {
    const wrap = document.getElementById("solo-video-wrap");
    const vid = document.getElementById("solo-video");
    if (vid) { try { vid.pause(); } catch (e) {} vid.removeAttribute("src"); if (vid.load) vid.load(); }
    if (wrap) wrap.classList.remove("active");
    if (collageContainer) collageContainer.style.opacity = "1";
}

async function playNextCutUpSlice(agentId) {
    if (!isCutUpPlaying) return;

    const fileKeys = (window.cutupTrackFiles && window.cutupTrackFiles.length)
        ? window.cutupTrackFiles : Object.keys(window.audioBufferCache);
    if (fileKeys.length === 0) {
        logMessage("ERROR", "No cut-up track list available!");
        stopCutUpPlayback();
        return;
    }

    // Pick random track — fix枠(ノンストップ)は Agent B 専用。Agent A の候補からは除外する。
    let pickKeys = fileKeys;
    if (agentId === "AgentA") {
        pickKeys = fileKeys.filter(f => !FIX_SOLO_TRACKS.has(f.replace(/\.(aif|aiff|mp3|wav)$/i, "").toLowerCase()));
        if (pickKeys.length === 0) pickKeys = fileKeys;
    }
    const randomFile = pickKeys[Math.floor(Math.random() * pickKeys.length)];
    // 遅延デコード: この曲の AudioBuffer をここで取得（キャッシュ済みなら即時）
    const audioBuffer = await getAudioBuffer(randomFile);
    if (!isCutUpPlaying) return; // デコード待ちの間に停止された
    if (!audioBuffer) {
        // 取得失敗（ネットワーク等）: 少し待って別トラックで再試行
        logMessage("ERROR", `Failed to load ${randomFile} — retrying with another track.`);
        setTimeout(() => { if (isCutUpPlaying) playNextCutUpSlice(agentId); }, 1000);
        return;
    }

    // Find metadata
    const trackData = audioMetadataPool.find(t => {
        const normFileId = t.file_id.replace(/\.(aif|aiff|mp3)$/i, '').toLowerCase();
        const normRandFile = randomFile.replace(/\.mp3$/i, '').toLowerCase();
        return normFileId === normRandFile;
    });

    // --- Agent B ノンストップ枠 (T525fix/T526fix/T527fix) ---
    const normName = randomFile.replace(/\.(aif|aiff|mp3|wav)$/i, "").toLowerCase();
    const isBSolo = (agentId === "AgentB") && FIX_SOLO_TRACKS.has(normName);

    // ソロ中は Agent A を再生しない（解除時に B が再開させる）
    if (agentId === "AgentA" && soloBActive) {
        return;
    }
    if (agentId === "AgentB") {
        if (isBSolo && !soloBActive) {
            // ソロ開始: Agent A を停止（音・映像・次スライス予約をクリア）
            soloBActive = true;
            if (cutUpTimerA) { clearTimeout(cutUpTimerA); cutUpTimerA = null; }
            if (cutUpNodeA) { try { cutUpNodeA.stop(); } catch (e) {} cutUpNodeA = null; }
            cutUpVideoTimeoutsA.forEach(t => clearTimeout(t));
            cutUpVideoTimeoutsA = [];
            const elA = document.getElementById("ana-track-name-a");
            if (elA) elA.textContent = `— paused (${randomFile} solo)`;
            if (window.LexMap) LexMap.setTrack("A", "");
            showSoloVideo(normName); // fix枠に対応する特殊動画を720p・回転無し・センター投影
            logMessage("CONTROL", `[AGENT B] Nonstop solo: ${randomFile} — Agent A paused`);
        } else if (!isBSolo && soloBActive) {
            // ソロ解除: 特殊動画を消してコラージュへ戻り、Agent A を再開
            soloBActive = false;
            hideSoloVideo();
            logMessage("CONTROL", "Agent B solo ended — resuming Agent A");
            setTimeout(() => { if (isCutUpPlaying) playNextCutUpSlice("AgentA"); }, 50);
        }
    }

    // フィボナッチ数列による再生尺（秒）の決定
    const FIBONACCI_SECS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    const validFibs = FIBONACCI_SECS.filter(f => f <= audioBuffer.duration);
    if (validFibs.length === 0) validFibs.push(1);
    
    let targetDuration = 1.0;
    const splitIndex = Math.max(1, Math.floor(validFibs.length / 2));
    
    if (agentId === "AgentA") {
        // Agent A Slicer (Short range loop sizes)
        const pool = validFibs.slice(0, Math.min(validFibs.length, splitIndex + 1));
        targetDuration = pool[Math.floor(Math.random() * pool.length)];
    } else {
        // Agent B Ambient (Long range loop sizes)
        const pool = validFibs.slice(splitIndex);
        targetDuration = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : validFibs[validFibs.length - 1];
    }

    // ノンストップ枠は全尺再生（スライスせず頭から最後まで）
    if (isBSolo) targetDuration = audioBuffer.duration;

    let targetStartTime = 0.0;
    let events = [];
    
    if (!trackData || !trackData.triggers.events || trackData.triggers.events.length === 0) {
        targetStartTime = Math.random() * Math.max(0.1, audioBuffer.duration - targetDuration);
    } else {
        const eventsPool = trackData.triggers.events;
        let chosenEvent = null;
        
        if (agentId === "AgentA") {
            // Agent A prefers "アタック"
            const attacks = eventsPool.filter(e => e.type === "アタック");
            chosenEvent = attacks.length > 0 ? attacks[Math.floor(Math.random() * attacks.length)] : eventsPool[Math.floor(Math.random() * eventsPool.length)];
            targetStartTime = Math.max(0, chosenEvent.time_sec - 0.1 - Math.random() * 0.2);
        } else {
            // Agent B prefers "うねり" or "静寂"
            const ambients = eventsPool.filter(e => e.type === "うねり" || e.type === "静寂");
            chosenEvent = ambients.length > 0 ? ambients[Math.floor(Math.random() * ambients.length)] : eventsPool[Math.floor(Math.random() * eventsPool.length)];
            targetStartTime = Math.max(0, chosenEvent.time_sec - 1.0 - Math.random() * 2.0);
        }
        
        // Bounds check
        if (targetStartTime + targetDuration > audioBuffer.duration) {
            targetStartTime = Math.max(0, audioBuffer.duration - targetDuration);
        }
        
        // Filter events
        events = eventsPool
            .filter(e => e.time_sec >= targetStartTime && e.time_sec <= (targetStartTime + targetDuration))
            .map((e, index) => ({
                id: `cutup_event_${index}_${Date.now()}_${agentId}`,
                time_sec: e.time_sec - targetStartTime,
                type: e.type,
                strength: e.strength,
                onomatopoeia: e.onomatopoeia,
                triggered: false
            }));
    }
    
    // ノンストップ枠は全尺を先頭から途切れず再生（スライスせず全イベントを使う）
    if (isBSolo) {
        targetStartTime = 0;
        targetDuration = audioBuffer.duration;
        events = (trackData && trackData.triggers.events ? trackData.triggers.events : []).map((e, index) => ({
            id: `cutup_event_${index}_${Date.now()}_${agentId}`,
            time_sec: e.time_sec,
            type: e.type,
            strength: e.strength,
            onomatopoeia: e.onomatopoeia,
            triggered: false
        }));
    }

    const agentLabel = agentId === "AgentA" ? "AGENT A (Slicer)" : "AGENT B (Ambient)";
    logMessage("CUT-UP", `[${agentLabel}] Playing slice: ${randomFile} [${targetStartTime.toFixed(1)}s - ${(targetStartTime + targetDuration).toFixed(1)}s] (${targetDuration.toFixed(1)}s)`);
    
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    
    const node = audioCtx.createBufferSource();
    node.buffer = audioBuffer;
    
    // Create fade-in / fade-out envelope gain
    const sliceGain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    sliceGain.gain.setValueAtTime(0, now);
    sliceGain.gain.linearRampToValueAtTime(1.0, now + 0.02); // 20ms fade-in
    sliceGain.gain.setValueAtTime(1.0, now + targetDuration - 0.02);
    sliceGain.gain.linearRampToValueAtTime(0, now + targetDuration); // 20ms fade-out
    
    // Stereo panner: Slicer -> Left, Ambient -> Right
    const panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
    if (panner) {
        const panVal = agentId === "AgentA" ? (-0.6 - Math.random() * 0.2) : (0.6 + Math.random() * 0.2);
        panner.pan.setValueAtTime(panVal, now);
        node.connect(sliceGain);
        sliceGain.connect(panner);
        panner.connect(analyser);
    } else {
        node.connect(sliceGain);
        sliceGain.connect(analyser);
    }
    
    node.start(0, targetStartTime, targetDuration);
    
    if (agentId === "AgentA") {
        cutUpNodeA = node;
        cutUpStartTimeA = targetStartTime;
        cutUpDurationA = targetDuration;
        cutUpEventsA = events;
        playbackStartTimeA = Date.now();
        
        // Update track name UI
        const trackNameElA = document.getElementById("ana-track-name-a");
        if (trackNameElA) trackNameElA.textContent = randomFile;
        if (window.LexMap) LexMap.setTrack('A', randomFile); // ライブマップ: 現在の音トラックを点灯
        
        // Clear old timeouts
        cutUpVideoTimeoutsA.forEach(t => clearTimeout(t));
        cutUpVideoTimeoutsA = [];
        
        // Schedule video triggers
        events.forEach(event => {
            const delayMs = event.time_sec * 1000;
            const timeoutId = setTimeout(() => {
                if (!isCutUpPlaying) return;
                event.triggered = true;
                logMessage("TRIGGER", `[AGENT A - Slicer] ${event.onomatopoeia} (Type: ${event.type}, Strength: ${event.strength.toFixed(2)})`);
                triggerCollageVideo(event, "A");
            }, delayMs);
            cutUpVideoTimeoutsA.push(timeoutId);
        });
        
        // Schedule next Slicer slice
        cutUpTimerA = setTimeout(() => {
            if (isCutUpPlaying) playNextCutUpSlice("AgentA");
        }, targetDuration * 1000);
        
    } else {
        cutUpNodeB = node;
        cutUpStartTimeB = targetStartTime;
        cutUpDurationB = targetDuration;
        cutUpEventsB = events;
        playbackStartTimeB = Date.now();
        
        // Update track name UI
        const trackNameElB = document.getElementById("ana-track-name-b");
        if (trackNameElB) trackNameElB.textContent = randomFile;
        if (window.LexMap) LexMap.setTrack('B', randomFile); // ライブマップ: 現在の音トラックを点灯
        
        // Clear old timeouts
        cutUpVideoTimeoutsB.forEach(t => clearTimeout(t));
        cutUpVideoTimeoutsB = [];
        
        // Schedule video triggers
        events.forEach(event => {
            const delayMs = event.time_sec * 1000;
            const timeoutId = setTimeout(() => {
                if (!isCutUpPlaying) return;
                event.triggered = true;
                logMessage("TRIGGER", `[AGENT B - Ambient] ${event.onomatopoeia} (Type: ${event.type}, Strength: ${event.strength.toFixed(2)})`);
                triggerCollageVideo(event, "B");
            }, delayMs);
            cutUpVideoTimeoutsB.push(timeoutId);
        });
        
        // Schedule next Ambient slice
        cutUpTimerB = setTimeout(() => {
            if (isCutUpPlaying) playNextCutUpSlice("AgentB");
        }, targetDuration * 1000);
    }
}

function updateCutUpLoop() {
    if (!isCutUpPlaying) return;
    
    const elapsedSecA = (Date.now() - playbackStartTimeA) / 1000;
    const elapsedSecB = (Date.now() - playbackStartTimeB) / 1000;
    
    // Update Agent A timeline Canvas (Item 5)
    drawTimeline("timeline-canvas-a", elapsedSecA, cutUpDurationA, cutUpEventsA);
    // Update Agent B timeline Canvas (Item 5)
    drawTimeline("timeline-canvas-b", elapsedSecB, cutUpDurationB, cutUpEventsB);
    
    // Update visualizer (Spectral Monitor)
    drawVisualizer();
    
    // Update current time displays in header
    const timeElA = document.getElementById("ana-time-a");
    const timeElB = document.getElementById("ana-time-b");
    if (timeElA) timeElA.textContent = `${elapsedSecA.toFixed(1)}s / ${cutUpDurationA.toFixed(1)}s`;
    if (timeElB) timeElB.textContent = `${elapsedSecB.toFixed(1)}s / ${cutUpDurationB.toFixed(1)}s`;
    
    // Update monitor cards based on active slots (Item 6)
    updateMonitorUI();
    
    requestAnimationFrame(updateCutUpLoop);
}

// Render Spectral Monitor Canvas
function drawVisualizer() {
    if (!analyser || !canvasCtx || !visualizerCanvas) return;
    
    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    
    canvasCtx.fillStyle = "rgba(5, 5, 8, 0.25)";
    canvasCtx.fillRect(0, 0, width, height);
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);
    
    const barWidth = (width / bufferLength) * 1.5;
    let barHeight;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * height;
        
        // Custom neon blue-green gradient
        const grad = canvasCtx.createLinearGradient(0, height, 0, height - barHeight);
        grad.addColorStop(0, "rgba(0, 136, 255, 0.8)"); // deep blue
        grad.addColorStop(0.5, "rgba(0, 191, 255, 0.8)"); // light blue
        grad.addColorStop(1, "rgba(0, 255, 170, 0.9)"); // neon green
        
        canvasCtx.fillStyle = grad;
        canvasCtx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        
        x += barWidth;
    }
}

// Real-time Peak Detection using Web Audio API
function detectRealtimePeak(currentTime) {
    if (!analyser) return;

    const bufferLength = analyser.fftSize;
    const dataArrayTime = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArrayTime);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        const val = (dataArrayTime[i] - 128) / 128.0;
        sum += val * val;
    }
    const rms = Math.sqrt(sum / bufferLength);

    rmsHistory.push(rms);
    if (rmsHistory.length > RMS_HISTORY_LIMIT) {
        rmsHistory.shift();
    }

    const rmsMean = rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length;
    
    const thresholdMultiplier = thresholdSlider ? parseFloat(thresholdSlider.value) : 1.35;
    const minIntervalMs = intervalSlider ? parseFloat(intervalSlider.value) : 250;
    
    const isPeak = rms > rmsMean * thresholdMultiplier && rms > 0.005;
    const timeSinceLastTrigger = (currentTime - lastTriggerTimeRealtime) * 1000.0;

    if (isPeak && timeSinceLastTrigger >= minIntervalMs) {
        lastTriggerTimeRealtime = currentTime;

        // Classify trigger type using spectrum energy distribution
        const dataArrayFreq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArrayFreq);

        let lowEnergy = 0;
        let highEnergy = 0;
        for (let i = 0; i < 8; i++) lowEnergy += dataArrayFreq[i];
        for (let i = 16; i < 64; i++) highEnergy += dataArrayFreq[i];

        let ttype = "刻み";
        if (highEnergy > lowEnergy * 1.3) {
            ttype = "刻み";
        } else if (lowEnergy > highEnergy * 1.5) {
            ttype = "うねり";
        } else {
            ttype = (trackDominantMotion === "アタック" || rms > rmsMean * 1.6) ? "アタック" : trackDominantMotion;
        }

        const triggerIndex = Math.floor(Math.random() * 1000);
        const selectedOnoma = trackVocab[triggerIndex % trackVocab.length];

        const event = {
            id: `realtime_${currentTime.toFixed(2)}`,
            time_sec: currentTime,
            type: ttype,
            strength: Math.min(1.0, rms * 8.0),
            onomatopoeia: selectedOnoma
        };

        triggerEvent(event);
    }
}

// Main high-precision animation loop
function updateLoop() {
    if (!isPlaying) return;
    if (!audioElement) return;

    const currentTime = audioElement.currentTime;
    const duration = audioElement.duration || 0;

    // Update progress bar & time display
    if (currentTimeDisplay) currentTimeDisplay.textContent = `${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`;
    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    if (progressBar) progressBar.style.width = `${progressPercent}%`;

    // Timeline and monitor updates
    drawTimeline("timeline-canvas-a", currentTime, duration, currentTrackEvents);
    updateMonitorUI();
    const timeEl = document.getElementById("ana-time");
    if (timeEl) timeEl.textContent = `${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`;

    // Render visualizer
    drawVisualizer();

    // Trigger check based on mode
    const mode = modeSelect ? modeSelect.value : "metadata";
    if (mode === "metadata") {
        currentTrackEvents.forEach(event => {
            if (event.time_sec <= currentTime && !triggeredEventIds.has(event.id)) {
                triggerEvent(event);
            }
        });
        updateNextTriggerDisplay();
    } else if (mode === "realtime") {
        detectRealtimePeak(currentTime);
    } else if (mode === "test-level2") {
        updatePipeLevel2(currentTime);
    }

    if (audioElement.ended) {
        logMessage("SYSTEM", "Track completed. Advancing to next track...");
        advanceToNextTrack();
        return;
    }

    requestAnimationFrame(updateLoop);
}

// Play A の連続再生: 曲終了後、許可トラックから前回と異なる曲を選び、3秒あけて次へ。
// (メイン index.html の runGlobalSequence と同じく、無限に回し続ける)
let advancingTrack = false;
let advanceTimeoutId = null;
function pickNextTrackId(excludeId) {
    const allowed = audioMetadataPool.filter(t =>
        ALLOWED_TRACKS_SET.has(t.file_id.replace(/\.(aif|aiff|mp3)$/i, '').toLowerCase()));
    let candidates = allowed.filter(t => t.file_id !== excludeId);
    if (candidates.length === 0) candidates = allowed;
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)].file_id;
}
function advanceToNextTrack() {
    if (advancingTrack) return;
    advancingTrack = true;
    const currentId = trackSelect ? trackSelect.value : null;
    const nextId = pickNextTrackId(currentId);
    if (!nextId) { advancingTrack = false; pauseSequence(); return; }
    // 曲間3秒の休符（メインと同じ間合い）。ユーザー停止時にタイムアウトをキャンセル可能にする
    advanceTimeoutId = setTimeout(() => {
        advanceTimeoutId = null;
        if (!isPlaying) { advancingTrack = false; return; } // 途中で停止された場合は何もしない
        if (!trackSelect || !audioElement) { advancingTrack = false; return; }

        // メタデータをチェック
        const trackData = audioMetadataPool.find(t => t.file_id === nextId);
        if (!trackData) {
            console.error("[demo] Track data not found for:", nextId);
            advancingTrack = false;
            return;
        }

        trackSelect.value = nextId;
        loadTrack(nextId);
        audioElement.play().then(() => {
            advancingTrack = false;
            requestAnimationFrame(updateLoop);
        }).catch(e => {
            console.error("[demo] Next track play failed:", nextId, e);
            advancingTrack = false;
            // 再生失敗時は次の曲を試す（ただし再帰を防ぐため手動で呼ぶ）
            // 実装を簡単にするため、ここは停止とする
            pauseSequence();
        });
    }, 3000);
}

// 実在チェック: 各動画の再生URLをHEADで確認し、404（R2に無い欠番）をプールから除外する。
// TODO: Phase1でcoreへ。logic.js の filterAvailableVideos と同一実装を保つこと。
async function filterAvailableVideos(basePath) {
    const results = await Promise.all(videoMetadataPool.map(async (v) => {
        const f = v[0];
        const match = f.match(/(\d+)\.(mov|mp4)/i);
        const name = match ? `${match[1]}-Sss720p.mp4` : f;
        const url = basePath + name + (window.VIDEO_CACHE_BUST || "");
        try {
            const res = await fetch(url, { method: 'HEAD', mode: 'cors' });
            return res.ok ? v : null;
        } catch (e) {
            return null;
        }
    }));
    const available = results.filter(Boolean);
    const removed = videoMetadataPool.length - available.length;
    if (available.length === 0) {
        // HEADプローブが全滅（CORS/ネットワーク障害）。全81本を維持すると R2 に無い
        // 90-97 等の欠番が選ばれて404（黒画面）になるため、R2に実在する既知52本へ絞る。
        // スナップショット(2026-07-05 ブラウザHEAD調査)。R2の内容が変わったら更新すること。
        const KNOWN_AVAILABLE = new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,38,39,40,41,44,45,46,47,48,49,50,51,52,53,54,56]);
        const fallback = videoMetadataPool.filter(v => { const m = v[0].match(/(\d+)/); return m && KNOWN_AVAILABLE.has(parseInt(m[1], 10)); });
        console.warn(`[demo] Availability probe failed (0 reachable) — falling back to ${fallback.length} known-available videos (excluding phantom 90-97 etc.).`);
        videoMetadataPool = fallback.length ? fallback : videoMetadataPool;
        if (window.addDecisionLog) window.addDecisionLog(`Availability probe failed — using ${videoMetadataPool.length} known-available videos.`, "warning");
        return;
    }
    videoMetadataPool = available;
    console.log(`[demo] Availability filter: ${available.length} playable, ${removed} missing removed.`);
    if (window.addDecisionLog) window.addDecisionLog(`Availability check: ${available.length} videos playable, ${removed} missing excluded.`, "success");
}

// 動画をActivityスコアに基づいて4レベルに分類する
// TODO: Phase1でcoreへ。しきい値・数式は logic.js の classifyVideos と一致させること。
// Weight/Time/Space/Hardnessの4軸平均を、音響トリガーの実需要比率
// (L1:11% L2:22% L3:21% L4:45%) に本数比が一致するよう逆算したしきい値で4分割する。
function classifyVideos() {
    videoPools = { 1: [], 2: [], 3: [], 4: [] };
    const IDX_WEIGHT = 4;
    const IDX_TIME = 5;
    const IDX_SPACE = 6;
    const IDX_HARDNESS = 7;

    videoMetadataPool.forEach(v => {
        const weight = v[IDX_WEIGHT] || 0;
        const time = v[IDX_TIME] || 0;
        const space = v[IDX_SPACE] || 0;
        const hardness = v[IDX_HARDNESS] || 0;
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
    console.log(`[demo] Classified videos: L1=${videoPools[1].length}, L2=${videoPools[2].length}, L3=${videoPools[3].length}, L4=${videoPools[4].length}`);
}

// 指定したレベルの動画プールからランダムに動画を選択する
function selectVideoByLevel(level, excludeSet = new Set()) {
    const pool = videoPools[level];
    if (!pool || pool.length === 0) {
        console.warn(`[demo] Pool for level ${level} is empty. Falling back to full videoMetadataPool.`);
        return videoMetadataPool[Math.floor(Math.random() * videoMetadataPool.length)];
    }
    
    let filtered = pool.filter(v => !excludeSet.has(v[0]));
    if (filtered.length === 0) {
        filtered = pool;
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

// Handle trigger event
function triggerEvent(event) {
    triggeredEventIds.add(event.id);
    
    // Increment count
    const triggerCount = triggeredEventIds.size;
    if (totalTriggersDisplay) totalTriggersDisplay.textContent = triggerCount;

    // Log the trigger details
    logMessage(
        event.type, 
        `${event.onomatopoeia} (Time: ${event.time_sec.toFixed(1)}s, Str: ${event.strength.toFixed(2)})`
    );

    // Determine the audio level (レベル判定は1回だけ。numScreensとログで共用)
    let audioLevel = 1;
    if (event.strength >= 0.75 || event.type === "アタック") {
        audioLevel = 4;
    } else if (event.strength >= 0.5) {
        audioLevel = 3;
    } else if (event.strength >= 0.25) {
        audioLevel = 2;
    }

    // Determine how many screens to trigger based on audio level
    let numScreens = 1;
    if (audioLevel === 4) {
        numScreens = 3;
    } else if (audioLevel === 3) {
        numScreens = 2;
    }

    addDecisionLog(`AUDIO ONSET: ${event.onomatopoeia} (Time: ${event.time_sec.toFixed(1)}s, Level ${audioLevel}, Strength: ${event.strength.toFixed(2)}) -> Triggering ${numScreens} screens`, "warning");

    let chosenInTrigger = new Set();

    // 振付ステートマシンに基づいて対象画面を取得して順次再生
    const screensToPlay = getScreensToPlay(numScreens);
    screensToPlay.forEach(activeScreenNum => {
        reactScreenWithVideo(activeScreenNum, event, chosenInTrigger);
    });
}

let idleTimer = null;

function resetIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    // 21秒後に無音時自動トリガーを実行（デモ画面）
    idleTimer = setTimeout(() => {
        triggerIdleFallbackVideo();
    }, 21000);
}

function triggerIdleFallbackVideo() {
    console.log("[demo] 21 seconds of inactivity detected. Triggering idle fallback video.");
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

// Video reaction and onomatopoeia popup logic
function reactScreenWithVideo(screenNum, event, chosenInTrigger = new Set()) {
    const wrapper = document.getElementById(`wrapper-${screenNum}`);
    const onoText = document.getElementById(`ono-text-${screenNum}`);
    const player = players[screenNum - 1];
    if (!player) return;
    
    const video = player.mediaEl;
    if (!video) return;

    // Highlight screen wrapper
    if (wrapper) wrapper.classList.add("active");

    // Determine the audio level
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

    // Check if player is locked
    if (player.isLocked) {
        console.log(`[demo] Screen ${screenNum} is locked. Skipping trigger.`);
        addDecisionLog(`Screen ${screenNum}: LOCKED (Skipped)`, "warning");
        return;
    }

    // Select video from the corresponding pool
    const videoData = selectVideoByLevel(audioLevel, chosenInTrigger);
    if (!videoData) return;

    // トリガーが成功したため、21秒の無音検出タイマーをリセット
    resetIdleTimer();

    const videoFileName = videoData[0];
    chosenInTrigger.add(videoFileName);

    // Apply rotation based on transition and video's original direction
    const originalDir = videoData[3] || "S";
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
    
    video.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`;
    console.log(`[demo] React Screen ${screenNum} with ${videoFileName} (Level ${audioLevel}, Rotate ${rotationAngle}deg, FlowDir ${flowDirection})`);

    // モニター用の再生情報をプレイヤーにセット
    player.currentVideoData = videoData;
    player.currentRotationAngle = rotationAngle;
    player.currentFlowDir = flowDirection;

    const lmaText = `W:${videoData[4]} T:${videoData[5]} S:${videoData[6]} H:${videoData[7]}`;
    addDecisionLog(`Screen ${screenNum} Triggered: Play ${videoFileName} (L${audioLevel}, ${rotationAngle}°, LMA: ${lmaText}, Flow:${flowDirection > 0 ? "L→R" : "R→L"})`, "info");

    const onPlaybackDone = () => {
        if (wrapper) wrapper.classList.remove("active");
        player.currentVideoData = null;
    };

    // Play according to audioLevel
    if (audioLevel === 1) {
        player.playLevel1(videoFileName).then(onPlaybackDone);
    } else if (audioLevel === 2) {
        const weight = videoData[4] || 0;
        const fadeTime = getFibonacciFadeTime(weight);
        player.playLevel2(videoFileName, fadeTime).then(onPlaybackDone);
    } else if (audioLevel === 3) {
        player.playLevel3(videoFileName).then(onPlaybackDone);
    } else if (audioLevel === 4) {
        player.playLevel4(videoFileName).then(onPlaybackDone);
    }

    if (onoText) {
        // Popup Onomatopoeia text
        onoText.textContent = event.onomatopoeia;
        onoText.className = "ono-text show"; // reset
        
        // Add type class for customized glow color
        if (event.type === "アタック") {
            onoText.classList.add("attack");
        } else if (event.type === "うねり") {
            onoText.classList.add("swell");
        } else if (event.type === "刻み") {
            onoText.classList.add("roll");
        }

        // Clear popup after timeout
        if (video.timeoutId) {
            clearTimeout(video.timeoutId);
        }
        video.timeoutId = setTimeout(() => {
            onoText.classList.remove("show");
        }, 1800);
    }
}

// Add parameters slider bindings
if (thresholdSlider) {
    thresholdSlider.addEventListener("input", () => {
        if (thresholdVal) thresholdVal.textContent = parseFloat(thresholdSlider.value).toFixed(2) + "x";
    });
}
if (intervalSlider) {
    intervalSlider.addEventListener("input", () => {
        if (intervalVal) intervalVal.textContent = intervalSlider.value + "ms";
    });
}
if (modeSelect) {
    modeSelect.addEventListener("change", () => {
        logMessage("SYSTEM", `Mode changed to: ${modeSelect.value}`);
        updateNextTriggerDisplay();
        rmsHistory = [];
    });
}

// Start loading metadata on page load
window.addEventListener("DOMContentLoaded", loadMetadata);

// タイムライン描画 (Canvas)
function drawTimeline(canvasId, currentTime, duration, events) {
    const canvas = document.getElementById(canvasId);
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

// スクリーンステータスの更新 (Plan A & B shared, handles 4 cards - Item 6)
function updateMonitorUI() {
    for (let screenNum = 1; screenNum <= 4; screenNum++) {
        const stateEl = document.getElementById(`scr${screenNum}-state`);
        const videoEl = document.getElementById(`scr${screenNum}-video`);
        const lmaEl = document.getElementById(`scr${screenNum}-lma`);
        const actEl = document.getElementById(`scr${screenNum}-activity`);
        const rotEl = document.getElementById(`scr${screenNum}-rot`);
        const freezeEl = document.getElementById(`scr${screenNum}-freezes`);
        
        if (!stateEl) continue;
        
        if (isCutUpPlaying) {
            // Plan B: Collage mode slot tracking (Item 6)
            const slot = activeCollageSlots[screenNum - 1];
            if (slot) {
                stateEl.textContent = slot.dataset.state || "PLAYING";
                stateEl.style.color = slot.dataset.state === "PLAYING" ? "var(--accent-green)" : "var(--accent-orange)";
                videoEl.textContent = slot.dataset.fileName || "-";
                lmaEl.textContent = `W:${slot.dataset.w} T:${slot.dataset.t} S:${slot.dataset.s} H:${slot.dataset.h}`;
                
                const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
                const actScore = (num(slot.dataset.w) + num(slot.dataset.t) + num(slot.dataset.s) + num(slot.dataset.h)) / 4;
                actEl.textContent = actScore.toFixed(2);
                
                rotEl.textContent = slot.dataset.rot || "-";
                freezeEl.textContent = slot.dataset.state === "FREEZING" ? "FREEZE FRAME (END)" : "None";
            } else {
                stateEl.textContent = "IDLE";
                stateEl.style.color = "var(--text-muted)";
                videoEl.textContent = "-";
                lmaEl.textContent = "-";
                actEl.textContent = "-";
                rotEl.textContent = "-";
                freezeEl.textContent = "-";
            }
        } else {
            // Plan A: Standard 3 screens (Screen 4 stays IDLE)
            if (screenNum > 3) {
                stateEl.textContent = "IDLE";
                stateEl.style.color = "var(--text-muted)";
                videoEl.textContent = "-";
                lmaEl.textContent = "-";
                actEl.textContent = "-";
                rotEl.textContent = "-";
                freezeEl.textContent = "-";
                continue;
            }
            
            const player = players[screenNum - 1];
            // 1. 状態表示
            let stateText = "IDLE";
            let stateColor = "var(--text-muted)";
            if (player.isLocked) {
                stateText = "LOCKED (L3)";
                stateColor = "var(--accent-blue)";
            } else if (player.mediaEl.paused) {
                if (player.freezeTimeout) {
                    stateText = "FREEZING";
                    stateColor = "var(--accent-orange)";
                } else if (player.mediaEl.src && player.mediaEl.currentTime > 0) {
                    stateText = "PAUSED";
                    stateColor = "var(--accent-orange)";
                } else {
                    stateText = "IDLE";
                }
            } else {
                stateText = "PLAYING";
                stateColor = "var(--accent-green)";
            }
            stateEl.textContent = stateText;
            stateEl.style.color = stateColor;
            
            // 2. メタデータ表示
            if (player.currentVideoData) {
                const vData = player.currentVideoData;
                videoEl.textContent = vData[0];
                
                const w = vData[4];
                const t = vData[5];
                const s = vData[6];
                const h = vData[7];
                lmaEl.textContent = `W:${w} T:${t} S:${s} H:${h}`;

                const actScore = vData.activity !== undefined ? vData.activity : (w + t + s + h) / 4;
                actEl.textContent = `${actScore.toFixed(2)}`;
                
                const rot = player.currentRotationAngle || 90;
                const origDir = vData[3] || "S";
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
        }
    }
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

/* =====================================================================
 * 統一音響・統一フリーズ（Play B / test-level2 共通。special には付けない）
 *  - 動画の音: 「大きさ→音量」「横位置→左右パン」。位置とサイズだけで L/R が
 *    決まる単純な写像 (gain→stereoPanner)。Web Audio に繋げない環境では
 *    音量のみで代替する(パン無し)。
 *  - フリーズフレーム: pauseTime.xml 由来の freezeFramesPool の地点で一時停止。
 *    停止秒数はフィボナッチ指標 (1,1,2,3,5秒) からランダム。
 * ===================================================================== */
function attachVideoSpatialAudio(el, left, top, w, h) {
    el.muted = window.videosMuted;
    const long = Math.max(w, h);                          // 梯子の段の長辺(向きに依らない)
    const minL = SIZE_LADDER[SIZE_LADDER.length - 1].w;
    const maxL = SIZE_LADDER[0].w;
    const vol = 0.1 + 0.9 * Math.max(0, Math.min(1, (long - minL) / (maxL - minL)));
    const pan = Math.max(-0.85, Math.min(0.85, ((left + w / 2) / COLLAGE_W) * 2 - 1));
    try {
        initAudioContext();
        const src = audioCtx.createMediaElementSource(el);
        const g = audioCtx.createGain();
        g.gain.value = vol * (window.videoGainVolume || 1.0);
        let out = g;
        if (audioCtx.createStereoPanner) {
            const p = audioCtx.createStereoPanner();
            p.pan.value = pan;
            g.connect(p); out = p;
        }
        src.connect(g);
        out.connect(audioCtx.destination);
        el.volume = 1.0;                                  // 実音量は gain 側で制御
    } catch (e) {
        el.volume = Math.min(1, vol * (window.videoGainVolume || 1.0));  // パン無し代替
    }
}

const FREEZE_FIB_SEC = [1, 1, 2, 3, 5];
function attachVideoFreeze(el, fileName) {
    const times = (window.freezeFramesPool || {})[fileName];
    if (!times || !times.length) return;
    const fired = new Array(times.length).fill(false);
    let frozen = false;
    el.addEventListener("timeupdate", () => {
        if (frozen || el.ended) return;
        const t = el.currentTime;
        for (let i = 0; i < times.length; i++) {
            if (fired[i] || t < times[i] || t > times[i] + 1.0) continue; // 通過後1秒以内なら発火
            fired[i] = true;
            frozen = true;
            const sec = FREEZE_FIB_SEC[Math.floor(Math.random() * FREEZE_FIB_SEC.length)];
            el.pause();
            setTimeout(() => {
                frozen = false;
                if (el.isConnected && !el.ended) el.play().catch(() => {});
            }, sec * 1000);
            break;
        }
    });
}

// Duet Collage Trigger and helper functions (Pattern B Test Only - Pre-cropped video version)
function triggerCollageVideo(event, agentId) {
    if (!isCutUpPlaying || !collageContainer) return;
    if (soloBActive) return; // ソロ中(fix枠)はセンター投影の特殊動画のみ。コラージュは生成しない
    
    // Determine audio level
    let audioLevel = 1;
    if (event.strength >= 0.75 || event.type === "アタック") {
        audioLevel = 4;
    } else if (event.strength >= 0.5) {
        audioLevel = 3;
    } else if (event.strength >= 0.25) {
        audioLevel = 2;
    }

    // 発火の間引き。強いイベント(L4=アタック)は詰めて出してよいが、弱いイベントは
    // 最小間隔を空ける。これが無いと1枚あたりの滞在が枠数で頭打ちになる。
    const nowMs = Date.now();
    const gap = (audioLevel >= 4) ? COLLAGE_STRONG_GAP_MS : COLLAGE_MIN_GAP_MS;
    if (lastCollageSpawnAt && nowMs - lastCollageSpawnAt < gap) return;
    lastCollageSpawnAt = nowMs;

    // Select video data (always use new Set() so we can reuse files in this test collage)
    const videoData = selectCollageVideo(audioLevel, new Set());
    if (!videoData) return;
    
    const fileName = videoData[0];
    let finalFileName = fileName;
    const match = fileName.match(/(\d+)\.(mov|mp4)/i);
    if (match) {
        finalFileName = `${match[1]}-Sss720p.mp4`;
    }
    // ライブマップ: 発火した映像とオノマトペをフラッシュ（映像—語—音の三者が光る）
    if (window.LexMap && match) LexMap.flash(match[1], event.onomatopoeia, agentId);
    const blobUrl = window.videoBlobCache[fileName] || (VIDEO_BASE_PATH + finalFileName);
    
    // 統一サイズ梯子から1段選ぶ(アスペクト比 1:2 / 2:1 は梯子が保証)。
    // 縦向きはキャンバス高(1080)に収まる段のみ — 1240段を縦にすると突き抜けるため横固定。
    const step = SIZE_LADDER[Math.floor(Math.random() * SIZE_LADDER.length)];
    const isVertical = Math.random() < 0.5 && step.w <= COLLAGE_H;
    const visW = isVertical ? step.h : step.w;
    const visH = isVertical ? step.w : step.h;
    
    let newVLeft = 0;
    let newVTop = 0;
    let placedSuccessfully = false;
    
    // 境界を 3840x2160 キャンバスに適用して接続先を計算
    if (lastBox) {
        const sides = ["top", "bottom", "left", "right"];
        const oppositeOfLast = {
            "top": "bottom",
            "bottom": "top",
            "left": "right",
            "right": "left"
        };
        const forbiddenSide = oppositeOfLast[lastBox.exitSide] || "";
        const allowedSides = sides.filter(s => s !== forbiddenSide);
        
        // 3辺をランダムにシャッフル
        allowedSides.sort(() => Math.random() - 0.5);
        
        for (let side of allowedSides) {
            const shift = [-21, -13, -8, 0, 8, 13, 21][Math.floor(Math.random() * 7)];
            
            if (side === "right") {
                newVLeft = lastBox.vRight;
                newVTop = lastBox.vTop + shift;
            } else if (side === "left") {
                newVLeft = lastBox.vLeft - visW;
                newVTop = lastBox.vTop + shift;
            } else if (side === "top") {
                newVTop = lastBox.vTop - visH;
                newVLeft = lastBox.vLeft + shift;
            } else if (side === "bottom") {
                newVTop = lastBox.vBottom;
                newVLeft = lastBox.vLeft + shift;
            }
            
            // 安全領域内 (3840x2160 境界内) に収まるかチェック
            const rightBound = newVLeft + visW;
            const bottomBound = newVTop + visH;

            if (newVLeft >= 0 && rightBound <= COLLAGE_W && newVTop >= 0 && bottomBound <= COLLAGE_H) {
                placedSuccessfully = true;
                lastBox.exitSide = side; // 新しい進行方向を exitSide に上書き記録
                break;
            }
        }
    }

    // 3840x2160 のウィンドウの辺にくっつける
    if (!placedSuccessfully) {
        // Always start spawning from the top edge to prevent large top blank spaces (Plan B display from top)
        const startEdge = ["left", "right", "top"][Math.floor(Math.random() * 3)];
        if (startEdge === "left") {
            newVLeft = 0;
            newVTop = 0;
        } else if (startEdge === "right") {
            newVLeft = COLLAGE_W - visW;
            newVTop = 0;
        } else { // top
            newVTop = 0;
            newVLeft = Math.random() * (COLLAGE_W - visW);
        }
        lastBox = { exitSide: "start" };
    }

    // ウィンドウの辺に近づいたらぴったりくっつける（3840x2160スナップ処理）
    if (Math.abs(newVLeft - 0) < 15) newVLeft = 0;
    if (Math.abs((newVLeft + visW) - COLLAGE_W) < 15) newVLeft = COLLAGE_W - visW;
    if (Math.abs(newVTop - 0) < 15) newVTop = 0;
    if (Math.abs((newVTop + visH) - COLLAGE_H) < 15) newVTop = COLLAGE_H - visH;
    
    // 今回表示される可視バウンディングボックスを次回の参照用に保存
    lastBox.vLeft = newVLeft;
    lastBox.vTop = newVTop;
    lastBox.vRight = newVLeft + visW;
    lastBox.vBottom = newVTop + visH;
    
    // 新しいラッパー（トリミング枠）エレメントを作成
    const wrapperEl = document.createElement("div");
    wrapperEl.style.position = "absolute";
    wrapperEl.style.width = `${visW}px`;
    wrapperEl.style.height = `${visH}px`;
    wrapperEl.style.left = `${newVLeft}px`;
    wrapperEl.style.top = `${newVTop}px`;
    wrapperEl.style.overflow = "hidden";
    wrapperEl.style.opacity = "0"; // 映像の再生開始まで非表示にし、白い外枠フラッシュを防ぐ
    wrapperEl.style.zIndex = collageZIndex++;
    
    // 影エフェクトは完全に削除 (Item 2)
    wrapperEl.style.boxShadow = "none";
    wrapperEl.style.transition = "opacity 0.4s ease";
    
    // 新しい動画エレメントを作成
    const videoEl = document.createElement("video");
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = window.videosMuted; // 音声の状態をグローバルと同期
    videoEl.loop = false;
    videoEl.crossOrigin = "anonymous";  // R2直リンク再生時もWeb Audioへ繋ぐため(ローカル/blobでは無害)
    videoEl.src = blobUrl;

    // 統一音響: 大きさ→音量 / 横位置→左右パン。フリーズフレームも統一で付ける
    attachVideoSpatialAudio(videoEl, newVLeft, newVTop, visW, visH);
    attachVideoFreeze(videoEl, fileName);
    
    // "動画は自由に回転してよい" (0, 90, 180, 270度から選択)
    const ROTATIONS = [0, 90, 180, 270];
    const rot = ROTATIONS[Math.floor(Math.random() * ROTATIONS.length)];
    
    // タイマー以外のトリガーで階調反転（強イベント強度 0.85 以上で発動 - Item 4）
    if (event.strength >= 0.85) {
        videoEl.style.filter = "invert(1)";
        logMessage("SPECIAL", `Audio Peak Inversion: Triggered on strength ${event.strength.toFixed(2)}`);
    }
    
    videoEl.style.position = "absolute";
    if (rot === 0 || rot === 180) {
        videoEl.style.width = "100%";
        videoEl.style.height = "100%";
        videoEl.style.left = "0px";
        videoEl.style.top = "0px";
    } else {
        // 90度または270度回転させる場合、アスペクト比の歪みを防ぐため幅と高さを入れ替えて中央配置 (Item 1)
        videoEl.style.width = `${visH}px`;
        videoEl.style.height = `${visW}px`;
        videoEl.style.left = `${(visW - visH) / 2}px`;
        videoEl.style.top = `${(visH - visW) / 2}px`;
    }
    videoEl.style.transform = `rotate(${rot}deg)`;
    
    // 各スロットのステータス表示用にメタデータをセット (Item 6)
    wrapperEl.dataset.fileName = fileName;
    wrapperEl.dataset.w = videoData[4];
    wrapperEl.dataset.t = videoData[5];
    wrapperEl.dataset.s = videoData[6];
    wrapperEl.dataset.h = videoData[7];
    wrapperEl.dataset.rot = `${rot}° / ${videoData[3] || "S"}`;
    wrapperEl.dataset.state = "PLAYING";
    
    // 動画の再生が始まったタイミングでラッパーを滑らかにフェードイン (空枠の白線表示を防ぐ)
    videoEl.onplaying = () => {
        wrapperEl.style.opacity = "1";
        // 最低滞在はここから数える(挿入時ではなく、実際に絵が出た時刻から)
        if (!wrapperEl._shownAt) wrapperEl._shownAt = Date.now();
    };
    
    wrapperEl.appendChild(videoEl);
    
    // コンテナへ追加
    collageContainer.appendChild(wrapperEl);
    
    // 最低滞在時間を割り当てる。大半は約10秒、一部だけ「一瞬」で消える。
    wrapperEl.dataset.level = String(audioLevel);
    wrapperEl._bornAt = Date.now();
    wrapperEl._shownAt = 0;                                    // 実際に絵が出た時刻(onplayingで入る)
    wrapperEl._dwellMs = Math.random() < COLLAGE_FLASH_RATE ? COLLAGE_FLASH_MS : COLLAGE_DWELL_MS;

    // 枠のマッピング: 空き枠 → 最低滞在を過ぎた枠 → それも無ければ最も長く出ている枠
    let targetIndex = activeCollageSlots.findIndex(s => s === null);
    if (targetIndex === -1) {
        const now = Date.now();
        for (let i = 0; i < COLLAGE_SLOTS; i++) {
            const idx = (nextSlotIndex + i) % COLLAGE_SLOTS;
            if (collageEvictableAt(activeCollageSlots[idx]) <= now) { targetIndex = idx; break; }
        }
        if (targetIndex === -1) {
            // 全枠がまだ最低滞在中 → 最も早く空く枠(=最も長く出ている枠)を押し出す
            let bestAt = Infinity;
            for (let i = 0; i < COLLAGE_SLOTS; i++) {
                const at = collageEvictableAt(activeCollageSlots[i]);
                if (at < bestAt) { bestAt = at; targetIndex = i; }
            }
            // ただし犠牲になるのが「まだ一度も絵が出ていない枠」なら、それを潰してまで
            // 新規を出す意味は無い(どちらも映らずに消えるだけ)。このトリガーは捨てる。
            // 音が詰まっている間は自然に発火が抑制され、枠が落ち着く。
            const victim = activeCollageSlots[targetIndex];
            if (victim && !victim._shownAt) { wrapperEl.remove(); return; }
        }
        nextSlotIndex = (targetIndex + 1) % COLLAGE_SLOTS;

        // 古いラッパーをフェードアウトして除去
        const oldWrapper = activeCollageSlots[targetIndex];
        if (oldWrapper) {
            oldWrapper.style.opacity = 0;
            setTimeout(() => { oldWrapper.remove(); }, 500);

            // collageVideos からも古いものを除外
            const vIdx = collageVideos.indexOf(oldWrapper);
            if (vIdx > -1) collageVideos.splice(vIdx, 1);
        }
    }

    activeCollageSlots[targetIndex] = wrapperEl;
    collageVideos.push(wrapperEl);

    // 再生完了した動画は最後のフレームで静止 (ステータスをFREEZINGに切り替え)
    videoEl.onended = () => {
        videoEl.pause();
        wrapperEl.dataset.state = "FREEZING";   // 最後まで再生し終えた枠はいつでも押し出せる
        updateMonitorUI();
    };
    
    videoEl.play().catch(e => {
        console.error("[demo] Collage video play failed:", e);
    });
}

function clearCollageVideos() {
    if (collageContainer) {
        collageContainer.innerHTML = "";
    }
    collageVideos = [];
    collageZIndex = 1;
}



// Escape key to stop playback
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("is-playing")) {
        if (isPlaying) stopSequence();
        if (isCutUpPlaying) stopCutUpPlayback();
    }
});


/* =====================================================================
 * test-level2 : 水道管パイプ (Pipe Mania) 再生テスト
 *  - 3本の独立したパイプ(フロー)が同時に伸びる。画面には各フローの
 *    「現在再生中の1枚」だけ表示 → 計3枚が同時再生。
 *  - 各フローは237マスのグリッド上を水道管ゲーム原理で蛇行(474x237ドミノ、
 *    出→次の入りを連結、はみ出さない向きへ回転)。他フローのカードは避ける。
 *  - 進行: 各フロー独立。動画終了で次カードへ(旧カードはフェイドアウト、
 *    新カードはフェイドイン=クロスフェード)。
 *  - 素材は向き付き動画(L2R/R2L)のみ。S・90〜97は除外。
 *    (「レベル2」は連結の合図ではなく"音"の話。音フィルタは別途対応)
 * ===================================================================== */
const PIPE_CARD_W = 474, PIPE_CARD_H = 237, PIPE_FLOWS = 3;
const PIPE = {
    active: false,
    pool: [],           // 向き付き動画(L2R/R2L)の連結素材プール
    flows: [],           // 3本のフロー {id, head:{cell0,flow}|null, card:{el,cells}|null, lastFile}
    count: 0,
};
function pipeLevelOf(event) {
    if (event.strength >= 0.75 || event.type === "アタック") return 4;
    if (event.strength >= 0.5) return 3;
    if (event.strength >= 0.25) return 2;
    return 1;
}

function pipeVideoSrc(fileName) {
    const m = fileName.match(/(\d+)\.(mov|mp4)/i);
    const finalName = m ? `${m[1]}-${window.VIDEO_QUALITY_SUFFIX || "Sss720p"}.mp4` : fileName;
    if (window.videoBlobCache && window.videoBlobCache[fileName]) return window.videoBlobCache[fileName];
    return VIDEO_BASE_PATH + finalName + (window.VIDEO_CACHE_BUST || "");
}

/* ── 入り口/出口の辺 ──────────────────────────────────────────────────
 *   ┏a1-a-a2┓     上=a / 右=b / 下=c / 左=d
 *   d       b      a,c は辺上の位置を持つ: a1=左25% / a=中央50% / a2=右75%
 *   ┗c1-c-c2┛     b,d は中央のみ(CSVにも b1/d2 等は現れない)
 * 連結規則: 出た辺の反対側から次の動画に入る(b→d / d→b / a→c / c→a)。
 * 次の動画はその辺の隣に置かれる。動画は回転させない。
 * ------------------------------------------------------------------ */
const PIPE_OPPOSITE = { a: "c", c: "a", b: "d", d: "b" };
const pipeEdgeBase = (e) => (e || "").charAt(0);
// 辺上の位置を幅に対する割合で返す(a1/c1=0.25, a/c=0.5, a2/c2=0.75)
const pipeEdgeFrac = (e) => (e && e.length > 1) ? (e.charAt(1) === "1" ? 0.25 : 0.75) : 0.5;

// skinslides-in-out.csv: 「ファイル名,入り口の辺,出口の辺」
async function loadPipeEdges() {
    PIPE.edges = {};
    try {
        const res = await fetch("skinslides-in-out.csv" + (window.VIDEO_CACHE_BUST || ""));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        (await res.text()).split(/\r?\n/).forEach(line => {
            const [file, inE, outE] = line.split(",").map(s => (s || "").trim());
            const m = file && file.match(/(\d+)/);
            if (!m || !inE || !outE) return;                       // 末尾の空行・辺なし行は無視
            if (!PIPE_OPPOSITE[pipeEdgeBase(inE)] || !PIPE_OPPOSITE[pipeEdgeBase(outE)]) return;
            PIPE.edges[parseInt(m[1], 10)] = { in: inE, out: outE };
        });
        console.log(`[pipe] 入出辺データ ${Object.keys(PIPE.edges).length} 本を読み込み`);
    } catch (e) {
        console.warn("[pipe] skinslides-in-out.csv の読み込みに失敗。パイプ連結は無効。", e);
    }
}

function buildPipePools() {
    PIPE.pool = [];
    videoMetadataPool.forEach(v => {
        const nm = (v[0].match(/(\d+)/) || [])[1];
        const num = nm ? parseInt(nm, 10) : 0;
        const e = PIPE.edges && PIPE.edges[num];
        if (!e) return;                           // 入出辺が未定義の動画は連結できないので除外
        PIPE.pool.push({ data: v, num, in: e.in, out: e.out });
    });
}

// ── 配置計算(回転なし。カードは2:1の横向きのまま、大きさだけ変える) ──
const PIPE_STAGE_W = 1920, PIPE_STAGE_H = 1080;

// カードの大きさは統一サイズ梯子(SIZE_LADDER)をそのまま使う。
// 1枚ごとに決め、再生中は変えない。
const PIPE_SIZES = SIZE_LADDER;
const PIPE_SIZE_DEFAULT = 2;                         // 474x237

// 直前カード(rect/curSize)の outEdge から出て、次カード(nextSize)へ inEdge から入る左上座標。
// 左右に抜けるときは辺の中心どうしを、上下に抜けるときは辺上の位置(a1/a/a2)どうしを合わせる。
function pipePlaceNext(rect, curSize, outEdge, inEdge, nextSize) {
    const ob = pipeEdgeBase(outEdge);
    if (ob === "b" || ob === "d") {
        const top = rect.top + curSize.h / 2 - nextSize.h / 2;
        return ob === "b"
            ? { left: rect.left + curSize.w, top }
            : { left: rect.left - nextSize.w, top };
    }
    const left = rect.left + pipeEdgeFrac(outEdge) * curSize.w - pipeEdgeFrac(inEdge) * nextSize.w;
    return ob === "c"
        ? { left, top: rect.top + curSize.h }
        : { left, top: rect.top - nextSize.h };
}

// 画面内に収まるか(フロー同士の重なりは許容する)
const pipeRectFits = (r, s) =>
    r.left >= 0 && r.left + s.w <= PIPE_STAGE_W &&
    r.top >= 0 && r.top + s.h <= PIPE_STAGE_H;

// 大きさの段を1枚ごとに決める。数枚は同じ段に留まり、ときどき隣の段へ、まれに跳ぶ。
// → 「短い尺が連続する」「長い尺でゆっくり変わる」というまとまりが生まれる。
function pipeNextSizeIdx(f) {
    const r = Math.random();
    if (r < 0.55) return f.sizeIdx;                                   // 同じ段が続く
    if (r > 0.97) return Math.floor(Math.random() * PIPE_SIZES.length); // まれに跳ぶ
    const i = f.sizeIdx + (Math.random() < 0.5 ? 1 : -1);             // 上下は対称
    return Math.max(0, Math.min(PIPE_SIZES.length - 1, i));
}

// 大きいカードは長い尺・穏やかな動き、小さいカードは短い尺・激しい動きを好む。
function pipeTempoWeight(p, sizeIdx) {
    const big  = 1 - sizeIdx / (PIPE_SIZES.length - 1);      // 1=最大 0=最小
    const long = Math.min((p.data[1] || 10) / 30, 1);        // 1=30秒以上
    const intense = Math.min(((p.data[5] || 0) + (p.data[7] || 0)) / 18, 1);
    return 0.25 + (1 - Math.abs(big - long)) + 0.6 * (1 - Math.abs(big - (1 - intense)));
}

// 3本の蛇行が離れすぎず重なりすぎず絡むように、他フローとの距離で重みを付ける。
const PIPE_NEAR = 500, PIPE_FAR = 1400;
function pipeFlowAffinity(f, rect, size) {
    const cx = rect.left + size.w / 2, cy = rect.top + size.h / 2;
    let minD = Infinity;
    for (const o of PIPE.flows) {
        if (o === f || !o.rect || !o.size) continue;
        const ox = o.rect.left + o.size.w / 2, oy = o.rect.top + o.size.h / 2;
        minD = Math.min(minD, Math.hypot(cx - ox, cy - oy));
    }
    if (!isFinite(minD)) return 1;
    if (minD < PIPE_NEAR) return 0.25 + 0.75 * (minD / PIPE_NEAR);   // 近すぎ → 離れる
    if (minD > PIPE_FAR)  return Math.max(0.25, PIPE_FAR / minD);    // 遠すぎ → 近づく
    return 1.4;                                                      // ほどよく絡む距離
}

/* ── オノマトペによる重み付け ────────────────────────────────────────
 * 「いま鳴っている音の語」に質感が近い映像をやや優遇する。
 * 【厳守】候補の絞り込み(入り口の辺の一致・はみ出し判定)には一切関与しない。
 *         既に有効と判定された候補の重みを上下させるだけなので、a/b/c/d の
 *         連結規則も b/d・d/b が多くなる性質もそのまま保たれる。
 * 偏り対策: 候補集合の中での相対順位だけを使い、倍率を
 *         最大 PIPE_ONOMA_BIAS 倍 〜 最小 1/PIPE_ONOMA_BIAS 倍 に収める。
 *         候補を除外しないため、行き止まり回避・Uターン抑制(最大20倍・6.7倍)
 *         といった既存の重みが引き続き支配的になる。
 * ------------------------------------------------------------------ */
const PIPE_ONOMA_BIAS = 1.8;

// いま鳴っている音のオノマトペ。updateLoop に依存しないので、
// Combination の pipe フェーズ(isPlaying=false)でも同じように効く。
function pipeCurrentWord() {
    if (!audioElement || !currentTrackEvents || !currentTrackEvents.length) return null;
    const t = audioElement.currentTime || 0;
    let best = -1, word = null;
    for (const e of currentTrackEvents) {
        if (e.time_sec <= t && e.time_sec > best && e.onomatopoeia) { best = e.time_sec; word = e.onomatopoeia; }
    }
    return word;
}

const pipeVideoNum = (fileName) => parseInt((String(fileName).match(/(\d+)/) || [])[1], 10);

// cands: [{p, w, ...}] の w を語との近さで上下させる。語やベクトルが無ければ何もしない。
function pipeApplyOnomaBias(cands) {
    const word = pipeCurrentWord();
    PIPE.word = word;
    if (!word || !window.LexMap || !LexMap.wordVideoDistance) return;
    let lo = Infinity, hi = -Infinity;
    for (const c of cands) {
        c.d = LexMap.wordVideoDistance(pipeVideoNum(c.p.data[0]), word);
        if (c.d == null) continue;
        if (c.d < lo) lo = c.d;
        if (c.d > hi) hi = c.d;
    }
    if (!isFinite(lo) || hi - lo < 1e-6) return;      // 差が付かないなら触らない
    for (const c of cands) {
        if (c.d == null) continue;
        const rel = (c.d - lo) / (hi - lo);           // 0=最も近い 1=最も遠い
        c.w *= Math.pow(PIPE_ONOMA_BIAS, 1 - 2 * rel);
    }
}

// 重み付きランダムで1つ選ぶ
function pipeWeightedPick(cands) {
    let total = 0;
    for (const c of cands) total += c.w;
    let t = Math.random() * total;
    for (const c of cands) { t -= c.w; if (t <= 0) return c; }
    return cands[cands.length - 1];
}

/* 次カードを重みづけで選ぶ。
 *   必須: 入り口の辺が requiredIn と一致し、置いても画面からはみ出さないこと。
 *   重み: ・その先にもう1枚置けない手(行き止まり)は大きく減点
 *         → 端に近づくと、まっすぐ進む手が自然に落ちて曲がる手が残る(=折り返し)
 *         ・来た道をすぐ戻るUターンは抑制
 *         ・直角に折れる手は少し優遇して蛇行に変化をつける
 *         ・尺/激しさとカードの大きさの相性、他フローとの距離も加味
 */
function pickNextPipe(f, requiredIn, size) {
    const travel = pipeEdgeBase(f.out);              // 直前に進んだ向き
    const cands = [];
    for (const p of PIPE.pool) {
        if (pipeEdgeBase(p.in) !== requiredIn) continue;
        const rect = pipePlaceNext(f.rect, f.size, f.out, p.in, size);
        if (!pipeRectFits(rect, size)) continue;
        const exit = pipeEdgeBase(p.out);
        // この先にもう1枚置ける見込みがあるか(次の入り口は中央・同じ大きさと仮定)
        const ahead = pipePlaceNext(rect, size, p.out, PIPE_OPPOSITE[exit], size);
        let w = pipeRectFits(ahead, size) ? 1 : 0.05;
        if (exit === PIPE_OPPOSITE[travel]) w *= 0.15;                 // Uターン抑制
        else if (exit !== travel) w *= 1.3;                            // 直角に折れる手
        if (p.data[0] === f.lastFile) w *= 0.2;
        w *= pipeTempoWeight(p, f.sizeIdx);
        w *= pipeFlowAffinity(f, rect, size);
        cands.push({ p, rect, w });
    }
    if (!cands.length) return null;
    pipeApplyOnomaBias(cands);      // ここで初めて語が効く。候補集合そのものは上で確定済み
    return pipeWeightedPick(cands);
}

// フローを開始位置へ戻す(初回・行き止まり時)
function pipeResetFlow(f) {
    f.sizeIdx = PIPE_SIZE_DEFAULT;
    f.size = PIPE_SIZES[f.sizeIdx];
    f.rect = {
        left: Math.min(f.startLeft, PIPE_STAGE_W - f.size.w),
        top:  Math.min(f.startTop,  PIPE_STAGE_H - f.size.h),
    };
    f.out = null;
}

function enterTestLevel2() {
    buildPipePools();
    PIPE.active = true;
    PIPE.count = 0;
    // 3本の蛇行。開始位置は画面内に散らし、以降は全体を自由に這う(重なりは許容)。
    PIPE.flows = Array.from({ length: PIPE_FLOWS }, (_, i) => {
        const f = {
            id: i, card: null, lastFile: null,
            startLeft: Math.round(PIPE_STAGE_W * (0.15 + 0.3 * i)),
            startTop:  Math.round(PIPE_STAGE_H * (0.15 + 0.3 * i)),
        };
        pipeResetFlow(f);                                        // sizeIdx/size/rect/out を初期化
        return f;
    });

    const stage = document.getElementById("pipe-stage");
    const conveyor = document.getElementById("pipe-conveyor");
    if (conveyor) conveyor.innerHTML = "";   // カードは絶対座標で配置(コンベアは静止コンテナ)
    if (stage) stage.classList.add("active");
    if (normalScreensContainer) normalScreensContainer.style.display = "none";
    if (collageWrapper) collageWrapper.style.display = "none";

    const n = PIPE.pool.length;
    if (window.addDecisionLog) window.addDecisionLog(`test-level2 起動: パイプ素材 ${n}本。3本のパイプが同時に伸びる(3枚同時再生)`, "success");
    console.log(`[pipe] entered test-level2. pool=${n}, flows=${PIPE.flows.length}`);

    // 各フローの1枚目を同時に出す(以降は各フロー独立で、動画終了→次)
    PIPE.flows.forEach(f => advanceFlow(f));
}

function exitTestLevel2() {
    PIPE.active = false;
    const stage = document.getElementById("pipe-stage");
    const conveyor = document.getElementById("pipe-conveyor");
    if (stage) stage.classList.remove("active");
    if (conveyor) conveyor.innerHTML = "";
    PIPE.flows = [];
    if (normalScreensContainer) normalScreensContainer.style.display = "";
    if (collageWrapper) collageWrapper.style.display = "";
}

// 動画は回転させない。連結は入り口/出口の辺の規則だけで成立するため、
// 回転角の計算(pipeRotationDeg)と237マスのグリッド計算は pipePlaceNext に置き換えて廃止した。

// 1本のフローを1手進める(現在カードをクロスフェードで次カードへ)
function advanceFlow(f) {
    if (!PIPE.active) return;
    const conveyor = document.getElementById("pipe-conveyor");
    if (!conveyor) return;

    // このカードの大きさを先に決める(再生が始まったら変えない)
    let sizeIdx = pipeNextSizeIdx(f);
    let size = PIPE_SIZES[sizeIdx];

    // 直前の出口の反対側から入る動画を選ぶ(b→d / d→b / a→c / c→a)。
    // 選んだ大きさで置けない(行き止まり)ときは、リセットする前に一段ずつ小さい段で
    // 置き直せないか試す。大きさは連結規則(辺)とは無関係なので、これで連結の連続性を
    // 保ったまま行き止まり率を下げられる。それでも駄目なら開始位置へ仕切り直す。
    let cand = null, rect = null, pick = null;
    if (f.out) {
        const req = PIPE_OPPOSITE[pipeEdgeBase(f.out)];
        for (let s = sizeIdx; s < PIPE_SIZES.length && !cand; s++) {
            cand = pickNextPipe(f, req, PIPE_SIZES[s]);
            if (cand) { sizeIdx = s; size = PIPE_SIZES[s]; }
        }
        if (cand) { pick = cand.p; rect = cand.rect; }
    }
    if (!pick) {
        pipeResetFlow(f);                       // 1枚目は入り口の制約が無いので何でもよい
        // 開始位置は既定サイズで画面内に収めてあるので、大きさもそれに合わせる
        sizeIdx = f.sizeIdx;
        size = f.size;
        const fresh = PIPE.pool.filter(p => p.data[0] !== f.lastFile);
        const src = fresh.length ? fresh : PIPE.pool;
        if (!src.length) return;
        // 1枚目は入り口の制約が無いぶん完全ランダムだった。ここも語で重み付けする
        // (制約が無いので連結ロジックには影響しない)。
        const seeds = src.map(p => ({ p, w: 1 }));
        pipeApplyOnomaBias(seeds);
        pick = pipeWeightedPick(seeds).p;
        rect = { ...f.rect };
    }

    const videoData = pick.data;
    const fileName = videoData[0];

    // 配置: 回転させず、前の動画の出口の辺の隣に置く(辺どうしが接する)
    const el = document.createElement("video");
    el.className = "pipe-card";
    el.playsInline = true;
    el.crossOrigin = "anonymous";       // R2フォールバック時もWeb Audioへ繋ぐため
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${size.w}px`;
    el.style.height = `${size.h}px`;
    el.src = pipeVideoSrc(fileName);
    conveyor.appendChild(el);
    // 統一音響+統一フリーズ: 大きさ→音量 / 横位置→パン、PAUSE地点でフィボナッチ秒静止
    attachVideoSpatialAudio(el, rect.left, rect.top, size.w, size.h);
    attachVideoFreeze(el, fileName);

    // クロスフェード: このフローの旧カードをフェイドアウトして除去
    const old = f.card;
    if (old && old.el) {
        old.el.classList.remove("show");
        const g = old.el;
        setTimeout(() => { if (g && g.parentNode) g.parentNode.removeChild(g); }, 600);
    }
    f.card = { el };
    f.lastFile = fileName;
    f.rect = rect;
    f.size = size;
    f.sizeIdx = sizeIdx;
    f.out = pick.out;                       // 次の動画はこの辺の反対側から入る

    const startPlay = () => {
        el.removeEventListener("canplay", startPlay);
        f.errCount = 0;                                          // 再生成功 → 連続エラーをリセット
        requestAnimationFrame(() => el.classList.add("show"));   // フェードイン
        el.play().catch(err => console.warn(`[pipe] play失敗 ${fileName}`, err));
    };
    el.addEventListener("canplay", startPlay);
    // 動画終了 → このフローを次カードへ(自分がまだこのフローの現在カードのときだけ)
    el.onended = () => {
        try { el.pause(); } catch (e) {}
        if (PIPE.active && f.card && f.card.el === el) advanceFlow(f);
    };
    // 読み込み失敗(404等): 即再帰すると高速無限ループ(count連打・重い)になるため、
    // 遅延してからリトライし、連続エラーが続いたらそのフローを停止する。
    el.onerror = () => {
        if (!PIPE.active || !f.card || f.card.el !== el) return;
        f.errCount = (f.errCount || 0) + 1;
        if (f.errCount > 12) {
            console.warn(`[pipe] flow${f.id}: 連続読み込み失敗が多いため停止 (${fileName})`);
            if (window.addDecisionLog) window.addDecisionLog(`Flow${f.id + 1}: 動画の読み込み失敗が続くため停止`, "error");
            return;
        }
        setTimeout(() => { if (PIPE.active && f.card && f.card.el === el) advanceFlow(f); }, 600);
    };
    el.load();

    PIPE.count++;
    // ライブマップ駆動: 出した映像と鳴っている語を光らせる(Play B と同じ扱い)。
    // 映像—語—音 の三者が結ばれ、test-level2 でもマップが動く。
    if (window.LexMap) LexMap.flash(pipeVideoNum(fileName), PIPE.word, "A");
    const wordTag = PIPE.word ? ` 〈${PIPE.word}〉` : "";
    if (window.addDecisionLog) window.addDecisionLog(`Flow${f.id + 1} #${PIPE.count}: ${fileName} (${pick.in}→${pick.out}, ${videoData[1]}s)${wordTag}`, "trigger");
    console.log(`[pipe] flow${f.id} ${fileName} in=${pick.in} out=${pick.out} ${size.w}x${size.h} at (${Math.round(rect.left)},${Math.round(rect.top)})`);
}

/* =====================================================================
 *  Combination — Play B と test-level2 を交互に回す
 *    ・Play B(速く激しい調子) を約2分
 *    ・→ test-level2(やや遅い調子) を音声1曲分
 *    ・これを繰り返す
 *    ・数巡に一度スペシャル: 動画90/91/92 と音声T525/526/527 を対で、
 *      キャンバス中央に横幅フィットで、他の映像・音声を出さず丸ごと1本再生する。
 *      (90〜92 はローカルの videos/ に無く R2 にのみ在るため R2 から直接再生)
 * ===================================================================== */
// Play B の持ち時間は「2分前後」: 毎回 105〜135秒からランダム。
// ?combi=5 のように秒で固定上書きでき、動作確認を短時間で回せる。
const COMBI_PLAYB_MS_Q = (() => {
    const q = parseFloat(new URLSearchParams(location.search).get("combi"));
    return (isFinite(q) && q > 0) ? q * 1000 : null;
})();
const combiPlayBMs = () => COMBI_PLAYB_MS_Q || (105000 + Math.random() * 30000);
/* special の解放スイッチ。
 * 動画90/91/92 を編集して差し替えたあとに解放する予定のため、現状は false。
 * 解放するときは下の false を true にするだけでよい(コードの他の場所は触らない)。
 * 実行中に切り替えたい場合は、コンソールで skinslidesSetSpecial(true) を呼ぶ。
 * false の間は Combination が Play B ⇄ test-level2 の交互だけを回す。 */
let COMBI_SPECIAL_ENABLED = false;
window.skinslidesSetSpecial = function (on) {
    COMBI_SPECIAL_ENABLED = !!on;
    if (COMBI_SPECIAL_ENABLED && COMBI.active) COMBI.specialAt = Date.now() + combiNextSpecialDelay();
    if (window.addDecisionLog) window.addDecisionLog(`special: ${COMBI_SPECIAL_ENABLED ? "解放" : "停止"}`, "system");
    return COMBI_SPECIAL_ENABLED;
};

// special は15〜30分に一回程度。回数ではなく経過時間で判定する(1巡の長さは
// 曲の尺で揺れるため、巡数固定だと間隔が安定しない)。
const COMBI_SPECIAL_MIN_MS = 15 * 60 * 1000;
const COMBI_SPECIAL_MAX_MS = 30 * 60 * 1000;
const combiNextSpecialDelay = () =>
    COMBI_SPECIAL_MIN_MS + Math.random() * (COMBI_SPECIAL_MAX_MS - COMBI_SPECIAL_MIN_MS);
const COMBI_R2 = "https://pub-b863fe2ba58a4525be0263e22ceb85a5.r2.dev/";
const COMBI = { active: false, phase: null, cycle: 0, timer: null, cleanup: null, specialAt: 0 };

function combiClearTimer() {
    if (COMBI.timer) { clearTimeout(COMBI.timer); COMBI.timer = null; }
}

// いま鳴っている/映っているものを全部止める(フェーズ切替の共通処理)
function combiStopAll() {
    combiClearTimer();
    if (COMBI.cleanup) { COMBI.cleanup(); COMBI.cleanup = null; }
    if (typeof isCutUpPlaying !== "undefined" && isCutUpPlaying) stopCutUpPlayback();
    if (PIPE.active) exitTestLevel2();
    if (audioElement) { try { audioElement.pause(); } catch (e) {} }
}

// 音声を1曲かけて、終わったら next() へ。曲が無い場合も止まらないよう保険を張る。
function combiPlayOneTrack(next) {
    if (!audioElement || !audioMetadataPool || !audioMetadataPool.length) {
        COMBI.timer = setTimeout(next, 60000);
        return () => {};
    }
    const t = audioMetadataPool[Math.floor(Math.random() * audioMetadataPool.length)];
    loadTrack(t.file_id);
    const done = () => { audioElement.removeEventListener("ended", done); next(); };
    audioElement.addEventListener("ended", done);
    audioElement.play().catch(err => {
        console.warn("[combi] 音声再生に失敗。時間で進めます。", err);
        COMBI.timer = setTimeout(next, 60000);
    });
    return () => audioElement.removeEventListener("ended", done);
}

function combiEnterPlayB() {
    combiStopAll();
    COMBI.phase = "playB";
    const ms = combiPlayBMs();
    startCutUpPlayback();
    if (window.addDecisionLog) window.addDecisionLog(`Combination: Play B (${Math.round(ms / 1000)}秒)`, "success");
    COMBI.timer = setTimeout(() => { if (COMBI.active) combiEnterPipe(); }, ms);
}

// pipe フェーズ中は updateLoop(isPlaying) が回らないため、レーンAのタイムラインと
// 時刻表示をここで駆動する。フェーズが変われば条件が外れて自然に止まる。
function combiPipeUiLoop() {
    if (!COMBI.active || COMBI.phase !== "pipe") return;
    const d = (audioElement && audioElement.duration) || 0;
    const t = audioElement ? audioElement.currentTime : 0;
    drawTimeline("timeline-canvas-a", t, d, currentTrackEvents || []);
    const timeElA = document.getElementById("ana-time-a");
    if (timeElA) timeElA.textContent = `${t.toFixed(1)}s / ${d.toFixed(1)}s`;
    requestAnimationFrame(combiPipeUiLoop);
}

function combiEnterPipe() {
    combiStopAll();
    COMBI.phase = "pipe";
    enterTestLevel2();
    if (window.addDecisionLog) window.addDecisionLog("Combination: test-level2 (音声1曲分)", "success");
    drawTimeline("timeline-canvas-b", 0, 0, []);   // レーンBは前フェーズの残像を消しておく
    COMBI.cleanup = combiPlayOneTrack(() => {
        if (!COMBI.active) return;
        COMBI.cycle++;
        // special は「解放されていて、かつ前回から15〜30分(抽選済み)経過していたら」挟む
        if (COMBI_SPECIAL_ENABLED && Date.now() >= COMBI.specialAt) combiEnterSpecial();
        else combiEnterPlayB();
    });
    combiPipeUiLoop();
}

/* ── special シーン ───────────────────────────────────────────────────
 * 動画90/91/92 を16:9キャンバスの中央に横幅フィット(2:1素材→1920x960)で
 * 丸ごと1本再生する。他の映像・音声は出さない。
 * 音は音声トラックを使わず「動画自体の音声」だけを鳴らす(2026-08-05統一仕様)。
 * フリーズフレーム・空間音響も special には適用しない。
 * 90〜92 はローカルの videos/ に無く R2 にのみ在るため R2 から直接再生。
 * ------------------------------------------------------------------ */
const SPECIAL_VIDEOS = [90, 91, 92];
const SPECIAL = { active: false, box: null, lastIdx: -1, onEnd: null };

function specialTeardown() {
    if (SPECIAL.box && SPECIAL.box.parentNode) SPECIAL.box.parentNode.removeChild(SPECIAL.box);
    SPECIAL.box = null;
    if (audioElement) { try { audioElement.pause(); } catch (e) {} }
}

// 1本を丸ごと再生し、終わったら next() を呼ぶ。音は動画自体の音声のみ。
function specialPlayOnce(next) {
    let i = Math.floor(Math.random() * SPECIAL_VIDEOS.length);
    if (SPECIAL_VIDEOS.length > 1 && i === SPECIAL.lastIdx) i = (i + 1) % SPECIAL_VIDEOS.length;
    SPECIAL.lastIdx = i;
    const videoNum = SPECIAL_VIDEOS[i];
    const sfx = window.VIDEO_QUALITY_SUFFIX || "Sss720p";

    // 他シーンと同じ 16:9 キャンバス(.display-area)の中に置く。viewport固定ではないため
    // --app-scale で一緒に縮み、フェーズが変わっても画角が飛ばない。
    const stage = document.querySelector(".display-area") || document.body;
    const box = document.createElement("div");
    box.id = "special-stage";
    box.style.cssText =
        "position:absolute; inset:0; z-index:9999; background:#000; display:flex;" +
        "align-items:center; justify-content:center;";
    const vid = document.createElement("video");
    vid.playsInline = true;
    vid.muted = false;                      // 動画自体の音声だけを鳴らす(トラックは使わない)
    // 枠いっぱい + contain。素材は 2:1 なので 16:9 キャンバスでは自動的に
    // 横幅いっぱい(1920x960)・上下センターになる。サイズ計算は一切しない。
    // センター全面表示なのでパン=0・音量=1、空間音響も不要。
    vid.style.cssText = "width:100%; height:100%; object-fit:contain; background:#000;";
    vid.src = COMBI_R2 + `${videoNum}-${sfx}.mp4`;
    box.appendChild(vid);
    stage.appendChild(box);
    SPECIAL.box = box;

    // 動画1本がまるまる終わったら次へ
    let done = false;
    const settle = () => {
        if (done) return;
        done = true;
        if (box.parentNode) box.parentNode.removeChild(box);
        if (SPECIAL.box === box) SPECIAL.box = null;
        next();
    };

    // src を入れた直後の play() は読み込み準備が整う前で中断されるため、
    // パイプカードと同じく canplay を待ってから鳴らす。
    vid.addEventListener("ended", settle, { once: true });
    vid.addEventListener("error", () => {
        console.warn(`[special] 動画 ${videoNum} を読めません`, vid.error && vid.error.message);
        settle();
    }, { once: true });
    vid.addEventListener("canplay", () => {
        vid.play().catch(err => console.warn("[special] 動画のplay失敗", err));
    }, { once: true });
    vid.load();

    console.log(`[special] ${videoNum}-${sfx}.mp4 (動画音声のみ)`);
    if (window.addDecisionLog) window.addDecisionLog(`special: 動画${videoNum} (動画音声のみ・キャンバス中央)`, "trigger");
}

// ファイルをランダムに変えながらループ
function startSpecialScene() {
    if (SPECIAL.active) return;
    SPECIAL.active = true;
    if (typeof isCutUpPlaying !== "undefined" && isCutUpPlaying) stopCutUpPlayback();
    if (PIPE.active) exitTestLevel2();
    if (isPlaying) stopSequence();
    if (normalScreensContainer) normalScreensContainer.style.setProperty("display", "none", "important");
    if (collageWrapper) collageWrapper.style.setProperty("display", "none", "important");
    const loop = () => { if (SPECIAL.active) specialPlayOnce(loop); };
    loop();
}

function stopSpecialScene() {
    SPECIAL.active = false;
    specialTeardown();
}
window.startSpecialScene = startSpecialScene;
window.stopSpecialScene = stopSpecialScene;

// Combination のスペシャル区間は special シーンを1回だけ流して通常へ戻る
function combiEnterSpecial() {
    combiStopAll();
    COMBI.phase = "special";
    COMBI.cleanup = specialTeardown;
    COMBI.specialAt = Date.now() + combiNextSpecialDelay();   // 次のspecialを抽選
    specialPlayOnce(() => { if (COMBI.active) combiEnterPlayB(); });
}

function startCombination() {
    if (!PIPE.edges || !Object.keys(PIPE.edges).length) {
        console.warn("[combi] 入出辺データが未読込みです。");
    }
    COMBI.active = true;
    COMBI.cycle = 0;
    COMBI.specialAt = Date.now() + combiNextSpecialDelay();   // 初回specialまでの間隔を抽選
    combiEnterPlayB();                                         // 冒頭は必ず Play B から
}

function stopCombination() {
    COMBI.active = false;
    COMBI.phase = null;
    combiStopAll();
}
window.startCombination = startCombination;
window.stopCombination = stopCombination;

// 連結は「動画終了で自動連結」(onended)に一本化したため、updateLoop側では何もしない。
// (「レベル2」は連結の合図ではなく"音"の話。音のレベル2フィルタは別途対応する。)
function updatePipeLevel2(currentTime) {
    if (!PIPE.active) return;
}
