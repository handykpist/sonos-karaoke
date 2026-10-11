# Sonos Karaoke Studio & TV Cast Extension

Real-time synchronized karaoke lyrics for all music played on your Sonos sound system, with 1-click casting to **Samsung Smart TVs**, **Google Chromecast**, and phones.

---

## 🎤 Key Features

- **Millisecond Synchronized Lyrics:**
  - Auto-fetches line-by-line LRC synchronized lyrics via **LRCLIB**.
  - Active line glowing highlight and smooth karaoke progression fill.
  - Smart tempo-based auto-timing fallback for songs with plain lyrics.
- **Instrumental Break Detection:**
  - Automatically identifies intros and solos (> 5s) and displays an animated countdown timer (`🎸 Instrumental Solo • 5s`) with a 3-2-1 indicator.
- **TV & Display Casting:**
  - **Samsung 75" QLED TV (4K):** Open the TV browser to `http://<linux-ip>:5050/tv` for full 4K ultra-wide karaoke with ambient lighting matching the album art.
  - **Google Chromecast / Android TV:** 1-click casting via `pychromecast` and DashCast.
  - **Party QR Code:** Guests can scan the on-screen QR code with their phones to read lyrics and sing along directly.
- **Multi-Room Speaker Support:**
  - Switch live between all Sonos speakers in your home with 1 click.
- **Live Timing Adjustments:**
  - On-the-fly lyrics sync adjustments (`-0.5s` / `+0.5s`).
- **Custom Lyrics Editor:**
  - Paste any custom lyrics or LRC file for unreleased or rare tracks.

---

## 🚀 Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Start the Karaoke Server
python3 server.py

# Open TV Karaoke Display in your browser:
# http://localhost:5050/tv

# Open Desktop Controller:
# http://localhost:5050/controller
```

---

## 🖥️ System Integration

Run as a background systemd user service:
```bash
cp sonos-karaoke.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sonos-karaoke.service
```

