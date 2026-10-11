#!/usr/bin/env bash
# Sonos Karaoke Extension - 1-Click Installer
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

mkdir -p "$BIN_DIR" "$APP_DIR" "$SYSTEMD_USER_DIR"

echo "=========================================================="
echo "         Sonos Karaoke Extension Installer               "
echo "=========================================================="

# 1. Install dependencies
echo "[*] Checking Python dependencies..."
python3 -m pip install --break-system-packages --user -r "$SCRIPT_DIR/requirements.txt" 2>/dev/null || python3 -m pip install --user -r "$SCRIPT_DIR/requirements.txt" || true

# 2. Install systemd user service
echo "[*] Installing background systemd service..."
cat << EOF > "$SYSTEMD_USER_DIR/sonos-karaoke.service"
[Unit]
Description=Sonos Karaoke Server & TV Cast Service
After=network.target

[Service]
Type=simple
Environment=PYTHONPATH="$SCRIPT_DIR"
ExecStart=/usr/bin/python3 "$SCRIPT_DIR/server.py"
WorkingDirectory=$SCRIPT_DIR
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now sonos-karaoke.service

# 3. Install binary and desktop launchers
echo "[*] Installing application launchers..."
ln -sfn "$SCRIPT_DIR/launch_karaoke.sh" "$BIN_DIR/sonos-karaoke"
chmod +x "$SCRIPT_DIR/launch_karaoke.sh"

cat << EOF > "$APP_DIR/sonos-karaoke.desktop"
[Desktop Entry]
Type=Application
Name=Sonos Karaoke
GenericName=Sonos Live Karaoke & TV Cast
Comment=Sing along with synchronized lyrics from your Sonos system and cast to TV
Exec=$BIN_DIR/sonos-karaoke
Icon=sonos
Terminal=false
Categories=AudioVideo;Audio;Player;
Keywords=sonos;karaoke;lyrics;sing;tv;cast;chromecast;samsung;music;
StartupWMClass=sonos-karaoke
Actions=OpenTV;

[Desktop Action OpenTV]
Name=Open Fullscreen TV Screen Directly
Exec=xdg-open http://127.0.0.1:5050/tv
EOF
chmod +x "$APP_DIR/sonos-karaoke.desktop"

if [ -d "$HOME/Desktop" ]; then
    cp "$APP_DIR/sonos-karaoke.desktop" "$HOME/Desktop/sonos-karaoke.desktop" 2>/dev/null || true
    chmod +x "$HOME/Desktop/sonos-karaoke.desktop" 2>/dev/null || true
    gio set "$HOME/Desktop/sonos-karaoke.desktop" metadata::trusted true 2>/dev/null || true
fi

echo ""
echo "[+] Successfully installed Sonos Karaoke Extension!"
echo "    • TV Display:       http://localhost:5050/tv"
echo "    • Controller:       http://localhost:5050/controller"
echo "    • Terminal Command: sonos-karaoke"

