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
import logging

_LOGGER = logging.getLogger("sonos_karaoke_cast")

try:
    import pychromecast
    from pychromecast.controllers.dashcast import DashCastController
    HAVE_PYCHROMECAST = True
except ImportError:
    HAVE_PYCHROMECAST = False

class CastManager:
    def __init__(self):
        self.cast_devices = []
        self._device_map = {}  # friendly_name -> CastInfo
        self.active_cast = None
        self._active_cast_obj = None
        self._active_browser = None
        self._lock = threading.Lock()
        self.refresh_devices()

    def refresh_devices(self):
        """Scans the local network dynamically for Google Cast and Smart TV displays."""
        t = threading.Thread(target=self._scan_all, daemon=True)
        t.start()

    def _scan_all(self):
        casts = []
        dev_map = {}
        if HAVE_PYCHROMECAST:
            try:
                chromecasts, browser = pychromecast.get_chromecasts(timeout=3.5)
                for c in chromecasts:
                    is_samsung = "qled" in (c.name or "").lower() or "q70" in (c.model_name or "").lower() or "samsung" in (c.model_name or "").lower()
                    casts.append({
                        "id": str(c.uuid),
                        "name": c.name,
                        "model": c.model_name or "Smart Display",
                        "type": "Samsung Smart TV" if is_samsung else "Google Cast / TV",
                        "ip": str(c.cast_info.host),
                        "cast_supported": True,
                        "requires_browser_cast": is_samsung
                    })
                    dev_map[c.name] = c.cast_info
                    try:
                        c.disconnect(blocking=False)
                    except Exception:
                        pass
                pychromecast.discovery.stop_discovery(browser)
            except Exception as e:
                _LOGGER.warning(f"Cast discovery notice: {e}")

        with self._lock:
            self.cast_devices = casts
            self._device_map = dev_map

    def get_all_displays(self):
        with self._lock:
            return {
                "devices": list(self.cast_devices)
            }

    def cast_to_device(self, friendly_name: str, target_url: str) -> dict:
        """Casts the Karaoke TV view to any discovered Cast device via DashCast."""
        if not HAVE_PYCHROMECAST:
            return {"success": False, "error": "pychromecast library not installed"}

        cast = None
        browser = None
        with self._lock:
            cast_info = self._device_map.get(friendly_name)

        try:
            # 1. Try fast direct connection if we already have the cast_info
            if cast_info:
                try:
                    cast = pychromecast.get_chromecast_from_cast_info(cast_info, timeout=3.5)
                except Exception as ex:
                    _LOGGER.info(f"Direct connection to {friendly_name} notice: {ex}")

            # 2. Fallback to mDNS lookup if direct connect didn't work
            if not cast:
                casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[friendly_name], timeout=3.5)
                if casts:
                    cast = casts[0]

            if not cast:
                if browser:
                    pychromecast.discovery.stop_discovery(browser)
                return {
                    "success": False,
                    "error": f"Display '{friendly_name}' not reachable directly. Use Browser Cast above."
                }

            cast.wait(timeout=4.0)

            # 3. Launch DashCast controller
            dashcast = DashCastController()
            cast.register_handler(dashcast)
            dashcast.load_url(target_url, force=True)

            self.active_cast = friendly_name
            self._active_cast_obj = cast
            self._active_browser = browser
            return {"success": True, "device": friendly_name, "url": target_url}

        except Exception as e:
            err_str = str(e)
            _LOGGER.warning(f"Error casting to {friendly_name}: {err_str}")
            if "111" in err_str or "Connection refused" in err_str:
                return {
                    "success": False,
                    "error": f"'{friendly_name}' is a Smart TV that requires Browser Casting. Please use the 'Cast to TV (Browser Cast)' button."
                }
            return {"success": False, "error": err_str}

    def stop_cast(self, friendly_name: str) -> dict:
        if not HAVE_PYCHROMECAST:
            return {"success": False, "error": "pychromecast library not installed"}
        try:
            if hasattr(self, "_active_cast_obj") and self._active_cast_obj:
                try:
                    self._active_cast_obj.quit_app()
                    self._active_cast_obj.disconnect(blocking=False)
                except Exception:
                    pass
                self._active_cast_obj = None
            if hasattr(self, "_active_browser") and self._active_browser:
                try:
                    pychromecast.discovery.stop_discovery(self._active_browser)
                except Exception:
                    pass
                self._active_browser = None
            self.active_cast = None
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

if __name__ == "__main__":
    cm = CastManager()
    time.sleep(4.0)
    print("Displays dynamically found:", json.dumps(cm.get_all_displays(), indent=2))
