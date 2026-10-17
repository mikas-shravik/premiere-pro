# Storyboard

Storyboard is a storyboard, moodboard and animatic app that runs on your Mac.
It works in your browser, but nothing goes online. Each project is an ordinary
folder in `~/Documents/Storyboards`.

| Tab | What it's for |
|---|---|
| **Storyboard** | Scenes made of shot cards. Each shot has a frame (still or clip), action, dialogue, size, angle, move, lens, length, transition, an AI prompt, references and notes. |
| **Moodboard** | An infinite canvas for reference stills, clips, sticky notes, headings, color swatches, links and arrows between ideas. A project can have several boards. |
| **Versions** | Every shot's evolution tree on one board: first references, the variations made from each, which one was picked, and the mark-up notes on each. Scenes run left to right like a timeline. |
| **Animatic** | Plays the board at each shot's length, with simulated camera moves on stills, dissolves and fades, dialogue captions and a temp music track. Drag a clip's edge in the timeline to retime it. |

Claude, in the Claude desktop app, can read and edit your boards. Its changes
appear live while you work (see [Working with Claude](#working-with-claude)).

It ties into the rest of this repo. A board exports a `shots.csv` that
`ai-footage/gen_clip.py batch` reads. The takes that generates show up on the
matching shot. The finished board goes to Premiere Pro as a sequence.

## Start it

You only need Python 3, and macOS offers to install it the first time if it's
missing. There's nothing else to install.

Recent macOS versions (Sequoia and later) block double-clicking scripts that
came from the internet, such as a downloaded zip. Right-click › Open no longer
gets around that. The Terminal method below always works because it never
double-clicks anything.

**The sure way: Terminal.**

1. Open Terminal: press ⌘ Space, type `Terminal` and press Return.
2. Type `python3` and a space, but don't press Return yet.
3. Drag `server.py` from the `storyboard` folder onto the Terminal window. Its
   location appears after `python3 `.
4. Press Return. Storyboard opens in your browser.

Keep that window open while you work, and close it to stop Storyboard. Next
time, open Terminal, press ↑ to bring the command back, and press Return.

- If a box asks to install **command line developer tools**, click Install,
  wait for it to finish, then repeat steps 2–4. That installs Python.
- If macOS asks whether Terminal may access your **Documents** folder, click
  Allow. If you refuse, projects are saved in `~/Storyboards` instead.

**Make double-clicking `Storyboard.command` work (optional, once).** Double-click
it so macOS blocks it, and click Done. Then open **System Settings › Privacy &
Security**, scroll down to Security, click **Open Anyway** next to the
Storyboard.command message and enter your password. Double-click it again and
choose **Open**. From then on it opens normally. To unblock the whole folder
in one go instead, type `xattr -dr com.apple.quarantine ` in Terminal (with a
space at the end), drag the folder onto the window and press Return.

**A real app in your Dock (optional).** In Terminal, type `bash ` (with a
space), drag `make-mac-app.sh` onto the window and press Return. This creates
`~/Applications/Storyboard.app`. macOS doesn't block it because it was made on
your Mac. Open it and drag it to the Dock. Opening it starts Storyboard in the
background and opens it in your browser. To stop it, click **Quit Storyboard**
at the bottom of the home screen. If you move the folder, build the app again.

`server.py` accepts these flags: `--port 9000`, `--data ~/Dropbox/Storyboards`
(another projects folder) and `--no-browser`.

Storyboard runs at **http://127.0.0.1:8765**. Chrome, Safari and Arc all work.

**As a Chrome app.** While Storyboard is running, click Chrome's install icon in
the address bar (or **⋮ › Cast, save and share › Install page as app**).
Storyboard gets its own window and an icon in the Dock, Launchpad and
Applications › Chrome Apps. The app is a window onto Storyboard, so Storyboard
itself still has to be running. If it isn't (after a restart, say), the window
shows the one line to paste into Terminal and reloads itself once Storyboard
starts. That line adds `--no-browser`, so starting it doesn't also open a
browser tab.

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

## Versions: the evolution tree

The Versions tab (press **3**) keeps the whole history of every shot: where it
started, what you tried, and how you got to the final frame. Scenes run left
to right in story order, with every shot in each scene. Each shot grows a tree
downward. It opens on the first scenes at a readable size; scroll sideways for
the rest, pick one scene from the menu, or press **F** to see the whole
project at once.

```
SC01 · SH020                        ← the shot (shows its current frame)
 ├─ v1 Option        ├─ v2 Rework   ← first references
 │                    ├─ v2.1 Exploring
 │                    └─ v2.2 Picked ← the final frame; its path is green
```

- **Start a tree:** any frame you give a shot on the Storyboard tab is added automatically. You can also drop images onto a shot here. Tick **Only shots with versions** to hide shots that don't have any yet.
- **Add variations:** drop the new generations onto the version they came from. You can also select a version and click **Add images as variations…**.
- **Status:** Exploring (not judged yet), Rework (close, needs changes), Option (a backup you might use later) or Picked. **Pick as final** (or press **P**) makes that version the shot's frame.
- **Clean up:** delete versions you know you won't use. Deleting one also deletes what grew from it. Undo works, and the image files stay in the project folder.
- **Empty versions** hold a prompt you haven't generated yet, either yours or Claude's. Drop the generated image onto one to fill it.
- Every version keeps its prompt, a note, its date and who made it.

## Mark-up: circle what should change

Double-click a version (or click **Review & mark up**) to open it full screen.
Pick **Circle (O)**, **Box (R)**, **Arrow (A)** or **Draw (P)** and mark the
part of the image you want changed. Each mark gets a number and a note, for
example "Replace this table with a rustic oak one". Notes show as sticky notes
on the image, and you can tick each one **Resolved**. You can also mark up a
shot's frame straight from the Storyboard inspector.

When you close the review, Storyboard saves a copy of the image with your
numbered marks drawn on it. That copy is what Claude looks at.

## Working with Claude

Claude in the **Claude desktop app** can read and edit your boards. Its edits
appear live in Storyboard within a second or two: no reloading, and your
scroll position, selection and the field you're typing in stay where they
are. Each Claude edit shows a note with **Undo**, and the changed cards flash
briefly. If you're both editing at once, both sets of changes are kept. If you
both change the same field, yours wins. It runs on your Claude plan, with no
extra cost.

**Set up once:**

1. Install the [Claude desktop app](https://claude.ai/download) and sign in.
2. In Storyboard, open **⋯ › Connect Claude…** (or the button on the home screen) and click **Connect**.
3. Quit Claude completely (⌘Q) and open it again. If macOS asks whether Claude may access a folder, click **Allow**.

Keep Storyboard running while you chat. Claude works on the project you have
open, and it knows which shot or version you've selected.

Connect copies the connector to `~/Library/Application Support/Storyboard`.
macOS doesn't let the Claude app run scripts kept in Downloads, Documents or
on the Desktop, and the connector would quit at once with "Server
disconnected". Storyboard keeps that copy up to date each time it starts.

**If Claude still says "Server disconnected":** in Claude, open **Settings ›
Developer › storyboard** and click **Open Logs Folder**. The last lines of
`mcp-server-storyboard.log` say what went wrong. A healthy start logs
"Storyboard connector ready".

**Things to ask:**

- "What's on my storyboard so far?"
- "Look at my notes on the version I have selected and write the next variation." Claude reads your notes, looks at the marked-up image, adds a new version under it with a complete prompt, and replies to each note. Generate that prompt in Higgsfield, then drop the result onto Claude's version.
- "Pitch three alternative openings and add them as shots after SC01_SH010."
- "Rewrite all the prompts in scene 2 to match the project look."
- "Look at the frames in scene 1. Anything breaking continuity?"
- "Put five lighting ideas for the bar scene on the moodboard."
- "Add the images in ~/Downloads/renders to SC01_SH020 as variations of v1."
- "Here's the Higgsfield render for your v1.2: /Users/me/Downloads/bar-wide.png"
- "Make a shot for each clip in ~/Downloads/scene3 at the end of scene 3."
- "Put these in the Locations section of the moodboard: https://…, https://…"
- "Start a new 9:16 project called Diwali Ad from this script, one scene per beat, and open it."
- "Rename this project to Kailash Feast – v2 and set it to 25 fps."

Claude can read the board, shots, version trees, notes and images, and see
what you have selected. It can create projects (from a template or from your
script), rename them, change their settings (aspect ratio, frame rate, shot
length, look and negative prompt) and open one in your Storyboard window. It
can add and edit shots and scenes, add versions, change version statuses
(including picking one), answer and resolve notes and add moodboard notes. A
new or renamed project shows up on the home screen straight away. Claude only
deletes something when you ask it to, and it can't delete projects.

**Adding photos and clips.** Claude can add images and clips from web links
or from files and folders on your Mac. It can put them in a shot's version
tree (as references, as variations of a version, or as the image for a
version it wrote), make one new shot per image, or place them on a moodboard,
inside a section if you name one. To give Claude a file, select it in Finder
and press **⌥⌘C** (Option-Command-C) to copy its path, then paste that into
the chat. A folder path adds every image and clip in it, up to 60. Claude
can't forward an image you attach to the chat, so send the path or a link
instead.

Claude can't generate images on its own. If you connect a generation tool to
Claude that returns a link to its result, Claude can add that result too.

If Claude says macOS didn't let Storyboard open a folder, open **System
Settings › Privacy & Security › Files and Folders** and allow Terminal (or the
app you start Storyboard from) to use that folder.

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
| **1 / 2 / 3 / 4** | Storyboard / Moodboard / Versions / Animatic |
| **⌘Z / ⇧⌘Z** | Undo / redo, everywhere |
| **Storyboard** | **N** new shot · **⇧N** new scene · **← →** move selection · **Space** quick look · **⌘C** copy prompt · **⌘V** paste image into the shot · **⌘D** duplicate · **⌫** delete |
| **Versions** | **↑ ↓ ← →** move around the tree · **P** pick as final · **Enter** or double-click to mark up · **⌫** delete · **F** fit |
| **Mark-up** | **O** circle · **R** box · **A** arrow · **P** draw · **V** move marks · **⌫** delete mark · **Esc** done |
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
- If the same project is open in two windows, or Claude edits while you work,
  the changes are merged live rather than one overwriting the other.
- Media files are stored once even if you add the same image twice.

## Notes

- Clips play if the browser can decode them. H.264/H.265 MP4 (what Higgsfield
  and most generators output) and WebM work in Chrome and Safari. ProRes `.mov`
  only plays in Safari. iPhone HEIC photos aren't accepted, so export them as
  JPG or PNG first.
- The server only listens on `127.0.0.1`, so other devices on your network
  can't reach it. It also only accepts requests from Storyboard's own pages.
