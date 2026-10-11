#!/usr/bin/env python3
"""
Sonos Karaoke - TV & Device Cast Manager
Dynamically discovers and casts to Google Cast, Android TV, and Smart TV displays on the LAN
without requiring hardcoded device names or IP addresses.
"""

import time
import socket
import threading
import urllib.request
import json

try:
    import pychromecast
    from pychromecast.controllers import BaseController
    HAVE_PYCHROMECAST = True
except ImportError:
    HAVE_PYCHROMECAST = False

class DashCastController(BaseController):
    def __init__(self):
        super().__init__("urn:x-cast:es.offd.dashcast", "5CB45E5A")

    def load_url(self, url, force=True):
        self.send_message({"jsonrpc": "2.0", "method": "loadUrl", "params": {"url": url, "force": force}, "id": 1})

class CastManager:
    def __init__(self):
        self.cast_devices = []
        self.active_cast = None
        self._lock = threading.Lock()
        self.refresh_devices()

    def refresh_devices(self):
        """Scans the local network dynamically for Google Cast and Smart TV displays."""
        t = threading.Thread(target=self._scan_all, daemon=True)
        t.start()

    def _scan_all(self):
        casts = []
        if HAVE_PYCHROMECAST:
            try:
                chromecasts, browser = pychromecast.get_chromecasts(timeout=3.5)
                for c in chromecasts:
                    casts.append({
                        "id": str(c.uuid),
                        "name": c.name,
                        "model": c.model_name or "Smart Display",
                        "type": "Google Cast / TV",
                        "ip": str(c.cast_info.host),
                        "cast_supported": True
                    })
                pychromecast.discovery.stop_discovery(browser)
            except Exception as e:
                print(f"[!] Cast discovery notice: {e}")

        with self._lock:
            self.cast_devices = casts

    def get_all_displays(self):
        with self._lock:
            return {
                "devices": list(self.cast_devices)
            }

    def cast_to_device(self, friendly_name: str, target_url: str) -> dict:
        """Casts the Karaoke TV view to any discovered Cast device via DashCast."""
        if not HAVE_PYCHROMECAST:
            return {"success": False, "error": "pychromecast library not installed"}

        try:
            casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[friendly_name], timeout=3.5)
            if not casts:
                pychromecast.discovery.stop_discovery(browser)
                return {"success": False, "error": f"Display '{friendly_name}' not found on network"}

            cast = casts[0]
            cast.wait(timeout=5.0)

            dashcast = DashCastController()
            cast.register_handler(dashcast)
            dashcast.launch()
            dashcast.load_url(target_url, force=True)
            self.active_cast = friendly_name
            pychromecast.discovery.stop_discovery(browser)
            return {"success": True, "device": friendly_name, "url": target_url}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def stop_cast(self, friendly_name: str) -> dict:
        if not HAVE_PYCHROMECAST:
            return {"success": False, "error": "pychromecast library not installed"}
        try:
            casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[friendly_name], timeout=3.5)
            if casts:
                cast = casts[0]
                cast.wait(timeout=5.0)
                cast.quit_app()
                self.active_cast = None
            pychromecast.discovery.stop_discovery(browser)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

if __name__ == "__main__":
    cm = CastManager()
    time.sleep(4.0)
    print("Displays dynamically found:", json.dumps(cm.get_all_displays(), indent=2))
