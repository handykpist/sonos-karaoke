/**
 * Sonos Karaoke TV Display Client
 * Smooth 60 FPS synchronized lyrics, instrumental countdown, and TV controls.
 */

let currentTrackId = "";
let currentLyrics = [];
let playbackState = "STOPPED";
let basePosition = 0;
let baseDuration = 0;
let syncTimestamp = 0;
let timingOffset = 0.0;
let activeRoom = "Sonos";

let activeLineIndex = -1;
let lastScrollY = 0;

// Elements
const ambientBg = document.getElementById("ambient-bg");
const lyricsStage = document.getElementById("lyrics-stage");
const lyricsTrack = document.getElementById("lyrics-track");
const instrumentalBanner = document.getElementById("instrumental-banner");
const instTitle = document.getElementById("inst-title");
const instTimer = document.getElementById("inst-timer");
const trackArt = document.getElementById("track-art");
const trackTitle = document.getElementById("track-title");
const trackArtist = document.getElementById("track-artist");
const currentTimeEl = document.getElementById("current-time");
const totalTimeEl = document.getElementById("total-time");
const progressBarFill = document.getElementById("progress-bar-fill");
const activeRoomName = document.getElementById("active-room-name");
const offsetLabel = document.getElementById("offset-label");
const qrModal = document.getElementById("qr-modal");
const qrUrlText = document.getElementById("qr-url-text");
const roomModal = document.getElementById("room-modal");
const roomList = document.getElementById("room-list");
const visualizer = document.getElementById("visualizer");

function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// 1. Polling Status Loop
async function pollStatus() {
    try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const data = await res.json();

        playbackState = data.state || "STOPPED";
        basePosition = data.position || 0;
        baseDuration = data.duration || 0;
        syncTimestamp = data.syncTime || (Date.now() / 1000);
        timingOffset = data.timingOffset || 0.0;
        offsetLabel.textContent = `Sync: ${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;

        if (data.room) {
            activeRoom = data.room;
            activeRoomName.textContent = activeRoom;
        }

        if (data.tvUrl) {
            qrUrlText.textContent = data.tvUrl;
        }

        // Check if track changed
        const newTrackId = `${data.artist} - ${data.title}`;
        if (newTrackId !== currentTrackId) {
            currentTrackId = newTrackId;
            onTrackChanged(data);
        }

        // Toggle visualizer
        if (playbackState === "PLAYING") {
            visualizer.style.opacity = "1";
        } else {
            visualizer.style.opacity = "0.2";
        }
    } catch (e) {
        console.warn("Poll status error:", e);
    }
}

function onTrackChanged(data) {
    trackTitle.textContent = data.title || "No Track Playing";
    trackArtist.textContent = data.artist || "Sonos Audio";
    document.title = data.title ? `${data.title} - Sonos Karaoke` : "Sonos Karaoke TV";

    const artUrl = data.albumArt ? `/api/albumart?t=${Date.now()}` : "/img/vinyl.png";
    trackArt.src = artUrl;
    ambientBg.style.backgroundImage = `url('${artUrl}')`;

    // Reset lyrics
    activeLineIndex = -1;
    if (data.lyrics && data.lyrics.lines && data.lyrics.lines.length > 0) {
        currentLyrics = data.lyrics.lines;
        renderLyrics(currentLyrics);
    } else {
        currentLyrics = [];
        lyricsTrack.innerHTML = `
            <div class="lyrics-placeholder">
                <div class="mic-icon">🎤</div>
                <h2>Searching lyrics for "${data.title}"...</h2>
                <p>${data.artist}</p>
            </div>
        `;
    }
}

function renderLyrics(lines) {
    lyricsTrack.innerHTML = "";
    lines.forEach((line, idx) => {
        const div = document.createElement("div");
        div.className = "lyric-line";
        div.dataset.index = idx;
        div.dataset.time = line.time;
        div.dataset.endTime = line.endTime;
        div.dataset.type = line.type;

        if (line.type === "break") {
            div.textContent = "";
            div.style.height = "0";
            div.style.margin = "0";
        } else {
            div.textContent = line.text;
        }
        lyricsTrack.appendChild(div);
    });
}

// 2. High-Precision 60 FPS Sync Loop
function getInterpolatedTime() {
    let t = basePosition;
    if (playbackState === "PLAYING") {
        const elapsed = (Date.now() / 1000) - syncTimestamp;
        t += elapsed;
    }
    return Math.max(0, t + timingOffset);
}

function syncLoop() {
    const curTime = getInterpolatedTime();

    // Update progress bar
    currentTimeEl.textContent = formatTime(curTime);
    totalTimeEl.textContent = formatTime(baseDuration);
    if (baseDuration > 0) {
        const pct = Math.min(100, Math.max(0, (curTime / baseDuration) * 100));
        progressBarFill.style.width = `${pct}%`;
    }

    // Sync Lyrics
    if (currentLyrics.length > 0) {
        let newIndex = -1;
        let activeBreak = null;

        for (let i = 0; i < currentLyrics.length; i++) {
            const item = currentLyrics[i];
            if (curTime >= item.time && curTime < item.endTime) {
                newIndex = i;
                if (item.type === "break") {
                    activeBreak = item;
                }
                break;
            } else if (curTime < item.time) {
                break;
            }
        }

        // Check if inside instrumental break
        if (activeBreak) {
            instrumentalBanner.classList.add("visible");
            instTitle.textContent = activeBreak.text || "Instrumental Break";
            const remaining = Math.max(0, Math.ceil(activeBreak.endTime - curTime));
            instTimer.textContent = `${remaining}s`;
        } else {
            instrumentalBanner.classList.remove("visible");
        }

        if (newIndex !== activeLineIndex && newIndex !== -1) {
            updateActiveLine(newIndex);
        }
    }

    requestAnimationFrame(syncLoop);
}

function updateActiveLine(newIndex) {
    activeLineIndex = newIndex;
    const lineEls = lyricsTrack.querySelectorAll(".lyric-line");

    lineEls.forEach((el, idx) => {
        el.classList.remove("active", "upcoming", "past");
        if (idx === activeLineIndex) {
            el.classList.add("active");
            // Wrap text in glowing span
            if (!el.querySelector(".glow-word") && el.textContent.trim()) {
                el.innerHTML = `<span class="glow-word">${el.textContent}</span>`;
            }
        } else if (idx === activeLineIndex + 1 || idx === activeLineIndex + 2) {
            el.classList.add("upcoming");
        } else if (idx < activeLineIndex) {
            el.classList.add("past");
        }
    });

    // Smooth Center Scrolling
    const activeEl = lyricsTrack.querySelector(`.lyric-line[data-index="${activeLineIndex}"]`);
    if (activeEl && activeEl.dataset.type !== "break") {
        const stageHeight = lyricsStage.clientHeight;
        const elOffset = activeEl.offsetTop;
        const elHeight = activeEl.clientHeight;
        const targetScroll = -(elOffset - (stageHeight / 2) + (elHeight / 2));
        lyricsTrack.style.transform = `translateY(${targetScroll}px)`;
    }
}

// 3. User Controls & Modals
document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
document.getElementById("btn-qr").addEventListener("click", () => qrModal.classList.add("open"));
document.getElementById("btn-close-qr").addEventListener("click", () => qrModal.classList.remove("open"));

document.getElementById("room-badge").addEventListener("click", openRoomModal);
document.getElementById("btn-close-room").addEventListener("click", () => roomModal.classList.remove("open"));

document.getElementById("btn-offset").addEventListener("click", async () => {
    // Quick toggle between 0, +0.5, +1.0, -0.5
    let nextOffset = timingOffset + 0.5;
    if (nextOffset > 1.5) nextOffset = -1.0;
    await fetch("/api/offset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: nextOffset })
    });
    timingOffset = nextOffset;
    offsetLabel.textContent = `Sync: ${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;
});

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
                roomModal.classList.remove("open");
                pollStatus();
            });
            roomList.appendChild(btn);
        });
        roomModal.classList.add("open");
    } catch (e) {
        console.error(e);
    }
}

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
    } else if (e.key === "q" || e.key === "Q") {
        qrModal.classList.toggle("open");
    } else if (e.key === "[") {
        adjustOffset(-0.25);
    } else if (e.key === "]") {
        adjustOffset(+0.25);
    }
});

async function adjustOffset(delta) {
    const nextOffset = Math.round((timingOffset + delta) * 100) / 100;
    await fetch("/api/offset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: nextOffset })
    });
    timingOffset = nextOffset;
    offsetLabel.textContent = `Sync: ${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;
}

// Start Poll and Animation Loops
setInterval(pollStatus, 1000);
pollStatus();
requestAnimationFrame(syncLoop);

