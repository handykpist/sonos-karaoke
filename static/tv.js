/**
 * Sonos Karaoke TV Display Client
 * - Sub-millisecond Monotonic Time Synchronization with Live Tap-to-Sync & per-song calibration
 * - Built-in Web Audio Karaoke Microphone with Reverb/Echo & Live VU Meter
 * - Responsive 60 FPS stage rendering, solo countdowns, and cast support
 */

// --- Safe Storage Helpers ---
function getStoredVal(key, def) {
    try {
        const v = localStorage.getItem(key);
        return v !== null ? v : def;
    } catch (e) {
        return def;
    }
}

function setStoredVal(key, val) {
    try {
        localStorage.setItem(key, val);
    } catch (e) {}
}

// --- Application State ---
let currentTrackId = "";
let currentLyrics = [];
let currentLyricsRaw = "";
let playbackState = "STOPPED";
let baseDuration = 0;
let timingOffset = 0.0;
let activeRoom = "Sonos";

// Sub-millisecond Monotonic Time Sync
let clientBasePosition = 0;
let clientSyncPerfTime = performance.now();
let lastServerPosition = -1;

let activeLineIndex = -1;
let linesMode = getStoredVal("karaoke_lines_mode", "3"); // "3" (Focus), "2" (Ultra), "4" (Context), "all"

// --- DOM Elements ---
const ambientBg = document.getElementById("ambient-bg");
const lyricsStage = document.getElementById("lyrics-stage");
const lyricsTrack = document.getElementById("lyrics-track");
const instrumentalBanner = document.getElementById("instrumental-banner");
const instTitle = document.getElementById("inst-title");
const instTimer = document.getElementById("inst-timer");
const instNextPreview = document.getElementById("inst-next-preview");
const trackArt = document.getElementById("track-art");
const trackTitle = document.getElementById("track-title");
const trackArtist = document.getElementById("track-artist");
const currentTimeEl = document.getElementById("current-time");
const totalTimeEl = document.getElementById("total-time");
const progressBarFill = document.getElementById("progress-bar-fill");
const activeRoomName = document.getElementById("active-room-name");
const offsetLabel = document.getElementById("offset-label");
const btnLinesMode = document.getElementById("btn-lines-mode");
const linesModeLabel = document.getElementById("lines-mode-label");
const qrModal = document.getElementById("qr-modal");
const qrUrlText = document.getElementById("qr-url-text");
const roomModal = document.getElementById("room-modal");
const roomList = document.getElementById("room-list");
const visualizer = document.getElementById("visualizer");

// Sync Dock Elements
const btnOffset = document.getElementById("btn-offset");
const syncDock = document.getElementById("sync-dock");
const syncBadgeVal = document.getElementById("sync-badge-val");
const syncSlider = document.getElementById("sync-slider");
const syncSaveTag = document.getElementById("sync-save-tag");
const btnTapSync = document.getElementById("btn-tap-sync");
const btnCloseSyncDock = document.getElementById("btn-close-sync-dock");
const btnResetSync = document.getElementById("btn-reset-sync");

// Mic Elements
const btnMic = document.getElementById("btn-mic");
const micStatusLabel = document.getElementById("mic-status-label");
const micVuMini = document.getElementById("mic-vu-mini");
const micModal = document.getElementById("mic-modal");
const btnCloseMic = document.getElementById("btn-close-mic");
const btnDoneMic = document.getElementById("btn-done-mic");
const micMasterToggle = document.getElementById("mic-master-toggle");
const micStatusDesc = document.getElementById("mic-status-desc");
const vuPeakLabel = document.getElementById("vu-peak-label");
const vuMeterFill = document.getElementById("vu-meter-fill");
const micGainSlider = document.getElementById("mic-gain-slider");
const micGainVal = document.getElementById("mic-gain-val");
const micEchoSlider = document.getElementById("mic-echo-slider");
const micEchoVal = document.getElementById("mic-echo-val");
const micPassthroughToggle = document.getElementById("mic-passthrough-toggle");
const micDeviceSelect = document.getElementById("mic-device-select");

function getLinesModeLabel(mode) {
    switch (mode) {
        case "2": return "Lines: 2 (Ultra)";
        case "3": return "Lines: 3 (Focus)";
        case "4": return "Lines: 4 (Context)";
        case "all": return "Lines: All";
        default: return "Lines: 3 (Focus)";
    }
}

function applyBodyModeClass() {
    if (linesMode === "all") {
        document.body.classList.add("mode-all");
    } else {
        document.body.classList.remove("mode-all");
    }
    if (linesModeLabel) {
        linesModeLabel.textContent = getLinesModeLabel(linesMode);
    }
}
applyBodyModeClass();

function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// =========================================================================
// 1. High-Precision Time Synchronization & Sonos Status Poller
// =========================================================================

async function pollStatus() {
    try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const data = await res.json();

        const prevState = playbackState;
        playbackState = data.state || "STOPPED";
        baseDuration = data.duration || 0;

        // Load timing offset
        if (typeof data.timingOffset === "number" && !syncDock.classList.contains("open")) {
            timingOffset = data.timingOffset;
            updateSyncUI();
        }

        if (data.room && activeRoomName) {
            activeRoom = data.room;
            activeRoomName.textContent = activeRoom;
        }

        if (data.tvUrl && qrUrlText) {
            qrUrlText.textContent = data.tvUrl;
        }

        const serverPos = typeof data.position === "number" ? data.position : parseFloat(data.position) || 0;

        // Monotonic Edge Synchronization
        if (playbackState === "PLAYING") {
            if (serverPos !== lastServerPosition || prevState !== "PLAYING") {
                lastServerPosition = serverPos;
                clientBasePosition = serverPos;
                clientSyncPerfTime = performance.now();
            } else {
                // If local interpolated clock drifts more than 1.6s from speaker, snap back
                const localElapsed = (performance.now() - clientSyncPerfTime) / 1000;
                const localCur = clientBasePosition + localElapsed;
                if (Math.abs(localCur - serverPos) > 1.6) {
                    clientBasePosition = serverPos;
                    clientSyncPerfTime = performance.now();
                }
            }
        } else {
            lastServerPosition = serverPos;
            clientBasePosition = serverPos;
            clientSyncPerfTime = performance.now();
        }

        const newTrackId = `${data.artist || ""} - ${data.title || ""}`.trim();
        const hasLyrics = Boolean(data.lyrics && data.lyrics.lines && data.lyrics.lines.length > 0);
        const lyricsRaw = (data.lyrics && data.lyrics.raw) || "";

        if (newTrackId !== currentTrackId) {
            currentTrackId = newTrackId;
            currentLyricsRaw = lyricsRaw;
            onTrackChanged(data);
        } else if (hasLyrics && (currentLyrics.length === 0 || lyricsRaw !== currentLyricsRaw)) {
            currentLyricsRaw = lyricsRaw;
            currentLyrics = data.lyrics.lines;
            renderLyrics(currentLyrics);
        }

        if (visualizer) {
            visualizer.style.opacity = (playbackState === "PLAYING") ? "1" : "0.2";
        }
    } catch (e) {
        console.warn("Poll status notice:", e);
    }
}

function onTrackChanged(data) {
    if (trackTitle) trackTitle.textContent = data.title || "No Track Playing";
    if (trackArtist) trackArtist.textContent = data.artist || "Sonos Audio";
    document.title = data.title ? `${data.title} - Sonos Karaoke` : "Sonos Karaoke TV";

    const artUrl = data.albumArt ? `/api/albumart?t=${Date.now()}` : "/img/vinyl.png";
    if (trackArt) trackArt.src = artUrl;
    if (ambientBg) ambientBg.style.backgroundImage = `url('${artUrl}')`;

    // Check if user has a custom saved offset for this song
    const savedSongOffset = getStoredVal(`offset_${currentTrackId}`, null);
    if (savedSongOffset !== null) {
        const parsed = parseFloat(savedSongOffset);
        if (!isNaN(parsed)) {
            timingOffset = parsed;
            updateSyncUI();
            postOffsetToServer(timingOffset);
            showSaveTag("Song Offset Loaded");
        }
    }

    activeLineIndex = -1;
    if (data.lyrics && data.lyrics.lines && data.lyrics.lines.length > 0) {
        currentLyrics = data.lyrics.lines;
        renderLyrics(currentLyrics);
    } else {
        currentLyrics = [];
        if (data.title) {
            lyricsTrack.innerHTML = `
                <div class="lyrics-placeholder">
                    <div class="mic-icon">🎤</div>
                    <h2>Searching lyrics for "${data.title}"...</h2>
                    <p>${data.artist || ""}</p>
                </div>
            `;
        } else {
            lyricsTrack.innerHTML = `
                <div class="lyrics-placeholder">
                    <div class="mic-icon">🎵</div>
                    <h2>Listening for Sonos music...</h2>
                    <p>Start any song in the Sonos App or select a room</p>
                </div>
            `;
        }
        if (instrumentalBanner) instrumentalBanner.classList.remove("visible");
    }
}

function renderLyrics(lines) {
    lyricsTrack.innerHTML = "";
    activeLineIndex = -1;

    if (!lines || lines.length === 0) {
        lyricsTrack.innerHTML = `<div class="lyric-line active" style="font-size: 2.2rem; color: var(--text-muted);">Waiting for lyrics...</div>`;
        return;
    }

    lines.forEach((line, idx) => {
        const div = document.createElement("div");
        div.className = "lyric-line hidden-line"; // Start hidden
        div.dataset.index = idx;
        div.dataset.time = line.time;
        div.dataset.endTime = line.endTime;
        div.dataset.type = line.type;
        div.dataset.rawText = line.text || "";

        if (line.type === "break") {
            div.textContent = "";
            div.style.height = "0";
            div.style.margin = "0";
            div.style.padding = "0";
            div.style.display = "none";
        } else {
            div.textContent = line.text;
        }
        lyricsTrack.appendChild(div);
    });

    updateStageForTime(getInterpolatedTime());
}

// 2. High-Precision 60 FPS Sync Loop
function getInterpolatedTime() {
    if (playbackState !== "PLAYING") {
        return Math.max(0, clientBasePosition + timingOffset);
    }
    const elapsed = (performance.now() - clientSyncPerfTime) / 1000;
    return Math.max(0, clientBasePosition + elapsed + timingOffset);
}

function syncLoop() {
    const curTime = getInterpolatedTime();

    if (currentTimeEl) currentTimeEl.textContent = formatTime(curTime);
    if (totalTimeEl) totalTimeEl.textContent = formatTime(baseDuration);
    if (progressBarFill && baseDuration > 0) {
        const pct = Math.min(100, Math.max(0, (curTime / baseDuration) * 100));
        progressBarFill.style.width = `${pct}%`;
    }

    if (currentLyrics.length > 0) {
        updateStageForTime(curTime);
    }

    requestAnimationFrame(syncLoop);
}

function getNextSingableLyric(startIndex) {
    for (let i = startIndex; i < currentLyrics.length; i++) {
        if (currentLyrics[i].type !== "break" && currentLyrics[i].text && currentLyrics[i].text.trim()) {
            return currentLyrics[i].text;
        }
    }
    return "";
}

function updateStageForTime(curTime) {
    if (!currentLyrics || currentLyrics.length === 0) return;

    // 1. Song Intro (before first lyric)
    const firstSingIdx = currentLyrics.findIndex(l => l.type !== "break" && l.text.trim());
    const firstLine = firstSingIdx !== -1 ? currentLyrics[firstSingIdx] : currentLyrics[0];

    if (firstLine && curTime < firstLine.time) {
        const remaining = Math.max(0, Math.ceil(firstLine.time - curTime));
        if (instrumentalBanner) {
            instrumentalBanner.classList.add("visible");
            if (instTitle) instTitle.textContent = "🎵 Intro";
            if (instTimer) instTimer.textContent = `${remaining}s`;
            if (instNextPreview) {
                instNextPreview.innerHTML = `<span class="next-tag">First Line:</span> "${firstLine.text}"`;
            }
        }

        const lineEls = lyricsTrack.querySelectorAll(".lyric-line");
        lineEls.forEach(el => {
            el.classList.remove("active", "next-line", "upcoming", "past");
            el.classList.add("hidden-line");
        });
        activeLineIndex = -1;
        return;
    }

    // 2. Active Lyric Line or Break
    let newIndex = -1;
    let activeBreak = null;

    for (let i = 0; i < currentLyrics.length; i++) {
        const item = currentLyrics[i];
        if (curTime >= item.time && curTime < item.endTime) {
            newIndex = i;
            if (item.type === "break" || !item.text || !item.text.trim()) {
                activeBreak = item;
            }
            break;
        } else if (curTime < item.time) {
            if (i > 0 && curTime >= currentLyrics[i - 1].endTime) {
                newIndex = i - 1;
            }
            break;
        }
    }

    // Outro Check
    const lastItem = currentLyrics[currentLyrics.length - 1];
    if (curTime >= lastItem.endTime) {
        if (instrumentalBanner) {
            instrumentalBanner.classList.add("visible");
            if (instTitle) instTitle.textContent = "🎵 Outro / End of Song";
            if (instTimer) instTimer.textContent = "●";
            if (instNextPreview) instNextPreview.innerHTML = "";
        }
        const lineEls = lyricsTrack.querySelectorAll(".lyric-line");
        lineEls.forEach((el, idx) => {
            el.classList.remove("active", "next-line", "upcoming");
            if (idx === currentLyrics.length - 1 && linesMode !== "2") {
                el.classList.remove("hidden-line");
                el.classList.add("past");
            } else {
                el.classList.add("hidden-line");
            }
        });
        return;
    }

    // Handle Instrumental Break / Solo
    if (activeBreak) {
        if (instrumentalBanner) {
            instrumentalBanner.classList.add("visible");
            if (instTitle) instTitle.textContent = activeBreak.text || "🎸 Instrumental Break";
            const remaining = Math.max(0, Math.ceil(activeBreak.endTime - curTime));
            if (instTimer) instTimer.textContent = `${remaining}s`;

            const nextLyricText = getNextSingableLyric(newIndex + 1);
            if (instNextPreview) {
                if (nextLyricText) {
                    instNextPreview.innerHTML = `<span class="next-tag">Next Up:</span> "${nextLyricText}"`;
                } else {
                    instNextPreview.innerHTML = "";
                }
            }
        }

        const lineEls = lyricsTrack.querySelectorAll(".lyric-line");
        lineEls.forEach(el => {
            el.classList.remove("active", "next-line", "upcoming", "past");
            el.classList.add("hidden-line");
        });
        activeLineIndex = newIndex;
        return;
    } else {
        if (instrumentalBanner) {
            instrumentalBanner.classList.remove("visible");
        }
    }

    if (newIndex !== -1 && (newIndex !== activeLineIndex || activeLineIndex === -1)) {
        activeLineIndex = newIndex;
        applyLineClasses(activeLineIndex);
    }
}

function applyLineClasses(activeIdx) {
    const lineEls = lyricsTrack.querySelectorAll(".lyric-line");
    if (lineEls.length === 0) return;

    lineEls.forEach((el, idx) => {
        el.classList.remove("active", "next-line", "upcoming", "past", "hidden-line");
        const raw = el.dataset.rawText || el.textContent;

        if (idx === activeIdx) {
            el.classList.add("active");
            if (raw.trim()) {
                el.innerHTML = `<span class="now-sing-badge"><span class="mic-wave">🎤</span> SING NOW</span><span class="glow-word">${raw}</span>`;
            }
        } else {
            el.textContent = raw;

            if (idx === activeIdx - 1) {
                if (linesMode === "2") {
                    el.classList.add("hidden-line");
                } else {
                    el.classList.add("past");
                }
            } else if (idx === activeIdx + 1) {
                el.classList.add("next-line");
            } else if (idx === activeIdx + 2) {
                if (linesMode === "4" || linesMode === "all") {
                    el.classList.add("upcoming");
                } else {
                    el.classList.add("hidden-line");
                }
            } else if (linesMode === "all") {
                if (idx < activeIdx) el.classList.add("past");
                else el.classList.add("upcoming");
            } else {
                el.classList.add("hidden-line");
            }
        }
    });

    if (linesMode === "all") {
        const activeEl = lyricsTrack.querySelector(`.lyric-line[data-index="${activeIdx}"]`);
        if (activeEl && activeEl.dataset.type !== "break") {
            const stageHeight = lyricsStage.clientHeight;
            const elOffset = activeEl.offsetTop;
            const elHeight = activeEl.clientHeight;
            const targetScroll = -(elOffset - (stageHeight / 2) + (elHeight / 2));
            lyricsTrack.style.transform = `translateY(${targetScroll}px)`;
        }
    } else {
        lyricsTrack.style.transform = "none";
    }
}

function cycleLinesMode() {
    const modes = ["3", "2", "4", "all"];
    const curIdx = modes.indexOf(linesMode);
    linesMode = modes[(curIdx + 1) % modes.length];
    setStoredVal("karaoke_lines_mode", linesMode);
    applyBodyModeClass();
    if (activeLineIndex !== -1) {
        applyLineClasses(activeLineIndex);
    } else {
        updateStageForTime(getInterpolatedTime());
    }
}

if (btnLinesMode) {
    btnLinesMode.addEventListener("click", cycleLinesMode);
}

// =========================================================================
// 2. Interactive Live Sync Calibration & Tap-To-Sync
// =========================================================================

function updateSyncUI() {
    const str = `${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(2)}s`;
    if (offsetLabel) offsetLabel.textContent = `Sync: ${str}`;
    if (syncBadgeVal) syncBadgeVal.textContent = str;
    if (syncSlider) syncSlider.value = timingOffset.toFixed(2);
}

async function setSyncOffset(val, saveForSong = false) {
    const clamped = Math.max(-3.0, Math.min(3.0, Math.round(val * 100) / 100));
    timingOffset = clamped;
    updateSyncUI();
    await postOffsetToServer(timingOffset);

    if (saveForSong && currentTrackId) {
        setStoredVal(`offset_${currentTrackId}`, timingOffset.toString());
        showSaveTag("Saved for this song");
    }
}

function showSaveTag(msg) {
    if (!syncSaveTag) return;
    syncSaveTag.textContent = msg;
    syncSaveTag.classList.add("visible");
    setTimeout(() => syncSaveTag.classList.remove("visible"), 3500);
}

async function postOffsetToServer(offset) {
    try {
        await fetch("/api/offset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offset })
        });
    } catch (e) {}
}

// Tap-To-Sync: Instantly locks current line to vocal melody
function triggerTapToSync() {
    if (!currentLyrics || currentLyrics.length === 0) return;

    // Find the nearest active or upcoming lyric line
    const rawTime = clientBasePosition + (playbackState === "PLAYING" ? (performance.now() - clientSyncPerfTime) / 1000 : 0);
    
    // Check line currently targeted or immediately upcoming
    let targetLine = null;
    if (activeLineIndex >= 0 && activeLineIndex < currentLyrics.length && currentLyrics[activeLineIndex].type !== "break") {
        targetLine = currentLyrics[activeLineIndex];
    } else {
        targetLine = currentLyrics.find(l => l.type !== "break" && Math.abs(l.time - (rawTime + timingOffset)) < 3.5);
    }

    if (!targetLine) {
        // Fallback to first line if during intro
        targetLine = currentLyrics.find(l => l.type !== "break");
    }

    if (targetLine) {
        // Desired offset = targetLine.time - rawTime
        const newOffset = targetLine.time - rawTime;
        setSyncOffset(newOffset, true);
        showSaveTag(`Synced to: "${targetLine.text.substring(0, 20)}..."`);
    }
}

if (btnOffset) {
    btnOffset.addEventListener("click", () => {
        syncDock.classList.toggle("open");
        if (syncDock.classList.contains("open")) {
            syncSlider.value = timingOffset.toFixed(2);
        }
    });
}

if (btnCloseSyncDock) {
    btnCloseSyncDock.addEventListener("click", () => syncDock.classList.remove("open"));
}

if (btnTapSync) {
    btnTapSync.addEventListener("click", triggerTapToSync);
}

if (btnResetSync) {
    btnResetSync.addEventListener("click", () => setSyncOffset(0.0, true));
}

if (syncSlider) {
    syncSlider.addEventListener("input", (e) => {
        setSyncOffset(parseFloat(e.target.value), false);
    });
    syncSlider.addEventListener("change", (e) => {
        setSyncOffset(parseFloat(e.target.value), true);
    });
}

document.querySelectorAll(".btn-nudge").forEach(btn => {
    btn.addEventListener("click", () => {
        const delta = parseFloat(btn.dataset.delta);
        if (!isNaN(delta)) {
            setSyncOffset(timingOffset + delta, true);
        }
    });
});

// =========================================================================
// 3. Web Audio Karaoke Microphone System
// =========================================================================

let micAudioContext = null;
let micStream = null;
let micSourceNode = null;
let micGainNode = null;
let micPassthroughNode = null;
let micDelayNode = null;
let micFeedbackNode = null;
let micFilterNode = null;
let micReverbGainNode = null;
let micAnalyserNode = null;
let micAnimId = null;

let isMicActive = false;
let micGainValue = parseFloat(getStoredVal("karaoke_mic_gain", "1.0")); // 0.0 - 2.0
let micEchoValue = parseFloat(getStoredVal("karaoke_mic_echo", "0.30")); // 0.0 - 1.0
let micHearSelf = getStoredVal("karaoke_mic_hear_self", "false") === "true"; // default off to prevent feedback on laptops
let selectedAudioDevice = getStoredVal("karaoke_mic_device", "default");

async function initAudioContext() {
    if (!micAudioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        micAudioContext = new AudioCtx();
    }
    if (micAudioContext.state === "suspended") {
        await micAudioContext.resume();
    }
}

async function startMicrophone() {
    try {
        await initAudioContext();

        const constraints = {
            audio: {
                deviceId: selectedAudioDevice !== "default" ? { exact: selectedAudioDevice } : undefined,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false
            }
        };

        micStream = await navigator.mediaDevices.getUserMedia(constraints);
        micSourceNode = micAudioContext.createMediaStreamSource(micStream);

        // 1. Master Mic Gain
        micGainNode = micAudioContext.createGain();
        micGainNode.gain.value = micGainValue;

        // 2. Analyser for VU Meter
        micAnalyserNode = micAudioContext.createAnalyser();
        micAnalyserNode.fftSize = 64;
        micAnalyserNode.smoothingTimeConstant = 0.8;

        // 3. Passthrough Gain to Speakers
        micPassthroughNode = micAudioContext.createGain();
        micPassthroughNode.gain.value = micHearSelf ? 1.0 : 0.0;

        // 4. Karaoke Reverb / Echo Feedback Loop (180ms warm delay + 3.2kHz filter)
        micDelayNode = micAudioContext.createDelay(1.0);
        micDelayNode.delayTime.value = 0.18; // 180ms delay

        micFeedbackNode = micAudioContext.createGain();
        micFeedbackNode.gain.value = micEchoValue * 0.55; // feedback intensity

        micFilterNode = micAudioContext.createBiquadFilter();
        micFilterNode.type = "lowpass";
        micFilterNode.frequency.value = 3200; // warm vocal roll-off

        micReverbGainNode = micAudioContext.createGain();
        micReverbGainNode.gain.value = micEchoValue > 0 && micHearSelf ? micEchoValue : 0.0;

        // Connect Graph
        micSourceNode.connect(micGainNode);
        micGainNode.connect(micAnalyserNode);

        // Voice output routing
        micGainNode.connect(micPassthroughNode);
        micPassthroughNode.connect(micAudioContext.destination);

        // Echo loop routing
        micGainNode.connect(micDelayNode);
        micDelayNode.connect(micFilterNode);
        micFilterNode.connect(micFeedbackNode);
        micFeedbackNode.connect(micDelayNode); // loopback
        micDelayNode.connect(micReverbGainNode);
        micReverbGainNode.connect(micAudioContext.destination);

        isMicActive = true;
        updateMicUI();
        runMicVisualizer();
        enumerateMicDevices();
    } catch (err) {
        console.error("Microphone activation failed:", err);
        alert("Could not access microphone: " + (err.message || err));
        isMicActive = false;
        updateMicUI();
    }
}

function stopMicrophone() {
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    if (micAnimId) {
        cancelAnimationFrame(micAnimId);
        micAnimId = null;
    }
    isMicActive = false;
    updateMicUI();
    if (vuMeterFill) vuMeterFill.style.width = "0%";
    if (vuPeakLabel) vuPeakLabel.textContent = "0%";
}

function toggleMicrophone() {
    if (isMicActive) {
        stopMicrophone();
    } else {
        startMicrophone();
    }
}

function updateMicUI() {
    if (btnMic) {
        if (isMicActive) {
            btnMic.classList.add("active");
            if (micStatusLabel) micStatusLabel.textContent = "Mic: LIVE";
        } else {
            btnMic.classList.remove("active");
            if (micStatusLabel) micStatusLabel.textContent = "Mic: OFF";
        }
    }
    if (micMasterToggle) {
        micMasterToggle.checked = isMicActive;
    }
    if (micStatusDesc) {
        micStatusDesc.textContent = isMicActive ? "Microphone is LIVE and listening" : "Click to enable live singing audio";
    }
    if (micGainSlider) micGainSlider.value = Math.round(micGainValue * 100);
    if (micGainVal) micGainVal.textContent = `${Math.round(micGainValue * 100)}%`;
    if (micEchoSlider) micEchoSlider.value = Math.round(micEchoValue * 100);
    if (micEchoVal) {
        const pct = Math.round(micEchoValue * 100);
        const label = pct === 0 ? "Off" : (pct < 35 ? "Subtle" : (pct < 65 ? "Stage" : "Arena"));
        micEchoVal.textContent = `${pct}% (${label})`;
    }
    if (micPassthroughToggle) {
        micPassthroughToggle.checked = micHearSelf;
    }
}

function runMicVisualizer() {
    if (!isMicActive || !micAnalyserNode) return;

    const dataArray = new Uint8Array(micAnalyserNode.frequencyBinCount);
    micAnalyserNode.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    const avg = sum / dataArray.length;
    const levelPct = Math.min(100, Math.round((avg / 128) * 100));

    if (vuMeterFill) vuMeterFill.style.width = `${levelPct}%`;
    if (vuPeakLabel) vuPeakLabel.textContent = `${levelPct}%`;

    // Mini meter in header button
    if (micVuMini) {
        const bars = micVuMini.querySelectorAll(".vu-bar");
        if (bars.length >= 3) {
            bars[0].style.height = `${Math.min(14, Math.max(3, levelPct * 0.12))}px`;
            bars[1].style.height = `${Math.min(14, Math.max(3, levelPct * 0.16))}px`;
            bars[2].style.height = `${Math.min(14, Math.max(3, levelPct * 0.10))}px`;
        }
    }

    // Active Line singing energy glow
    if (levelPct > 20) {
        const nowBadge = lyricsTrack.querySelector(".now-sing-badge");
        if (nowBadge) {
            nowBadge.style.boxShadow = `0 0 ${20 + levelPct * 0.3}px rgba(56, 189, 248, ${0.4 + levelPct * 0.005})`;
        }
    }

    micAnimId = requestAnimationFrame(runMicVisualizer);
}

async function enumerateMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === "audioinput");
        if (micDeviceSelect) {
            micDeviceSelect.innerHTML = `<option value="default">Default System Microphone</option>`;
            audioInputs.forEach((d, i) => {
                const opt = document.createElement("option");
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${i + 1}`;
                if (d.deviceId === selectedAudioDevice) opt.selected = true;
                micDeviceSelect.appendChild(opt);
            });
        }
    } catch (e) {}
}

// Mic Event Listeners
if (btnMic) {
    btnMic.addEventListener("click", () => {
        micModal.classList.add("open");
        updateMicUI();
        enumerateMicDevices();
    });
}

if (btnCloseMic) btnCloseMic.addEventListener("click", () => micModal.classList.remove("open"));
if (btnDoneMic) btnDoneMic.addEventListener("click", () => micModal.classList.remove("open"));

if (micMasterToggle) {
    micMasterToggle.addEventListener("change", (e) => {
        if (e.target.checked) startMicrophone();
        else stopMicrophone();
    });
}

if (micGainSlider) {
    micGainSlider.addEventListener("input", (e) => {
        micGainValue = parseFloat(e.target.value) / 100;
        setStoredVal("karaoke_mic_gain", micGainValue.toString());
        if (micGainNode) micGainNode.gain.value = micGainValue;
        if (micGainVal) micGainVal.textContent = `${e.target.value}%`;
    });
}

if (micEchoSlider) {
    micEchoSlider.addEventListener("input", (e) => {
        micEchoValue = parseFloat(e.target.value) / 100;
        setStoredVal("karaoke_mic_echo", micEchoValue.toString());
        if (micFeedbackNode) micFeedbackNode.gain.value = micEchoValue * 0.55;
        if (micReverbGainNode) micReverbGainNode.gain.value = micEchoValue > 0 && micHearSelf ? micEchoValue : 0.0;
        if (micEchoVal) {
            const pct = parseInt(e.target.value);
            const label = pct === 0 ? "Off" : (pct < 35 ? "Subtle" : (pct < 65 ? "Stage" : "Arena"));
            micEchoVal.textContent = `${pct}% (${label})`;
        }
    });
}

if (micPassthroughToggle) {
    micPassthroughToggle.addEventListener("change", (e) => {
        micHearSelf = e.target.checked;
        setStoredVal("karaoke_mic_hear_self", micHearSelf ? "true" : "false");
        if (micPassthroughNode) micPassthroughNode.gain.value = micHearSelf ? 1.0 : 0.0;
        if (micReverbGainNode) micReverbGainNode.gain.value = micEchoValue > 0 && micHearSelf ? micEchoValue : 0.0;
    });
}

if (micDeviceSelect) {
    micDeviceSelect.addEventListener("change", (e) => {
        selectedAudioDevice = e.target.value;
        setStoredVal("karaoke_mic_device", selectedAudioDevice);
        if (isMicActive) {
            stopMicrophone();
            startMicrophone();
        }
    });
}

// =========================================================================
// 4. Modals & Navigation Controls
// =========================================================================

const btnFullscreen = document.getElementById("btn-fullscreen");
if (btnFullscreen) btnFullscreen.addEventListener("click", toggleFullscreen);

const btnQr = document.getElementById("btn-qr");
if (btnQr) btnQr.addEventListener("click", () => qrModal && qrModal.classList.add("open"));

const btnCloseQr = document.getElementById("btn-close-qr");
if (btnCloseQr) btnCloseQr.addEventListener("click", () => qrModal && qrModal.classList.remove("open"));

const roomBadge = document.getElementById("room-badge");
if (roomBadge) roomBadge.addEventListener("click", openRoomModal);

const btnCloseRoom = document.getElementById("btn-close-room");
if (btnCloseRoom) btnCloseRoom.addEventListener("click", () => roomModal && roomModal.classList.remove("open"));

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

async function openRoomModal() {
    try {
        const res = await fetch("/api/rooms");
        const data = await res.json();
        if (!roomList) return;
        roomList.innerHTML = "";
        data.rooms.forEach(r => {
            const btn = document.createElement("button");
            btn.className = `room-item ${r.name === data.active ? 'active' : ''}`;
            btn.textContent = `${r.name} (${r.ip})`;
            btn.addEventListener("click", async () => {
                await fetch("/api/room", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ room: r.name })
                });
                if (roomModal) roomModal.classList.remove("open");
                pollStatus();
            });
            roomList.appendChild(btn);
        });
        if (roomModal) roomModal.classList.add("open");
    } catch (e) {
        console.error(e);
    }
}

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
    // Prevent interfering with modal inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
        return;
    }

    if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
    } else if (e.key === "q" || e.key === "Q") {
        if (qrModal) qrModal.classList.toggle("open");
    } else if (e.key === "l" || e.key === "L") {
        cycleLinesMode();
    } else if (e.key === "m" || e.key === "M") {
        toggleMicrophone();
    } else if (e.key === "s" || e.key === "S") {
        if (syncDock) syncDock.classList.toggle("open");
    } else if (e.key === " ") {
        // Spacebar triggers Tap-to-Sync
        e.preventDefault();
        triggerTapToSync();
    } else if (e.key === "[") {
        setSyncOffset(timingOffset - 0.1, true);
    } else if (e.key === "]") {
        setSyncOffset(timingOffset + 0.1, true);
    } else if (e.key === "{") {
        setSyncOffset(timingOffset - 0.5, true);
    } else if (e.key === "}") {
        setSyncOffset(timingOffset + 0.5, true);
    }
});

// Start Poll and Animation Loops
setInterval(pollStatus, 800);
pollStatus();
requestAnimationFrame(syncLoop);
