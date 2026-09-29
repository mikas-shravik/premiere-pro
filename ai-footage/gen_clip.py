#!/usr/bin/env python3
"""Generate AI video clips into an editor-friendly folder.

Backends:
  comfyui  - your own ComfyUI running locally (free, uses your GPU)
  fal      - fal.ai hosted API (pay per clip, free signup credit)

Every clip is saved as <SHOT>_v###.mp4 next to a <SHOT>_v###.json sidecar
holding the prompt, seed, backend and model, so you always know how a shot
was made. conform.py later reads those sidecars.

Examples:
  python gen_clip.py comfyui --workflow workflows/wan22_api.json \
      --shot SC01_SH010 --prompt "slow push-in on a rain-soaked neon street"
  python gen_clip.py fal --shot SC01_SH020 --prompt "drone shot over misty hills"
  python gen_clip.py batch shots.csv --backend comfyui --workflow workflows/wan22_api.json
"""
import argparse
import csv
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

DEFAULT_OUT = Path(__file__).resolve().parent / "incoming"
VIDEO_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".gif")
POLL_SECONDS = 3


def next_version_path(out_dir: Path, shot: str) -> Path:
    """SC01_SH010 -> SC01_SH010_v001.mp4, v002, ... never overwrites a take."""
    out_dir.mkdir(parents=True, exist_ok=True)
    taken = [int(m.group(1)) for p in out_dir.glob(f"{shot}_v*.*")
             if (m := re.fullmatch(re.escape(shot) + r"_v(\d{3})\.\w+", p.name))]
    return out_dir / f"{shot}_v{max(taken, default=0) + 1:03d}.mp4"


def download(url: str, dest: Path, session=requests) -> None:
    with session.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)


def write_sidecar(video: Path, info: dict) -> None:
    info = {"file": video.name,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **info}
    video.with_suffix(".json").write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")


# --- ComfyUI (local) -------------------------------------------------------

def fill_placeholders(node, values: dict):
    """Swap "{{PROMPT}}", "{{SEED}}" ... in an API-format workflow.

    A value that is exactly a placeholder takes the typed value (so seeds stay
    integers); placeholders inside longer text are substituted as strings.
    """
    if isinstance(node, dict):
        return {k: fill_placeholders(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [fill_placeholders(v, values) for v in node]
    if isinstance(node, str):
        for key, val in values.items():
            tag = "{{" + key + "}}"
            if node == tag:
                return val
            node = node.replace(tag, str(val))
    return node


def run_comfyui(prompt, seed, dest, workflow, host, negative="", **_):
    graph = json.loads(Path(workflow).read_text())
    if "{{PROMPT}}" not in json.dumps(graph):
        sys.exit(f"{workflow}: no {{{{PROMPT}}}} placeholder found. Put {{{{PROMPT}}}} "
                 "in your positive prompt node before exporting (see README).")
    graph = fill_placeholders(graph, {"PROMPT": prompt, "SEED": seed, "NEGATIVE": negative})

    r = requests.post(f"{host}/prompt", json={"prompt": graph}, timeout=30)
    if r.status_code != 200:
        sys.exit(f"ComfyUI rejected the workflow ({r.status_code}): {r.text[:500]}")
    prompt_id = r.json()["prompt_id"]
    print(f"  queued in ComfyUI ({prompt_id[:8]})", flush=True)

    while True:
        hist = requests.get(f"{host}/history/{prompt_id}", timeout=30).json()
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                sys.exit(f"ComfyUI failed: {json.dumps(status.get('messages', []))[:800]}")
            if status.get("completed", True):
                break
        time.sleep(POLL_SECONDS)

    # SaveVideo reports under "images", VideoHelperSuite under "gifs"; accept any.
    files = [f for out in entry["outputs"].values() for items in out.values()
             if isinstance(items, list) for f in items
             if isinstance(f, dict) and f.get("filename", "").lower().endswith(VIDEO_EXTS)]
    if not files:
        sys.exit("ComfyUI finished but produced no video file. Does the workflow "
                 "end in a Save Video / Video Combine node?")
    f = files[-1]
    ext = Path(f["filename"]).suffix
    dest = dest.with_suffix(ext)
    params = {"filename": f["filename"], "subfolder": f.get("subfolder", ""),
              "type": f.get("type", "output")}
    with requests.get(f"{host}/view", params=params, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest, "wb") as out:
            for chunk in r.iter_content(1 << 20):
                out.write(chunk)
    return dest, {"backend": "comfyui", "model": Path(workflow).stem}


# --- fal.ai (API) ----------------------------------------------------------

def run_fal(prompt, seed, dest, model, duration=None, aspect=None, negative="", **_):
    key = os.environ.get("FAL_KEY")
    if not key:
        sys.exit("Set FAL_KEY first (fal.ai dashboard -> API Keys).")
    base = os.environ.get("FAL_QUEUE_URL", "https://queue.fal.run")
    s = requests.Session()
    s.headers["Authorization"] = f"Key {key}"

    body = {"prompt": prompt, "seed": seed}
    if negative:
        body["negative_prompt"] = negative
    if duration:
        body["duration"] = str(duration)
    if aspect:
        body["aspect_ratio"] = aspect
    r = s.post(f"{base}/{model}", json=body, timeout=60)
    if r.status_code >= 400:
        sys.exit(f"fal.ai rejected the request ({r.status_code}): {r.text[:500]}")
    job = r.json()
    print(f"  queued on fal.ai ({job['request_id'][:8]})", flush=True)

    while True:
        st = s.get(job["status_url"], timeout=30).json()
        if st.get("status") == "COMPLETED":
            break
        if st.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
            sys.exit(f"fal.ai job failed: {st}")
        time.sleep(POLL_SECONDS)

    result = s.get(job["response_url"], timeout=60).json()
    video = result.get("video") or (result.get("videos") or [None])[0]
    if not video or "url" not in video:
        sys.exit(f"fal.ai returned no video: {json.dumps(result)[:500]}")
    download(video["url"], dest)
    return dest, {"backend": "fal", "model": model, "seed": result.get("seed", seed)}


BACKENDS = {"comfyui": run_comfyui, "fal": run_fal}


def generate(backend, shot, prompt, out_dir, seed=None, **opts):
    seed = seed if seed is not None else random.randint(0, 2**31 - 1)
    dest = next_version_path(Path(out_dir), shot)
    print(f"[{shot}] {prompt[:70]}{'...' if len(prompt) > 70 else ''}", flush=True)
    t0 = time.time()
    dest, meta = BACKENDS[backend](prompt=prompt, seed=seed, dest=dest, **opts)
    info = {"shot": shot, "prompt": prompt, "seed": seed, **meta,
            "seconds_to_generate": round(time.time() - t0, 1)}
    if opts.get("negative"):
        info["negative"] = opts["negative"]
    write_sidecar(dest, info)
    print(f"  -> {dest}", flush=True)
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help="output folder (default: ./incoming)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def backend_opts(p):
        p.add_argument("--workflow", help="[comfyui] API-format workflow JSON")
        p.add_argument("--host", default=os.environ.get("COMFYUI_HOST", "http://127.0.0.1:8188"),
                       help="[comfyui] server address")
        p.add_argument("--model", default=os.environ.get("FAL_MODEL", "fal-ai/ltx-video"),
                       help="[fal] model id, e.g. fal-ai/ltx-video")
        p.add_argument("--negative", default="", help="negative prompt")

    for name in BACKENDS:
        p = sub.add_parser(name, help=f"one clip via {name}")
        p.add_argument("--prompt", required=True)
        p.add_argument("--shot", default="SHOT", help="shot name, e.g. SC01_SH010")
        p.add_argument("--seed", type=int)
        p.add_argument("--duration", type=int, help="[fal] seconds, if the model supports it")
        p.add_argument("--aspect", help='[fal] e.g. "16:9", if the model supports it')
        backend_opts(p)

    p = sub.add_parser("batch", help="every row of a shot-list CSV")
    p.add_argument("csv", help="columns: shot,prompt[,negative,seed,duration,aspect,takes]")
    p.add_argument("--backend", choices=BACKENDS, required=True)
    backend_opts(p)

    a = ap.parse_args()
    if (a.cmd == "comfyui" or getattr(a, "backend", None) == "comfyui") and not a.workflow:
        ap.error("comfyui needs --workflow")
    common = {"workflow": a.workflow, "host": a.host.rstrip("/"), "model": a.model}

    if a.cmd != "batch":
        generate(a.cmd, a.shot, a.prompt, a.out, a.seed, negative=a.negative,
                 duration=a.duration, aspect=a.aspect, **common)
        return

    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("shot") or "").strip()]
    for row in rows:
        for take in range(int(row.get("takes") or 1)):
            generate(a.backend, row["shot"].strip(), row["prompt"].strip(), a.out,
                     int(row["seed"]) + take if row.get("seed") else None,
                     negative=row.get("negative") or a.negative,
                     duration=int(row["duration"]) if row.get("duration") else None,
                     aspect=row.get("aspect") or None, **common)


if __name__ == "__main__":
    main()
