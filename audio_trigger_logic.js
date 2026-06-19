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

function playSequence() {
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

// Main high-precision animation loop
function updateLoop() {
    if (!isPlaying) return;

    const currentTime = audioElement.currentTime;
    const duration = audioElement.duration || 0;

    // Update progress bar & time display
    currentTimeDisplay.textContent = `${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`;
    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    progressBar.style.width = `${progressPercent}%`;

    // Check triggers
    currentTrackEvents.forEach(event => {
        if (event.time_sec <= currentTime && !triggeredEventIds.has(event.id)) {
            triggerEvent(event);
        }
    });

    updateNextTriggerDisplay();

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
        `${event.onomatopoeia} (Time: ${event.time_sec}s, Str: ${event.strength.toFixed(2)})`
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
        
        // Load and play video
        video.src = VIDEO_BASE_PATH + videoFileName;
        video.play().then(() => {
            video.classList.add("playing");
        }).catch(err => {
            console.warn(`[demo] Video file not found: ${videoFileName}. Visualizing triggers only.`);
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

// Start loading metadata on page load
window.addEventListener("DOMContentLoaded", loadMetadata);
