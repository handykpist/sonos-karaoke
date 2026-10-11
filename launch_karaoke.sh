#!/usr/bin/env bash
# Sonos Karaoke Studio Desktop Launcher
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Ensure backend service is running
if ! systemctl --user is-active --quiet sonos-karaoke.service; then
    systemctl --user start sonos-karaoke.service
fi

TARGET_URL="http://127.0.0.1:5050/controller"

# 2. Prefer standalone Google Chrome application window if available
if command -v google-chrome >/dev/null 2>&1; then
    exec google-chrome --app="$TARGET_URL" --class="sonos-karaoke" --window-size=1200,820 "$@"
elif command -v chromium >/dev/null 2>&1; then
    exec chromium --app="$TARGET_URL" --class="sonos-karaoke" --window-size=1200,820 "$@"
elif command -v chromium-browser >/dev/null 2>&1; then
    exec chromium-browser --app="$TARGET_URL" --class="sonos-karaoke" --window-size=1200,820 "$@"
else
    # Fallback to default browser
    exec xdg-open "$TARGET_URL"
fi

