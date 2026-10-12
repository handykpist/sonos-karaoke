/**
 * Sonos Karaoke TV Display Client
 * Ultra-smooth, high-precision synchronized lyrics, dynamic ambient lighting, and solo/break countdowns.
 */

// Safe Storage Helpers
function getStoredLinesMode() {
    try {
        return localStorage.getItem("karaoke_lines_mode") || "3";
    } catch (e) {
        return "3";
    }
}

function setStoredLinesMode(val) {
    try {
        localStorage.setItem("karaoke_lines_mode", val);
    } catch (e) {}
}

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
let linesMode = getStoredLinesMode(); // "3" (Focus), "2" (Ultra), "4" (Context), "all"

// DOM Elements
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

// 1. High-Precision Status Poller & Time Synchronizer
async function pollStatus() {
    try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const data = await res.json();

        const prevState = playbackState;
        playbackState = data.state || "STOPPED";
        baseDuration = data.duration || 0;
        timingOffset = typeof data.timingOffset === "number" ? data.timingOffset : 0.0;

        if (offsetLabel) {
            offsetLabel.textContent = `Sync: ${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;
        }

        if (data.room && activeRoomName) {
            activeRoom = data.room;
            activeRoomName.textContent = activeRoom;
        }

        if (data.tvUrl && qrUrlText) {
            qrUrlText.textContent = data.tvUrl;
        }

        const serverPos = typeof data.position === "number" ? data.position : parseFloat(data.position) || 0;

        // Synchronize local high-precision clock
        if (playbackState === "PLAYING") {
            if (serverPos !== lastServerPosition || prevState !== "PLAYING") {
                lastServerPosition = serverPos;
                clientBasePosition = serverPos;
                clientSyncPerfTime = performance.now();
            } else {
                // Check if local time drifted significantly (> 1.8s) from speaker
                const localElapsed = (performance.now() - clientSyncPerfTime) / 1000;
                const localCur = clientBasePosition + localElapsed;
                if (Math.abs(localCur - serverPos) > 1.8) {
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
        div.className = "lyric-line hidden-line"; // Start hidden to prevent walls of text
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

    // Update progress bar
    if (currentTimeEl) currentTimeEl.textContent = formatTime(curTime);
    if (totalTimeEl) totalTimeEl.textContent = formatTime(baseDuration);
    if (progressBarFill && baseDuration > 0) {
        const pct = Math.min(100, Math.max(0, (curTime / baseDuration) * 100));
        progressBarFill.style.width = `${pct}%`;
    }

    // Sync Lyrics
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

    // 1. Intro before the first lyric line
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

        // During intro, all track lines hidden while banner displays countdown and first line
        const lineEls = lyricsTrack.querySelectorAll(".lyric-line");
        lineEls.forEach(el => {
            el.classList.remove("active", "next-line", "upcoming", "past");
            el.classList.add("hidden-line");
        });
        activeLineIndex = -1;
        return;
    }

    // 2. Find currently active line or break
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

    // Outro check
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

        // During break, hide track lines so solo card is prominent and uncluttered
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

    // Active Line Update
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
    setStoredLinesMode(linesMode);
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

// Controls & Modals
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

const btnOffset = document.getElementById("btn-offset");
if (btnOffset) {
    btnOffset.addEventListener("click", async () => {
        let nextOffset = timingOffset + 0.5;
        if (nextOffset > 2.0) nextOffset = -1.5;
        await adjustOffsetTo(nextOffset);
    });
}

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
    if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
    } else if (e.key === "q" || e.key === "Q") {
        if (qrModal) qrModal.classList.toggle("open");
    } else if (e.key === "l" || e.key === "L") {
        cycleLinesMode();
    } else if (e.key === "[") {
        adjustOffset(-0.25);
    } else if (e.key === "]") {
        adjustOffset(+0.25);
    }
});

async function adjustOffset(delta) {
    const nextOffset = Math.round((timingOffset + delta) * 100) / 100;
    await adjustOffsetTo(nextOffset);
}

async function adjustOffsetTo(val) {
    try {
        await fetch("/api/offset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offset: val })
        });
        timingOffset = val;
        if (offsetLabel) {
            offsetLabel.textContent = `Sync: ${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;
        }
    } catch (e) {}
}

// Start Poll and Animation Loops
setInterval(pollStatus, 1000);
pollStatus();
requestAnimationFrame(syncLoop);
