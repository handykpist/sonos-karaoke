#!/usr/bin/env python3
"""
Sonos Karaoke - Real-Time Sonos Speaker Tracker
Tracks playback state, track metadata, and position across all household Sonos speakers.
Includes multi-tier auto-discovery via SSDP multicast, port 1400 LAN scan fallback,
and UPnP ZoneGroupTopology household expansion.
"""

import os
import sys
import time
import html
import json
import socket
import re
import threading
import urllib.request
import xml.etree.ElementTree as ET
import concurrent.futures

try:
    from karaoke.lyrics import fetch_lyrics
except ImportError:
    from lyrics import fetch_lyrics

CONFIG_DIR = os.path.expanduser("~/.config/sonos")
CONFIG_FILE = os.path.join(CONFIG_DIR, "speakers.json")
os.makedirs(CONFIG_DIR, exist_ok=True)

def get_local_subnet():
    """Detects local LAN IP and /24 subnet prefix."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            my_ip = s.getsockname()[0]
        prefix = ".".join(my_ip.split(".")[:3])
        return my_ip, prefix
    except Exception:
        return "127.0.0.1", "127.0.0"

def parse_time(time_str: str) -> float:
    """Parses 'HH:MM:SS' or 'M:SS' to seconds."""
    if not time_str or time_str in ("NOT_IMPLEMENTED", ""):
        return 0.0
    try:
        parts = time_str.strip().split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(time_str)
    except Exception:
        return 0.0

class SonosTracker:
    def __init__(self, speakers=None):
        self.lock = threading.Lock()
        self.speakers = speakers or self._load_cache()
        if not self.speakers:
            self.discover_speakers(save_cache=True)

        self.active_room = self.speakers[0]["name"] if self.speakers else "Sonos"

        # State
        self.current_state = {
            "room": self.active_room,
            "ip": self.speakers[0]["ip"] if self.speakers else "",
            "state": "STOPPED",
            "title": "",
            "artist": "",
            "album": "",
            "albumArt": "",
            "position": 0.0,
            "duration": 0.0,
            "syncTime": time.time(),
            "lyrics": None
        }

        self.subscribers = []
        self._running = False
        self._thread = None
        self._last_discovery_time = time.time()

    def _load_cache(self):
        speakers = []
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for ip, s in data.get("speakers", {}).items():
                        name = s.get("name") or s.get("model") or f"Speaker ({ip})"
                        speakers.append({
                            "name": name,
                            "ip": ip,
                            "model": s.get("model", "ZonePlayer"),
                            "uuid": s.get("udn", "")
                        })
            except Exception:
                pass
        return speakers

    def _save_cache(self, spk_list):
        try:
            cache_data = {"speakers": {}}
            if os.path.exists(CONFIG_FILE):
                try:
                    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                        cache_data = json.load(f)
                except Exception:
                    pass

            if "speakers" not in cache_data:
                cache_data["speakers"] = {}

            for s in spk_list:
                ip = s["ip"]
                existing = cache_data["speakers"].get(ip, {})
                existing.update({
                    "ip": ip,
                    "name": s["name"],
                    "model": s.get("model", existing.get("model", "ZonePlayer")),
                    "udn": s.get("uuid", existing.get("udn", "")),
                    "location": f"http://{ip}:1400/xml/device_description.xml",
                    "server": "Linux UPnP/1.0 Sonos/57.23-74170"
                })
                cache_data["speakers"][ip] = existing

            cache_data["updated_at"] = time.time()
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(cache_data, f, indent=2)
        except Exception:
            pass

    def discover_speakers(self, save_cache=True):
        """
        Multi-tier dynamic Sonos discovery:
        Tier 1: SSDP M-SEARCH broadcast (UDP port 1900)
        Tier 2: Fast multi-threaded port 1400 LAN scan fallback
        Tier 3: UPnP ZoneGroupTopology expansion from any discovered seed speaker
        """
        seed_ips = set()

        # Tier 1: SSDP Multicast M-SEARCH
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.settimeout(1.5)
            msg = (
                "M-SEARCH * HTTP/1.1\r\n"
                "HOST: 239.255.255.250:1900\r\n"
                "MAN: \"ssdp:discover\"\r\n"
                "MX: 1\r\n"
                "ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n"
            ).encode("utf-8")
            sock.sendto(msg, ("239.255.255.250", 1900))

            start = time.time()
            while time.time() - start < 1.8:
                try:
                    data, addr = sock.recvfrom(2048)
                    text = data.decode("utf-8", errors="ignore")
                    if ":1400" in text or "Sonos" in text or "ZonePlayer" in text:
                        seed_ips.add(addr[0])
                except socket.timeout:
                    break
                except Exception:
                    break
            sock.close()
        except Exception:
            pass

        # Tier 2: Fast LAN Port 1400 Probe (fallback if SSDP multicast blocked by router)
        if len(seed_ips) == 0:
            _, prefix = get_local_subnet()
            def probe(ip):
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.2)
                try:
                    if s.connect_ex((ip, 1400)) == 0:
                        return ip
                except Exception:
                    pass
                finally:
                    s.close()
                return None

            candidates = [f"{prefix}.{i}" for i in range(1, 255)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=50) as ex:
                for res in ex.map(probe, candidates):
                    if res:
                        seed_ips.add(res)

        # Tier 3: Query ZoneGroupTopology on any responsive seed IP
        found_speakers = []
        seen_ips = set()

        for ip in list(seed_ips):
            xml_str = self._soap_call(ip, "/ZoneGroupTopology/Control", "ZoneGroupTopology", "GetZoneGroupState")
            if xml_str and "<ZoneGroupState>" in xml_str:
                start = xml_str.find("<ZoneGroupState>")
                end = xml_str.find("</ZoneGroupState>")
                if start != -1 and end != -1:
                    raw = html.unescape(xml_str[start+16:end])
                    try:
                        root = ET.fromstring(raw)
                        for zg in root.findall(".//ZoneGroupMember"):
                            zname = zg.attrib.get("ZoneName", "Sonos Speaker")
                            loc = zg.attrib.get("Location", "")
                            uuid = zg.attrib.get("UUID", "")
                            m = re.search(r"http://([^:/]+)", loc)
                            spk_ip = m.group(1) if m else ip
                            if spk_ip not in seen_ips:
                                seen_ips.add(spk_ip)
                                found_speakers.append({
                                    "name": zname,
                                    "ip": spk_ip,
                                    "uuid": uuid,
                                    "model": zg.attrib.get("ModelName", "ZonePlayer")
                                })
                        if found_speakers:
                            break
                    except Exception:
                        pass

        # If ZoneGroupTopology was not accessible, use seed IPs directly
        if not found_speakers and seed_ips:
            for ip in seed_ips:
                if ip not in seen_ips:
                    seen_ips.add(ip)
                    found_speakers.append({
                        "name": f"Sonos Speaker ({ip})",
                        "ip": ip,
                        "uuid": f"RINCON_{ip.replace('.', '')}",
                        "model": "ZonePlayer"
                    })

        if found_speakers:
            with self.lock:
                # Merge with existing speakers preserving user selection
                existing_map = {s["ip"]: s for s in self.speakers}
                for f in found_speakers:
                    existing_map[f["ip"]] = f
                self.speakers = list(existing_map.values())

                active_found = any(s["name"] == self.active_room for s in self.speakers)
                if not active_found and self.speakers:
                    self.active_room = self.speakers[0]["name"]
                    self.current_state["room"] = self.active_room
                    self.current_state["ip"] = self.speakers[0]["ip"]

            if save_cache:
                self._save_cache(found_speakers)

        return self.speakers

    def get_active_speaker(self):
        with self.lock:
            for s in self.speakers:
                if s["name"] == self.active_room:
                    return s
            return self.speakers[0] if self.speakers else {"name": "Sonos", "ip": ""}

    def set_active_room(self, room_name: str):
        with self.lock:
            for s in self.speakers:
                if s["name"].lower() == room_name.lower():
                    self.active_room = s["name"]
                    self.current_state["room"] = s["name"]
                    self.current_state["ip"] = s["ip"]
                    # Reset track so new room's lyrics load immediately
                    self.current_state["title"] = ""
                    return True
        return False

    def get_speakers_list(self):
        with self.lock:
            return [dict(s) for s in self.speakers]

    def _soap_call(self, ip: str, endpoint: str, service: str, action: str, args: str = "") -> str:
        if not ip:
            return ""
        body = f'''<?xml version="1.0" encoding="utf-8"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body>
                <u:{action} xmlns:u="urn:schemas-upnp-org:service:{service}:1">
                    <InstanceID>0</InstanceID>
                    {args}
                </u:{action}>
            </s:Body>
        </s:Envelope>'''
        headers = {
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": f'"urn:schemas-upnp-org:service:{service}:1#{action}"'
        }
        req = urllib.request.Request(f"http://{ip}:1400{endpoint}", data=body.encode("utf-8"), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=1.8) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except Exception:
            return ""

    def query_speaker(self, ip: str):
        """Queries UPnP for current transport state and track position metadata."""
        if not ip:
            return {"state": "STOPPED", "position": 0.0, "duration": 0.0, "title": "", "artist": "", "album": "", "albumArt": ""}

        # 1. Transport info
        trans_xml = self._soap_call(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "GetTransportInfo")
        state = "STOPPED"
        if "<CurrentTransportState>" in trans_xml:
            s_tag = trans_xml.split("<CurrentTransportState>")[1].split("</CurrentTransportState>")[0]
            state = s_tag.strip()

        # 2. Position info
        pos_xml = self._soap_call(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "GetPositionInfo")
        if not pos_xml:
            return {"state": state, "position": 0.0, "duration": 0.0, "title": "", "artist": "", "album": "", "albumArt": ""}

        rel_time = 0.0
        track_dur = 0.0
        if "<RelTime>" in pos_xml:
            rel_time = parse_time(pos_xml.split("<RelTime>")[1].split("</RelTime>")[0])
        if "<TrackDuration>" in pos_xml:
            track_dur = parse_time(pos_xml.split("<TrackDuration>")[1].split("</TrackDuration>")[0])

        title = ""
        artist = ""
        album = ""
        album_art = ""

        if "<TrackMetaData>" in pos_xml:
            raw_meta = pos_xml.split("<TrackMetaData>")[1].split("</TrackMetaData>")[0]
            if raw_meta:
                try:
                    meta_decoded = html.unescape(raw_meta)
                    root = ET.fromstring(meta_decoded)
                    t_elem = root.find(".//{http://purl.org/dc/elements/1.1/}title")
                    c_elem = root.find(".//{http://purl.org/dc/elements/1.1/}creator")
                    a_elem = root.find(".//{urn:schemas-upnp-org:metadata-1-0/upnp/}album")
                    art_elem = root.find(".//{urn:schemas-upnp-org:metadata-1-0/upnp/}albumArtURI")

                    if t_elem is not None and t_elem.text:
                        title = t_elem.text.strip()
                    if c_elem is not None and c_elem.text:
                        artist = c_elem.text.strip()
                    if a_elem is not None and a_elem.text:
                        album = a_elem.text.strip()
                    if art_elem is not None and art_elem.text:
                        raw_art = art_elem.text.strip()
                        if raw_art.startswith("http://") or raw_art.startswith("https://"):
                            album_art = raw_art
                        else:
                            album_art = f"http://{ip}:1400{raw_art}"
                except Exception:
                    pass

        return {
            "state": state,
            "position": rel_time,
            "duration": track_dur,
            "title": title,
            "artist": artist,
            "album": album,
            "albumArt": album_art
        }

    def update_cycle(self):
        """Single poll tick."""
        # Periodic background re-discovery check every 60 seconds
        if time.time() - self._last_discovery_time > 60:
            self._last_discovery_time = time.time()
            threading.Thread(target=self.discover_speakers, kwargs={"save_cache": True}, daemon=True).start()

        spk = self.get_active_speaker()
        if not spk.get("ip"):
            return

        data = self.query_speaker(spk["ip"])

        # Auto-switch to active room if current room is stopped/idle but another is playing
        if data["state"] != "PLAYING":
            with self.lock:
                other_speakers = [s for s in self.speakers if s["name"] != spk["name"]]
            for other in other_speakers:
                other_data = self.query_speaker(other["ip"])
                if other_data["state"] == "PLAYING" and other_data["title"]:
                    spk = other
                    data = other_data
                    self.set_active_room(spk["name"])
                    break

        now = time.time()
        track_changed = False
        with self.lock:
            prev_title = self.current_state["title"]
            prev_artist = self.current_state["artist"]

            self.current_state["room"] = spk["name"]
            self.current_state["ip"] = spk["ip"]
            self.current_state["state"] = data["state"]
            self.current_state["position"] = data["position"]
            self.current_state["duration"] = data["duration"]
            self.current_state["album"] = data["album"]
            self.current_state["albumArt"] = data["albumArt"]
            self.current_state["syncTime"] = now

            if data["title"] != prev_title or data["artist"] != prev_artist:
                self.current_state["title"] = data["title"]
                self.current_state["artist"] = data["artist"]
                track_changed = True

        if track_changed and data["title"]:
            lyrics = fetch_lyrics(data["title"], data["artist"], data["duration"], data["album"])
            with self.lock:
                self.current_state["lyrics"] = lyrics

    def get_state(self):
        with self.lock:
            return dict(self.current_state)

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self.update_cycle()
            except Exception as e:
                time.sleep(0.5)
            time.sleep(0.75)

if __name__ == "__main__":
    tracker = SonosTracker()
    print("Testing SonosTracker dynamic discovery...")
    print(f"Discovered rooms: {[s['name'] + ' (' + s['ip'] + ')' for s in tracker.speakers]}")
    tracker.update_cycle()
    st = tracker.get_state()
    print(f"Active Room: {st['room']} ({st['ip']}) | State: {st['state']}")
    print(f"Track: {st['title']} by {st['artist']} ({st['position']}/{st['duration']}s)")
    if st["lyrics"]:
        print(f"Lyrics loaded: {st['lyrics']['synced']}, lines: {len(st['lyrics']['lines'])}")
