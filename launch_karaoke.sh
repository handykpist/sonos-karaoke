#!/usr/bin/env bash
# Sonos Karaoke Studio Desktop Launcher
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Ensure backend service is running
if ! systemctl --user is-active --quiet sonos-karaoke.service; then
    systemctl --user start sonos-karaoke.service
fi

TARGET_URL="http://127.0.0.1:5050/controller"

# Dynamically detect LAN IP to whitelist for WebRTC & Presentation APIs
LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || echo "127.0.0.1")
ORIGINS="http://127.0.0.1:5050,http://localhost:5050,http://${LOCAL_IP}:5050"

CHROME_FLAGS=(
    --app="$TARGET_URL"
    --class="sonos-karaoke"
    --window-size=1280,840
    --password-store=basic
    --use-mock-keychain
    --enable-features=MediaRouter,PresentationAPI
    --unsafely-treat-insecure-origin-as-secure="$ORIGINS"
)

# 2. Prefer standalone Google Chrome application window if available
if command -v google-chrome >/dev/null 2>&1; then
    exec google-chrome "${CHROME_FLAGS[@]}" "$@"
elif command -v google-chrome-stable >/dev/null 2>&1; then
    exec google-chrome-stable "${CHROME_FLAGS[@]}" "$@"
elif command -v chromium >/dev/null 2>&1; then
    exec chromium "${CHROME_FLAGS[@]}" "$@"
elif command -v chromium-browser >/dev/null 2>&1; then
    exec chromium-browser "${CHROME_FLAGS[@]}" "$@"
else
    # Fallback to default browser
    exec xdg-open "$TARGET_URL"
fi
