// audio_trigger_logic.js

let videoMetadataPool = [];
let audioMetadataPool = [];
let currentTrackEvents = [];
let triggeredEventIds = new Set();
let isPlaying = false;
let screenIndex = 0; // Screen rotation index

const audioElement = document.getElementById("audio-element");
const playButton = document.getElementById("play-btn");
const trackSelect = document.getElementById("track-select");
const currentTimeDisplay = document.getElementById("current-time");
const totalTriggersDisplay = document.getElementById("total-triggers");
const nextTriggerDisplay = document.getElementById("next-trigger");
const progressBar = document.getElementById("progress-bar");
const logPanel = document.getElementById("log-panel");

// New UI bindings for parameters and visualizer
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
        // Load videos metadata
        const resVideos = await fetch("logic_weights.json");
        videoMetadataPool = await resVideos.json();
        console.log(`[demo] Loaded ${videoMetadataPool.length} videos metadata.`);

        // Load audios metadata
        const resAudios = await fetch("Audio%20analysis%20data/sound_metadata.json");
        audioMetadataPool = await resAudios.json();
        console.log(`[demo] Loaded ${audioMetadataPool.length} audios metadata.`);

        // Populate track select dropdown
        populateTrackSelect();
    } catch (e) {
        console.error("[demo] Failed to load metadata files:", e);
        logMessage("SYSTEM", "Failed to load metadata. Check paths.");
    }
}

function populateTrackSelect() {
    trackSelect.innerHTML = '<option value="" disabled selected>Select an audio track...</option>';
    
    // Sort audios by dynamism score for convenience
    const sortedAudios = [...audioMetadataPool].sort((a, b) => b.profile.amount.dynamism_score - a.profile.amount.dynamism_score);

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
    
    const fileId = trackSelect.value;
    const trackData = audioMetadataPool.find(t => t.file_id === fileId);
    if (!trackData) return;

    // Load MP3 file (mapping .aif to .mp3)
    const mp3FileName = fileId.replace(/\.(aif|aiff)$/i, ".mp3");
    audioElement.src = AUDIO_BASE_PATH + mp3FileName;
    audioElement.load();

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
    
    // Auto-update slider values
    if (intervalSlider) {
        intervalSlider.value = autoInterval;
        intervalVal.textContent = autoInterval + "ms";
    }
    if (thresholdSlider) {
        thresholdSlider.value = autoThreshold;
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
    currentTimeDisplay.textContent = `0.0s / ${trackData.notes.duration_sec}s`;
    totalTriggersDisplay.textContent = "0";
    progressBar.style.width = "0%";
    
    logPanel.innerHTML = "";
    logMessage("SYSTEM", `Loaded track: ${mp3FileName}`);
    logMessage("SYSTEM", `Duration: ${trackData.notes.duration_sec}s, Total Events: ${currentTrackEvents.length}`);

    updateNextTriggerDisplay();
}

function updateNextTriggerDisplay() {
    if (!audioElement.duration) {
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
playButton.addEventListener("click", () => {
    if (!audioElement.src) {
        alert("Please select a track first!");
        return;
    }

    if (isPlaying) {
        pauseSequence();
    } else {
        playSequence();
    }
});

function initAudioContext() {
    if (audioCtx) return;
    
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
    // Initialize Web Audio Context on user interaction
    initAudioContext();
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }

    audioElement.play().then(() => {
        isPlaying = true;
        playButton.textContent = "Pause Sequence";
        playButton.style.background = "linear-gradient(135deg, #ff3366 0%, #ff0055 100%)";
        playButton.style.boxShadow = "0 4px 15px rgba(255, 0, 85, 0.3)";
        logMessage("CONTROL", "Sequence started");
        
        // Start precision loop
        requestAnimationFrame(updateLoop);
    }).catch(e => {
        console.error("Audio play failed:", e);
        alert("Audio playback blocked. Click select / drag track first.");
    });
}

function pauseSequence() {
    audioElement.pause();
    isPlaying = false;
    playButton.textContent = "Play Sequence";
    playButton.style.background = "linear-gradient(135deg, #0088ff 0%, #00bfff 100%)";
    playButton.style.boxShadow = "0 4px 15px rgba(0, 191, 255, 0.3)";
    logMessage("CONTROL", "Sequence paused");
}

function stopSequence() {
    audioElement.pause();
    audioElement.currentTime = 0;
    isPlaying = false;
    playButton.textContent = "Play Sequence";
    playButton.style.background = "linear-gradient(135deg, #0088ff 0%, #00bfff 100%)";
    playButton.style.boxShadow = "0 4px 15px rgba(0, 191, 255, 0.3)";
    
    // Clear screens
    for (let i = 1; i <= 3; i++) {
        const video = document.getElementById(`video-${i}`);
        video.pause();
        video.src = "";
        video.classList.remove("playing");
        document.getElementById(`wrapper-${i}`).classList.remove("active");
    }
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
    
    const thresholdMultiplier = parseFloat(thresholdSlider.value);
    const minIntervalMs = parseFloat(intervalSlider.value);
    
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

    const currentTime = audioElement.currentTime;
    const duration = audioElement.duration || 0;

    // Update progress bar & time display
    currentTimeDisplay.textContent = `${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`;
    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    progressBar.style.width = `${progressPercent}%`;

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

// Handle trigger event
function triggerEvent(event) {
    triggeredEventIds.add(event.id);
    
    // Increment count
    const triggerCount = triggeredEventIds.size;
    totalTriggersDisplay.textContent = triggerCount;

    // Log the trigger details
    logMessage(
        event.type, 
        `${event.onomatopoeia} (Time: ${event.time_sec.toFixed(1)}s, Str: ${event.strength.toFixed(2)})`
    );

    // Rotate through screens 1, 2, 3
    const activeScreenNum = (screenIndex % 3) + 1;
    screenIndex++;

    reactScreenWithVideo(activeScreenNum, event);
}

// Video reaction and onomatopoeia popup logic
function reactScreenWithVideo(screenNum, event) {
    const wrapper = document.getElementById(`wrapper-${screenNum}`);
    const video = document.getElementById(`video-${screenNum}`);
    const onoText = document.getElementById(`ono-text-${screenNum}`);

    // Highlight screen wrapper
    wrapper.classList.add("active");

    // Select matching video
    const videoData = selectMatchingVideo(event.type);
    if (videoData) {
        const videoFileName = videoData[0]; // filename (e.g. "01.mov")
        
        let finalVideoName = videoFileName;
        const match = videoFileName.match(/(\d+)\.(mov|mp4)/i);
        if (match) {
            finalVideoName = `${match[1]}-Sss720p.mp4`;
        }
        
        // Load and play video
        video.src = VIDEO_BASE_PATH + finalVideoName;
        video.play().then(() => {
            video.classList.add("playing");
        }).catch(err => {
            console.warn(`[demo] Video file not found: ${finalVideoName}. Visualizing triggers only.`);
        });

        // Setup end handler
        video.onended = () => {
            video.classList.remove("playing");
            video.src = "";
            wrapper.classList.remove("active");
        };
    } else {
        // Fallback
        setTimeout(() => {
            wrapper.classList.remove("active");
        }, 2000);
    }

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

// Search video based on trigger type
function selectMatchingVideo(type) {
    if (!videoMetadataPool || videoMetadataPool.length === 0) return null;

    let candidates = [];
    const IDX_WEIGHT = 4;
    const IDX_TIME = 5;
    const IDX_SPACE = 6;
    const IDX_HARDNESS = 7;

    // Filter or Sort based on trigger category
    if (type === "アタック") {
        candidates = videoMetadataPool.filter(v => v[IDX_WEIGHT] >= 6 && v[IDX_TIME] >= 6);
        if (candidates.length === 0) {
            candidates = [...videoMetadataPool].sort((a, b) => (b[IDX_WEIGHT] + b[IDX_TIME]) - (a[IDX_WEIGHT] + a[IDX_TIME]));
        }
    } 
    else if (type === "うねり") {
        candidates = videoMetadataPool.filter(v => v[IDX_SPACE] >= 6 && v[IDX_TIME] <= 4);
        if (candidates.length === 0) {
            candidates = [...videoMetadataPool].sort((a, b) => (b[IDX_SPACE] - b[IDX_TIME]) - (a[IDX_SPACE] - a[IDX_TIME]));
        }
    } 
    else {
        // 刻み (Roll)
        candidates = videoMetadataPool.filter(v => v[IDX_HARDNESS] >= 6);
        if (candidates.length === 0) {
            candidates = [...videoMetadataPool].sort((a, b) => b[IDX_HARDNESS] - a[IDX_HARDNESS]);
        }
    }

    // Pick a random matching candidate
    const index = Math.floor(Math.random() * Math.min(candidates.length, 5));
    return candidates[index];
}

// Add parameters slider bindings
if (thresholdSlider) {
    thresholdSlider.addEventListener("input", () => {
        thresholdVal.textContent = parseFloat(thresholdSlider.value).toFixed(2) + "x";
    });
}
if (intervalSlider) {
    intervalSlider.addEventListener("input", () => {
        intervalVal.textContent = intervalSlider.value + "ms";
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
