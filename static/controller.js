/**
 * Sonos Karaoke Desktop Controller Client
 */

let currentTrackId = "";
let currentLyrics = [];
let playbackState = "STOPPED";
let basePosition = 0;
let baseDuration = 0;
let syncTimestamp = 0;
let timingOffset = 0.0;
let activeIndex = -1;

const roomSelect = document.getElementById("room-select");
const mainArt = document.getElementById("main-art");
const mainTitle = document.getElementById("main-title");
const mainArtist = document.getElementById("main-artist");
const mainCurrentTime = document.getElementById("main-current-time");
const mainTotalTime = document.getElementById("main-total-time");
const mainProgressFill = document.getElementById("main-progress-fill");
const playbackStatusTag = document.getElementById("playback-status-tag");
const syncedTag = document.getElementById("synced-tag");
const tvUrlPill = document.getElementById("tv-url-pill");
const offsetVal = document.getElementById("offset-val");
const lyricsScrollBox = document.getElementById("lyrics-scroll-box");
const lyricsPreviewTrack = document.getElementById("lyrics-preview-track");
const btnCastChromecast = document.getElementById("btn-cast-chromecast");
const castStatusLabel = document.getElementById("cast-status-label");

// Modals
const customModal = document.getElementById("custom-modal");
const btnCustomLyrics = document.getElementById("btn-custom-lyrics");
const btnCancelCustom = document.getElementById("btn-cancel-custom");
const btnSaveCustom = document.getElementById("btn-save-custom");
const customLyricsText = document.getElementById("custom-lyrics-text");

function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

async function loadRooms() {
    try {
        const res = await fetch("/api/rooms");
        const data = await res.json();
        roomSelect.innerHTML = "";
        data.rooms.forEach(r => {
            const opt = document.createElement("option");
            opt.value = r.name;
            opt.textContent = `${r.name} (${r.ip})`;
            if (r.name === data.active) opt.selected = true;
            roomSelect.appendChild(opt);
        });
    } catch (e) {
        console.warn(e);
    }
}

roomSelect.addEventListener("change", async () => {
    const chosen = roomSelect.value;
    await fetch("/api/room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: chosen })
    });
    pollStatus();
});

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

        playbackStatusTag.textContent = playbackState;
        playbackStatusTag.style.color = playbackState === "PLAYING" ? "#22c55e" : "#eab308";
        offsetVal.textContent = `${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;

        if (data.tvUrl) {
            tvUrlPill.textContent = data.tvUrl;
        }

        const newId = `${data.artist || ""} - ${data.title || ""}`.trim();
        const hasLyrics = Boolean(data.lyrics && data.lyrics.lines && data.lyrics.lines.length > 0);

        if (newId !== currentTrackId) {
            currentTrackId = newId;
            mainTitle.textContent = data.title || "No Track Playing";
            mainArtist.textContent = data.artist || "Sonos Audio";
            mainArt.src = data.albumArt ? `/api/albumart?t=${Date.now()}` : "/img/vinyl.png";

            if (hasLyrics) {
                currentLyrics = data.lyrics.lines;
                syncedTag.textContent = data.lyrics.synced ? "SYNCED LRC" : (data.lyrics.estimated ? "AUTO-TIMED" : "PLAIN TEXT");
                syncedTag.style.background = data.lyrics.synced ? "rgba(34, 197, 94, 0.2)" : "rgba(234, 179, 8, 0.2)";
                syncedTag.style.color = data.lyrics.synced ? "#4ade80" : "#facc15";

                const langTag = document.getElementById("lang-tag");
                if (langTag && data.lyrics.language) {
                    langTag.textContent = `${data.lyrics.language.flag || '🌐'} ${data.lyrics.language.native || data.lyrics.language.name || 'Lyrics'}`;
                    langTag.style.display = "inline-block";
                }
                renderLyricsPreview(currentLyrics);
            } else {
                currentLyrics = [];
                lyricsPreviewTrack.innerHTML = `<div class="preview-line">${data.title ? "Searching lyrics..." : "Waiting for track..."}</div>`;
            }
        } else if (hasLyrics && currentLyrics.length === 0) {
            currentLyrics = data.lyrics.lines;
            syncedTag.textContent = data.lyrics.synced ? "SYNCED LRC" : (data.lyrics.estimated ? "AUTO-TIMED" : "PLAIN TEXT");
            syncedTag.style.background = data.lyrics.synced ? "rgba(34, 197, 94, 0.2)" : "rgba(234, 179, 8, 0.2)";
            syncedTag.style.color = data.lyrics.synced ? "#4ade80" : "#facc15";

            const langTag = document.getElementById("lang-tag");
            if (langTag && data.lyrics.language) {
                langTag.textContent = `${data.lyrics.language.flag || '🌐'} ${data.lyrics.language.native || data.lyrics.language.name || 'Lyrics'}`;
                langTag.style.display = "inline-block";
            }
            renderLyricsPreview(currentLyrics);
        }
    } catch (e) {
        console.warn(e);
    }
}

function renderLyricsPreview(lines) {
    lyricsPreviewTrack.innerHTML = "";
    lines.forEach((l, idx) => {
        if (l.type === "break") return;
        const div = document.createElement("div");
        div.className = "preview-line";
        div.dataset.index = idx;
        div.dataset.time = l.time;
        div.dataset.endTime = l.endTime;
        div.textContent = l.text;
        lyricsPreviewTrack.appendChild(div);
    });
}

function syncLoop() {
    let curTime = basePosition;
    if (playbackState === "PLAYING") {
        const elapsed = (Date.now() / 1000) - syncTimestamp;
        curTime += elapsed;
    }
    curTime = Math.max(0, curTime + timingOffset);

    mainCurrentTime.textContent = formatTime(curTime);
    mainTotalTime.textContent = formatTime(baseDuration);
    if (baseDuration > 0) {
        const pct = Math.min(100, Math.max(0, (curTime / baseDuration) * 100));
        mainProgressFill.style.width = `${pct}%`;
    }

    if (currentLyrics.length > 0) {
        let newIdx = -1;
        for (let i = 0; i < currentLyrics.length; i++) {
            if (curTime >= currentLyrics[i].time && curTime < currentLyrics[i].endTime) {
                newIdx = i;
                break;
            } else if (curTime < currentLyrics[i].time) {
                break;
            }
        }

        if (newIdx !== activeIndex && newIdx !== -1) {
            activeIndex = newIdx;
            const lineEls = lyricsPreviewTrack.querySelectorAll(".preview-line");
            lineEls.forEach(el => {
                const idx = parseInt(el.dataset.index);
                el.classList.remove("active", "past", "next-line", "distant");
                if (idx === activeIndex) {
                    el.classList.add("active");
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                } else if (idx === activeIndex - 1) {
                    el.classList.add("past");
                } else if (idx === activeIndex + 1) {
                    el.classList.add("next-line");
                } else {
                    el.classList.add("distant");
                }
            });
        }
    }

    requestAnimationFrame(syncLoop);
}

// Dynamic Cast Devices
let activeCastingDevices = new Set();

async function loadDisplays() {
    try {
        const res = await fetch("/api/displays");
        const data = await res.json();
        const castCards = document.getElementById("cast-cards");
        if (!castCards) return;

        castCards.innerHTML = `
            <div class="device-card">
                <div class="device-icon">📺</div>
                <div class="device-info">
                    <div class="device-name">Smart TV / Web Browser</div>
                    <div class="device-status">Open on any TV browser or scan QR</div>
                </div>
                <a href="/tv" target="_blank" class="btn-cast-action">Open TV</a>
            </div>
        `;

        if (data.devices && data.devices.length > 0) {
            data.devices.forEach(dev => {
                const card = document.createElement("div");
                card.className = "device-card";
                const isCasting = activeCastingDevices.has(dev.name);
                card.innerHTML = `
                    <div class="device-icon">📡</div>
                    <div class="device-info">
                        <div class="device-name">${dev.name}</div>
                        <div class="device-status" id="status-${dev.id}">${isCasting ? "Casting Active" : "Ready to Cast"}</div>
                    </div>
                    <button class="btn-cast-action" style="${isCasting ? 'background: #ef4444; color: #fff;' : ''}">${isCasting ? "Stop" : "Cast"}</button>
                `;
                const btn = card.querySelector("button");
                const statusEl = card.querySelector(`#status-${dev.id}`);
                btn.addEventListener("click", () => toggleCastDevice(dev.name, btn, statusEl));
                castCards.appendChild(card);
            });
        }
    } catch (e) {
        console.warn("Could not load displays:", e);
    }
}

async function toggleCastDevice(deviceName, btn, statusEl) {
    if (!activeCastingDevices.has(deviceName)) {
        if (statusEl) statusEl.textContent = `Connecting to ${deviceName}...`;
        btn.textContent = "Connecting...";
        try {
            const res = await fetch("/api/cast/chromecast", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ device: deviceName })
            });
            const data = await res.json();
            if (data.success) {
                activeCastingDevices.add(deviceName);
                if (statusEl) {
                    statusEl.textContent = `Casting to ${deviceName} (Active)`;
                    statusEl.style.color = "#4ade80";
                }
                btn.textContent = "Stop";
                btn.style.background = "#ef4444";
                btn.style.color = "#fff";
            } else {
                if (statusEl) statusEl.textContent = `Cast notice: ${data.error}`;
                btn.textContent = "Cast";
            }
        } catch (e) {
            if (statusEl) statusEl.textContent = "Connection error";
            btn.textContent = "Cast";
        }
    } else {
        await fetch("/api/cast/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device: deviceName })
        });
        activeCastingDevices.delete(deviceName);
        if (statusEl) {
            statusEl.textContent = "Ready to Cast";
            statusEl.style.color = "";
        }
        btn.textContent = "Cast";
        btn.style.background = "";
        btn.style.color = "";
    }
}

// Offset controls
document.getElementById("btn-sub-offset").addEventListener("click", () => updateOffset(-0.5));
document.getElementById("btn-add-offset").addEventListener("click", () => updateOffset(+0.5));
document.getElementById("btn-reset-offset").addEventListener("click", () => setOffset(0.0));

async function updateOffset(delta) {
    const next = Math.round((timingOffset + delta) * 100) / 100;
    setOffset(next);
}

async function setOffset(val) {
    await fetch("/api/offset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: val })
    });
    timingOffset = val;
    offsetVal.textContent = `${timingOffset >= 0 ? '+' : ''}${timingOffset.toFixed(1)}s`;
}

// Custom lyrics & Local File modal
const ctrlLocalLrcFile = document.getElementById("ctrl-local-lrc-file");
const ctrlFileName = document.getElementById("ctrl-file-name");

if (ctrlLocalLrcFile) {
    ctrlLocalLrcFile.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (ctrlFileName) ctrlFileName.textContent = file.name;
        const reader = new FileReader();
        reader.onload = (event) => {
            if (customLyricsText) customLyricsText.value = event.target.result;
        };
        reader.readAsText(file);
    });
}

btnCustomLyrics.addEventListener("click", () => customModal.classList.add("open"));
btnCancelCustom.addEventListener("click", () => customModal.classList.remove("open"));
btnSaveCustom.addEventListener("click", async () => {
    const text = customLyricsText.value.trim();
    if (text) {
        const filename = (ctrlLocalLrcFile && ctrlLocalLrcFile.files[0]) ? ctrlLocalLrcFile.files[0].name : "";
        await fetch("/api/lyrics/save_local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lrc: text, title: mainTitle.textContent, artist: mainArtist.textContent, filename: filename })
        });
        customModal.classList.remove("open");
        pollStatus();
    }
});

// Versions Modal & Language Selector
const btnVersions = document.getElementById("btn-versions");
const versionsModal = document.getElementById("versions-modal");
const btnCloseVersions = document.getElementById("btn-close-versions");
const ctrlVersionsList = document.getElementById("ctrl-versions-list");
const ctrlLangSelect = document.getElementById("ctrl-lang-select");

if (btnVersions) {
    btnVersions.addEventListener("click", async () => {
        if (!versionsModal) return;
        versionsModal.classList.add("open");

        // Load language preference
        try {
            const lRes = await fetch("/api/lyrics/languages");
            if (lRes.ok) {
                const lData = await lRes.json();
                if (ctrlLangSelect && lData.languages) {
                    ctrlLangSelect.innerHTML = "";
                    lData.languages.forEach(l => {
                        const opt = document.createElement("option");
                        opt.value = l.code;
                        opt.textContent = `${l.flag} ${l.name}`;
                        if (l.code === lData.preferred) opt.selected = true;
                        ctrlLangSelect.appendChild(opt);
                    });
                }
            }
        } catch (e) {}

        loadControllerVersions();
    });
}

if (btnCloseVersions) {
    btnCloseVersions.addEventListener("click", () => versionsModal && versionsModal.classList.remove("open"));
}

if (ctrlLangSelect) {
    ctrlLangSelect.addEventListener("change", async (e) => {
        await fetch("/api/lyrics/preference", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferredLanguage: e.target.value })
        });
        loadControllerVersions();
        pollStatus();
    });
}

async function loadControllerVersions() {
    if (!ctrlVersionsList) return;
    ctrlVersionsList.innerHTML = `<div style="padding: 1rem; color: #94a3b8; text-align: center;">Searching versions...</div>`;

    try {
        const res = await fetch(`/api/lyrics/versions?title=${encodeURIComponent(mainTitle.textContent)}&artist=${encodeURIComponent(mainArtist.textContent)}`);
        if (!res.ok) return;
        const data = await res.json();
        const versions = data.versions || [];

        if (versions.length === 0) {
            ctrlVersionsList.innerHTML = `<div style="padding: 1rem; color: #94a3b8; text-align: center;">No alternative versions found. Use Custom/Local button to upload.</div>`;
            return;
        }

        ctrlVersionsList.innerHTML = "";
        versions.forEach(v => {
            const row = document.createElement("div");
            const isActive = v.active || v.id === data.currentVersionId;
            row.style.background = isActive ? "rgba(56, 189, 248, 0.15)" : "rgba(255, 255, 255, 0.05)";
            row.style.border = isActive ? "1px solid #38bdf8" : "1px solid var(--border-color)";
            row.style.borderRadius = "0.75rem";
            row.style.padding = "0.75rem 1rem";
            row.style.display = "flex";
            row.style.justifyContent = "space-between";
            row.style.alignItems = "center";
            row.style.cursor = "pointer";

            const lang = v.language || { name: "Unknown", flag: "🌐" };
            const prev = (v.preview && v.preview.length > 0) ? v.preview[0] : "";

            row.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 0.2rem; flex: 1;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-weight: 700; font-size: 0.9rem;">${lang.flag || '🌐'} ${lang.native || lang.name || 'Lyrics'}</span>
                        <span style="font-size: 0.8rem; color: #94a3b8;">${v.sourceLabel || v.source || ''}</span>
                    </div>
                    <div style="font-size: 0.8rem; color: #64748b; font-style: italic;">${prev}</div>
                </div>
                <button class="btn-primary" style="padding: 0.35rem 0.8rem; font-size: 0.8rem;">${isActive ? 'Active ✓' : 'Select'}</button>
            `;

            row.addEventListener("click", async () => {
                await fetch("/api/lyrics/choose", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ versionId: v.id, title: mainTitle.textContent, artist: mainArtist.textContent })
                });
                versionsModal.classList.remove("open");
                pollStatus();
            });
            ctrlVersionsList.appendChild(row);
        });
    } catch (e) {
        ctrlVersionsList.innerHTML = `<div style="padding: 1rem; color: #ef4444; text-align: center;">Error loading versions</div>`;
    }
}

loadRooms();
loadDisplays();
setInterval(pollStatus, 1000);
pollStatus();
requestAnimationFrame(syncLoop);

