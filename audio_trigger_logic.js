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

window.audioBufferCache = {}; // filename -> AudioBuffer

async function preloadAllAudios(basePath, onProgress) {
    let loadedCount = 0;
    const filesToLoad = Array.from(ALLOWED_TRACKS_SET).map(id => {
        if (id.includes("scene2end")) {
            return id.replace("scene2end", "scene2End") + ".mp3";
        }
        return id.toUpperCase() + ".mp3";
    });
    const totalCount = filesToLoad.length;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const tempCtx = new AudioContextClass();
    
    const promises = filesToLoad.map(async (file) => {
        const url = basePath + file + (window.VIDEO_CACHE_BUST || "");
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            const decoded = await tempCtx.decodeAudioData(arrayBuffer);
            window.audioBufferCache[file] = decoded;
        } catch (e) {
            console.warn(`[demo] Failed to preload audio buffer for ${file}:`, e);
        } finally {
            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalCount);
        }
    });
    
    await Promise.all(promises);
    await tempCtx.close();
    console.log(`[demo] Preloaded ${Object.keys(window.audioBufferCache).length} audio buffers.`);
}

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

        // 実在する動画だけをプールに残す（欠番選択による一瞬の黒画面を防ぐ）
        await filterAvailableVideos(VIDEO_BASE_PATH);

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
        
        if (preloadProgress) preloadProgress.textContent = "0% (0/18 videos)";
        if (overlayProgress) overlayProgress.textContent = "0%";
        await window.preloadAllVideos(VIDEO_BASE_PATH, (loaded, total) => {
            const pct = Math.round((loaded / total) * 100);
            if (preloadProgress) preloadProgress.textContent = `${pct}% (${loaded}/${total} videos)`;
            if (overlayProgress) overlayProgress.textContent = `${pct}%`;
        });

        // 音響のAudioBufferプリロードを一括開始
        if (preloadProgress) preloadProgress.textContent = "0% (0/38 audios)";
        if (overlayProgress) overlayProgress.textContent = "0%";
        await preloadAllAudios(AUDIO_BASE_PATH, (loaded, total) => {
            const pct = Math.round((loaded / total) * 100);
            if (preloadProgress) preloadProgress.textContent = `${pct}% (${loaded}/${total} audios)`;
            if (overlayProgress) overlayProgress.textContent = `${pct}%`;
        });
        
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
            
            if (planABtn) {
                planABtn.addEventListener("click", () => {
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
    "t538_02", "t538_2"
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
    
    // Hide timeline track B for simple single track display (Item 3)
    const sectionB = document.getElementById("timeline-section-b");
    if (sectionB) sectionB.style.display = "none";
    
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

const FIB_SIZES = [144, 233, 377, 610];
// Plan Bコラージュのキャンバス寸法（Plan Aと同じ最大画角 3840x2160・向き固定）
const COLLAGE_W = 3840;
const COLLAGE_H = 2160;

function resizeCollage() {
    const container = document.getElementById("duet-collage-container");
    const wrapper = document.getElementById("duet-collage-wrapper");
    if (wrapper && container) {
        const scale = wrapper.clientWidth / COLLAGE_W;
        container.style.transform = `scale(${scale})`;
    }
}
window.addEventListener("resize", resizeCollage);

let isCutUpPlaying = false;
let selectedPlan = "A";
let activeCollageSlots = [null, null, null, null]; // Slot mapping for SCREEN 1, 2, 3, 4 cards
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
    activeCollageSlots = [null, null, null, null];
    nextSlotIndex = 0;
    
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
    activeCollageSlots = [null, null, null, null];
    
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

function playNextCutUpSlice(agentId) {
    if (!isCutUpPlaying) return;
    
    const fileKeys = Object.keys(window.audioBufferCache);
    if (fileKeys.length === 0) {
        logMessage("ERROR", "No preloaded audio buffers found for cut-up!");
        stopCutUpPlayback();
        return;
    }
    
    // Pick random track
    const randomFile = fileKeys[Math.floor(Math.random() * fileKeys.length)];
    const audioBuffer = window.audioBufferCache[randomFile];
    
    // Find metadata
    const trackData = audioMetadataPool.find(t => {
        const normFileId = t.file_id.replace(/\.(aif|aiff|mp3)$/i, '').toLowerCase();
        const normRandFile = randomFile.replace(/\.mp3$/i, '').toLowerCase();
        return normFileId === normRandFile;
    });
    
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
                triggerCollageVideo(event);
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
                triggerCollageVideo(event);
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
        console.warn("[demo] Availability check returned 0 playable videos — keeping full pool (probe likely failed).");
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

// Duet Collage Trigger and helper functions (Pattern B Test Only - Pre-cropped video version)
function triggerCollageVideo(event) {
    if (!isCutUpPlaying || !collageContainer) return;
    
    // Determine audio level
    let audioLevel = 1;
    if (event.strength >= 0.75 || event.type === "アタック") {
        audioLevel = 4;
    } else if (event.strength >= 0.5) {
        audioLevel = 3;
    } else if (event.strength >= 0.25) {
        audioLevel = 2;
    }
    
    // Select video data (always use new Set() so we can reuse files in this test collage)
    const videoData = selectVideoByLevel(audioLevel, new Set());
    if (!videoData) return;
    
    const fileName = videoData[0];
    let finalFileName = fileName;
    const match = fileName.match(/(\d+)\.(mov|mp4)/i);
    if (match) {
        finalFileName = `${match[1]}-Sss720p.mp4`;
    }
    const blobUrl = window.videoBlobCache[fileName] || (VIDEO_BASE_PATH + finalFileName);
    
    // 短辺 S をフィボナッチサイズから選択し、長辺は 2 * S とすることでアスペクト比 1:2 / 2:1 を固定する
    const S = FIB_SIZES[Math.floor(Math.random() * FIB_SIZES.length)];
    const isVertical = Math.random() < 0.5;
    const visW = isVertical ? S : 2 * S;
    const visH = isVertical ? 2 * S : S;
    
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
    videoEl.src = blobUrl;
    
    // 枠のサイズ（短辺 S）に合わせて音量を自動調節 (Item 3)
    const volume = (S - 144) / (610 - 144) * 0.9 + 0.1; // 0.1 (静) 〜 1.0 (動)
    videoEl.volume = Math.min(1.0, volume * (window.videoGainVolume || 1.0)); // gain>1.0でのDOMException回避
    
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
    };
    
    wrapperEl.appendChild(videoEl);
    
    // コンテナへ追加
    collageContainer.appendChild(wrapperEl);
    
    // 4スロットマッピング：空いているスロット、または最も古いスロットを押し出し (Item 6)
    let targetIndex = activeCollageSlots.findIndex(s => s === null);
    if (targetIndex === -1) {
        // 空きがない場合はラウンドロビンで押し出し
        targetIndex = nextSlotIndex;
        nextSlotIndex = (nextSlotIndex + 1) % 4;
        
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
        wrapperEl.dataset.state = "FREEZING";
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
