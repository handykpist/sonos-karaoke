#!/usr/bin/env python3
"""
Sonos Karaoke - HTTP & SSE Web Server
Serves TV display, Controller UI, REST APIs, and real-time Server-Sent Events.
"""

import os
import sys

# Ensure project root is in sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import time
import json
import socket
import urllib.request
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import io
import qrcode

try:
    from karaoke.sonos_tracker import SonosTracker
    from karaoke.cast_manager import CastManager
    from karaoke.lyrics import fetch_lyrics
except ImportError:
    from sonos_tracker import SonosTracker
    from cast_manager import CastManager
    from lyrics import fetch_lyrics

PORT = 5050
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

def get_local_ip():
    """Detects local LAN IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

LOCAL_IP = get_local_ip()

class KaraokeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, format, *args):
        # Suppress spammy polling logs, log only errors or major actions
        try:
            msg = format % args if args else str(format)
            if "/api/status" in msg or "/api/rooms" in msg:
                return
            super().log_message(format, *args)
        except Exception:
            pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/tv")
            self.end_headers()
            return

        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        elif path == "/tv":
            self.serve_file(os.path.join(STATIC_DIR, "tv.html"), "text/html; charset=utf-8")
            return

        elif path == "/controller":
            self.serve_file(os.path.join(STATIC_DIR, "controller.html"), "text/html; charset=utf-8")
            return

        elif path == "/api/status":
            state = self.server.tracker.get_state()
            state["hostIp"] = LOCAL_IP
            state["port"] = PORT
            state["tvUrl"] = f"http://{LOCAL_IP}:{PORT}/tv"
            state["timingOffset"] = self.server.timing_offset
            self.send_json(state)
            return

        elif path == "/api/rooms":
            if query.get("refresh", ["0"])[0] in ("1", "true"):
                self.server.tracker.discover_speakers(save_cache=True)
            rooms = self.server.tracker.get_speakers_list()
            active = self.server.tracker.active_room
            self.send_json({"rooms": rooms, "active": active})
            return

        elif path == "/api/displays":
            displays = self.server.cast_mgr.get_all_displays()
            displays["tvUrl"] = f"http://{LOCAL_IP}:{PORT}/tv"
            self.send_json(displays)
            return

        elif path == "/api/lyrics":
            track = query.get("title", [""])[0]
            artist = query.get("artist", [""])[0]
            album = query.get("album", [""])[0]
            dur = float(query.get("duration", ["0"])[0])
            if not track:
                st = self.server.tracker.get_state()
                track, artist, album, dur = st["title"], st["artist"], st["album"], st["duration"]
            lyrics = fetch_lyrics(track, artist, dur, album)
            self.send_json(lyrics)
            return

        elif path == "/api/albumart":
            st = self.server.tracker.get_state()
            art_url = st.get("albumArt")
            if art_url:
                try:
                    req = urllib.request.Request(art_url, headers={"User-Agent": "SonosKaraoke"})
                    with urllib.request.urlopen(req, timeout=3.0) as r:
                        content_type = r.headers.get("Content-Type", "image/jpeg")
                        data = r.read()
                        self.send_response(200)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Cache-Control", "max-age=3600")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                except Exception:
                    pass
            # Default placeholder image redirect
            self.send_response(302)
            self.send_header("Location", "/img/vinyl.png")
            self.end_headers()
            return

        elif path == "/api/qrcode":
            target_url = f"http://{LOCAL_IP}:{PORT}/tv"
            qr = qrcode.QRCode(box_size=6, border=2)
            qr.add_data(target_url)
            qr.make(fit=True)
            img = qr.make_image(fill_color="#FFFFFF", back_color="#0D0F18")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return

        # Fall back to serving static files (css, js, assets)
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if path == "/api/room":
            room_name = payload.get("room")
            if room_name:
                ok = self.server.tracker.set_active_room(room_name)
                self.send_json({"success": ok, "room": room_name})
            else:
                self.send_json({"success": False, "error": "Missing room name"}, status=400)
            return

        elif path in ("/api/rooms/refresh", "/api/discover"):
            rooms = self.server.tracker.discover_speakers(save_cache=True)
            self.send_json({"success": True, "rooms": rooms, "active": self.server.tracker.active_room})
            return

        elif path == "/api/offset":
            offset = float(payload.get("offset", 0.0))
            self.server.timing_offset = round(offset, 2)
            self.send_json({"success": True, "offset": self.server.timing_offset})
            return

        elif path == "/api/cast/chromecast":
            device_name = payload.get("device", "")
            tv_url = f"http://{LOCAL_IP}:{PORT}/tv"
            res = self.server.cast_mgr.cast_to_device(device_name, tv_url)
            self.send_json(res)
            return

        elif path == "/api/cast/stop":
            device_name = payload.get("device", "")
            res = self.server.cast_mgr.stop_cast(device_name)
            self.send_json(res)
            return

        elif path == "/api/lyrics/override":
            # Allow user to paste custom lyrics or manual LRC
            custom_lrc = payload.get("lrc", "")
            title = payload.get("title", "")
            artist = payload.get("artist", "")
            from karaoke.lyrics import parse_lrc
            lines = parse_lrc(custom_lrc, 0)
            override_data = {
                "found": True,
                "synced": True,
                "matchedTitle": title,
                "matchedArtist": artist,
                "lines": lines,
                "raw": custom_lrc
            }
            with self.server.tracker.lock:
                self.server.tracker.current_state["lyrics"] = override_data
            self.send_json({"success": True, "lines": len(lines)})
            return

        self.send_error(404, "Endpoint not found")

    def serve_file(self, full_path, content_type):
        if not os.path.exists(full_path):
            self.send_error(404, "File Not Found")
            return
        with open(full_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

class KaraokeServer(ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass):
        super().__init__(server_address, RequestHandlerClass)
        self.tracker = SonosTracker()
        self.tracker.start()
        self.cast_mgr = CastManager()
        self.timing_offset = 0.0

def run_server():
    server_address = ("", PORT)
    httpd = KaraokeServer(server_address, KaraokeHandler)
    print("=" * 60)
    print(f"      Sonos Karaoke Server active on port {PORT}")
    print(f"      TV Cast URL:      http://{LOCAL_IP}:{PORT}/tv")
    print(f"      Controller URL:   http://{LOCAL_IP}:{PORT}/controller")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Sonos Karaoke Server...")
        httpd.tracker.stop()
        httpd.server_close()

if __name__ == "__main__":
    run_server()
