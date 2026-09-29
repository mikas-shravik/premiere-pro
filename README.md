# AI Footage → Premiere Pro toolkit

Generate AI clips from a shot list, conform them to your project settings,
and import them into Premiere with prompts attached. The flow:

```
shots.csv ──► gen_clip.py ──► incoming/   (raw clips + .json with prompt/seed/model)
                                 │
                            conform.py ──► edit_ready/   (ProRes/DNxHR at project fps)
                                              └─ AI_Clips.xml ──► Premiere: File › Import
```

The XML import gives you:
- **An "AI Clips" bin** with every take. The prompt is in the *Description* column, the shot name in *Scene*, and the model and seed in *Log Note*, so you can always regenerate a shot.
- **An "AI Assembly" sequence** with the newest take of each shot, in shot order. It's a rough cut ready to trim.

## One-time setup (Mac)

In Terminal:

```bash
# Homebrew, if you don't have it yet: https://brew.sh
brew install python ffmpeg uv
cd premiere-pro
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

In each new Terminal window, run `source premiere-pro/.venv/bin/activate` before using the scripts.

For fal.ai, add `export FAL_KEY=your-key` to `~/.zshrc`, then open a new Terminal window.

## Local generation on a Mac (free)

Your MacBook Pro M4 with 24 GB runs video models on its GPU through Apple's
**MLX** framework. MLX is much better than ComfyUI on a Mac, where FP8
checkpoints don't run and Wan video currently comes out corrupted.

**One-time install of LTX-2.3 for MLX.** It generates video *with synced audio*.

```bash
git clone https://github.com/dgrauet/ltx-2-mlx.git ~/ltx-2-mlx
cd ~/ltx-2-mlx && uv sync --all-extras
```

The first generation downloads the int4 model, about 12 GB. It fits in
24 GB. If macOS shows memory pressure, add `--low-ram` to the preset in
`gen_clip.py`.

**Generate:**

```bash
cd premiere-pro/ai-footage
python3 gen_clip.py local --shot SC01_SH010 \
    --prompt "slow push-in on a rain-soaked neon street at night, reflections, cinematic"
```

The `ltx-mac` preset makes 4-second clips (97 frames at 24 fps, 704×480).
Budget several minutes or more per clip on a base M4. That's fine for
b-roll and drafts running overnight from a shot list. Use Magnific or
fal.ai for hero shots.

**Any other command-line generator** works too. Pass a template, and
`{prompt}`, `{seed}`, `{output}` and `{negative}` get filled in:

```bash
python3 gen_clip.py local --cmd "python3 -m mlx_video.wan_2.generate --model-dir ~/models/wan22_mlx \
    --prompt {prompt} --seed {seed} --output-path {output}"
```

## Using ComfyUI (better suited to Windows/NVIDIA machines)

1. In ComfyUI, open **Workflow › Browse Templates** and pick a video template.
2. In the positive prompt box, type exactly `{{PROMPT}}`.
   - The sampler's `seed` field can take `{{SEED}}`, and a negative prompt box can take `{{NEGATIVE}}`.
3. Choose **Workflow › Export (API)** and save the file as `ai-footage/workflows/my_api.json`.
4. Run `python3 gen_clip.py comfyui --workflow workflows/my_api.json --shot SC01_SH010 --prompt "..."`

## Using fal.ai (API)

```bash
python3 gen_clip.py fal --shot SC01_SH020 --prompt "drone shot over misty hills at sunrise"
python3 gen_clip.py fal --model <model-id-from-fal.ai> --duration 5 --aspect 16:9 ...
```

The default model is `fal-ai/ltx-video`, which is cheap and fast. To use a different model, copy its ID from that model's page on fal.ai. Parameters like `--duration` and `--aspect` are only sent when you pass them, because not every model accepts them.

## A whole shot list at once

Copy `ai-footage/shots.example.csv` and edit it in Excel or Google Sheets:

| column | meaning |
|---|---|
| `shot` | `SC01_SH010`-style name. Takes are versioned `_v001`, `_v002`… and never overwritten |
| `prompt` | the shot description |
| `negative`, `seed`, `duration`, `aspect` | optional |
| `takes` | how many variations to generate (default 1) |

```bash
python3 gen_clip.py batch myshots.csv --backend local      # or --backend fal
```

## Conform for editing

```bash
python3 conform.py --fps 25                                     # ProRes 422, native size
python3 conform.py --fps 23.976 --codec dnxhr --size 1920x1080  # DNxHR HQ, crop-fill to 1080p
python3 conform.py --fps 25 --motion interp                     # smooth out 16 fps Wan clips
```

- `--motion dup` (the default) keeps real-time speed by dropping or duplicating frames.
- `--motion interp` uses optical-flow-style interpolation. It's slower and smoother, but check it for warping artifacts.
- `--fit crop|pad|stretch` decides what happens when the clip's aspect ratio doesn't match `--size`.
- Clips that are already conformed are skipped. Use `--force` to redo them.

Then in Premiere, choose **File › Import** and select `edit_ready/AI_Clips.xml`.

## Letting Claude generate clips for you

If Claude has a video-generation connector, you can ask it in chat, for example: *"generate SC01_SH010 from my shot list with Seedance, 5 s, 16:9"*. Claude writes the prompt, generates the clip and hands you the file. Drop the file in `incoming/` and run `conform.py`. The Magnific connector offers Kling 2.5, MiniMax Hailuo and Seedance 2.0/2.5, and it spends your Magnific credits. Claude can also turn a script into a shot list CSV for `gen_clip.py batch`.

## Free and cheap ways to generate video (September 2026)

Free tiers change often, so check each site before relying on it.

**Local on your Mac (M4, 24 GB). Free and unlimited, with no watermark.**

| Option | Fits 24 GB? | Notes |
|---|---|---|
| **LTX-2.3 int4 via [ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx)** | ✅ ~12 GB | The `ltx-mac` preset. Video and audio together. Free for commercial use under $10M revenue |
| Wan 2.2 TI2V-5B / Wan 2.1 1.3B via [mlx-video](https://github.com/Blaizzy/mlx-video) | ✅ | Apache 2.0 license. Needs a weight-conversion step; use it with `--cmd` |
| [ltx-video-mac](https://github.com/james-see/ltx-video-mac) app | ✅ (int4) | A point-and-click Mac app for the same LTX models, if you'd rather not use Terminal |
| LTX-2.3 int8 / bf16 | ❌ | Needs 32 GB / 64 GB+ |
| Anything FP8 in ComfyUI | ❌ | Metal can't run FP8 models |

**Free hosted tiers (no GPU needed)**
- **Kling AI:** 66 credits/day, about 2–6 clips. They're 720p and watermarked, and not licensed for commercial use.
- **Google Flow (Veo 3.1):** a daily free credit allowance.
- **Pika:** 80 credits/month at 480p, image-to-video only. No watermark, and commercial use is allowed.
- **Hailuo:** 200 credits once at signup, about 8 clips. **PixVerse:** about 50 at signup plus 30–60/day.
- **Runway:** a few free clips at signup.

**APIs that work with `gen_clip.py fal`, or could be added as backends**
- **fal.ai:** about $10 of free credit at signup, enough for roughly 50–100 LTX/Wan clips. Also offers Kling and Hunyuan.
- **Replicate:** pay per second, with a huge model catalog.

(OpenAI's Sora API shut down on 24 Sept 2026.)
