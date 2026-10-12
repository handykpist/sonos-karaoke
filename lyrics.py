#!/usr/bin/env python3
"""
Sonos Karaoke - Synchronized Lyrics Engine
Fetches, parses, normalizes, and caches line-by-line synced lyrics using LRCLIB and fallback sources.
"""

import os
import re
import json
import urllib.request
import urllib.parse
import hashlib

CACHE_DIR = os.path.expanduser("~/.cache/sonos-karaoke/lyrics")
os.makedirs(CACHE_DIR, exist_ok=True)

USER_AGENT = "SonosKaraoke/1.0 (Linux; https://github.com/morluto/rea)"

def clean_string(s: str) -> str:
    if not s:
        return ""
    # Remove (Remastered...), [Deluxe...], - Remastered, feat. ..., etc.
    s = re.sub(r'\(.*?(remaster|deluxe|version|edit|live|mono|stereo|bonus|feat|featuring).*?\)', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\[.*?(remaster|deluxe|version|edit|live|mono|stereo|bonus|feat|featuring).*?\]', '', s, flags=re.IGNORECASE)
    s = re.sub(r'-\s*(remaster|live|radio edit|bonus track|mono|stereo).*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+-\s+.*$', '', s) # trailing dash subtitles
    # Remove extra spaces
    return " ".join(s.split()).strip()

def get_cache_key(artist: str, title: str) -> str:
    key = f"{artist.lower().strip()}_{title.lower().strip()}"
    return hashlib.md5(key.encode('utf-8')).hexdigest()

def parse_lrc(lrc_text: str, duration: float = 0) -> list:
    """Parses standard LRC timestamps [mm:ss.xx] into structured lines with breaks."""
    raw_lines = []
    for line in lrc_text.splitlines():
        line = line.strip()
        if not line:
            continue
        # Support multiple timestamps on same line [00:12.34][00:15.67] text
        matches = list(re.finditer(r'\[(\d+):(\d+(?:\.\d+)?)\]', line))
        if not matches:
            continue
        text = line[matches[-1].end():].strip()
        for m in matches:
            mins = int(m.group(1))
            secs = float(m.group(2))
            t = round(mins * 60.0 + secs, 2)
            raw_lines.append((t, text))

    # Sort by timestamp
    raw_lines.sort(key=lambda x: x[0])

    if not raw_lines:
        return []

    processed = []
    for i in range(len(raw_lines)):
        t, text = raw_lines[i]
        next_t = raw_lines[i + 1][0] if i + 1 < len(raw_lines) else (duration if duration > t else t + 5.0)

        # Empty line in LRC signals end of previous line or start of instrumental break
        if not text:
            if next_t - t >= 3.5:
                processed.append({
                    "type": "break",
                    "time": t,
                    "endTime": round(next_t, 2),
                    "text": "🎸 Instrumental Solo / Break",
                    "duration": round(next_t - t, 1)
                })
            continue

        line_duration = next_t - t
        # If there is a large gap (>10s) before the next lyric, split into line + break
        if line_duration > 10.0:
            actual_end = round(t + 6.0, 2)
            processed.append({
                "type": "lyric",
                "time": t,
                "endTime": actual_end,
                "text": text
            })
            processed.append({
                "type": "break",
                "time": actual_end,
                "endTime": round(next_t, 2),
                "text": "🎸 Instrumental Break",
                "duration": round(next_t - actual_end, 1)
            })
            continue
        else:
            actual_end = round(next_t, 2)

        processed.append({
            "type": "lyric",
            "time": t,
            "endTime": actual_end,
            "text": text
        })

    # Add initial intro break if song takes a while before first lyric
    enriched = []
    if processed and processed[0]["time"] > 4.0:
        enriched.append({
            "type": "break",
            "time": 0.0,
            "endTime": processed[0]["time"],
            "text": "🎵 Intro",
            "duration": processed[0]["time"]
        })
    enriched.extend(processed)
    return enriched

def estimate_timing_for_plain(plain_text: str, duration: float) -> list:
    """Estimates timecodes for plain lyrics when no synced version exists."""
    lines = [l.strip() for l in plain_text.splitlines() if l.strip()]
    if not lines or duration <= 0:
        return [{"type": "lyric", "time": 0.0, "endTime": duration or 180.0, "text": l} for l in lines]

    # Assume 10-second intro, 10-second outro
    usable_time = max(duration - 20.0, 10.0)
    time_per_line = usable_time / len(lines)

    result = []
    if duration > 20:
        result.append({
            "type": "break",
            "time": 0.0,
            "endTime": 10.0,
            "text": "🎵 Intro",
            "duration": 10.0
        })

    cur_time = 10.0 if duration > 20 else 0.0
    for line in lines:
        end_t = cur_time + time_per_line
        result.append({
            "type": "lyric",
            "time": round(cur_time, 2),
            "endTime": round(end_t, 2),
            "text": line
        })
        cur_time = end_t

    return result

def fetch_lyrics(title: str, artist: str, duration: float = 0, album: str = "") -> dict:
    """Fetches synced lyrics with smart multi-tier fallback and local caching."""
    if not title:
        return {"found": False, "lines": [], "synced": False}

    cache_file = os.path.join(CACHE_DIR, f"{get_cache_key(artist, title)}.json")
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("found"):
                    if data.get("raw") and data.get("synced"):
                        data["lines"] = parse_lrc(data["raw"], duration)
                    return data
        except Exception:
            pass

    clean_t = clean_string(title)
    clean_a = clean_string(artist)

    queries = [
        {"track_name": title, "artist_name": artist},
        {"track_name": clean_t, "artist_name": clean_a},
        {"q": f"{clean_t} {clean_a}".strip()}
    ]
    if album:
        queries.insert(1, {"track_name": clean_t, "artist_name": clean_a, "album_name": clean_string(album)})

    synced_raw = None
    plain_raw = None
    matched_title = title
    matched_artist = artist

    for q in queries:
        try:
            is_search = "q" in q
            endpoint = "search" if is_search else "get"
            params = urllib.parse.urlencode(q)
            url = f"https://lrclib.net/api/{endpoint}?{params}"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

            with urllib.request.urlopen(req, timeout=4) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))

                if is_search:
                    if isinstance(res_data, list) and res_data:
                        # Prefer items with syncedLyrics
                        with_synced = [item for item in res_data if item.get("syncedLyrics")]
                        target = with_synced[0] if with_synced else res_data[0]
                        synced_raw = target.get("syncedLyrics")
                        plain_raw = target.get("plainLyrics")
                        matched_title = target.get("trackName", title)
                        matched_artist = target.get("artistName", artist)
                else:
                    if isinstance(res_data, dict):
                        synced_raw = res_data.get("syncedLyrics")
                        plain_raw = res_data.get("plainLyrics")
                        matched_title = res_data.get("trackName", title)
                        matched_artist = res_data.get("artistName", artist)

            if synced_raw:
                break
        except Exception:
            continue

    if synced_raw:
        lines = parse_lrc(synced_raw, duration)
        result = {
            "found": True,
            "synced": True,
            "matchedTitle": matched_title,
            "matchedArtist": matched_artist,
            "lines": lines,
            "raw": synced_raw
        }
    elif plain_raw:
        lines = estimate_timing_for_plain(plain_raw, duration)
        result = {
            "found": True,
            "synced": False,
            "estimated": True,
            "matchedTitle": matched_title,
            "matchedArtist": matched_artist,
            "lines": lines,
            "raw": plain_raw
        }
    else:
        result = {
            "found": False,
            "synced": False,
            "matchedTitle": title,
            "matchedArtist": artist,
            "lines": [
                {"type": "break", "time": 0.0, "endTime": duration or 180.0, "text": "🎵 No lyrics found for this track - Sing along freely!"}
            ]
        }

    # Save to cache
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

    return result

if __name__ == "__main__":
    import sys
    test_track = sys.argv[1] if len(sys.argv) > 1 else "Smalltown Boy"
    test_artist = sys.argv[2] if len(sys.argv) > 2 else "Bronski Beat"
    print(f"Fetching lyrics for: {test_track} by {test_artist}")
    res = fetch_lyrics(test_track, test_artist, 302.0)
    print(f"Found: {res['found']}, Synced: {res['synced']}, Lines count: {len(res['lines'])}")
    for line in res["lines"][:8]:
        print(f" [{line['time']:05.2f} -> {line['endTime']:05.2f}] ({line['type']}) {line['text']}")

