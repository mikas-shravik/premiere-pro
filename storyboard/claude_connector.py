#!/usr/bin/env python3
"""Storyboard connector for the Claude desktop app.

An MCP server over stdio: the Claude desktop app starts this script and
gets tools to read and edit the boards in the Storyboard app running on
this computer. Every edit is saved through Storyboard, so an open Storyboard
window shows it within a second and can undo it.

Set up from Storyboard itself (⋯ › Connect Claude), which adds this script
to Claude's settings. Standard library only, Python 3.9+.
"""
import base64
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("STORYBOARD_URL", "http://127.0.0.1:8765").rstrip("/")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # always direct to localhost

# Kept in step with app/js/vocab.js.
SIZES = ["EWS", "WS", "FS", "MWS", "MS", "MCU", "CU", "ECU", "INS", "OTS", "POV", "2S", "EST"]
ANGLES = ["Eye level", "Low", "High", "Overhead", "Worm", "Dutch", "Profile", "Aerial"]
MOVES = ["Static", "Push in", "Pull out", "Pan left", "Pan right", "Tilt up", "Tilt down", "Truck left",
         "Truck right", "Tracking", "Orbit", "Crane up", "Crane down", "Handheld", "Zoom in", "Zoom out",
         "Crash zoom", "Drone", "FPV", "Whip pan", "Rack focus", "Dolly zoom"]
TRANSITIONS = ["Cut", "Dissolve", "Fade in", "Fade out", "Match cut", "Smash cut", "Whip pan", "J-cut", "L-cut", "Wipe"]
ASPECTS = {"16:9": (1920, 1080), "2.39:1": (1920, 804), "1.85:1": (1920, 1038), "9:16": (1080, 1920),
           "4:5": (1080, 1350), "1:1": (1080, 1080), "4:3": (1440, 1080), "21:9": (2560, 1080)}
FPS = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]
SHOT_STATUS = {"idea": "Idea", "prompt": "Prompt ready", "generated": "Generated", "approved": "Approved", "edit": "In edit"}
VERSION_STATUS = {"new": "Exploring", "rework": "Rework", "option": "Option", "picked": "Picked"}

INSTRUCTIONS = """Storyboard is the user's storyboard and moodboard app for planning video shots. They are a video editor who generates shots with AI tools such as Higgsfield, then edits in Premiere Pro.

- The user can have several projects. Tools work on the project open in Storyboard unless you name one. After create_project, pass the new project's name to later calls, or open it with open_project when the user wants to see it.
- Shots are coded like SC01_SH020 (scene 1, shot 20). When the user says "this shot" or "the selected one", call get_selection.
- Each shot has a version tree: first references are versions 1, 2, 3; variations made from version 1 are 1.1, 1.2, and so on. Exactly one version can be Picked, and it is the shot's frame.
- The user circles, boxes or draws on images and attaches numbered notes saying what to change. Read them with get_feedback, and look at the marked-up image with view_images.
- To answer feedback, call create_version under the version being revised. Give it a complete, self-contained prompt that keeps what worked and fixes each note, including the project look. Then call reply_to_notes to say how you handled each note. The user generates the prompt in Higgsfield and drops the result onto your new version, or gives it to you to add.
- You can put images and clips on the board: pass web links (https://…) or file and folder paths on this computer to add_media_to_shot, add_shots_from_media or add_media_to_moodboard. If another tool generates an image or clip for you and gives you a link, add it the same way, under the version whose prompt you used. An image you can only see in the chat can't be passed to these tools; ask for its location instead (in Finder: select the file and press Option-Command-C to copy its path) or a link.
- Your edits appear live in the user's open Storyboard window, and they can undo them there. Don't delete anything unless the user asks you to."""


class ToolError(Exception):
    pass


class Offline(ToolError):
    pass


class Conflict(Exception):
    pass


def uid(prefix):
    return prefix + uuid.uuid4().hex[:10]


def now_ms():
    return int(time.time() * 1000)


# --- talking to Storyboard ---------------------------------------------------

def http(method, path, body=None, headers=None, raw=False, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"X-Storyboard": "1", "Content-Type": "application/json", **(headers or {})})
    try:
        with OPENER.open(req, timeout=timeout) as r:
            payload = r.read()
            return payload if raw else json.loads(payload or b"{}")
    except urllib.error.HTTPError as e:
        if e.code == 409:
            raise Conflict() from None
        try:
            msg = json.loads(e.read()).get("error") or str(e)
        except ValueError:
            msg = str(e)
        raise ToolError(f"Storyboard said: {msg}") from None
    except (urllib.error.URLError, OSError):
        raise Offline("Storyboard isn't running on this computer. Ask the user to start it "
                        "(the python3 command in Terminal, or the Storyboard app), then try again.") from None


def presence():
    try:
        return http("GET", "/api/presence")
    except ToolError:
        raise
    except Exception:  # noqa: BLE001
        return {}


def resolve_project(name=None):
    projects = http("GET", "/api/projects")["projects"]
    if not projects:
        raise ToolError("There are no projects in Storyboard yet.")
    if name:
        key = name.strip().lower()
        for p in projects:
            if p["id"] == name or p["name"].lower() == key:
                return p["id"]
        hits = [p for p in projects if key in p["name"].lower()]
        if len(hits) == 1:
            return hits[0]["id"]
        names = ", ".join(f'"{p["name"]}"' for p in (hits or projects)[:12])
        raise ToolError(f'No single project matches "{name}". Projects: {names}')
    pres = presence()
    if pres.get("project") and any(p["id"] == pres["project"] for p in projects):
        return pres["project"]
    return projects[0]["id"]


def load(pid):
    p = http("GET", f"/api/projects/{pid}")
    p.pop("path", None)
    p.setdefault("scenes", [])
    p.setdefault("boards", [])
    p.setdefault("versions", [])
    p.setdefault("settings", {})
    return p


def edit(pid, fn, summary):
    """Load, change and save the project; retry if a window saved meanwhile.
    fn(project, touched) mutates the project, appends changed ids to touched
    and returns the tool's answer."""
    for _ in range(6):
        p = load(pid)
        touched = []
        result = fn(p, touched)
        try:
            http("PUT", f"/api/projects/{pid}", p, headers={
                "X-Base-Rev": str(p.get("rev", 0)), "X-Client": "claude", "X-Actor": "claude",
                "X-Summary": urllib.parse.quote(summary[:200]),
                "X-Touched": urllib.parse.quote(",".join(touched[:50]))})
            return result
        except Conflict:
            time.sleep(0.25)
    raise ToolError("The board kept changing while I tried to save. Please try again.")


# --- lookups -----------------------------------------------------------------

def code(scene, shot):
    return f"SC{int(scene.get('number', 0)):02d}_SH{int(shot.get('number', 0)):03d}"


def scene_code(scene):
    return f"SC{int(scene.get('number', 0)):02d}"


def all_shots(p):
    for scene in p["scenes"]:
        for shot in scene.get("shots", []):
            yield scene, shot


def find_shot(p, ref):
    ref = (ref or "").strip()
    if ref.lower() in ("", "selected", "current", "this", "this shot"):
        pres = presence()
        if pres.get("project") == p["id"] and pres.get("shot"):
            ref = pres["shot"]
        else:
            raise ToolError("No shot is selected in Storyboard right now. Name one, e.g. SC01_SH020.")
    m = re.search(r"sc\D*0*(\d+)\D+sh\D*0*(\d+)", ref, re.I) or re.fullmatch(r"\s*0*(\d+)\s*[/._ -]\s*0*(\d+)\s*", ref)
    for scene, shot in all_shots(p):
        if shot.get("id") == ref:
            return scene, shot
        if m and int(scene.get("number", 0)) == int(m.group(1)) and int(shot.get("number", 0)) == int(m.group(2)):
            return scene, shot
    raise ToolError(f'No shot "{ref}" in this project. Use codes like SC01_SH020 (see get_board).')


def find_scene(p, ref):
    m = re.search(r"0*(\d+)", ref or "")
    for scene in p["scenes"]:
        if scene.get("id") == ref or (m and int(scene.get("number", 0)) == int(m.group(1))):
            return scene
    key = (ref or "").strip().lower()
    hits = [s for s in p["scenes"] if key and key in (s.get("title") or "").lower()]
    if len(hits) == 1:
        return hits[0]
    raise ToolError(f'No scene "{ref}". Use SC01, SC02… (see get_board).')


def versions_of(p, shot_id):
    return [v for v in p["versions"] if v.get("shot") == shot_id]


def children(p, vid):
    return sorted((v for v in p["versions"] if v.get("parent") == vid), key=lambda v: v.get("created", 0))


def find_version(p, shot, ref):
    vs = versions_of(p, shot["id"])
    ref = (ref or "").strip().lower().lstrip("v")
    if ref in ("selected", "current", "this"):
        pres = presence()
        hit = next((v for v in vs if v["id"] == pres.get("version")), None)
        if hit:
            return hit
        raise ToolError("No version is selected in Storyboard right now. Name one, e.g. 1.2.")
    if ref in ("picked", "final"):
        hit = next((v for v in vs if v.get("status") == "picked"), None)
        if hit:
            return hit
        raise ToolError("This shot has no picked version yet.")
    for v in vs:
        if str(v.get("label", "")).lower() == ref or v.get("id") == ref:
            return v
    labels = ", ".join(sorted(str(v.get("label")) for v in vs)) or "none"
    raise ToolError(f'No version "{ref}" on {shot.get("number")}. Versions: {labels}')


def next_label(p, shot_id, parent):
    sibs = [v for v in versions_of(p, shot_id) if (v.get("parent") or None) == (parent["id"] if parent else None)]
    n = max([int(str(v.get("label", "0")).split(".")[-1] or 0) for v in sibs if str(v.get("label", "0")).split(".")[-1].isdigit()] or [0]) + 1
    return f"{parent['label']}.{n}" if parent else str(n)


def open_marks(v):
    return [m for m in v.get("marks", []) if not m.get("done")]


def region(m):
    """Where a mark sits on the image, in words and percentages."""
    if m.get("shape") in ("ellipse", "rect"):
        x0, y0 = m.get("x", 0), m.get("y", 0)
        x1, y1 = x0 + m.get("w", 0), y0 + m.get("h", 0)
    else:
        pts = m.get("pts") or [[0, 0]]
        if m.get("shape") == "arrow" and len(pts) == 2:
            (ax, ay), (bx, by) = pts
            return f"arrow pointing at x {bx:.0%}, y {by:.0%} ({place(bx, by)})"
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    name = {"ellipse": "circle", "rect": "box", "pen": "scribble"}.get(m.get("shape"), "mark")
    return f"{name} around the {place((x0 + x1) / 2, (y0 + y1) / 2)} (x {x0:.0%}–{x1:.0%}, y {y0:.0%}–{y1:.0%})"


def place(x, y):
    h = "left" if x < 0.34 else "right" if x > 0.66 else "center"
    v = "top" if y < 0.34 else "bottom" if y > 0.66 else "middle"
    return "center" if (h, v) == ("center", "middle") else f"{v} {h}".replace("middle ", "").replace(" center", "")


def camera(shot):
    bits = [shot.get("size"), shot.get("angle") if shot.get("angle") not in ("", "Eye level") else "",
            shot.get("lens"), shot.get("move") if shot.get("move") not in ("", "Static") else ""]
    return " · ".join(b for b in bits if b)


def clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def shot_line(p, scene, shot, prompt_len=220):
    vs = versions_of(p, shot["id"])
    notes = sum(len(open_marks(v)) for v in vs)
    parts = [f"{code(scene, shot)} [{SHOT_STATUS.get(shot.get('status'), shot.get('status'))}] {shot.get('duration', 0)}s"]
    if camera(shot):
        parts.append(camera(shot))
    if shot.get("transition") and shot["transition"] != "Cut":
        parts.append(f"in: {shot['transition']}")
    line = " · ".join(parts)
    out = [line, f"    action: {clip(shot.get('action'), 400) or '—'}"]
    if shot.get("dialogue"):
        out.append(f"    dialogue: “{clip(shot['dialogue'], 300)}”")
    if shot.get("prompt"):
        out.append(f"    prompt: {clip(shot['prompt'], prompt_len)}")
    extra = [f"frame: {'yes' if shot.get('frame') else 'none'}"]
    if vs:
        extra.append(f"{len(vs)} version{'s' if len(vs) != 1 else ''}")
    if notes:
        extra.append(f"{notes} open note{'s' if notes != 1 else ''}")
    out.append("    " + " · ".join(extra))
    return "\n".join(out)


def tree_text(p, shot):
    lines = []

    def walk(v, depth):
        st = VERSION_STATUS.get(v.get("status"), v.get("status"))
        flags = [st, "by Claude" if v.get("by") == "claude" else "", "no image yet" if not v.get("media") else ""]
        lines.append(f"{'  ' * depth}v{v.get('label')} [{', '.join(f for f in flags if f)}]")
        if v.get("prompt"):
            lines.append(f"{'  ' * depth}  prompt: {clip(v['prompt'], 500)}")
        if v.get("note"):
            lines.append(f"{'  ' * depth}  note: {clip(v['note'], 300)}")
        for m in v.get("marks", []):
            state = "resolved" if m.get("done") else "OPEN"
            lines.append(f"{'  ' * depth}  #{m.get('n')} ({state}) {region(m)}: {clip(m.get('note'), 300) or '(no text)'}")
            if m.get("reply"):
                lines.append(f"{'  ' * depth}     ↳ your reply: {clip(m['reply'], 200)}")
        for c in children(p, v["id"]):
            walk(c, depth + 1)

    vs = versions_of(p, shot["id"])
    roots = sorted((v for v in vs if not v.get("parent") or not any(o["id"] == v["parent"] for o in vs)),
                   key=lambda v: v.get("created", 0))
    for r in roots:
        walk(r, 0)
    return "\n".join(lines) or "(no versions yet)"


# --- new projects (kept in step with app/js/store.js) -------------------------------

TEMPLATES = {
    "blank": (None, [("", "", 1)]),
    "commercial": (2.5, [("Hook", "Grab attention in the first 2 seconds", 2), ("Problem", "The tension the product solves", 2),
                         ("Product", "Hero shots, features in action", 4), ("Payoff", "Life with the product, emotion", 3),
                         ("End card", "Logo, tagline, call to action", 1)]),
    "music": (2, [("Intro", "", 2), ("Verse 1", "", 4), ("Chorus 1", "", 4), ("Verse 2", "", 4), ("Chorus 2", "", 4),
                  ("Bridge", "", 3), ("Final chorus", "", 4), ("Outro", "", 2)]),
    "short": (4, [("Act 1 · Setup", "World, character, what they want", 3), ("Inciting incident", "Everything changes", 2),
                  ("Act 2 · Confrontation", "Obstacles escalate", 4), ("Climax", "The decisive moment", 3),
                  ("Act 3 · Resolution", "New normal", 2)]),
}


def board(name, items):
    return {"id": uid("bd_"), "name": name, "items": items, "links": [], "view": {"x": 0, "y": 0, "z": 1}}


def starter_boards():
    def note(x, y, text, color="yellow", w=220, h=150):
        return {"id": uid("it_"), "type": "note", "x": x, "y": y, "w": w, "h": h, "text": text, "color": color}

    def section(x, y, w, h, title):
        return {"id": uid("it_"), "type": "section", "x": x, "y": y, "w": w, "h": h, "title": title}
    return [
        board("Look & feel", [
            section(-40, -60, 760, 520, "Look & lighting"), section(760, -60, 520, 520, "Color palette"),
            section(-40, 500, 760, 460, "Characters & wardrobe"), section(760, 500, 520, 460, "Locations"),
            note(0, 0, "Drop reference stills, frames from films, Higgsfield generations… anything that nails the look.", "yellow", 260, 140),
            note(800, 0, "Select an image → “Extract palette” to pull its colors here.", "blue", 240, 120)]),
        board("Ideas", [
            note(0, 0, "Core idea in one line", "orange", 240, 120), note(320, -80, "What should the audience feel?", "pink"),
            note(320, 120, "Key visual moment", "purple"), note(620, 20, "Ending / payoff", "green")]),
    ]


def settings_from(args, base):
    """Apply the settings fields of a tool call to base; returns the names changed."""
    changed = []
    if args.get("aspect"):
        if args["aspect"] not in ASPECTS:
            raise ToolError(f"Aspect must be one of {', '.join(ASPECTS)}.")
        base["aspect"] = args["aspect"]
        base["width"], base["height"] = ASPECTS[args["aspect"]]
        changed.append("aspect")
    if args.get("fps"):
        if str(args["fps"]) not in FPS:
            raise ToolError(f"Frame rate must be one of {', '.join(FPS)}.")
        base["fps"] = str(args["fps"])
        changed.append("fps")
    if args.get("duration"):
        base["duration"] = max(0.5, round(float(args["duration"]), 2))
        changed.append("default shot length")
    for k in ("look", "negative"):
        if args.get(k) is not None:
            base[k] = args[k]
            changed.append(k)
    return changed


def open_in_app(pid):
    return http("POST", "/api/open", {"project": pid}).get("windows", 0)


# --- media ---------------------------------------------------------------------

def gather(pid, sources):
    """Copy images and clips from links or paths on this computer into the
    project. Returns (media refs, problems)."""
    if isinstance(sources, str):
        sources = [sources]
    refs, problems = [], []
    for src in [str(x).strip() for x in sources or [] if str(x).strip()][:60]:
        try:
            if re.match(r"(?i)https?://", src):
                got = [http("POST", f"/api/projects/{pid}/fetch", {"url": src, "info": True}, timeout=300)]
            elif src.startswith("data:"):
                raise ToolError("pass a link or a file path, not image data")
            else:
                res = http("POST", f"/api/projects/{pid}/import-path", {"path": src}, timeout=300)
                got = res["items"]
                if res.get("more"):
                    problems.append(f"{clip(src, 80)}: took the first {len(got)} files; {res['more']} more were left out")
        except Offline:
            raise
        except ToolError as e:
            msg = str(e).replace("Storyboard said: ", "")
            problems.append(msg if src in msg or src.strip("'\"") in msg else f"{clip(src, 80)}: {msg}")
            continue
        for r in got:
            if r.get("kind") == "audio":
                problems.append(f"{r.get('name')}: music goes in the Animatic tab, not on shots or moodboards")
            else:
                refs.append(r)
    if not refs:
        raise ToolError("Nothing was added. " + ("; ".join(problems) or "Pass at least one link or file path."))
    return refs, problems


def media_ref(r):
    return {k: r[k] for k in ("src", "kind", "w", "h", "duration", "name") if r.get(k) is not None}


def pick_version(p, shot, v, touched):
    """Make v the shot's pick and frame; an earlier pick becomes an option."""
    for o in versions_of(p, shot["id"]):
        if o.get("status") == "picked" and o is not v:
            o["status"] = "option"
    v["status"] = "picked"
    if v.get("media"):
        shot["frame"] = dict(v["media"])
        if v["media"].get("kind") == "video" and shot.get("status") in ("idea", "prompt"):
            shot["status"] = "generated"
        touched.append(shot["id"])


def new_version(p, shot, parent, **over):
    v = {"id": uid("v_"), "shot": shot["id"], "parent": parent["id"] if parent else None,
         "label": next_label(p, shot["id"], parent), "media": None, "prompt": "", "note": "", "status": "new",
         "by": "you", "created": now_ms(), "marks": [], "markedSrc": None}
    v.update(over)
    p["versions"].append(v)
    return v


def lay_out(refs, x0, y0, max_w, box=320):
    """Moodboard items in rows, each fitted into a box×box square."""
    items, x, y, row_h = [], 0, 0, 0
    for r in refs:
        ratio = r["h"] / r["w"] if r.get("w") and r.get("h") else 9 / 16
        w = box if ratio <= 1 else round(box / ratio)
        if x and x + w > max_w:
            x, y, row_h = 0, y + row_h + 24, 0
        it = {"id": uid("it_"), "type": "video" if r.get("kind") == "video" else "image", "src": r["src"],
              "x": x0 + x, "y": y0 + y, "w": w, "h": round(w * ratio),
              "mw": r.get("w"), "mh": r.get("h"), "duration": r.get("duration"), "name": r.get("name")}
        items.append({k: v for k, v in it.items() if v is not None})
        x += w + 24
        row_h = max(row_h, it["h"])
    return items


def done_msg(msg, problems):
    return msg + ("\nNot added: " + "; ".join(problems) if problems else "")


# --- tools ---------------------------------------------------------------------

def t_list_projects(_):
    projects = http("GET", "/api/projects")["projects"]
    pres = presence()
    if not projects:
        return "No projects yet."
    rows = []
    for p in projects:
        mark = "  ← open in Storyboard" if p["id"] == pres.get("project") else ""
        rows.append(f"- {p['name']} (id {p['id']}): {p['shots']} shots, {p['seconds']}s, {p['aspect']}{mark}")
    return "\n".join(rows)


def t_get_selection(_):
    pres = presence()
    if not pres.get("project"):
        return "Nothing is open in Storyboard right now."
    p = load(pres["project"])
    out = [f"Project: {p.get('name')} (id {p['id']}) · view: {pres.get('view') or '?'}"]
    if pres.get("shot"):
        try:
            scene, shot = find_shot(p, pres["shot"])
            out.append(f"Selected shot: {code(scene, shot)}")
            if pres.get("version"):
                v = next((x for x in versions_of(p, shot["id"]) if x["id"] == pres["version"]), None)
                if v:
                    out.append(f"Selected version: v{v.get('label')} ({VERSION_STATUS.get(v.get('status'))}, {len(open_marks(v))} open notes)")
            out.append("")
            out.append(shot_line(p, scene, shot, 1000))
        except ToolError:
            pass
    else:
        out.append("No shot selected.")
    return "\n".join(out)


def t_get_board(args):
    p = load(resolve_project(args.get("project")))
    s = p["settings"]
    only = find_scene(p, args["scene"]) if args.get("scene") else None
    many = sum(len(sc.get("shots", [])) for sc in p["scenes"]) > 80
    out = [f"# {p.get('name')} (id {p['id']})",
           f"aspect {s.get('aspect', '16:9')} · {s.get('fps', '24')} fps"
           + (f" · look: {s['look']}" if s.get("look") else "")
           + (f" · negative: {s['negative']}" if s.get("negative") else "")]
    total = 0.0
    for scene in p["scenes"]:
        if only and scene is not only:
            continue
        shots = scene.get("shots", [])
        dur = sum(float(x.get("duration") or 0) for x in shots)
        total += dur
        out.append(f"\n## {scene_code(scene)} {scene.get('title') or '(untitled)'} · {len(shots)} shots · {dur:g}s")
        if scene.get("synopsis"):
            out.append(f"synopsis: {scene['synopsis']}")
        for shot in shots:
            out.append(shot_line(p, scene, shot, 120 if many else 260))
    if not only:
        out.append(f"\nTotal runtime {total:g}s.")
        for b in p["boards"]:
            notes = [clip(i.get("text"), 160) for i in b.get("items", []) if i.get("type") in ("note", "text") and i.get("text")]
            images = sum(1 for i in b.get("items", []) if i.get("type") in ("image", "video"))
            sections = [i.get("title") for i in b.get("items", []) if i.get("type") == "section"]
            swatches = [i.get("color") for i in b.get("items", []) if i.get("type") == "swatch"]
            out.append(f"\nMoodboard “{b.get('name')}”: {images} images/clips"
                       + (f", sections: {', '.join(sections)}" if sections else "")
                       + (f", colors: {' '.join(swatches[:12])}" if swatches else ""))
            for n in notes[:25]:
                out.append(f"  - {n}")
    return "\n".join(out)


def t_get_shot(args):
    p = load(resolve_project(args.get("project")))
    scene, shot = find_shot(p, args.get("shot"))
    out = [f"{code(scene, shot)} in {scene_code(scene)} “{scene.get('title') or ''}”", shot_line(p, scene, shot, 4000)]
    for key in ("negative", "notes", "seed", "model"):
        if shot.get(key):
            out.append(f"    {key}: {shot[key]}")
    if shot.get("refs"):
        out.append(f"    {len(shot['refs'])} reference image(s) attached")
    out.append("\nVersion tree:")
    out.append(tree_text(p, shot))
    return "\n".join(out)


def t_get_feedback(args):
    p = load(resolve_project(args.get("project")))
    only = find_shot(p, args["shot"])[1] if args.get("shot") else None
    out = []
    for scene, shot in all_shots(p):
        if only and shot is not only:
            continue
        for v in versions_of(p, shot["id"]):
            marks = open_marks(v)
            if not marks:
                continue
            out.append(f"{code(scene, shot)} v{v.get('label')} ({VERSION_STATUS.get(v.get('status'))})"
                       + (" · marked-up image available via view_images" if v.get("markedSrc") else ""))
            if v.get("prompt"):
                out.append(f"  made with prompt: {clip(v['prompt'], 600)}")
            if v.get("note"):
                out.append(f"  overall note: {v['note']}")
            for m in marks:
                out.append(f"  #{m.get('n')} {region(m)}: {m.get('note') or '(no text)'}")
    return "\n".join(out) if out else "No open notes. Everything marked up has been resolved."


def t_view_images(args):
    pid = resolve_project(args.get("project"))
    p = load(pid)
    scene, shot = find_shot(p, args.get("shot"))
    wanted = args.get("versions") or []
    annotated = args.get("annotated", True)
    items = []
    if not wanted:
        if shot.get("frame"):
            items.append((f"{code(scene, shot)} current frame", shot["frame"]["src"], shot["frame"].get("kind")))
        else:
            wanted = [v.get("label") for v in versions_of(p, shot["id"]) if v.get("media")][:4]
    for ref in wanted[:6]:
        if str(ref).lower() == "frame":
            if shot.get("frame"):
                items.append((f"{code(scene, shot)} current frame", shot["frame"]["src"], shot["frame"].get("kind")))
            continue
        v = find_version(p, shot, str(ref))
        if not v.get("media"):
            items.append((f"v{v.get('label')}: no image yet (prompt only)", None, None))
            continue
        src = v["markedSrc"] if annotated and v.get("markedSrc") else v["media"]["src"]
        label = f"{code(scene, shot)} v{v.get('label')}" + (" with the user's marks (numbered)" if src == v.get("markedSrc") else "")
        items.append((label, src, v["media"].get("kind")))
    if not items:
        raise ToolError("This shot has no frame or version images yet.")
    size = 1024 if len(items) == 1 else 768
    content = []
    for label, src, kind in items:
        content.append({"type": "text", "text": label + (" (first frame of a clip)" if kind == "video" else "")})
        if not src:
            continue
        data = http("GET", f"/api/projects/{pid}/preview?src={urllib.parse.quote(src)}&max={size}", raw=True)
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg" if data[:2] == b"\xff\xd8" else \
            "image/webp" if data[8:12] == b"WEBP" else "image/gif" if data[:3] == b"GIF" else "image/jpeg"
        content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime})
    return content


def shot_fields(args):
    keys = ["action", "dialogue", "size", "angle", "move", "lens", "duration", "transition", "prompt", "negative", "notes", "status"]
    out = {k: args[k] for k in keys if k in args and args[k] is not None}
    if "duration" in out:
        out["duration"] = max(0.1, round(float(out["duration"]), 2))
    return out


def new_shot(p, fields):
    s = {"id": uid("sh_"), "number": 10, "frame": None, "action": "", "dialogue": "", "size": "", "angle": "",
         "move": "", "lens": "", "duration": float(p["settings"].get("duration") or 3), "transition": "Cut",
         "prompt": "", "negative": "", "seed": "", "takes": "", "model": "", "status": "idea", "notes": "", "refs": []}
    s.update(fields)
    return s


def number_between(before, after):
    if after is None:
        return before // 10 * 10 + 10
    if after - before >= 2:
        mid = (before + after) // 2
        r5 = round(mid / 5) * 5
        return r5 if before < r5 < after else mid
    return None


def t_update_shot(args):
    pid = resolve_project(args.get("project"))
    fields = shot_fields(args)
    if not fields:
        raise ToolError("Nothing to change. Pass at least one field.")

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        shot.update(fields)
        touched.append(shot["id"])
        return f"Updated {code(scene, shot)}: {', '.join(fields)}."
    return edit(pid, fn, f"updated {args.get('shot')} ({', '.join(fields)})")


def insertion_point(p, args):
    """(scene, index) for new shots: after args.after, else at the end of args.scene or the last scene."""
    if args.get("after"):
        scene, after = find_shot(p, args["after"])
        return scene, scene["shots"].index(after) + 1
    scene = find_scene(p, args.get("scene") or "") if args.get("scene") else (p["scenes"][-1] if p["scenes"] else None)
    if scene is None:
        scene = {"id": uid("sc_"), "number": 1, "title": "", "synopsis": "", "collapsed": False, "shots": []}
        p["scenes"].append(scene)
    return scene, len(scene["shots"])


def insert_shot(scene, index, shot):
    before = scene["shots"][index - 1]["number"] if index > 0 else 0
    after_n = scene["shots"][index]["number"] if index < len(scene["shots"]) else None
    n = number_between(before, after_n)
    scene["shots"].insert(index, shot)
    if n is None:
        for i, s in enumerate(scene["shots"]):
            s["number"] = (i + 1) * 10
    else:
        shot["number"] = n


def t_add_shots(args):
    pid = resolve_project(args.get("project"))
    specs = args.get("shots") or []
    if not specs:
        raise ToolError("Pass at least one shot.")

    def fn(p, touched):
        scene, index = insertion_point(p, args)
        made = []
        for spec in specs:
            shot = new_shot(p, shot_fields(spec))
            insert_shot(scene, index, shot)
            index += 1
            made.append(shot)
            touched.append(shot["id"])
        return f"Added {len(made)} shot(s) in {scene_code(scene)}: " + ", ".join(code(scene, s) for s in made)
    return edit(pid, fn, f"added {len(specs)} shot{'s' if len(specs) != 1 else ''}")


def t_delete_shot(args):
    pid = resolve_project(args.get("project"))

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        scene["shots"].remove(shot)
        return f"Deleted {code(scene, shot)}. The user can undo this in Storyboard."
    return edit(pid, fn, f"deleted {args.get('shot')}")


def t_add_scene(args):
    pid = resolve_project(args.get("project"))

    def fn(p, touched):
        num = max([int(s.get("number", 0)) for s in p["scenes"]] or [0]) + 1
        scene = {"id": uid("sc_"), "number": num, "title": args.get("title", ""), "synopsis": args.get("synopsis", ""),
                 "collapsed": False, "shots": []}
        if args.get("after_scene"):
            at = p["scenes"].index(find_scene(p, args["after_scene"])) + 1
        else:
            at = len(p["scenes"])
        p["scenes"].insert(at, scene)
        for i, spec in enumerate(args.get("shots") or [{}]):
            shot = new_shot(p, shot_fields(spec))
            shot["number"] = (i + 1) * 10
            scene["shots"].append(shot)
            touched.append(shot["id"])
        touched.append(scene["id"])
        return f"Added {scene_code(scene)} “{scene['title']}” with shots " + ", ".join(code(scene, s) for s in scene["shots"])
    return edit(pid, fn, f"added scene “{args.get('title', '')}”")


def t_update_scene(args):
    pid = resolve_project(args.get("project"))

    def fn(p, touched):
        scene = find_scene(p, args.get("scene"))
        for k in ("title", "synopsis"):
            if args.get(k) is not None:
                scene[k] = args[k]
        touched.append(scene["id"])
        return f"Updated {scene_code(scene)}."
    return edit(pid, fn, f"updated scene {args.get('scene')}")


def t_create_version(args):
    pid = resolve_project(args.get("project"))
    if not (args.get("prompt") or "").strip():
        raise ToolError("A new version needs a prompt.")

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        parent = None
        if args.get("parent"):
            parent = find_version(p, shot, args["parent"])
        else:
            vs = versions_of(p, shot["id"])
            pres = presence()
            parent = next((v for v in vs if v["id"] == pres.get("version")), None) \
                or next((v for v in vs if v.get("status") == "picked"), None) \
                or max(vs, key=lambda v: v.get("created", 0), default=None)
        v = new_version(p, shot, parent, prompt=args["prompt"].strip(), note=args.get("note", ""), by="claude")
        touched += [v["id"], shot["id"]]
        resolved = []
        if parent and args.get("resolves"):
            for m in parent.get("marks", []):
                if m.get("n") in args["resolves"]:
                    m["done"] = True
                    m["reply"] = m.get("reply") or f"Addressed in v{v['label']}."
                    resolved.append(f"#{m['n']}")
            if parent.get("status") == "new":
                parent["status"] = "rework"
        where = f" under v{parent['label']}" if parent else " as a new first reference"
        msg = f"Created {code(scene, shot)} v{v['label']}{where} with your prompt. It's waiting for the user to generate it and drop the image on it."
        if resolved:
            msg += f" Marked notes {', '.join(resolved)} on v{parent['label']} as resolved."
        return msg
    return edit(pid, fn, f"wrote a new version for {args.get('shot')}")


def t_update_version(args):
    pid = resolve_project(args.get("project"))

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        v = find_version(p, shot, args.get("version"))
        changed = []
        for k in ("prompt", "note"):
            if args.get(k) is not None:
                v[k] = args[k]
                changed.append(k)
        st = args.get("status")
        if st:
            if st == "picked":
                pick_version(p, shot, v, touched)
            v["status"] = st
            changed.append(f"status {VERSION_STATUS[st]}")
        touched.append(v["id"])
        return f"Updated {code(scene, shot)} v{v.get('label')}: {', '.join(changed) or 'nothing'}."
    return edit(pid, fn, f"updated {args.get('shot')} v{str(args.get('version', '')).lstrip('v')}")


def t_reply_to_notes(args):
    pid = resolve_project(args.get("project"))

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        v = find_version(p, shot, args.get("version"))
        done = []
        for r in args.get("replies") or []:
            m = next((x for x in v.get("marks", []) if x.get("n") == r.get("note")), None)
            if not m:
                continue
            if r.get("reply"):
                m["reply"] = r["reply"]
            if r.get("resolved") is not None:
                m["done"] = bool(r["resolved"])
            done.append(f"#{m['n']}")
        touched.append(v["id"])
        return f"Replied to {', '.join(done) or 'no matching notes'} on {code(scene, shot)} v{v.get('label')}."
    return edit(pid, fn, f"answered notes on {args.get('shot')}")


def t_add_moodboard_notes(args):
    pid = resolve_project(args.get("project"))
    texts = [t for t in (args.get("notes") or []) if str(t).strip()]
    if not texts:
        raise ToolError("Pass at least one note.")
    color = args.get("color") or "purple"

    def fn(p, touched):
        boards = p["boards"]
        if not boards:
            boards.append({"id": uid("bd_"), "name": "Moodboard", "items": [], "links": [], "view": {"x": 0, "y": 0, "z": 1}})
        board = boards[0]
        if args.get("board"):
            key = args["board"].lower()
            board = next((b for b in boards if key in (b.get("name") or "").lower()), board)
        items = board.setdefault("items", [])
        right = max([i.get("x", 0) + i.get("w", 0) for i in items] or [0]) + 80
        top = min([i.get("y", 0) for i in items] or [0])
        for k, text in enumerate(texts):
            item = {"id": uid("it_"), "type": "note", "x": right + (k % 2) * 240, "y": top + (k // 2) * 170,
                    "w": 220, "h": 150, "text": str(text)[:2000], "color": color}
            items.append(item)
            touched.append(item["id"])
        return f"Added {len(texts)} sticky note(s) to the “{board.get('name')}” moodboard."
    return edit(pid, fn, f"added {len(texts)} moodboard note{'s' if len(texts) != 1 else ''}")


def t_create_project(args):
    name = (args.get("name") or "").strip()
    if not name:
        raise ToolError("A new project needs a name.")
    tpl = args.get("template") or "blank"
    if tpl not in TEMPLATES:
        raise ToolError(f"Template must be one of {', '.join(TEMPLATES)}.")
    tpl_duration, tpl_scenes = TEMPLATES[tpl]
    settings = {"aspect": "16:9", "fps": "24", "width": 1920, "height": 1080, "duration": tpl_duration or 3,
                "look": "", "negative": "", "takes": 1, "music": None}
    settings_from(args, settings)
    p = {"version": 1, "settings": settings, "scenes": [], "boards": starter_boards(), "versions": []}
    specs = args.get("scenes") or [{"title": t, "synopsis": syn, "shots": [{}] * n} for t, syn, n in tpl_scenes]
    for i, spec in enumerate(specs):
        scene = {"id": uid("sc_"), "number": i + 1, "title": spec.get("title", ""), "synopsis": spec.get("synopsis", ""),
                 "collapsed": False, "shots": []}
        for k, shot_spec in enumerate(spec.get("shots") or [{}]):
            shot = new_shot(p, shot_fields(shot_spec))
            shot["number"] = (k + 1) * 10
            scene["shots"].append(shot)
        p["scenes"].append(scene)
    made = http("POST", "/api/projects", {"name": name, "project": p})
    shots = sum(len(sc["shots"]) for sc in p["scenes"])
    msg = f"Created project “{made['name']}” (id {made['id']}): {len(p['scenes'])} scene(s), {shots} shot(s), {settings['aspect']} at {settings['fps']} fps."
    if args.get("open"):
        msg += " It's open in Storyboard now." if open_in_app(made["id"]) else \
            " Storyboard isn't open in a browser window, so the user will find it on the home screen."
    else:
        msg += f" Pass project “{made['name']}” to other tools to work on it (it isn't the open project)."
    return msg


def t_update_project(args):
    pid = resolve_project(args.get("project"))
    new_name = (args.get("name") or "").strip()

    def fn(p, touched):
        changed = settings_from(args, p["settings"])
        if new_name:
            old = p.get("name")
            p["name"] = new_name[:120]
            changed.insert(0, f"name (was “{old}”)")
        if not changed:
            raise ToolError("Nothing to change. Pass a new name or a setting.")
        return f"Updated project “{p['name']}”: {', '.join(changed)}."
    summary = f"renamed the project to “{new_name}”" if new_name else "changed the project settings"
    return edit(pid, fn, summary)


def t_open_project(args):
    if not args.get("project"):
        raise ToolError("Name the project to open (see list_projects).")
    pid = resolve_project(args["project"])
    name = load(pid).get("name")
    if not open_in_app(pid):
        return (f"Storyboard isn't open in a browser window. Ask the user to open http://127.0.0.1:8765 "
                f"(or the Storyboard app) and pick “{name}”.")
    return f"Opened “{name}” in Storyboard."


def t_add_media_to_shot(args):
    pid = resolve_project(args.get("project"))
    p = load(pid)  # check the names before downloading anything
    _, shot = find_shot(p, args.get("shot"))
    for key in ("version", "parent"):
        if args.get(key):
            find_version(p, shot, args[key])
    refs, problems = gather(pid, args.get("sources"))

    def fn(p, touched):
        scene, shot = find_shot(p, args.get("shot"))
        target = find_version(p, shot, args["version"]) if args.get("version") else None
        if target and target.get("media"):
            raise ToolError(f"v{target['label']} already has an image. To add variations of it, "
                            f"pass parent \"{target['label']}\" instead of version.")
        if target:
            parent = next((v for v in p["versions"] if v["id"] == target.get("parent")), None)
        else:
            parent = find_version(p, shot, args["parent"]) if args.get("parent") else None
        prompt = args.get("prompt") or (target or {}).get("prompt") or ""
        made, todo = [], list(refs)
        if target:
            target["media"] = media_ref(todo.pop(0))
            target["prompt"] = target.get("prompt") or prompt
            target["note"] = target.get("note") or args.get("note", "")
            made.append(target)
        for i, r in enumerate(todo):
            made.append(new_version(p, shot, parent, media=media_ref(r), prompt=prompt,
                                    note=args.get("note", ""), created=now_ms() + i))
        nothing_picked = not shot.get("frame") and not any(v.get("status") == "picked" for v in versions_of(p, shot["id"]))
        if args.get("pick") or nothing_picked:
            pick_version(p, shot, made[0], touched)
        touched += [v["id"] for v in made] + [shot["id"]]
        labels = ", ".join(f"v{v['label']}" for v in made)
        where = f"under v{parent['label']}" if parent else "as first references"
        msg = f"Added {len(made)} image(s)/clip(s) to {code(scene, shot)}: {labels} ({'filled' if target else where})."
        if made[0].get("status") == "picked":
            msg += f" v{made[0]['label']} is now the shot's frame."
        return done_msg(msg, problems)
    return edit(pid, fn, f"added {len(refs)} image{'s' if len(refs) != 1 else ''} to {args.get('shot')}")


def t_add_shots_from_media(args):
    pid = resolve_project(args.get("project"))
    insertion_point(load(pid), args)
    refs, problems = gather(pid, args.get("sources"))

    def fn(p, touched):
        scene, index = insertion_point(p, args)
        made = []
        for i, r in enumerate(refs):
            shot = new_shot(p, {"frame": None, "status": "idea"})
            insert_shot(scene, index + i, shot)
            v = new_version(p, shot, None, media=media_ref(r), created=now_ms() + i)
            pick_version(p, shot, v, touched)
            made.append(shot)
            touched += [shot["id"], v["id"]]
        return done_msg(f"Added {len(made)} shot(s) in {scene_code(scene)}, one per image/clip: "
                        + ", ".join(code(scene, s) for s in made), problems)
    return edit(pid, fn, f"added {len(refs)} shot{'s' if len(refs) != 1 else ''} from images")


def t_add_media_to_moodboard(args):
    pid = resolve_project(args.get("project"))
    refs, problems = gather(pid, args.get("sources"))

    def fn(p, touched):
        boards = p["boards"]
        if not boards:
            boards.append({"id": uid("bd_"), "name": "Moodboard", "items": [], "links": [], "view": {"x": 0, "y": 0, "z": 1}})
        board = boards[0]
        if args.get("board"):
            key = args["board"].lower()
            board = next((b for b in boards if key in (b.get("name") or "").lower()), board)
        items = board.setdefault("items", [])
        sec = None
        if args.get("section"):
            key = args["section"].lower()
            sec = next((i for i in items if i.get("type") == "section" and key in (i.get("title") or "").lower()), None)
        cols = min(4, math.ceil(math.sqrt(len(refs))))
        if sec:
            def inside(i):
                cx, cy = i.get("x", 0) + i.get("w", 0) / 2, i.get("y", 0) + i.get("h", 0) / 2
                return sec["x"] <= cx <= sec["x"] + sec["w"] and sec["y"] <= cy <= sec["y"] + sec["h"]
            below = max([i["y"] + i.get("h", 0) for i in items if i is not sec and i.get("type") != "section" and inside(i)]
                        or [sec["y"] + 32])
            room = sec["w"] - 48
            new = lay_out(refs, sec["x"] + 24, below + 24, room, box=max(120, min(320, (room - 24) // 2)))
            bottom = max(i["y"] + i["h"] for i in new) + 24
            grow = bottom - (sec["y"] + sec["h"])
            if grow > 0:  # make room: push whatever sits under the section down
                edge = sec["y"] + sec["h"]
                for i in items:
                    if i is not sec and i.get("y", 0) >= edge - 1 and i.get("x", 0) < sec["x"] + sec["w"] and i.get("x", 0) + i.get("w", 0) > sec["x"]:
                        i["y"] += grow
                sec["h"] += grow
            touched.append(sec["id"])
        else:
            right = max([i.get("x", 0) + i.get("w", 0) for i in items] or [0]) + 80
            top = min([i.get("y", 0) for i in items] or [0])
            new = lay_out(refs, right, top, cols * 344)
        items.extend(new)
        touched += [i["id"] for i in new]
        where = f"the “{sec.get('title')}” section of " if sec else ""
        msg = f"Added {len(new)} image(s)/clip(s) to {where}the “{board.get('name')}” moodboard."
        if args.get("section") and not sec:
            msg += f" There's no section called “{args['section']}”, so they went to the right of everything else."
        return done_msg(msg, problems)
    return edit(pid, fn, f"added {len(refs)} image{'s' if len(refs) != 1 else ''} to the moodboard")


PROJECT = {"type": "string", "description": "Project name or id. Omit to use the project open in Storyboard."}
PROJECT_SETTINGS = {
    "aspect": {"type": "string", "enum": list(ASPECTS)},
    "fps": {"type": "string", "enum": FPS},
    "duration": {"type": "number", "description": "Default length of new shots, in seconds."},
    "look": {"type": "string", "description": "Look/style prefix added to every prompt."},
    "negative": {"type": "string", "description": "Default negative prompt."},
}
SOURCES = {"type": "array", "items": {"type": "string"},
           "description": "Web links (https://…) to images or clips, or full paths on this computer to files or folders "
                          "(/Users/…/frame.png, ~/Downloads/renders/). A folder adds every image and clip in it, by name."}
SHOT = {"type": "string", "description": "Shot code like SC01_SH020, or \"selected\" for the shot selected in Storyboard."}
VERSION = {"type": "string", "description": "Version label like 1.2, or \"selected\" or \"picked\"."}
SHOT_PROPS = {
    "action": {"type": "string", "description": "What we see in the shot."},
    "dialogue": {"type": "string", "description": "Dialogue, voice-over or on-screen text."},
    "size": {"type": "string", "enum": SIZES + [""], "description": "Shot size."},
    "angle": {"type": "string", "enum": ANGLES + [""]},
    "move": {"type": "string", "enum": MOVES + [""], "description": "Camera movement."},
    "lens": {"type": "string", "description": "e.g. 35mm, 85mm, Anamorphic."},
    "duration": {"type": "number", "description": "Length in seconds."},
    "transition": {"type": "string", "enum": TRANSITIONS, "description": "Transition into this shot."},
    "prompt": {"type": "string", "description": "Text-to-video/image prompt for this shot (without the project look, which is added automatically)."},
    "negative": {"type": "string"},
    "notes": {"type": "string", "description": "Production notes."},
    "status": {"type": "string", "enum": list(SHOT_STATUS), "description": "idea, prompt (ready), generated, approved, edit (in the edit)."},
}


def tool(name, description, props=None, required=None, fn=None, readonly=True):
    return {"name": name, "description": description, "fn": fn,
            "inputSchema": {"type": "object", "properties": props or {}, "required": required or []},
            "annotations": {"readOnlyHint": readonly, "destructiveHint": name == "delete_shot", "openWorldHint": False}}


TOOLS = [
    tool("list_projects", "List the user's Storyboard projects, marking the one open in the app.", fn=t_list_projects),
    tool("get_selection", "What the user has open and selected in Storyboard right now (project, view, shot, version). Use when they say \"this shot\".", fn=t_get_selection),
    tool("get_board", "Read a project's storyboard: settings and look, every scene and shot (camera, action, dialogue, prompt, status, versions, open notes), and moodboard notes.",
         {"project": PROJECT, "scene": {"type": "string", "description": "Optional: only this scene, e.g. SC02."}}, fn=t_get_board),
    tool("get_shot", "Read one shot in full, including its version tree with prompts, statuses and the user's mark-up notes.",
         {"project": PROJECT, "shot": SHOT}, ["shot"], fn=t_get_shot),
    tool("get_feedback", "List every open mark-up note (what to change, where on the image), across the project or for one shot.",
         {"project": PROJECT, "shot": {**SHOT, "description": "Optional: only this shot."}}, fn=t_get_feedback),
    tool("view_images", "Look at a shot's images: its current frame, or chosen versions. Versions the user marked up are shown with their numbered marks drawn on.",
         {"project": PROJECT, "shot": SHOT,
          "versions": {"type": "array", "items": {"type": "string"}, "description": "Version labels like [\"1\", \"1.2\"], or [\"frame\"]. Omit for the frame (or the first versions)."},
          "annotated": {"type": "boolean", "description": "Show marked-up snapshots where they exist (default true)."}}, ["shot"], fn=t_view_images),
    tool("update_shot", "Change fields of a shot (action, dialogue, camera, length, prompt, status…).",
         {"project": PROJECT, "shot": SHOT, **SHOT_PROPS}, ["shot"], fn=t_update_shot, readonly=False),
    tool("add_shots", "Add one or more shots, after a given shot or at the end of a scene.",
         {"project": PROJECT, "after": {"type": "string", "description": "Insert after this shot code."},
          "scene": {"type": "string", "description": "Or: add at the end of this scene, e.g. SC02."},
          "shots": {"type": "array", "items": {"type": "object", "properties": SHOT_PROPS}, "description": "The shots to add, in order."}},
         ["shots"], fn=t_add_shots, readonly=False),
    tool("delete_shot", "Delete a shot. Only when the user asks for it.", {"project": PROJECT, "shot": SHOT}, ["shot"], fn=t_delete_shot, readonly=False),
    tool("add_scene", "Add a scene, optionally with shots.",
         {"project": PROJECT, "title": {"type": "string"}, "synopsis": {"type": "string"},
          "after_scene": {"type": "string", "description": "Insert after this scene, e.g. SC02. Default: at the end."},
          "shots": {"type": "array", "items": {"type": "object", "properties": SHOT_PROPS}}}, ["title"], fn=t_add_scene, readonly=False),
    tool("update_scene", "Rename a scene or change its synopsis.",
         {"project": PROJECT, "scene": {"type": "string", "description": "e.g. SC02"}, "title": {"type": "string"}, "synopsis": {"type": "string"}},
         ["scene"], fn=t_update_scene, readonly=False),
    tool("create_version", "Add the next variation to a shot's version tree: a new version (by Claude) carrying the prompt to generate. Use it to answer mark-up notes.",
         {"project": PROJECT, "shot": SHOT,
          "parent": {**VERSION, "description": "The version this one improves on. Default: the selected, else picked, else latest version."},
          "prompt": {"type": "string", "description": "Complete prompt for the new variation, ready to paste into Higgsfield."},
          "note": {"type": "string", "description": "Short note on what changed and why."},
          "resolves": {"type": "array", "items": {"type": "integer"}, "description": "Note numbers on the parent that this version addresses."}},
         ["shot", "prompt"], fn=t_create_version, readonly=False),
    tool("update_version", "Change a version's status (new/Exploring, rework, option, picked), prompt or note. Picking makes it the shot's frame.",
         {"project": PROJECT, "shot": SHOT, "version": VERSION,
          "status": {"type": "string", "enum": list(VERSION_STATUS)}, "prompt": {"type": "string"}, "note": {"type": "string"}},
         ["shot", "version"], fn=t_update_version, readonly=False),
    tool("reply_to_notes", "Answer the user's numbered mark-up notes on a version, optionally marking them resolved.",
         {"project": PROJECT, "shot": SHOT, "version": VERSION,
          "replies": {"type": "array", "items": {"type": "object", "properties": {
              "note": {"type": "integer", "description": "Note number"}, "reply": {"type": "string"}, "resolved": {"type": "boolean"}},
              "required": ["note"]}}},
         ["shot", "version", "replies"], fn=t_reply_to_notes, readonly=False),
    tool("add_moodboard_notes", "Put sticky notes on a moodboard (ideas, references to find, palette thoughts).",
         {"project": PROJECT, "notes": {"type": "array", "items": {"type": "string"}},
          "board": {"type": "string", "description": "Moodboard name. Default: the first board."},
          "color": {"type": "string", "enum": ["yellow", "orange", "pink", "purple", "blue", "green", "gray"]}},
         ["notes"], fn=t_add_moodboard_notes, readonly=False),
    tool("add_media_to_shot", "Put images or clips into a shot's version tree: as first references, as variations under a version, or as the image for a version that has none yet (like one you wrote with create_version). The first one becomes the frame if the shot has none.",
         {"project": PROJECT, "shot": SHOT, "sources": SOURCES,
          "version": {**VERSION, "description": "Fill this version, which has no image yet. Extra sources become its siblings."},
          "parent": {**VERSION, "description": "Add the images as variations under this version."},
          "pick": {"type": "boolean", "description": "Make the first one the picked version and the shot's frame."},
          "prompt": {"type": "string", "description": "The prompt the images were made with, if known."},
          "note": {"type": "string"}},
         ["shot", "sources"], fn=t_add_media_to_shot, readonly=False),
    tool("add_shots_from_media", "Make one new shot per image or clip, with it as the shot's frame. Added after a given shot or at the end of a scene.",
         {"project": PROJECT, "sources": SOURCES,
          "after": {"type": "string", "description": "Insert after this shot code."},
          "scene": {"type": "string", "description": "Or: add at the end of this scene, e.g. SC02."}},
         ["sources"], fn=t_add_shots_from_media, readonly=False),
    tool("add_media_to_moodboard", "Put images or clips on a moodboard, optionally inside one of its sections (e.g. Locations).",
         {"project": PROJECT, "sources": SOURCES,
          "board": {"type": "string", "description": "Moodboard name. Default: the first board."},
          "section": {"type": "string", "description": "Section title to place them in; it grows to fit."}},
         ["sources"], fn=t_add_media_to_moodboard, readonly=False),
    tool("create_project", "Create a new Storyboard project, from a template or with your own scenes and shots (e.g. broken down from a script).",
         {"name": {"type": "string"},
          "template": {"type": "string", "enum": list(TEMPLATES), "description": "Starting scenes when you don't pass scenes: blank, commercial (30-second spot), music (music video), short (short film)."},
          "scenes": {"type": "array", "description": "Scenes in order; overrides the template's.", "items": {"type": "object", "properties": {
              "title": {"type": "string"}, "synopsis": {"type": "string"},
              "shots": {"type": "array", "items": {"type": "object", "properties": SHOT_PROPS}}}}},
          **PROJECT_SETTINGS,
          "open": {"type": "boolean", "description": "Show it in the user's Storyboard window now."}},
         ["name"], fn=t_create_project, readonly=False),
    tool("update_project", "Rename a project or change its settings: aspect ratio, frame rate, default shot length, look/style prefix (added to every prompt) and default negative prompt.",
         {"project": PROJECT, "name": {"type": "string", "description": "New name."}, **PROJECT_SETTINGS},
         fn=t_update_project, readonly=False),
    tool("open_project", "Show a project in the user's Storyboard window.",
         {"project": {"type": "string", "description": "Project name or id."}}, ["project"], fn=t_open_project, readonly=False),
]
BY_NAME = {t["name"]: t for t in TOOLS}


# --- MCP over stdio -------------------------------------------------------------

def send(obj):
    # ASCII-only JSON on the raw byte stream: works whatever locale the
    # Claude app starts us with.
    sys.stdout.buffer.write((json.dumps(obj) + "\n").encode("ascii"))
    sys.stdout.buffer.flush()


def call(name, args):
    t = BY_NAME.get(name)
    if not t:
        return {"content": [{"type": "text", "text": f"Unknown tool {name}"}], "isError": True}
    try:
        result = t["fn"](args or {})
        content = result if isinstance(result, list) else [{"type": "text", "text": str(result)}]
        return {"content": content, "isError": False}
    except ToolError as e:
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    except Exception as e:  # noqa: BLE001 - report, never crash the connector
        return {"content": [{"type": "text", "text": f"Storyboard connector error: {e}"}], "isError": True}


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        asked = str(params.get("protocolVersion") or "")
        result = {"protocolVersion": asked if asked >= "2024-11-05" else "2024-11-05",
                  "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": "storyboard", "title": "Storyboard", "version": "1.0.0"},
                  "instructions": INSTRUCTIONS}
    elif method == "tools/list":
        result = {"tools": [{k: v for k, v in t.items() if k != "fn"} for t in TOOLS]}
    elif method == "tools/call":
        result = call(params.get("name"), params.get("arguments"))
    elif method == "ping":
        result = {}
    elif mid is None:
        return  # notifications need no answer
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
        return
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def main():
    sys.stderr.write(f"Storyboard connector ready (Python {sys.version.split()[0]}, talking to {BASE})\n")
    sys.stderr.flush()
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            try:
                handle(m)
            except Exception as e:  # noqa: BLE001
                if m.get("id") is not None:
                    send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32603, "message": str(e)}})


if __name__ == "__main__":
    main()
