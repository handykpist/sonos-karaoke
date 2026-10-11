#!/usr/bin/env python3
"""
Sonos Karaoke - Real-Time Sonos Speaker Tracker
Tracks playback state, track metadata, and position across all household Sonos speakers.
"""

import time
import html
import threading
import urllib.request
import xml.etree.ElementTree as ET
try:
    from karaoke.lyrics import fetch_lyrics
except ImportError:
    from lyrics import fetch_lyrics

import os
import json
import socket
import re

CONFIG_FILE = os.path.expanduser("~/.config/sonos/speakers.json")

def load_discovered_speakers():
    """Loads discovered Sonos speakers from local configuration cache."""
    speakers = []
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                for ip, s in data.get("speakers", {}).items():
                    name = s.get("name") or s.get("model") or f"Speaker ({ip})"
                    speakers.append({"name": name, "ip": ip})
        except Exception:
            pass
    return speakers

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
        self.speakers = speakers or load_discovered_speakers()
        self.active_room = self.speakers[0]["name"] if self.speakers else "Sonos"
        self.lock = threading.Lock()
        
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

    def get_active_speaker(self):
        with self.lock:
            for s in self.speakers:
                if s["name"] == self.active_room:
                    return s
            return self.speakers[0]

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
        spk = self.get_active_speaker()
        data = self.query_speaker(spk["ip"])

        # Auto-switch to active room if current room is stopped/idle but another is playing
        if data["state"] != "PLAYING":
            for other in self.speakers:
                if other["name"] != spk["name"]:
                    other_data = self.query_speaker(other["ip"])
                    if other_data["state"] == "PLAYING" and other_data["title"]:
                        # Switch to playing speaker
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
            # Fetch lyrics asynchronously
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
                print(f"[!] Error in tracker loop: {e}")
            time.sleep(0.75)

if __name__ == "__main__":
    tracker = SonosTracker()
    print("Testing SonosTracker polling for 3 seconds...")
    tracker.update_cycle()
    st = tracker.get_state()
    print(f"Room: {st['room']} ({st['ip']}) | State: {st['state']}")
    print(f"Track: {st['title']} by {st['artist']} ({st['position']}/{st['duration']}s)")
    if st["lyrics"]:
        print(f"Lyrics loaded: {st['lyrics']['synced']}, lines: {len(st['lyrics']['lines'])}")
