// audio_trigger_logic.js

let videoMetadataPool = [];
let audioMetadataPool = [];
let currentTrackEvents = [];
let triggeredEventIds = new Set();
let isPlaying = false;
let screenIndex = 0; // Screen rotation index

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

// Fetch metadata files
async function loadMetadata() {
    try {
        // Local videos folder auto-detection
        try {
            const testRes = await fetch("videos/05-Sss720p.mp4", { method: 'HEAD' });
            if (testRes.ok) {
                console.log("[demo] Local /videos/ folder detected. Using local videos same-origin source.");
                VIDEO_BASE_PATH = "videos/";
                addDecisionLog("Local videos folder detected. Using local videos (no CORS restriction, 50x Web Audio boost active).", "success");
            }
        } catch (e) {
            console.log("[demo] Local videos not found. Using Cloudflare R2.");
        }

        // プリロード用の動画要素プールを初期化
        players.forEach(p => p.initializePool(VIDEO_BASE_PATH));

        // Load videos metadata
        const resVideos = await fetch("logic_weights.json");
        videoMetadataPool = await resVideos.json();
        console.log(`[demo] Loaded ${videoMetadataPool.length} videos metadata.`);

        // 動画の4レベル分類
        classifyVideos();

        // フリーズフレーム情報のロード
        await window.loadFreezeFrames();

        // Load audios metadata
        const resAudios = await fetch("Audio%20analysis%20data/sound_metadata.json");
        audioMetadataPool = await resAudios.json();
        console.log(`[demo] Loaded ${audioMetadataPool.length} audios metadata.`);

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

function populateTrackSelect() {
    if (!trackSelect) return;
    trackSelect.innerHTML = '<option value="" disabled selected>Select an audio track...</option>';
    
    // Filter to include only scene2End tracks
    const sortedAudios = [...audioMetadataPool]
        .filter(track => track.file_id.includes("scene2End"))
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
}

// Track change handler
function handleTrackChange() {
    stopSequence();
    
    if (!trackSelect) return;
    const fileId = trackSelect.value;
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
    addDecisionLog(`--- Loaded track: ${mp3FileName} ---`, "success");

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
    screenIndex = 0;
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
    if (playButton) {
        playButton.textContent = "Play Sequence";
        playButton.style.background = "linear-gradient(135deg, #0088ff 0%, #00bfff 100%)";
        playButton.style.boxShadow = "0 4px 15px rgba(0, 191, 255, 0.3)";
    }
    
    // Clear screens
    players.forEach((player, idx) => {
        player.stop();
        const wrapper = document.getElementById(`wrapper-${idx + 1}`);
        if (wrapper) wrapper.classList.remove("active");
    });
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
    drawTimeline(currentTime, duration, currentTrackEvents);
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
    }

    if (audioElement.ended) {
        logMessage("SYSTEM", "Track completed.");
        pauseSequence();
        return;
    }

    requestAnimationFrame(updateLoop);
}

// 動画をActivityスコアに基づいて4レベルに分類する
function classifyVideos() {
    videoPools = { 1: [], 2: [], 3: [], 4: [] };
    const IDX_WEIGHT = 4;
    const IDX_TIME = 5;
    const IDX_HARDNESS = 7;
    
    videoMetadataPool.forEach(v => {
        const weight = v[IDX_WEIGHT] || 0;
        const time = v[IDX_TIME] || 0;
        const hardness = v[IDX_HARDNESS] || 0;
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

    // Dynamic decision log
    let tempLvl = 1;
    if (event.strength >= 0.75 || event.type === "アタック") tempLvl = 4;
    else if (event.strength >= 0.5) tempLvl = 3;
    else if (event.strength >= 0.25) tempLvl = 2;
    
    let tempScrCount = 1;
    if (tempLvl === 4) tempScrCount = 3;
    else if (tempLvl === 3) tempScrCount = 2;

    addDecisionLog(`AUDIO ONSET: ${event.onomatopoeia} (Time: ${event.time_sec.toFixed(1)}s, Level ${tempLvl}, Strength: ${event.strength.toFixed(2)}) -> Triggering ${tempScrCount} screens`, "warning");

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

    // Determine how many screens to trigger based on audio level
    let numScreens = 1;
    if (audioLevel === 4) {
        numScreens = 3;
    } else if (audioLevel === 3) {
        numScreens = 2;
    }

    let chosenInTrigger = new Set();

    // 振付ステートマシンに基づいて対象画面を取得して順次再生
    const screensToPlay = getScreensToPlay(numScreens);
    screensToPlay.forEach(activeScreenNum => {
        reactScreenWithVideo(activeScreenNum, event, chosenInTrigger);
    });
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
            color = "var(--accent-orange)";
            radius = 5;
            lineH = 30;
        } else if (e.strength >= 0.5) {
            level = 3;
            color = "var(--accent-blue)";
            radius = 4.5;
            lineH = 22;
        } else if (e.strength >= 0.25) {
            level = 2;
            color = "var(--accent-green)";
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
            
            const actScore = vData.activity || (w + t + h) / 3;
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
