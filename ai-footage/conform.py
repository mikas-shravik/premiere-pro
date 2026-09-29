#!/usr/bin/env python3
"""Make raw AI clips edit-ready and hand them to Premiere Pro.

AI generators spit out odd frame rates (Wan = 16 fps, others 24/30), odd
sizes (832x480, 1280x720) and long-GOP H.264 that scrubs badly. This script:

  1. transcodes everything in ./incoming to ./edit_ready at your project
     frame rate, in ProRes 422 / DNxHR HQ / H.264 (optionally resized),
  2. writes edit_ready/AI_Clips.xml. In Premiere: File > Import that XML and
     you get a bin of every take, with the prompt in the Description column
     and model/seed in Log Note, plus an "AI Assembly" sequence holding the
     newest take of each shot in shot order.

Needs ffmpeg + ffprobe on PATH.

Examples:
  python conform.py --fps 25
  python conform.py --fps 23.976 --codec dnxhr --size 1920x1080 --fit crop
  python conform.py --fps 30 --motion interp    # smooth 16 fps Wan clips
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".gif"}

CODECS = {
    "prores": (["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"], ".mov"),
    "dnxhr": (["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"], ".mov"),
    "h264": (["-c:v", "libx264", "-crf", "14", "-preset", "slow", "-g", "1",
              "-pix_fmt", "yuv420p"], ".mp4"),
}
# display fps -> (xml timebase, ntsc, exact ffmpeg rate)
RATES = {"23.976": (24, True, "24000/1001"), "24": (24, False, "24"),
         "25": (25, False, "25"), "29.97": (30, True, "30000/1001"),
         "30": (30, False, "30"), "50": (50, False, "50"),
         "59.94": (60, True, "60000/1001"), "60": (60, False, "60")}


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                          "-show_streams", "-show_format", str(path)],
                         capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    num, den = (int(x) for x in v.get("avg_frame_rate", "0/1").split("/"))
    return {"width": int(v["width"]), "height": int(v["height"]),
            "fps": num / den if den else 0.0,
            "seconds": float(info["format"].get("duration") or v.get("duration") or 0),
            "frames": int(v["nb_frames"]) if v.get("nb_frames", "").isdigit() else None,
            "audio": a is not None,
            "sample_rate": int(a["sample_rate"]) if a else None,
            "channels": int(a["channels"]) if a else None}


def video_filter(src: dict, rate: str, size, fit: str, motion: str) -> str:
    chain = []
    if size and (src["width"], src["height"]) != size:
        w, h = size
        if fit == "crop":
            chain += [f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos",
                      f"crop={w}:{h}"]
        elif fit == "pad":
            chain += [f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos",
                      f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"]
        else:
            chain += [f"scale={w}:{h}:flags=lanczos"]
    if motion == "interp":
        chain.append(f"minterpolate=fps={rate}:mi_mode=mci:mc_mode=aobmc:vsbmc=1")
    else:  # keep real-time speed, duplicate/drop frames to hit the rate
        chain.append(f"fps={rate}")
    chain.append("setsar=1")
    return ",".join(chain)


def transcode(src: Path, dst: Path, rate: str, codec: str, size, fit, motion) -> None:
    s = probe(src)
    args, _ = CODECS[codec]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-map", "0:v:0", "-map", "0:a:0?",
           "-vf", video_filter(s, rate, size, fit, motion), *args]
    if s["audio"]:
        cmd += ["-c:a", "pcm_s16le", "-ar", "48000"] if dst.suffix == ".mov" \
            else ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"]
    cmd += ["-movflags", "+write_colr", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-colorspace", "bt709", str(dst)]
    subprocess.run(cmd, check=True)


# --- Premiere / FCP7 XML ---------------------------------------------------

def pathurl(p: Path) -> str:
    posix = p.resolve().as_posix()
    if not posix.startswith("/"):  # Windows: C:/Users/...
        posix = "/" + posix
    return "file://localhost" + quote(posix, safe="/:")


def shot_of(name: str) -> str:
    return re.sub(r"_v\d{3}$", "", Path(name).stem)


def build_xml(clips: list, timebase: int, ntsc: bool, seq_name: str) -> str:
    """clips: dicts with path, frames, width, height, audio, channels, meta."""
    rate = f"<rate><timebase>{timebase}</timebase><ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc></rate>"
    x = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>",
         '<xmeml version="4">', "<project>", "<name>AI Generated</name>", "<children>",
         "<bin>", "<name>AI Clips</name>", "<children>"]

    for i, c in enumerate(clips, 1):
        c["file_id"] = f"file-{i}"
        m = c["meta"]
        audio_def = ""
        if c["audio"]:
            audio_def = ("<audio><samplecharacteristics><depth>16</depth>"
                         "<samplerate>48000</samplerate></samplecharacteristics>"
                         f"<channelcount>{c['channels']}</channelcount></audio>")
        file_def = (f'<file id="{c["file_id"]}"><name>{escape(c["path"].name)}</name>'
                    f"<pathurl>{escape(pathurl(c['path']))}</pathurl>{rate}"
                    f"<duration>{c['frames']}</duration><media><video>"
                    f"<samplecharacteristics>{rate}<width>{c['width']}</width>"
                    f"<height>{c['height']}</height><pixelaspectratio>square</pixelaspectratio>"
                    f"</samplecharacteristics></video>{audio_def}</media></file>")
        note = ", ".join(f"{k}: {m[k]}" for k in ("backend", "model", "seed") if k in m)
        x += [f'<clip id="clip-{i}">', f"<name>{escape(c['path'].stem)}</name>",
              f"<duration>{c['frames']}</duration>", rate,
              "<media><video><track>",
              f"<clipitem id=\"clipitem-bin-{i}\"><name>{escape(c['path'].stem)}</name>"
              f"{rate}<start>0</start><end>{c['frames']}</end><in>0</in>"
              f"<out>{c['frames']}</out>{file_def}</clipitem>",
              "</track></video></media>",
              "<logginginfo>",
              f"<description>{escape(m.get('prompt', ''))}</description>",
              f"<scene>{escape(shot_of(c['path'].name))}</scene>",
              f"<lognote>{escape(note)}</lognote>",
              "</logginginfo>", "</clip>"]
    x += ["</children>", "</bin>"]

    # Assembly: newest take of every shot, in shot-name order.
    latest = {}
    for c in clips:
        latest[shot_of(c["path"].name)] = c
    picks = [latest[k] for k in sorted(latest)]
    total = sum(c["frames"] for c in picks)
    w, h = (picks[0]["width"], picks[0]["height"]) if picks else (1920, 1080)

    def items(kind):
        out, t = [], 0
        for n, c in enumerate(picks, 1):
            if kind == "audio" and not c["audio"]:
                t += c["frames"]
                continue
            src = ("<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex>"
                   "</sourcetrack>") if kind == "audio" else ""
            out.append(f'<clipitem id="{kind}-{n}"><name>{escape(c["path"].stem)}</name>'
                       f"<duration>{c['frames']}</duration>{rate}"
                       f"<start>{t}</start><end>{t + c['frames']}</end>"
                       f"<in>0</in><out>{c['frames']}</out>"
                       f'<file id="{c["file_id"]}"/>{src}</clipitem>')
            t += c["frames"]
        return "".join(out)

    x += ['<sequence id="sequence-1">', f"<name>{escape(seq_name)}</name>",
          f"<duration>{total}</duration>", rate,
          f"<timecode>{rate}<string>01:00:00:00</string><frame>0</frame>"
          "<displayformat>NDF</displayformat></timecode>",
          "<media><video><format><samplecharacteristics>", rate,
          f"<width>{w}</width><height>{h}</height>"
          "<pixelaspectratio>square</pixelaspectratio>",
          "</samplecharacteristics></format>",
          f"<track>{items('video')}</track></video>",
          f"<audio><track>{items('audio')}</track></audio></media>",
          "</sequence>", "</children>", "</project>", "</xmeml>"]
    return "\n".join(x)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=HERE / "incoming", type=Path)
    ap.add_argument("--dst", default=HERE / "edit_ready", type=Path)
    ap.add_argument("--fps", default="25", choices=RATES, help="project frame rate")
    ap.add_argument("--codec", default="prores", choices=CODECS)
    ap.add_argument("--size", help="e.g. 1920x1080 (default: keep native size)")
    ap.add_argument("--fit", default="crop", choices=["crop", "pad", "stretch"],
                    help="how to handle aspect mismatch with --size")
    ap.add_argument("--motion", default="dup", choices=["dup", "interp"],
                    help="dup = drop/duplicate frames (fast), "
                         "interp = motion-interpolate (smoother, slow)")
    ap.add_argument("--force", action="store_true", help="re-conform existing files")
    ap.add_argument("--sequence", default="AI Assembly", help="name of the assembly sequence")
    a = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found. Install ffmpeg (see README) and try again.")
    size = tuple(int(v) for v in a.size.lower().split("x")) if a.size else None
    timebase, ntsc, rate = RATES[a.fps]
    ext = CODECS[a.codec][1]
    a.dst.mkdir(parents=True, exist_ok=True)

    sources = sorted(p for p in a.src.glob("*") if p.suffix.lower() in VIDEO_EXTS)
    if not sources:
        sys.exit(f"No clips in {a.src}")

    clips = []
    for src in sources:
        dst = a.dst / (src.stem + ext)
        if a.force or not dst.exists():
            print(f"conform  {src.name} -> {dst.name}", flush=True)
            transcode(src, dst, rate, a.codec, size, a.fit, a.motion)
        else:
            print(f"skip     {dst.name} (exists, use --force to redo)")
        info = probe(dst)
        sidecar = src.with_suffix(".json")
        meta = json.loads(sidecar.read_text()) if sidecar.exists() else {}
        frames = info["frames"] or round(info["seconds"] * timebase / (1.001 if ntsc else 1))
        clips.append({"path": dst, "frames": frames, "meta": meta, **{
            k: info[k] for k in ("width", "height", "audio", "channels")}})

    xml_path = a.dst / "AI_Clips.xml"
    xml_path.write_text(build_xml(clips, timebase, ntsc, a.sequence), encoding="utf-8")
    print(f"\n{len(clips)} clip(s) ready. In Premiere: File > Import > {xml_path}")


if __name__ == "__main__":
    main()
