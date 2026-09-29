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

## One-time setup

1. **Python 3.10+**: install it from python.org, then run `pip install -r requirements.txt`.
2. **ffmpeg**:
   - Windows: `winget install ffmpeg`
   - Mac: `brew install ffmpeg`
3. **A generator.** Pick at least one:
   - **Local (free):** install [ComfyUI Desktop](https://www.comfy.org/download). See the next section.
   - **API:** make a [fal.ai](https://fal.ai) account and create an API key. Then set it:
     - Windows: `setx FAL_KEY "your-key"`
     - Mac: add `export FAL_KEY=your-key` to `~/.zshrc`

## Using a local model (ComfyUI)

1. In ComfyUI, open **Workflow › Browse Templates** and pick a video template, for example *Wan 2.2 5B text-to-video* or *LTX Video*. ComfyUI offers to download the model files.
2. In the positive prompt box, type exactly `{{PROMPT}}`.
   - In the sampler's `seed` field, you can also put `{{SEED}}`. Convert the widget to an input first if it only accepts numbers.
   - A negative prompt box can take `{{NEGATIVE}}`.
3. Choose **Workflow › Export (API)** and save the file as `ai-footage/workflows/wan22_api.json`.
4. With ComfyUI running, run:

```bash
cd ai-footage
python gen_clip.py comfyui --workflow workflows/wan22_api.json \
    --shot SC01_SH010 --prompt "slow push-in on a rain-soaked neon street at night"
```

You can save any workflow this way, including image-to-video, upscaler chains and LoRAs. The script only fills in the placeholders.

## Using fal.ai (API)

```bash
python gen_clip.py fal --shot SC01_SH020 --prompt "drone shot over misty hills at sunrise"
python gen_clip.py fal --model <model-id-from-fal.ai> --duration 5 --aspect 16:9 ...
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
python gen_clip.py batch myshots.csv --backend comfyui --workflow workflows/wan22_api.json
```

## Conform for editing

```bash
python conform.py --fps 25                                     # ProRes 422, native size
python conform.py --fps 23.976 --codec dnxhr --size 1920x1080  # DNxHR HQ, crop-fill to 1080p
python conform.py --fps 25 --motion interp                     # smooth out 16 fps Wan clips
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

**Local, on your own GPU. Free and unlimited, with no watermark.**

| Model | Min VRAM (approx.) | Notes |
|---|---|---|
| Wan 2.2 5B (GGUF) | ~8 GB | Apache 2.0 license (commercial use OK). Best starting point for 8–12 GB cards. Outputs 16 fps; conform with `--motion interp` |
| HunyuanVideo 1.5 | ~14 GB (FP8 + offload) | Strong realism on a 16–24 GB card |
| CogVideoX 2B / 5B | 16 / 24 GB | Older but lightweight |
| LTX-2.x | 32 GB+ distilled | Generates synced audio with the video. Heavy; free for commercial use under $10M revenue |

All four run in ComfyUI, and most have one-click templates. With 8–12 GB of VRAM you'll get short 480p–720p clips. With 24 GB you can run almost everything.

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
