#!/usr/bin/env python3
"""
Sonos Karaoke - Synchronized Lyrics Engine with Multi-Language & Local Songs Support
Fetches, parses, normalizes, detects language, and caches line-by-line synced lyrics.
Supports local .lrc files, language preference, alternative lyric versions, and custom uploads.
"""

import os
import re
import json
import urllib.request
import urllib.parse
import hashlib
import glob

# Storage Directories
CACHE_DIR = os.path.expanduser("~/.cache/sonos-karaoke/lyrics")
CONFIG_DIR = os.path.expanduser("~/.config/sonos-karaoke")
LOCAL_LYRICS_DIR = os.path.join(CONFIG_DIR, "lyrics")
SYS_LYRICS_DIR = os.path.expanduser("~/.lyrics")
USER_MUSIC_DIR = os.path.expanduser("~/Music")
PREFS_FILE = os.path.join(CONFIG_DIR, "lyrics_preferences.json")

for d in (CACHE_DIR, CONFIG_DIR, LOCAL_LYRICS_DIR, SYS_LYRICS_DIR):
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass

USER_AGENT = "SonosKaraoke/1.0 (Linux)"

# Language definitions with flags, names, and distinctive keywords
LANG_MAP = {
    "sv": {
        "name": "Swedish",
        "native": "Svenska",
        "flag": "🇸🇪",
        "chars": r"[åäöÅÄÖ]",
        "words": {
            "och", "att", "det", "jag", "inte", "är", "som", "för", "på", "med", "dig",
            "mig", "vi", "du", "så", "här", "när", "vad", "var", "nu", "har", "kan",
            "ska", "om", "men", "ett", "den", "sig", "till", "från", "blir", "blev"
        }
    },
    "en": {
        "name": "English",
        "native": "English",
        "flag": "🇬🇧",
        "chars": r"",
        "words": {
            "the", "and", "you", "that", "with", "have", "for", "not", "are", "but",
            "from", "your", "know", "like", "love", "just", "all", "this", "what",
            "see", "get", "can", "out", "when", "time", "baby", "yeah", "don't", "can't"
        }
    },
    "es": {
        "name": "Spanish",
        "native": "Español",
        "flag": "🇪🇸",
        "chars": r"[ñáéíóúÁÉÍÓÚ¿¡]",
        "words": {
            "que", "de", "no", "la", "el", "en", "y", "los", "se", "del", "las", "un",
            "por", "con", "para", "una", "como", "más", "pero", "sus", "le", "ya", "o",
            "fue", "este", "todo", "ti", "mi", "amor", "quiero", "corazón"
        }
    },
    "de": {
        "name": "German",
        "native": "Deutsch",
        "flag": "🇩🇪",
        "chars": r"[äöüÄÖÜß]",
        "words": {
            "und", "die", "der", "das", "ist", "nicht", "ein", "eine", "mit", "sich",
            "auch", "auf", "für", "dass", "wie", "mir", "dir", "sie", "es", "du", "ich",
            "wir", "den", "dem", "nach", "noch", "wenn", "aber", "schon"
        }
    },
    "fr": {
        "name": "French",
        "native": "Français",
        "flag": "🇫🇷",
        "chars": r"[éèêëàâçîïôùûœÉÈÊËÀÂÇÎÏÔÙÛŒ]",
        "words": {
            "les", "des", "pour", "dans", "une", "que", "est", "pas", "qui", "sur",
            "avec", "nous", "vous", "moi", "toi", "mais", "elle", "ce", "un", "du",
            "au", "mon", "mes", "tout", "plus", "être", "sans", "faire"
        }
    },
    "it": {
        "name": "Italian",
        "native": "Italiano",
        "flag": "🇮🇹",
        "chars": r"[àèéìíîòóùúÀÈÉÌÍÎÒÓÙÚ]",
        "words": {
            "non", "che", "di", "la", "il", "un", "sono", "per", "con", "nella",
            "della", "questo", "come", "se", "ma", "io", "tu", "mi", "ti", "ci",
            "anche", "tutto", "lei", "lui", "più", "ora", "vita", "amore"
        }
    },
    "no": {
        "name": "Norwegian",
        "native": "Norsk",
        "flag": "🇳🇴",
        "chars": r"[æøåÆØÅ]",
        "words": {
            "og", "det", "på", "for", "ikke", "jeg", "som", "til", "med", "vi",
            "du", "meg", "deg", "kan", "skal", "hva", "den", "et", "har", "om"
        }
    },
    "pt": {
        "name": "Portuguese",
        "native": "Português",
        "flag": "🇵🇹",
        "chars": r"[ãõçáéíóúâêôÃÕÇÁÉÍÓÚÂÊÔ]",
        "words": {
            "não", "para", "uma", "com", "seu", "sua", "você", "mais", "por",
            "como", "dos", "das", "meu", "minha", "nosso", "quando", "sempre"
        }
    },
    "ja": {
        "name": "Japanese",
        "native": "日本語",
        "flag": "🇯🇵",
        "chars": r"[\u3040-\u309F\u30A0-\u30FF]",
        "words": set()
    },
    "ko": {
        "name": "Korean",
        "native": "한국어",
        "flag": "🇰🇷",
        "chars": r"[\uAC00-\uD7AF]",
        "words": set()
    },
    "zh": {
        "name": "Chinese",
        "native": "中文",
        "flag": "🇨🇳",
        "chars": r"[\u4E00-\u9FAF]",
        "words": set()
    }
}

def detect_language(text: str) -> dict:
    """Accurately detects the language of a lyrics string."""
    if not text:
        return {"code": "unknown", "name": "Unknown", "native": "Unknown", "flag": "🌐"}

    # 1. Asian Scripts Detection
    if re.search(r"[\u3040-\u309F\u30A0-\u30FF]", text):
        return {"code": "ja", "name": "Japanese", "native": "日本語", "flag": "🇯🇵"}
    if re.search(r"[\uAC00-\uD7AF]", text):
        return {"code": "ko", "name": "Korean", "native": "한국어", "flag": "🇰🇷"}
    if re.search(r"[\u4E00-\u9FAF]", text):
        return {"code": "zh", "name": "Chinese", "native": "中文", "flag": "🇨🇳"}

    # 2. Extract words and special characters
    words = re.findall(r"[a-zA-ZåäöÅÄÖéèêëàâçîïôùûœñáíóúüßøæ]+", text.lower())
    if not words:
        return {"code": "en", "name": "English", "native": "English", "flag": "🇬🇧"}

    # Count language-specific characters
    scores = {}
    for code, info in LANG_MAP.items():
        if code in ("ja", "ko", "zh"):
            continue
        score = 0
        if info["chars"]:
            matches = len(re.findall(info["chars"], text))
            score += matches * 3
        # Match common functional words
        word_hits = sum(1 for w in words if w in info["words"])
        score += word_hits * 2
        scores[code] = score

    best_code, best_score = max(scores.items(), key=lambda x: x[1])
    if best_score >= 3:
        info = LANG_MAP[best_code]
        return {
            "code": best_code,
            "name": info["name"],
            "native": info["native"],
            "flag": info["flag"]
        }

    # Default fallback
    return {"code": "en", "name": "English", "native": "English", "flag": "🇬🇧"}


def clean_string(s: str) -> str:
    """Removes release tags, remasters, bonus notations, and parentheticals."""
    if not s:
        return ""
    s = re.sub(r'\(.*?(remaster|deluxe|version|edit|live|mono|stereo|bonus|feat|featuring).*?\)', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\[.*?(remaster|deluxe|version|edit|live|mono|stereo|bonus|feat|featuring).*?\]', '', s, flags=re.IGNORECASE)
    s = re.sub(r'-\s*(remaster|live|radio edit|bonus track|mono|stereo).*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+-\s+.*$', '', s)
    return " ".join(s.split()).strip()

def normalize_compare_key(s: str) -> str:
    """Creates a normalized alphanumeric string for reliable matching."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r'\(.*?\)|\[.*?\]', '', s)
    s = re.sub(r'^\d+[\s.-]+', '', s) # Strip leading track numbers like '01 - '
    s = re.sub(r'[^a-z0-9åäöéèêáíóúñüß]+', ' ', s)
    return " ".join(s.split()).strip()

def get_cache_key(artist: str, title: str) -> str:
    key = f"{artist.lower().strip()}_{title.lower().strip()}"
    return hashlib.md5(key.encode('utf-8')).hexdigest()

def read_lyrics_file(filepath: str) -> str:
    """Reads lyrics file trying UTF-8, UTF-8-sig, Latin-1, CP1252, ISO-8859-1."""
    encodings = ("utf-8-sig", "utf-8", "latin-1", "cp1252", "iso-8859-1")
    for enc in encodings:
        try:
            with open(filepath, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
        except Exception:
            return ""
    try:
        with open(filepath, "r", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""

def parse_lrc(lrc_text: str, duration: float = 0) -> list:
    """Parses standard LRC timestamps [mm:ss.xx] into structured lines with breaks."""
    raw_lines = []
    for line in lrc_text.splitlines():
        line = line.strip()
        if not line:
            continue
        matches = list(re.finditer(r'\[(\d+):(\d+(?:\.\d+)?)\]', line))
        if not matches:
            continue
        text = line[matches[-1].end():].strip()
        for m in matches:
            mins = int(m.group(1))
            secs = float(m.group(2))
            t = round(mins * 60.0 + secs, 2)
            raw_lines.append((t, text))

    raw_lines.sort(key=lambda x: x[0])
    if not raw_lines:
        return []

    processed = []
    for i in range(len(raw_lines)):
        t, text = raw_lines[i]
        next_t = raw_lines[i + 1][0] if i + 1 < len(raw_lines) else (duration if duration > t else t + 5.0)

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
        else:
            processed.append({
                "type": "lyric",
                "time": t,
                "endTime": round(next_t, 2),
                "text": text
            })

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

def repair_synced_accents(synced_lrc: str, plain_lyrics: str) -> str:
    """
    Restores local language accents (e.g. å, ä, ö, é, ñ) into a synced LRC
    if the online synced source stripped non-ASCII characters while plain lyrics has full accents.
    """
    if not synced_lrc or not plain_lyrics:
        return synced_lrc

    synced_lines = []
    for line in synced_lrc.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r'(\[\d+:\d+(?:\.\d+)?\])\s*(.*)', line)
        if m:
            synced_lines.append((m.group(1), m.group(2)))

    plain_lines = [l.strip() for l in plain_lyrics.splitlines() if l.strip()]

    if not synced_lines or not plain_lines:
        return synced_lrc

    # Check if plain lines have special accents that synced lines lack
    synced_accents = len(re.findall(r'[åäöÅÄÖéèêëáíóúñüßøæ]', synced_lrc))
    plain_accents = len(re.findall(r'[åäöÅÄÖéèêëáíóúñüßøæ]', plain_lyrics))

    if plain_accents <= synced_accents or plain_accents == 0:
        return synced_lrc

    # Reconstruct synced lines by mapping matching text
    reconstructed = []
    p_idx = 0
    for ts, s_text in synced_lines:
        if not s_text:
            reconstructed.append(ts)
            continue

        s_norm = re.sub(r'[^a-z0-9]', '', s_text.lower())
        matched_plain = None

        # Look forward in plain lines for best matching line
        for offset in range(max(0, p_idx - 2), min(len(plain_lines), p_idx + 4)):
            p_text = plain_lines[offset]
            p_norm = re.sub(r'[^a-z0-9åäöéèêëáíóúñüßøæ]', '', p_text.lower())
            # Replace accents in p_norm to compare with s_norm
            p_ascii = re.sub(r'[åäöéèêëáíóúñüßøæ]', '', p_norm)
            if s_norm and (s_norm in p_ascii or p_ascii in s_norm or s_norm == p_norm):
                matched_plain = p_text
                p_idx = offset + 1
                break

        if matched_plain:
            reconstructed.append(f"{ts} {matched_plain}")
        else:
            reconstructed.append(f"{ts} {s_text}")

    return "\n".join(reconstructed)

# =========================================================================
# Local Songs & Files Search
# =========================================================================

def find_local_lyrics(title: str, artist: str) -> list:
    """
    Searches local directories for .lrc and .txt lyric files for the current song.
    Checks ~/.config/sonos-karaoke/lyrics, ~/.lyrics, and ~/Music.
    """
    if not title:
        return []

    norm_t = normalize_compare_key(title)
    norm_a = normalize_compare_key(artist)

    search_dirs = [LOCAL_LYRICS_DIR, SYS_LYRICS_DIR]
    if os.path.exists(USER_MUSIC_DIR):
        search_dirs.append(USER_MUSIC_DIR)
        music_lyrics = os.path.join(USER_MUSIC_DIR, "lyrics")
        if os.path.exists(music_lyrics):
            search_dirs.append(music_lyrics)

    candidates = []
    seen_paths = set()

    for sdir in search_dirs:
        if not os.path.exists(sdir):
            continue
        try:
            # Find all .lrc and .txt files
            for ext in ("*.lrc", "*.txt"):
                pattern = os.path.join(sdir, "**", ext) if sdir == USER_MUSIC_DIR else os.path.join(sdir, ext)
                for fpath in glob.glob(pattern, recursive=(sdir == USER_MUSIC_DIR)):
                    if fpath in seen_paths or not os.path.isfile(fpath):
                        continue
                    seen_paths.add(fpath)

                    fname = os.path.splitext(os.path.basename(fpath))[0]
                    norm_fn = normalize_compare_key(fname)

                    # Match logic:
                    # 1. Filename contains both artist and title: 'magnus uggla astrologen'
                    # 2. Filename equals title: 'astrologen'
                    # 3. Filename starts with title or contains title
                    matches = False
                    if norm_t and norm_t in norm_fn:
                        matches = True
                    elif norm_a and norm_t and (norm_a in norm_fn and norm_t in norm_fn):
                        matches = True

                    if matches:
                        content = read_lyrics_file(fpath)
                        if not content.strip():
                            continue
                        is_synced = bool(re.search(r'\[\d+:\d+(?:\.\d+)?\]', content))
                        lang = detect_language(content)
                        preview_lines = [l for l in content.splitlines() if l.strip() and not l.strip().startswith("[ti:") and not l.strip().startswith("[ar:")][:3]
                        clean_preview = [re.sub(r'\[\d+:\d+(?:\.\d+)?\]\s*', '', p) for p in preview_lines]

                        candidates.append({
                            "id": f"local:{os.path.basename(fpath)}",
                            "source": "local",
                            "sourceLabel": f"📁 Local File ({os.path.basename(fpath)})",
                            "path": fpath,
                            "synced": is_synced,
                            "language": lang,
                            "raw": content,
                            "preview": clean_preview
                        })
        except Exception:
            continue

    return candidates

# =========================================================================
# User Preferences Storage (Preferred Versions & Default Language)
# =========================================================================

def load_preferences() -> dict:
    if os.path.exists(PREFS_FILE):
        try:
            with open(PREFS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"preferredLanguage": "auto", "songs": {}}

def save_preferences(prefs: dict):
    try:
        with open(PREFS_FILE, "w", encoding="utf-8") as f:
            json.dump(prefs, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def get_song_preference(artist: str, title: str) -> str:
    prefs = load_preferences()
    key = f"{artist.lower().strip()}_{title.lower().strip()}"
    return prefs.get("songs", {}).get(key, "")

def set_song_preference(artist: str, title: str, version_id: str):
    prefs = load_preferences()
    if "songs" not in prefs:
        prefs["songs"] = {}
    key = f"{artist.lower().strip()}_{title.lower().strip()}"
    prefs["songs"][key] = version_id
    save_preferences(prefs)

def get_language_preference() -> str:
    prefs = load_preferences()
    return prefs.get("preferredLanguage", "auto")

def set_language_preference(lang_code: str):
    prefs = load_preferences()
    prefs["preferredLanguage"] = lang_code
    save_preferences(prefs)

# =========================================================================
# All Versions Aggregation & Fetching
# =========================================================================

def fetch_all_lyric_versions(title: str, artist: str, duration: float = 0, album: str = "") -> list:
    """
    Collects ALL candidate lyric versions: local files, online synced,
    repaired local-language accented versions, plain auto-timed, and translations.
    """
    if not title:
        return []

    versions = []

    # 1. Search local files on disk
    local_candidates = find_local_lyrics(title, artist)
    versions.extend(local_candidates)

    # 2. Check LRCLIB online API
    clean_t = clean_string(title)
    clean_a = clean_string(artist)

    queries = [
        {"track_name": title, "artist_name": artist},
        {"track_name": clean_t, "artist_name": clean_a}
    ]
    if album:
        queries.insert(1, {"track_name": clean_t, "artist_name": clean_a, "album_name": clean_string(album)})

    online_items = []
    seen_ids = set()

    for q in queries:
        try:
            params = urllib.parse.urlencode(q)
            url = f"https://lrclib.net/api/get?{params}"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3.5) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                if isinstance(res_data, dict) and res_data.get("id"):
                    item_id = str(res_data["id"])
                    if item_id not in seen_ids:
                        seen_ids.add(item_id)
                        online_items.append(res_data)
                        break
        except Exception:
            continue

    # Also attempt search query if get didn't return multiple or synced
    try:
        search_params = urllib.parse.urlencode({"q": f"{clean_t} {clean_a}".strip()})
        search_url = f"https://lrclib.net/api/search?{search_params}"
        req = urllib.request.Request(search_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            s_data = json.loads(resp.read().decode("utf-8"))
            if isinstance(s_data, list):
                for item in s_data[:4]:
                    item_id = str(item.get("id"))
                    if item_id and item_id not in seen_ids:
                        seen_ids.add(item_id)
                        online_items.append(item)
    except Exception:
        pass

    # Collect all available plain lyrics texts across items
    all_plains = [item.get("plainLyrics") for item in online_items if item.get("plainLyrics")]

    # Process online items into candidate versions
    for item in online_items:
        synced = item.get("syncedLyrics")
        plain = item.get("plainLyrics")
        item_id = str(item.get("id", ""))

        if synced:
            # Check if any available plain lyrics can repair stripped local language characters
            best_repaired = None
            for p_cand in all_plains:
                rep = repair_synced_accents(synced, p_cand)
                if rep != synced:
                    best_repaired = rep
                    break

            if best_repaired:
                lang = detect_language(best_repaired)
                preview = [l for l in best_repaired.splitlines() if l.strip()][:3]
                clean_prev = [re.sub(r'\[\d+:\d+(?:\.\d+)?\]\s*', '', p) for p in preview]
                versions.append({
                    "id": f"lrclib:repaired:{item_id}",
                    "source": "online_repaired",
                    "sourceLabel": f"✨ Synced (Restored {lang['name']} Accents)",
                    "synced": True,
                    "language": lang,
                    "raw": best_repaired,
                    "preview": clean_prev
                })

            lang = detect_language(synced)
            preview = [l for l in synced.splitlines() if l.strip()][:3]
            clean_prev = [re.sub(r'\[\d+:\d+(?:\.\d+)?\]\s*', '', p) for p in preview]
            versions.append({
                "id": f"lrclib:synced:{item_id}",
                "source": "online_synced",
                "sourceLabel": f"☁️ LRCLIB Synced ({lang['name']})",
                "synced": True,
                "language": lang,
                "raw": synced,
                "preview": clean_prev
            })

        if plain:
            lang = detect_language(plain)
            preview = [l for l in plain.splitlines() if l.strip()][:3]
            versions.append({
                "id": f"lrclib:plain:{item_id}",
                "source": "online_plain",
                "sourceLabel": f"📄 LRCLIB Plain Text ({lang['name']})",
                "synced": False,
                "language": lang,
                "raw": plain,
                "preview": preview
            })

    # Deduplicate versions by normalizing line contents
    unique_versions = []
    seen_sigs = set()
    for v in versions:
        # Create signature from normalized text so identical versions are not repeated
        sig_raw = re.sub(r'\s+', '', v["raw"].strip().lower())
        sig = f"{v['synced']}_{sig_raw[:120]}"
        if sig in seen_sigs:
            continue
        seen_sigs.add(sig)
        unique_versions.append(v)

    return unique_versions

def fetch_lyrics(title: str, artist: str, duration: float = 0, album: str = "", chosen_version_id: str = None) -> dict:
    """
    Fetches synced lyrics, selects preferred language or local version,
    and returns parsed lines along with the list of all available versions.
    """
    if not title:
        return {"found": False, "lines": [], "synced": False, "availableVersions": []}

    cache_file = os.path.join(CACHE_DIR, f"{get_cache_key(artist, title)}.json")

    # Check stored user song preference if not explicitly provided
    if not chosen_version_id:
        chosen_version_id = get_song_preference(artist, title)

    preferred_lang = get_language_preference()

    # Collect all available versions
    all_versions = fetch_all_lyric_versions(title, artist, duration, album)

    # If no versions found, return empty placeholder
    if not all_versions:
        return {
            "found": False,
            "synced": False,
            "matchedTitle": title,
            "matchedArtist": artist,
            "language": {"code": "unknown", "name": "Unknown", "flag": "🌐"},
            "lines": [
                {"type": "break", "time": 0.0, "endTime": duration or 180.0, "text": "🎵 No lyrics found for this track - Sing along freely!"}
            ],
            "availableVersions": [],
            "currentVersionId": ""
        }

    # Selection Priority:
    # 1. User-chosen version (by versionId)
    # 2. Local file version (user's local collection)
    # 3. Version matching user's preferred language (e.g. 'sv' for Swedish songs)
    # 4. First synced version (preferring restored accented)
    # 5. First available version
    selected_version = None

    if chosen_version_id:
        for v in all_versions:
            if v["id"] == chosen_version_id:
                selected_version = v
                break

    if not selected_version:
        # Check local files first
        local_v = [v for v in all_versions if v["source"] == "local" and v["synced"]]
        if local_v:
            selected_version = local_v[0]

    if not selected_version and preferred_lang and preferred_lang != "auto":
        # Check matching preferred language
        lang_match = [v for v in all_versions if v["language"]["code"] == preferred_lang and v["synced"]]
        if lang_match:
            selected_version = lang_match[0]

    if not selected_version:
        # Repaired accented synced
        repaired_v = [v for v in all_versions if v["source"] == "online_repaired"]
        if repaired_v:
            selected_version = repaired_v[0]

    if not selected_version:
        # Any synced
        synced_v = [v for v in all_versions if v["synced"]]
        if synced_v:
            selected_version = synced_v[0]

    if not selected_version:
        selected_version = all_versions[0]

    # Parse lines based on whether version is synced or plain
    raw_text = selected_version["raw"]
    if selected_version["synced"]:
        lines = parse_lrc(raw_text, duration)
    else:
        lines = estimate_timing_for_plain(raw_text, duration)

    # Prepare available versions summary (exclude full raw text to keep payload light)
    versions_summary = []
    for v in all_versions:
        versions_summary.append({
            "id": v["id"],
            "source": v["source"],
            "sourceLabel": v["sourceLabel"],
            "synced": v["synced"],
            "language": v["language"],
            "preview": v["preview"],
            "active": (v["id"] == selected_version["id"])
        })

    result = {
        "found": True,
        "synced": selected_version["synced"],
        "matchedTitle": title,
        "matchedArtist": artist,
        "language": selected_version["language"],
        "currentVersionId": selected_version["id"],
        "lines": lines,
        "raw": raw_text,
        "availableVersions": versions_summary
    }

    # Save to cache
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

    return result

def save_local_lyric_file(title: str, artist: str, lrc_text: str, filename: str = "") -> dict:
    """
    Saves a custom or uploaded .lrc file into the local lyrics folder ~/.config/sonos-karaoke/lyrics,
    sets it as preferred for this song, and returns the updated lyrics result.
    """
    if not filename:
        clean_t = re.sub(r'[/\\?%*:|"<>]', '_', title.strip())
        clean_a = re.sub(r'[/\\?%*:|"<>]', '_', artist.strip())
        filename = f"{clean_a} - {clean_t}.lrc" if clean_a else f"{clean_t}.lrc"

    if not filename.endswith(".lrc") and not filename.endswith(".txt"):
        filename += ".lrc"

    target_path = os.path.join(LOCAL_LYRICS_DIR, filename)
    with open(target_path, "w", encoding="utf-8") as f:
        f.write(lrc_text)

    version_id = f"local:{filename}"
    set_song_preference(artist, title, version_id)

    # Invalidate old cache
    cache_file = os.path.join(CACHE_DIR, f"{get_cache_key(artist, title)}.json")
    if os.path.exists(cache_file):
        try:
            os.remove(cache_file)
        except Exception:
            pass

    return fetch_lyrics(title, artist, chosen_version_id=version_id)


if __name__ == "__main__":
    import sys
    test_track = sys.argv[1] if len(sys.argv) > 1 else "Astrologen"
    test_artist = sys.argv[2] if len(sys.argv) > 2 else "Magnus Uggla"
    print(f"Fetching lyrics and versions for: {test_track} by {test_artist}")
    res = fetch_lyrics(test_track, test_artist, 310.0)
    print(f"Active Version: {res.get('currentVersionId')}")
    print(f"Detected Language: {res.get('language')}")
    print(f"Available Versions: {len(res.get('availableVersions', []))}")
    for v in res.get("availableVersions", []):
        print(f" - [{v['language']['flag']} {v['language']['name']}] {v['sourceLabel']} (Active: {v['active']})")
    print(f"Lines count: {len(res['lines'])}")
    for line in res["lines"][:5]:
        print(f" [{line['time']:05.2f} -> {line['endTime']:05.2f}] ({line['type']}) {line['text']}")
