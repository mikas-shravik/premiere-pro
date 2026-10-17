#!/usr/bin/env python3
"""Storyboard: a local storyboard, moodboard and animatic app.

Runs a small web server on this computer only (127.0.0.1) and opens the app
in your browser. Nothing is uploaded anywhere. Each project is a plain folder:

  ~/Documents/Storyboards/<project>/
      project.json      scenes, shots, moodboards, settings
      media/            every image, clip and track you drop in
      exports/          shots.csv, Premiere XML, slates
      .history/         automatic snapshots of project.json

Standard library only, so it runs with the python3 that ships with macOS.

  python3 server.py                     # opens http://127.0.0.1:8765
  python3 server.py --port 9000 --no-browser
  python3 server.py --data ~/Dropbox/Storyboards
"""
import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import secrets
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
import zipfile
from csv import DictWriter
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
CONNECTOR = HERE / "claude_connector.py"  # copied to connector_home() when connecting Claude
APP_DIR = HERE / "app"
AI_FOOTAGE = HERE.parent / "ai-footage"
DEFAULT_TAKES = AI_FOOTAGE / "incoming"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
TAKE_RE = re.compile(r"^(?P<shot>.+)_v(?P<ver>\d{3})$")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
TYPE_EXTS = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
             "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg",
             "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
             "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
             "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/flac": ".flac"}
EXTRA_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
               ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif",
               ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
               ".webm": "video/webm", ".m4a": "audio/mp4", ".flac": "audio/flac",
               ".webmanifest": "application/manifest+json", ".csv": "text/csv",
               ".xml": "application/xml"}
MAX_FETCH = 500 * 1024 * 1024
MAX_FOLDER = 60            # files taken from one folder by import-path
HISTORY_EVERY = 10 * 60      # seconds between automatic snapshots
HISTORY_KEEP = 60

# display fps -> (xml timebase, ntsc); same table as ai-footage/conform.py
RATES = {"23.976": (24, True), "24": (24, False), "25": (25, False),
         "29.97": (30, True), "30": (30, False), "50": (50, False),
         "59.94": (60, True), "60": (60, False)}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def now_ms() -> int:
    return int(time.time() * 1000)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:48] or "project"


def pathurl(p: Path) -> str:
    posix = p.resolve().as_posix()
    if not posix.startswith("/"):  # Windows: C:/Users/...
        posix = "/" + posix
    return "file://localhost" + quote(posix, safe="/:")


def reveal(path: Path) -> None:
    if sys.platform == "darwin":
        args = ["open", "-R", str(path)] if path.is_file() else ["open", str(path)]
    elif os.name == "nt":
        args = ["explorer", f"/select,{path}"] if path.is_file() else ["explorer", str(path)]
    else:
        args = ["xdg-open", str(path if path.is_dir() else path.parent)]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Library:
    """All projects live in one data folder, one sub-folder per project."""

    def __init__(self, root: Path, takes: Path):
        self.root = root
        self.takes = takes
        self.lock = threading.Lock()
        self.subscribers = {}  # project id -> set of queues, one per open window
        self.presence = {}     # project id -> what the person has selected
        root.mkdir(parents=True, exist_ok=True)

    # -- live updates --------------------------------------------------------

    def subscribe(self, pid: str) -> "queue.Queue":
        q = queue.Queue()
        with self.lock:
            self.subscribers.setdefault(pid, set()).add(q)
        return q

    def unsubscribe(self, pid: str, q) -> None:
        with self.lock:
            self.subscribers.get(pid, set()).discard(q)

    def broadcast(self, pid: str, event: dict) -> None:
        for q in list(self.subscribers.get(pid, ())):
            q.put(event)

    def close_streams(self) -> None:
        for qs in list(self.subscribers.values()):
            for q in list(qs):
                q.put(None)

    def dir(self, pid: str) -> Path:
        if not ID_RE.match(pid or ""):
            raise ApiError(HTTPStatus.BAD_REQUEST, "bad project id")
        d = self.root / pid
        if not (d / "project.json").is_file():
            raise ApiError(HTTPStatus.NOT_FOUND, "no such project")
        return d

    def inside(self, pid: str, rel: str) -> Path:
        base = self.dir(pid).resolve()
        p = (base / rel).resolve()
        if not p.is_relative_to(base):
            raise ApiError(HTTPStatus.FORBIDDEN, "path outside project")
        return p

    def read(self, pid: str) -> dict:
        return json.loads((self.dir(pid) / "project.json").read_text(encoding="utf-8"))

    def write(self, d: Path, data: dict) -> None:
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, d / "project.json")

    # -- projects ----------------------------------------------------------

    def list(self) -> list:
        out = []
        for f in self.root.glob("*/project.json"):
            if f.parent.name.startswith("."):
                continue
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            shots = [s for sc in p.get("scenes", []) for s in sc.get("shots", [])]
            cover = next((s["frame"] for s in shots if s.get("frame")), None)
            if not cover:
                cover = next((dict(src=i["src"], kind=i["type"])
                              for b in p.get("boards", []) for i in b.get("items", [])
                              if i.get("type") == "image"), None)
            out.append({"id": f.parent.name, "name": p.get("name", f.parent.name),
                        "updated": p.get("updated", 0), "created": p.get("created", 0),
                        "scenes": len(p.get("scenes", [])), "shots": len(shots),
                        "seconds": round(sum(float(s.get("duration") or 0) for s in shots), 2),
                        "aspect": p.get("settings", {}).get("aspect", "16:9"),
                        "cover": cover})
        return sorted(out, key=lambda p: p["updated"], reverse=True)

    def create(self, data: dict) -> dict:
        name = (data.get("name") or "Untitled project").strip()[:120]
        with self.lock:
            pid = f"{slugify(name)}-{secrets.token_hex(2)}"
            d = self.root / pid
            (d / "media").mkdir(parents=True)
            project = data.get("project") or {}
            project.update({"id": pid, "name": name, "created": now_ms(),
                            "updated": now_ms(), "rev": 1})
            self.write(d, project)
        return project

    def save(self, pid: str, data: dict, base_rev, meta=None) -> int:
        """meta: who saved (client id, actor, summary, touched ids), passed
        on to every open window so they can merge the change live."""
        with self.lock:
            d = self.dir(pid)
            current = self.read(pid)
            rev = int(current.get("rev", 0))
            if base_rev is not None and int(base_rev) != rev:
                raise ApiError(HTTPStatus.CONFLICT, "changed in another window")
            self.snapshot(d)
            data.update({"id": pid, "rev": rev + 1, "updated": now_ms()})
            self.write(d, data)
        self.broadcast(pid, {"rev": rev + 1, **(meta or {})})
        return rev + 1

    def snapshot(self, d: Path, force=False) -> None:
        hist = d / ".history"
        hist.mkdir(exist_ok=True)
        snaps = sorted(hist.glob("*.json"))
        if not force and snaps and time.time() - snaps[-1].stat().st_mtime < HISTORY_EVERY:
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(d / "project.json", hist / f"{stamp}.json")
        for old in sorted(hist.glob("*.json"))[:-HISTORY_KEEP]:
            old.unlink()

    def history(self, pid: str) -> list:
        out = []
        for f in sorted((self.dir(pid) / ".history").glob("*.json"), reverse=True):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            shots = sum(len(s.get("shots", [])) for s in p.get("scenes", []))
            out.append({"name": f.name, "time": int(f.stat().st_mtime * 1000), "shots": shots,
                        "items": sum(len(b.get("items", [])) for b in p.get("boards", []))})
        return out

    def restore(self, pid: str, name: str) -> dict:
        with self.lock:
            d = self.dir(pid)
            src = d / ".history" / Path(name).name
            if not src.is_file():
                raise ApiError(HTTPStatus.NOT_FOUND, "no such snapshot")
            current = self.read(pid)
            self.snapshot(d, force=True)
            data = json.loads(src.read_text(encoding="utf-8"))
            data.update({"id": pid, "rev": int(current.get("rev", 0)) + 1, "updated": now_ms()})
            self.write(d, data)
        self.broadcast(pid, {"rev": data["rev"], "actor": "history",
                             "summary": "restored an earlier version"})
        return data

    def duplicate(self, pid: str) -> dict:
        src = self.dir(pid)
        data = self.read(pid)
        with self.lock:
            name = f"{data.get('name', pid)} copy"
            new = f"{slugify(name)}-{secrets.token_hex(2)}"
            shutil.copytree(src, self.root / new, ignore=shutil.ignore_patterns(".history", "exports"))
            data.update({"id": new, "name": name, "created": now_ms(), "updated": now_ms(),
                         "rev": 1})
            self.write(self.root / new, data)
        return data

    def trash(self, pid: str) -> None:
        d = self.dir(pid)
        bin_ = self.root / ".trash"
        bin_.mkdir(exist_ok=True)
        os.replace(d, bin_ / f"{pid}-{datetime.now():%Y%m%d-%H%M%S}")

    # -- media -------------------------------------------------------------

    def store_media(self, pid: str, stream, length: int, name: str, ctype: str = "") -> dict:
        ext = Path(name).suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
        if ext not in MEDIA_EXTS:
            ext = TYPE_EXTS.get(ctype.split(";")[0].strip().lower(), "")
        if ext not in MEDIA_EXTS:
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                           f"{name or 'file'}: not an image, video or audio file")
        media = self.dir(pid) / "media"
        media.mkdir(exist_ok=True)
        h = hashlib.sha1()
        fd, tmp = tempfile.mkstemp(dir=media, suffix=".part")
        try:
            with os.fdopen(fd, "wb") as f:
                left = length
                while left is None or left > 0:
                    chunk = stream.read(min(1 << 20, left) if left is not None else 1 << 20)
                    if not chunk:
                        break
                    if left is not None:
                        left -= len(chunk)
                    elif f.tell() + len(chunk) > MAX_FETCH:
                        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file too large")
                    h.update(chunk)
                    f.write(chunk)
            if left:
                raise ApiError(HTTPStatus.BAD_REQUEST, "upload was cut off")
            if os.path.getsize(tmp) == 0:
                raise ApiError(HTTPStatus.BAD_REQUEST, "empty file")
            final = media / f"{h.hexdigest()[:16]}{ext}"
            if final.exists():
                os.unlink(tmp)
            else:
                os.replace(tmp, final)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        kind = "image" if ext in IMAGE_EXTS else "video" if ext in VIDEO_EXTS else "audio"
        return {"src": f"media/{final.name}", "kind": kind, "name": Path(name).name or final.name}

    def fetch_url(self, pid: str, url: str) -> dict:
        u = urlparse(url)
        if u.scheme not in ("http", "https"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "only http(s) links can be fetched")
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Storyboard/1.0",
            "Accept": "image/*,video/*,*/*;q=0.5"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                ctype = r.headers.get("Content-Type", "")
                length = r.headers.get("Content-Length")
                if length and int(length) > MAX_FETCH:
                    raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file too large")
                name = Path(unquote(u.path)).name or "download"
                return self.store_media(pid, r, int(length) if length else None, name, ctype)
        except ApiError:
            raise
        except Exception as e:  # noqa: BLE001 - report any network failure to the UI
            raise ApiError(HTTPStatus.BAD_GATEWAY, f"couldn't download that link ({e})")

    def import_path(self, pid: str, raw: str) -> dict:
        """Copy an image/clip, or every image and clip in a folder, from this
        computer into the project. Used by the Claude connector, which can't
        read Documents/Downloads itself but can name a file."""
        path = local_path(raw)
        try:
            if path.is_dir():
                files = sorted((f for f in path.iterdir() if not f.name.startswith(".")
                                and f.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS and f.is_file()),
                               key=lambda f: f.name.lower())
                if not files:
                    raise ApiError(HTTPStatus.NOT_FOUND, f"no images or clips in {path}")
            elif path.is_file():
                files = [path]
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, f"there's no file or folder at {path}")
            items = []
            for f in files[:MAX_FOLDER]:
                with open(f, "rb") as fh:
                    ref = self.store_media(pid, fh, f.stat().st_size, f.name)
                items.append({**ref, **self.media_info(pid, ref["src"])})
        except PermissionError:
            raise ApiError(HTTPStatus.FORBIDDEN,
                           f"macOS didn't let Storyboard open {path}. In System Settings › Privacy & Security › "
                           "Files and Folders, allow Terminal (or the app you start Storyboard from) to use that "
                           "folder, then try again") from None
        return {"items": items, "more": max(0, len(files) - MAX_FOLDER)}

    def media_info(self, pid: str, src: str) -> dict:
        try:
            return media_info(self.inside(pid, src))
        except ApiError:
            return {}

    # -- ai-footage takes ----------------------------------------------------

    def list_takes(self) -> dict:
        takes = {}
        if not self.takes.is_dir():
            return {"folder": str(self.takes), "takes": takes}
        for f in sorted(self.takes.iterdir()):
            m = TAKE_RE.match(f.stem)
            if not m or f.suffix.lower() not in VIDEO_EXTS | IMAGE_EXTS:
                continue
            meta = {}
            sidecar = f.with_suffix(".json")
            if sidecar.is_file():
                try:
                    meta = json.loads(sidecar.read_text(encoding="utf-8"))
                except ValueError:
                    pass
            takes.setdefault(m["shot"], []).append({
                "name": f.name, "version": int(m["ver"]), "url": f"/takes/{quote(f.name)}",
                "kind": "video" if f.suffix.lower() in VIDEO_EXTS else "image",
                "mtime": int(f.stat().st_mtime * 1000),
                "prompt": meta.get("prompt", ""), "model": meta.get("model", ""),
                "seed": meta.get("seed", "")})
        return {"folder": str(self.takes), "takes": takes}

    def take_path(self, name: str) -> Path:
        p = (self.takes / Path(unquote(name)).name).resolve()
        if not p.is_relative_to(self.takes.resolve()) or not p.is_file():
            raise ApiError(HTTPStatus.NOT_FOUND, "no such take")
        return p

    def import_take(self, pid: str, name: str) -> dict:
        p = self.take_path(name)
        with open(p, "rb") as f:
            return self.store_media(pid, f, p.stat().st_size, p.name)

    # -- exports -------------------------------------------------------------

    def export_csv(self, pid: str, rows: list) -> Path:
        out = self.dir(pid) / "exports"
        out.mkdir(exist_ok=True)
        buf = StringIO()
        w = DictWriter(buf, ["shot", "prompt", "negative", "seed", "duration", "aspect", "takes"],
                       extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: str(v).replace("\r", " ").replace("\n", " ") for k, v in r.items()})
        path = out / "shots.csv"
        path.write_text(buf.getvalue(), encoding="utf-8")
        return path

    def export_xml(self, pid: str, spec: dict) -> Path:
        d = self.dir(pid)
        out = d / "exports"
        out.mkdir(exist_ok=True)
        timebase, ntsc = RATES.get(str(spec.get("fps")), (24, False))
        xml = build_animatic_xml(d, spec, timebase, ntsc)
        path = out / f"{slugify(spec.get('name') or 'storyboard')}_animatic.xml"
        path.write_text(xml, encoding="utf-8")
        return path

    def preview(self, pid: str, src: str, size: int = 1024) -> Path:
        """A small JPEG/PNG of an image or clip, for showing Claude without
        sending a 20 MB file. Uses macOS's sips/qlmanage, else ffmpeg."""
        path = self.inside(pid, src)
        if not path.is_file():
            raise ApiError(HTTPStatus.NOT_FOUND, "no such media file")
        size = max(128, min(int(size or 1024), 2048))
        cache = self.dir(pid) / ".cache"
        cache.mkdir(exist_ok=True)
        is_video = path.suffix.lower() in VIDEO_EXTS
        for out in (cache / f"{path.stem}-{size}.jpg", cache / f"{path.stem}-{size}.png"):
            if out.exists() and out.stat().st_mtime >= path.stat().st_mtime:
                return out
        out = cache / f"{path.stem}-{size}.jpg"
        quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": 60}
        try:
            if sys.platform == "darwin" and not is_video and shutil.which("sips"):
                subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82",
                                "-Z", str(size), str(path), "--out", str(out)], **quiet)
            elif sys.platform == "darwin" and is_video and shutil.which("qlmanage"):
                subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", str(cache), str(path)], **quiet)
                made = cache / f"{path.name}.png"
                if made.exists():
                    os.replace(made, cache / f"{path.stem}-{size}.png")
                    return cache / f"{path.stem}-{size}.png"
            if not out.exists() and shutil.which("ffmpeg"):
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *(["-ss", "0.3"] if is_video else []),
                                "-i", str(path), "-frames:v", "1", "-vf",
                                f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                                "-q:v", "4", str(out)], **quiet)
        except (OSError, subprocess.SubprocessError):
            pass
        if out.exists():
            return out
        if not is_video and path.stat().st_size < 4 * 1024 * 1024:
            return path
        raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "couldn't make a preview of this file")

    def zip_project(self, pid: str) -> Path:
        d = self.dir(pid)
        out = d / "exports"
        out.mkdir(exist_ok=True)
        path = out / f"{slugify(self.read(pid).get('name', pid))}.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
            for f in sorted(d.rglob("*")):
                rel = f.relative_to(d)
                if f.is_file() and rel.parts[0] not in (".history", "exports"):
                    z.write(f, Path(pid) / rel)
        return path


def local_path(raw: str) -> Path:
    """A path as people paste it: quoted, ~/…, file://…, or with Terminal's
    backslash-escaped spaces."""
    s = (raw or "").strip().strip("'\"")
    if s.lower().startswith("file://"):
        s = unquote(urlparse(s).path)
    if "\\" in s and not os.path.exists(s):
        s = re.sub(r"\\(.)", r"\1", s)
    path = Path(os.path.expanduser(s))
    if not s or not path.is_absolute():
        raise ApiError(HTTPStatus.BAD_REQUEST, f"“{raw}” isn't a full path; it should start with / or ~/")
    return path


def media_info(path: Path) -> dict:
    """Pixel size, and length for clips, from the file itself; {} if unknown."""
    ext = path.suffix.lower()
    info = {}
    try:
        with open(path, "rb") as f:
            if ext in (".mp4", ".mov", ".m4v"):
                info = mp4_info(f)
            elif ext in IMAGE_EXTS:
                info = image_size(f)
    except (OSError, ValueError, IndexError, struct.error):
        info = {}
    if "w" not in info and ext in VIDEO_EXTS and shutil.which("ffprobe"):
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=width,height:format=duration", "-of", "json", str(path)],
                               capture_output=True, timeout=20)
            d = json.loads(r.stdout or b"{}")
            st = (d.get("streams") or [{}])[0]
            if st.get("width") and st.get("height"):
                info = {"w": int(st["width"]), "h": int(st["height"])}
            if (d.get("format") or {}).get("duration"):
                info["duration"] = round(float(d["format"]["duration"]), 3)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    if "w" not in info and ext in IMAGE_EXTS and sys.platform == "darwin" and shutil.which("sips"):
        try:
            r = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
                               capture_output=True, text=True, timeout=20)
            w = re.search(r"pixelWidth: (\d+)", r.stdout)
            h = re.search(r"pixelHeight: (\d+)", r.stdout)
            if w and h:
                info = {"w": int(w.group(1)), "h": int(h.group(1))}
        except (OSError, subprocess.SubprocessError):
            pass
    return info


def image_size(f) -> dict:
    head = f.read(32)
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", head[16:24])
    elif head[:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", head[6:10])
    elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        chunk = head[12:16]
        if chunk == b"VP8 ":
            w, h = (struct.unpack("<H", head[26:28])[0] & 0x3FFF, struct.unpack("<H", head[28:30])[0] & 0x3FFF)
        elif chunk == b"VP8L":
            bits = struct.unpack("<I", head[21:25])[0]
            w, h = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        elif chunk == b"VP8X":
            w, h = 1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little")
        else:
            return {}
    elif head[:2] == b"BM":
        w, h = struct.unpack("<ii", head[18:26])
    elif head[:2] == b"\xff\xd8":
        return jpeg_size(f)
    else:
        return {}
    return {"w": abs(w), "h": abs(h)} if w and h else {}


def jpeg_size(f) -> dict:
    """Walk the JPEG markers to the frame header, honouring EXIF rotation the
    way browsers do."""
    f.seek(2)
    turned = False
    while True:
        b = f.read(1)
        while b and b != b"\xff":
            b = f.read(1)
        while b == b"\xff":
            b = f.read(1)
        if not b:
            return {}
        marker = b[0]
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            continue
        length = struct.unpack(">H", f.read(2))[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">xHH", f.read(5))
            return ({"w": h, "h": w} if turned else {"w": w, "h": h}) if w and h else {}
        if marker == 0xE1:
            data = f.read(length - 2)
            turned = turned or exif_orientation(data) in (5, 6, 7, 8)
        else:
            f.seek(length - 2, 1)


def exif_orientation(data: bytes) -> int:
    if data[:6] != b"Exif\0\0":
        return 1
    t = data[6:]
    e = "<" if t[:2] == b"II" else ">"
    off = struct.unpack(e + "I", t[4:8])[0]
    for i in range(struct.unpack(e + "H", t[off:off + 2])[0]):
        entry = t[off + 2 + 12 * i: off + 14 + 12 * i]
        if struct.unpack(e + "H", entry[:2])[0] == 0x0112:
            return struct.unpack(e + "H", entry[8:10])[0]
    return 1


def mp4_info(f) -> dict:
    """Size of the first video track and the movie length, from an MP4/MOV."""
    size = os.fstat(f.fileno()).st_size

    def atoms(start, end):
        pos = start
        while pos + 8 <= end:
            f.seek(pos)
            n, kind = struct.unpack(">I4s", f.read(8))
            head = 8
            if n == 1:
                n, head = struct.unpack(">Q", f.read(8))[0], 16
            elif n == 0:
                n = end - pos
            if n < head:
                return
            yield kind, pos + head, pos + n
            pos += n

    info = {}
    for kind, start, end in atoms(0, size):
        if kind != b"moov":
            continue
        for kind2, s2, e2 in atoms(start, end):
            if kind2 == b"mvhd":
                f.seek(s2)
                v1 = f.read(4)[0] == 1
                f.seek(16 if v1 else 8, 1)
                scale, dur = struct.unpack(">IQ" if v1 else ">II", f.read(12 if v1 else 8))
                if scale:
                    info["duration"] = round(dur / scale, 3)
            elif kind2 == b"trak" and "w" not in info:
                for kind3, s3, _ in atoms(s2, e2):
                    if kind3 == b"tkhd":
                        f.seek(s3)
                        v1 = f.read(4)[0] == 1
                        f.seek((32 if v1 else 20) + 16, 1)
                        matrix = struct.unpack(">9i", f.read(36))
                        w, h = (round(x / 65536) for x in struct.unpack(">II", f.read(8)))
                        if w and h:  # audio tracks are 0×0
                            info["w"], info["h"] = (h, w) if matrix[0] == 0 and matrix[1] != 0 else (w, h)
        break
    return info


def link_media(d: Path, src: str, name: str) -> Path:
    """exports/premiere/<name>: a hard link (or copy) of a media file, so
    Premiere's bin shows SC01_SH010.png instead of a content hash."""
    source = (d / src).resolve()
    if not source.is_relative_to(d.resolve()) or not source.is_file():
        raise ApiError(HTTPStatus.BAD_REQUEST, f"missing media file {src}")
    out = d / "exports" / "premiere"
    out.mkdir(parents=True, exist_ok=True)
    target = out / (re.sub(r'[\\/:*?"<>|]+', "_", name) + source.suffix.lower())
    if target.exists():
        if target.stat().st_ino == source.stat().st_ino:
            return target
        target.unlink()
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return target


# --- Claude desktop app connector ------------------------------------------

def claude_config_path() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "Claude" / "claude_desktop_config.json"
    return Path.home() / ".config" / "Claude" / "claude_desktop_config.json"


def claude_app_found() -> bool:
    if sys.platform == "darwin":
        return any(p.exists() for p in (Path("/Applications/Claude.app"),
                                         Path.home() / "Applications" / "Claude.app"))
    return claude_config_path().parent.exists()


def connector_home() -> Path:
    """Where the connector lives for Claude. Not Downloads/Documents/Desktop:
    macOS won't let the Claude app read scripts there, so the connector
    would quit as soon as Claude started it."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Storyboard"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "Storyboard"
    return Path.home() / ".local" / "share" / "storyboard"


def installed_connector() -> Path:
    return connector_home() / "claude_connector.py"


def claude_entry():
    cfg = claude_config_path()
    if cfg.is_file():
        try:
            return json.loads(cfg.read_text(encoding="utf-8")).get("mcpServers", {}).get("storyboard")
        except (OSError, ValueError):
            pass
    return None


def claude_status() -> dict:
    entry = claude_entry()
    target = installed_connector()
    linked = bool(entry) and str(target) in (entry.get("args") or []) and target.is_file()
    return {"installed": linked, "outdated": bool(entry) and not linked, "appFound": claude_app_found(),
            "config": str(claude_config_path()), "connector": str(target)}


def refresh_connector() -> None:
    """Keep the copy Claude runs in step with this version of Storyboard."""
    target = installed_connector()
    try:
        if target.is_file() and target.read_bytes() != CONNECTOR.read_bytes():
            shutil.copy2(CONNECTOR, target)
    except OSError:
        pass


def claude_install(port: int) -> dict:
    """Add Storyboard to the Claude desktop app's connectors (its MCP
    servers list), keeping everything else in that file as it is."""
    cfg = claude_config_path()
    data = {}
    if cfg.is_file():
        try:
            data = json.loads(cfg.read_text(encoding="utf-8") or "{}")
        except ValueError:
            raise ApiError(HTTPStatus.CONFLICT, f"Claude's settings file isn't valid JSON: {cfg}")
        shutil.copy2(cfg, cfg.with_name(cfg.name + ".bak"))
    target = installed_connector()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CONNECTOR, target)
    data.setdefault("mcpServers", {})["storyboard"] = {
        "command": sys.executable,
        "args": [str(target)],
        "env": {"STORYBOARD_URL": f"http://127.0.0.1:{port}"},
    }
    cfg.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg.with_name(cfg.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, cfg)
    return claude_status()


def build_animatic_xml(d: Path, spec: dict, timebase: int, ntsc: bool) -> str:
    """FCP7 XML (Premiere: File > Import) with one clip per shot in a sequence,
    a sequence marker per shot carrying its action/dialogue, and the temp music
    on A1. Same dialect as ai-footage/conform.py."""
    rate = f"<rate><timebase>{timebase}</timebase><ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc></rate>"
    width, height = int(spec.get("width") or 1920), int(spec.get("height") or 1080)
    name = spec.get("name") or "Storyboard"
    files, clips, markers, t = {}, [], [], 0

    def file_ref(src, kind, frames, w=None, h=None, audio=False, label=None):
        path = link_media(d, src, label or Path(src).stem)
        if path in files:
            return f'<file id="{files[path]}"/>'
        fid = files[path] = f"file-{len(files) + 1}"
        media = ""
        if kind != "audio":
            media += (f"<video><samplecharacteristics>{rate}<width>{int(w or width)}</width>"
                      f"<height>{int(h or height)}</height>"
                      "<pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>")
        if kind == "audio" or audio:
            media += ("<audio><samplecharacteristics><depth>16</depth><samplerate>48000"
                      "</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>")
        return (f'<file id="{fid}"><name>{escape(path.name)}</name>'
                f"<pathurl>{escape(pathurl(path))}</pathurl>{rate}<duration>{frames}</duration>"
                f"<media>{media}</media></file>")

    for i, s in enumerate(spec.get("shots", []), 1):
        frames = max(1, int(s.get("frames") or timebase))
        src = s.get("src")
        if src:
            kind = s.get("kind", "image")
            length = frames if kind == "image" else max(1, int(s.get("srcFrames") or frames))
            use = min(frames, length)
            clips.append(
                f'<clipitem id="clipitem-{i}"><name>{escape(s.get("code", f"Shot {i}"))}</name>'
                f"<enabled>TRUE</enabled><duration>{length}</duration>{rate}"
                f"<start>{t}</start><end>{t + use}</end><in>0</in><out>{use}</out>"
                + ("<stillframe>TRUE</stillframe>" if kind == "image" else "")
                + file_ref(src, kind, length, s.get("w"), s.get("h"), label=s.get("code"))
                + "<logginginfo>"
                f"<description>{escape(s.get('prompt', ''))}</description>"
                f"<scene>{escape(s.get('code', ''))}</scene>"
                f"<lognote>{escape(s.get('action', ''))}</lognote>"
                "</logginginfo></clipitem>")
        comment = " | ".join(x for x in (s.get("action"), s.get("dialogue") and
                                         f"“{s['dialogue']}”", s.get("camera")) if x)
        markers.append(f"<marker><name>{escape(s.get('code', ''))}</name>"
                       f"<comment>{escape(comment)}</comment>"
                       f"<in>{t}</in><out>-1</out></marker>")
        t += frames

    audio_track = ""
    music = spec.get("music")
    if music and music.get("src"):
        mframes = max(1, int(music.get("frames") or t))
        offset = max(0, int(music.get("offsetFrames") or 0))
        use = max(1, min(t, mframes - offset))
        audio_track = (f'<clipitem id="music-1"><name>{escape(Path(music["src"]).name)}</name>'
                       f"<duration>{mframes}</duration>{rate}<start>0</start><end>{use}</end>"
                       f"<in>{offset}</in><out>{offset + use}</out>"
                       + file_ref(music["src"], "audio", mframes,
                                  label=Path(music.get("name") or "music").stem)
                       + "<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex>"
                       "</sourcetrack></clipitem>")

    return "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="4">',
        f'<sequence id="sequence-1"><name>{escape(name)} - Animatic</name>',
        f"<duration>{t}</duration>{rate}",
        f"<timecode>{rate}<string>01:00:00:00</string><frame>0</frame>"
        "<displayformat>NDF</displayformat></timecode>",
        "<media><video><format><samplecharacteristics>" + rate +
        f"<width>{width}</width><height>{height}</height>"
        "<pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>",
        f"<track>{''.join(clips)}</track></video>",
        f"<audio><track>{audio_track}</track></audio></media>",
        "".join(markers), "</sequence>", "</xmeml>"])


class Handler(BaseHTTPRequestHandler):
    server_version = "Storyboard/1.0"
    lib: Library = None

    def log_message(self, fmt, *args):  # quiet: only errors
        if args and str(args[1]).startswith(("4", "5")) and str(args[1]) != "404":
            sys.stderr.write("  %s %s\n" % (self.command, fmt % args))

    # -- plumbing ------------------------------------------------------------

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid JSON")

    def send_file(self, path: Path, download=False, immutable=False):
        if not path.is_file():
            raise ApiError(HTTPStatus.NOT_FOUND, "not found")
        ctype = EXTRA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] \
            or "application/octet-stream"
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if m and size:
            if m[1]:
                start = int(m[1])
                end = min(int(m[2]), size - 1) if m[2] else size - 1
            else:
                start = max(0, size - int(m[2] or 0))
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        self.send_response(HTTPStatus.PARTIAL_CONTENT if m and size else HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1 if size else 0))
        if m and size:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control",
                         "public, max-age=31536000, immutable" if immutable else "no-cache")
        if download:
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{quote(path.name)}")
        if not path.is_relative_to(APP_DIR):
            self.send_header("Content-Security-Policy", "default-src 'none'; "
                             "img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
        self.end_headers()
        if self.command == "HEAD" or not size:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # video element seeked away mid-stream

    def guard(self, mutating: bool):
        # Only answer to localhost names (blocks DNS-rebinding), and require a
        # custom header on writes so other websites can't drive this server.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ApiError(HTTPStatus.FORBIDDEN, "local access only")
        if mutating and self.headers.get("X-Storyboard") != "1":
            raise ApiError(HTTPStatus.FORBIDDEN, "missing X-Storyboard header")

    def handle_any(self, method):
        try:
            url = urlparse(self.path)
            parts = [unquote(p) for p in url.path.split("/") if p]
            self.guard(method not in ("GET", "HEAD"))
            if parts[:1] == ["api"]:
                return self.api(method, parts[1:], parse_qs(url.query))
            if method not in ("GET", "HEAD"):
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
            if parts[:1] == ["p"] and len(parts) >= 3:
                q = parse_qs(url.query)
                return self.send_file(self.lib.inside(parts[1], "/".join(parts[2:])),
                                      download="download" in q, immutable=parts[2] == "media")
            if parts[:1] == ["takes"] and len(parts) == 2:
                return self.send_file(self.lib.take_path(parts[1]))
            rel = "/".join(parts) or "index.html"
            path = (APP_DIR / rel).resolve()
            if not path.is_relative_to(APP_DIR) or not path.is_file():
                path = APP_DIR / "index.html"
            return self.send_file(path)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 - never kill the server on a bad request
            import traceback
            traceback.print_exc()
            self.send_json({"error": f"server error: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def api(self, method, parts, query):
        lib = self.lib
        route = (method, *parts[:1], *(["*"] if len(parts) > 1 else []), *parts[2:])
        pid = parts[1] if len(parts) > 1 else None

        if route == ("GET", "ping"):
            # `command` is shown by the Chrome app's offline page to restart us.
            command = f"python3 {shlex.quote(str(HERE / 'server.py'))} --no-browser"
            return self.send_json({"ok": True, "data": str(lib.root), "takes": str(lib.takes),
                                   "command": command})
        if route == ("POST", "shutdown"):
            self.send_json({"ok": True})
            lib.close_streams()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        if route == ("GET", "presence"):
            # The project and shot the person is looking at right now.
            if not lib.presence:
                return self.send_json({})
            pid_, info = max(lib.presence.items(), key=lambda kv: kv[1].get("ts", 0))
            return self.send_json({"project": pid_, **info})
        if (method, *parts) == ("GET", "claude", "status"):
            return self.send_json(claude_status())
        if (method, *parts) == ("POST", "claude", "install"):
            return self.send_json(claude_install(self.server.server_address[1]))
        if route == ("GET", "projects"):
            return self.send_json({"projects": lib.list(), "data": str(lib.root)})
        if route == ("POST", "projects"):
            return self.send_json(lib.create(self.body_json()), HTTPStatus.CREATED)
        if route == ("GET", "projects", "*"):
            data = lib.read(pid)
            data["path"] = str(lib.dir(pid))
            return self.send_json(data)
        if route in (("PUT", "projects", "*"), ("POST", "projects", "*", "save")):
            data = self.body_json()
            data.pop("path", None)
            touched = unquote(self.headers.get("X-Touched") or "")
            meta = {"client": self.headers.get("X-Client") or "",
                    "actor": self.headers.get("X-Actor") or "window",
                    "summary": unquote(self.headers.get("X-Summary") or ""),
                    "touched": [t for t in touched.split(",") if t]}
            return self.send_json({"rev": lib.save(pid, data, self.headers.get("X-Base-Rev"), meta)})
        if route == ("GET", "projects", "*", "events"):
            return self.stream_events(pid)
        if route == ("POST", "projects", "*", "presence"):
            lib.dir(pid)
            lib.presence[pid] = {**self.body_json(), "ts": time.time()}
            return self.send_json({"ok": True})
        if route == ("GET", "projects", "*", "presence"):
            lib.dir(pid)
            return self.send_json(lib.presence.get(pid, {}))
        if route == ("GET", "projects", "*", "preview"):
            src = (query.get("src") or [""])[0]
            size = int((query.get("max") or ["1024"])[0])
            return self.send_file(lib.preview(pid, src, size))
        if route == ("DELETE", "projects", "*"):
            lib.trash(pid)
            return self.send_json({"ok": True})
        if route == ("POST", "projects", "*", "duplicate"):
            return self.send_json(lib.duplicate(pid), HTTPStatus.CREATED)
        if route == ("POST", "projects", "*", "media"):
            name = unquote(self.headers.get("X-Filename") or "")
            length = int(self.headers.get("Content-Length") or 0)
            return self.send_json(lib.store_media(pid, self.rfile, length, name,
                                                  self.headers.get("Content-Type", "")))
        if route == ("POST", "projects", "*", "fetch"):
            body = self.body_json()
            ref = lib.fetch_url(pid, body.get("url", ""))
            return self.send_json({**ref, **lib.media_info(pid, ref["src"])} if body.get("info") else ref)
        if route == ("POST", "projects", "*", "import-path"):
            return self.send_json(lib.import_path(pid, self.body_json().get("path", "")))
        if route == ("POST", "projects", "*", "reveal"):
            rel = self.body_json().get("path") or "."
            reveal(lib.inside(pid, rel))
            return self.send_json({"ok": True})
        if route == ("GET", "projects", "*", "history"):
            return self.send_json({"snapshots": lib.history(pid)})
        if route == ("POST", "projects", "*", "restore"):
            return self.send_json(lib.restore(pid, self.body_json().get("name", "")))
        if route == ("GET", "projects", "*", "takes"):
            lib.dir(pid)
            return self.send_json(lib.list_takes())
        if route == ("POST", "projects", "*", "import-take"):
            return self.send_json(lib.import_take(pid, self.body_json().get("name", "")))
        if route[:3] == ("POST", "projects", "*") and len(parts) == 4 and parts[2] == "export":
            kind = parts[3]
            if kind == "csv":
                path = lib.export_csv(pid, self.body_json().get("rows", []))
            elif kind == "xml":
                path = lib.export_xml(pid, self.body_json())
            elif kind == "zip":
                path = lib.zip_project(pid)
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "unknown export")
            rel = path.relative_to(lib.dir(pid)).as_posix()
            tools = AI_FOOTAGE if (AI_FOOTAGE / "gen_clip.py").is_file() else None
            return self.send_json({"path": str(path), "rel": rel,
                                   "url": f"/p/{pid}/{quote(rel)}?download=1",
                                   "tools": str(tools) if tools else None})
        raise ApiError(HTTPStatus.NOT_FOUND, "unknown endpoint")

    def stream_events(self, pid):
        """Server-sent events: one message per save of this project."""
        rev = int(self.lib.read(pid).get("rev", 0))
        q = self.lib.subscribe(pid)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(f"data: {json.dumps({'hello': True, 'rev': rev})}\n\n".encode())
            while True:
                try:
                    event = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    continue
                if event is None:
                    break
                self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.lib.unsubscribe(pid, q)

    def do_GET(self):
        self.handle_any("GET")

    def do_HEAD(self):
        self.handle_any("HEAD")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")


def already_running(port: int) -> bool:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.load(r).get("ok") is True
    except Exception:  # noqa: BLE001
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("STORYBOARD_PORT", 8765)))
    ap.add_argument("--data", type=Path, default=os.environ.get("STORYBOARD_DATA"),
                    help="folder that holds your projects (default: ~/Documents/Storyboards)")
    ap.add_argument("--takes", type=Path, default=DEFAULT_TAKES,
                    help="folder scanned for generated takes named SHOT_v001.mp4 "
                         "(default: ../ai-footage/incoming)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    a = ap.parse_args()

    url = f"http://127.0.0.1:{a.port}/"
    if already_running(a.port):
        print(f"Storyboard is already running at {url}")
        if not a.no_browser:
            webbrowser.open(url)
        return

    takes = a.takes.expanduser().resolve()
    data = Path(a.data or Path.home() / "Documents" / "Storyboards").expanduser().resolve()
    try:
        Handler.lib = Library(data, takes)
    except PermissionError:
        # macOS asks before letting Terminal into Documents; if that was
        # refused, keep working from the home folder instead of crashing.
        if a.data:
            sys.exit(f"No permission to use {data}. Pick another folder with --data.")
        fallback = Path.home() / "Storyboards"
        print(f"No permission to use {data} (macOS privacy settings).\n"
              f"Using {fallback} instead.")
        Handler.lib = Library(fallback, takes)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError as e:
        sys.exit(f"Port {a.port} is busy ({e}). Try: python3 server.py --port 8777")
    httpd.daemon_threads = True
    # Claude set up by an older Storyboard runs the connector from this folder,
    # which macOS may block; move it to the safe copy and keep that current.
    entry = claude_entry()
    if entry and str(installed_connector()) not in (entry.get("args") or []):
        try:
            claude_install(a.port)
            print("Updated the Claude connector. Quit and reopen the Claude app to use it.")
        except (ApiError, OSError) as e:
            print(f"Couldn't update the Claude connector: {e}")
    refresh_connector()
    print(f"Storyboard running at {url}\n  projects: {Handler.lib.root}\n"
          f"  takes:    {Handler.lib.takes}\nKeep this window open. Press Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.4, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("\nStoryboard stopped.")


if __name__ == "__main__":
    main()
