# Storyboard

Storyboard is a storyboard, moodboard and animatic app that runs on your Mac.
It works in your browser, but nothing goes online. Each project is an ordinary
folder in `~/Documents/Storyboards`.

| Tab | What it's for |
|---|---|
| **Storyboard** | Scenes made of shot cards. Each shot has a frame (still or clip), action, dialogue, size, angle, move, lens, length, transition, an AI prompt, references and notes. |
| **Moodboard** | An infinite canvas for reference stills, clips, sticky notes, headings, color swatches, links and arrows between ideas. A project can have several boards. |
| **Animatic** | Plays the board at each shot's length, with simulated camera moves on stills, dissolves and fades, dialogue captions and a temp music track. Drag a clip's edge in the timeline to retime it. |

It ties into the rest of this repo. A board exports a `shots.csv` that
`ai-footage/gen_clip.py batch` reads. The takes that generates show up on the
matching shot. The finished board goes to Premiere Pro as a sequence.

## Start it

You only need Python 3 (see the main README's Mac setup). There's nothing else to install.

**Option A: a real app in your Dock.** In Terminal, run this once:

```bash
cd premiere-pro/storyboard
./make-mac-app.sh
```

This creates `~/Applications/Storyboard.app`. Open it and drag it to the Dock.
Opening it starts Storyboard in the background and opens it in your browser.
To stop it, click **Quit Storyboard** at the bottom of the home screen. If you
move the `premiere-pro` folder, run `./make-mac-app.sh` again.

**Option B: double-click `Storyboard.command`** in Finder. A Terminal window
opens. Keep it open while you work, and close it to stop Storyboard. If macOS
says the file can't be opened, right-click it and choose **Open** the first time.

**Option C: Terminal.** Run `python3 storyboard/server.py`. It accepts these flags:
`--port 9000`, `--data ~/Dropbox/Storyboards` (another projects folder) and
`--no-browser`.

Storyboard runs at **http://127.0.0.1:8765**. Chrome, Safari and Arc all work.
In Chrome you can also choose **⋮ › Cast, save and share › Install page as app**
to give Storyboard its own window.

## A typical Higgsfield workflow

1. **Moodboard first.** Drag in stills from Finder, images straight from web
   pages (Pinterest, film-grab sites…), or paste screenshots with ⌘V. Group
   them in sections. To get a palette, select a still and click
   *Extract palette*. Double-click empty canvas to add a sticky note. Drag the
   round handle on a selected item onto another item to connect them with an
   arrow, for mapping out ideas.
2. **Rough the board.** On the Storyboard tab, drop a batch of stills onto a
   scene to get one shot per image. You can also select images on the
   moodboard and click *Make shots*. Press **N** for an empty shot.
3. **Describe each shot.** Fill in the action plus size, angle, move and lens.
   Click **Build** to turn those fields into a prompt, then edit it. Set
   the project's *Look / style prefix* in ⚙ Project settings (for example
   "35mm film, teal-orange grade, anamorphic"). It's added to the front of every
   prompt, so all shots match.
4. **Generate.** Select a shot and press **⌘C** (or click *Copy*), then paste
   into Higgsfield. To use references, drag them from the shot's References
   section or click *Finder* to drag the file from there. Set the status to
   *Prompt ready* or *Generated* as you go.
5. **Bring takes back.** Drop the downloaded clip onto the shot's card or its
   inspector, and it becomes the shot's frame. If you drop several clips onto
   one card, the extra ones become new shots right after it. A shot with a clip
   moves to *Generated* automatically.
6. **Time it.** On the Animatic tab, add temp music (drag the waveform to slip
   it), press Space to play, and drag clip edges to retime shots.
7. **Hand off.** Use **Export › Premiere Pro animatic (XML)**, then in
   Premiere use *File › Import*.

## Exports

| Export | Result |
|---|---|
| **Premiere Pro animatic (XML)** | A sequence with every shot at its length, plus a sequence marker per shot carrying its action and dialogue. Each clip's prompt goes in its *Description* column. The temp music goes on A1. Shots without a frame get a text slate. Media is linked from `exports/premiere/` under shot names such as `SC01_SH010.png`, so the bin reads like a shot list. Stills import at their own size, so select the clips and use *Set to Frame Size*. |
| **Shot list for gen_clip.py (CSV)** | `exports/shots.csv` in the format `gen_clip.py batch` expects: full prompt, negative, seed, whole-second length, aspect and takes. The dialog shows the exact command to run. Shots with no prompt or description are left out. |
| **Storyboard PDF** | A print view with 3, 4, 6, 9 or 12 shots per page and the fields you pick. Choose *Save as PDF* in the print dialog. |
| **Shot list spreadsheet** | Every field of every shot as a CSV for Excel, Numbers or Sheets. |
| **Copy all prompts** | Every prompt with its shot code, ready to paste. |
| **Package (.zip)** | The project folder and its media, for a backup or to send to someone else. |

### Takes from gen_clip.py

Storyboard scans `ai-footage/incoming/` for files named `SHOT_v001.mp4`.
A shot whose code matches shows a "2 takes" chip, and its inspector lists the
takes with their prompt, seed and model from the JSON sidecar. Click a take and
choose *Use as frame*. To scan another folder (a Higgsfield downloads folder you
rename files in, for example), start Storyboard with `--takes PATH`.

## Shot numbers

Shots are coded `SC01_SH010`, `SH020`, and so on, the way a shot list is.
Codes stay with the shot when you move other shots around. A shot inserted
between SH010 and SH020 becomes SH015, so generated takes keep matching.
*⚙ Project settings › Renumber* tidies everything up when you want.

## Keyboard

Press **?** in the app for the full list.

| | |
|---|---|
| **1 / 2 / 3** | Storyboard / Moodboard / Animatic |
| **⌘Z / ⇧⌘Z** | Undo / redo, everywhere |
| **Storyboard** | **N** new shot · **⇧N** new scene · **← →** move selection · **Space** quick look · **⌘C** copy prompt · **⌘V** paste image into the shot · **⌘D** duplicate · **⌫** delete |
| **Moodboard** | **V** select · **H** or hold Space to pan · **N** note · **T** text · **S** section · **C** swatch · scroll to pan · ⌘-scroll or pinch to zoom · **⇧1** zoom to fit |
| **Animatic** | **Space** play/pause · **J K L** back 1 s / pause / play · **← →** step one frame · **↑ ↓** previous/next shot · **F** full screen |

## Where your work lives

```
~/Documents/Storyboards/
  neon-nights-3f9a/
    project.json     everything you typed, plus board layouts
    media/           every image, clip and track you added
    exports/         shots.csv, the Premiere XML, slates
    .history/        a snapshot every 10 minutes while you work (the last 60)
  .trash/            deleted projects, in case you change your mind
```

- Storyboard saves as you work. The dot next to Undo shows the save state.
- Click **⋯ › Version history** to restore an older snapshot. Restoring also
  snapshots the current state first.
- If the same project is open in two windows, Storyboard warns you instead of
  silently overwriting one with the other.
- Media files are stored once even if you add the same image twice.

## Notes

- Clips play if the browser can decode them. H.264/H.265 MP4 (what Higgsfield
  and most generators output) and WebM work in Chrome and Safari. ProRes `.mov`
  only plays in Safari. iPhone HEIC photos aren't accepted, so export them as
  JPG or PNG first.
- The server only listens on `127.0.0.1`, so other devices on your network
  can't reach it. It also only accepts requests from Storyboard's own pages.
