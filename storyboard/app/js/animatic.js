// Animatic view: plays the board in order at each shot's length, simulating
// the planned camera move on stills, with dissolves/fades, captions and a
// temp music track. Drag a clip's right edge in the timeline to retime it.

import { mediaUrl } from './api.js';
import { addAll, mediaEl } from './shared.js';
import { cameraLine, moveOf } from './vocab.js';
import { clamp, droppedMedia, fmtTimecode, h, icon, iconBtn, isTyping, menu, mod, pickFiles, promptDialog, toast } from './ui.js';

const PREFS_KEY = 'storyboard.animatic';
const peaksCache = new Map();
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const easeOut = (p) => 1 - (1 - p) ** 3;

export function mount(host, { store, app }) {
  const pid = store.id;
  let prefs = { captions: true, notes: false, camera: true, loop: false, clipSound: false, pps: 0 };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* ignore */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

  let tl = [];       // [{ shot, scene, code, start, end }]
  let total = 0;
  let t = 0;
  let playing = false;
  let raf = 0;
  let clock = { perf: 0, t: 0 };
  let curIdx = -1;
  let nextIdx = -1;
  let pps = 40;      // timeline pixels per second
  let trimming = null;
  const fps = () => Number(store.settings.fps) || 24;
  const music = () => store.settings.music;

  // --- DOM ----------------------------------------------------------------------

  const layerA = h('div.an-layer');
  const layerB = h('div.an-layer', { style: { opacity: 0 } });
  const black = h('div.an-black');
  const hud = h('div.an-hud');
  const actionBox = h('div.an-action.hidden');
  const sub = h('div.an-sub');
  const stage = h('div.an-stage', null, layerA, layerB, black, hud, actionBox, sub);
  const stageWrap = h('div.an-stage-wrap', { ondblclick: () => toggleFullscreen() }, stage);
  const audio = h('audio', { preload: 'auto' });

  const playBtn = h('button.an-play', { type: 'button', title: 'Play / pause (Space)', onclick: () => (playing ? pause() : play()) }, icon('play', 18));
  const tc = h('span.tc.mono');
  const now = h('span.now.grow');
  const toggles = {
    captions: iconBtn('captions', 'Dialogue captions', () => toggle('captions')),
    notes: iconBtn('note', 'Show action notes', () => toggle('notes')),
    camera: iconBtn('camera', 'Simulate camera moves on stills', () => toggle('camera')),
    clipSound: iconBtn('volume', 'Sound from video clips', () => { toggle('clipSound'); syncVolumes(); }),
    loop: iconBtn('loop', 'Loop', () => toggle('loop')),
  };
  const zoomIn = h('input', { type: 'range', min: 4, max: 400, step: 1, title: 'Timeline zoom', style: { width: '90px' }, oninput: (e) => { prefs.pps = +e.target.value; savePrefs(); pps = prefs.pps; layoutTimeline(); }, ondblclick: () => { prefs.pps = 0; savePrefs(); layoutTimeline(); } });
  const transport = h('div.an-transport', null,
    iconBtn('prev', 'Previous shot (↑)', () => jumpShot(-1)), playBtn, iconBtn('next', 'Next shot (↓)', () => jumpShot(1)),
    tc, now,
    toggles.captions, toggles.notes, toggles.camera, toggles.clipSound, toggles.loop,
    iconBtn('music', 'Temp music', (e) => musicMenu(e.currentTarget)),
    h('span', { style: { width: '1px', height: '22px', background: 'var(--line)', margin: '0 6px' } }),
    icon('minus', 13), zoomIn, icon('plus', 13),
    iconBtn('expand', 'Full screen (F)', () => toggleFullscreen()));

  const ruler = h('div.tl-ruler');
  const marks = h('div.tl-scene-marks');
  const track = h('div.tl-track');
  const audioLane = h('div');
  const head = h('div.tl-head');
  const inner = h('div.tl-inner', null, ruler, marks, track, audioLane, head);
  const timeline = h('div.an-timeline', null, inner);
  const root = h('div.an', null, stageWrap, transport, timeline, audio);
  host.append(root);

  function toggle(k) {
    prefs[k] = !prefs[k];
    savePrefs();
    syncToggles();
    draw(true);
  }
  function syncToggles() {
    for (const [k, b] of Object.entries(toggles)) b.classList.toggle('on', !!prefs[k]);
  }

  // --- timeline model -------------------------------------------------------------

  function rebuild() {
    tl = store.shots().map((x) => ({ shot: x.shot, scene: x.scene, code: x.code, start: x.start, end: x.end }));
    total = tl.length ? tl[tl.length - 1].end : 0;
    t = clamp(t, 0, Math.max(0, total - 1e-3));
    if (!tl.length) {
      root.replaceChildren(h('div.an-empty', null, h('div', null, h('h3', null, 'Nothing to play yet'), h('p', null, 'Add shots on the Storyboard tab first.'))));
      return false;
    }
    if (!root.contains(stageWrap)) root.replaceChildren(stageWrap, transport, timeline, audio);
    return true;
  }

  const indexAt = (time) => {
    let lo = 0, hi = tl.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tl[mid].start <= time) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  // --- stage ----------------------------------------------------------------------

  function slate(x) {
    return h('div.slate', null, h('div.code', null, x.code), h('div.act', null, x.shot.action || x.scene.title || 'No description'),
      cameraLine(x.shot) && h('div.cam', null, cameraLine(x.shot)));
  }

  function fill(layer, x) {
    layer.replaceChildren();
    layer.style.transform = '';
    layer.dataset.id = x.shot.id;
    const f = x.shot.frame;
    if (f?.kind === 'video') {
      const v = mediaEl(pid, f, { autoplay: false, loop: false, muted: !prefs.clipSound });
      v.preload = 'auto';
      layer.append(v);
      layer.video = v;
    } else {
      layer.video = null;
      layer.append(f?.kind === 'image' ? mediaEl(pid, f) : slate(x));
    }
    layer.kind = f?.kind || 'slate';
  }

  function syncVolumes() {
    for (const l of [layerA, layerB]) if (l.video) l.video.muted = !prefs.clipSound;
  }

  function moveTransform(x, local, dur) {
    if (!prefs.camera || x.shot.frame?.kind === 'video') return '';
    const m = moveOf(x.shot.move);
    if (!m) return '';
    const raw = clamp(local / dur, 0, 1);
    const p = m.ease === 'fast' ? easeOut(raw) : ease(raw);
    const lerp = (a) => (a ? a[0] + (a[1] - a[0]) * p : 0);
    const s = lerp(m.s) || 1;
    let tx = lerp(m.x) * 100, ty = lerp(m.y) * 100;
    if (m.shake) { const k = local * 6; tx += Math.sin(k * 1.7) * 0.6 + Math.sin(k * 3.1) * 0.3; ty += Math.cos(k * 1.3) * 0.5 + Math.sin(k * 2.7) * 0.25; }
    return `translate(${tx}%, ${ty}%) scale(${s})`;
  }

  function syncVideo(layer, local, force) {
    const v = layer.video;
    if (!v) return;
    const target = Math.min(local, (v.duration || Infinity) - 0.04);
    if (playing) {
      if (force || Math.abs(v.currentTime - target) > 0.25) { try { v.currentTime = Math.max(0, target); } catch { /* not ready */ } }
      if (v.paused && local < (v.duration || Infinity)) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (force || Math.abs(v.currentTime - target) > 1 / fps()) { try { v.currentTime = Math.max(0, target); } catch { /* not ready */ } }
    }
  }

  function draw(force = false) {
    if (!tl.length) return;
    const i = indexAt(t);
    const x = tl[i];
    const dur = x.end - x.start;
    const local = t - x.start;
    const changed = i !== curIdx || force;
    if (i !== curIdx || layerA.dataset.id !== x.shot.id || layerA.src !== x.shot.frame?.src) {
      // Reuse the incoming dissolve layer if it already holds this shot.
      if (layerB.dataset.id === x.shot.id && layerB.src === x.shot.frame?.src) {
        const kids = [...layerB.childNodes];
        layerA.replaceChildren(...kids);
        Object.assign(layerA, { video: layerB.video, kind: layerB.kind });
        layerA.dataset.id = x.shot.id;
        layerB.replaceChildren();
        layerB.dataset.id = '';
        layerB.video = null;
      } else fill(layerA, x);
      layerA.src = x.shot.frame?.src;
      curIdx = i;
    }
    if (changed) {
      hud.replaceChildren(h('span.badge', null, x.code), x.scene.title && h('span.badge', { style: { fontFamily: 'var(--font)', fontWeight: 500 } }, x.scene.title));
      actionBox.textContent = [x.shot.action, cameraLine(x.shot)].filter(Boolean).join('  ·  ');
      sub.replaceChildren(x.shot.dialogue ? h('em', null, x.shot.dialogue) : '');
      now.textContent = `${x.code}${x.shot.action ? ` — ${x.shot.action}` : ''}`;
      highlightClip(x.shot.id);
    }
    actionBox.classList.toggle('hidden', !prefs.notes || !actionBox.textContent || layerA.kind === 'slate');
    sub.classList.toggle('hidden', !prefs.captions);
    layerA.style.transform = moveTransform(x, local, dur);
    syncVideo(layerA, local, changed);

    // transitions
    const next = tl[i + 1];
    const D = Math.min(0.6, dur / 2);
    let blackO = 0;
    if (x.shot.transition === 'Fade in' && local < D) blackO = 1 - local / D;
    if (x.shot.transition === 'Fade out' && local > dur - D) blackO = (local - (dur - D)) / D;
    if (i === 0 && local < 0.001 && !playing && x.shot.transition === 'Fade in') blackO = 1;
    black.style.opacity = blackO;
    if (next && next.shot.transition === 'Dissolve' && local > dur - D) {
      if (layerB.dataset.id !== next.shot.id || layerB.src !== next.shot.frame?.src) { fill(layerB, next); layerB.src = next.shot.frame?.src; }
      layerB.style.opacity = (local - (dur - D)) / D;
      layerB.style.transform = moveTransform(next, 0, next.end - next.start);
      nextIdx = i + 1;
    } else if (nextIdx !== -1 || layerB.style.opacity !== '0') {
      layerB.style.opacity = 0;
      layerB.video?.pause();
      nextIdx = -1;
    }

    tc.replaceChildren(fmtTimecode(t, fps()), h('span.faint', null, ` / ${fmtTimecode(total, fps())}`));
    head.style.left = `${t * pps}px`;
    if (playing) keepHeadVisible();
  }

  // --- transport ----------------------------------------------------------------------

  function musicTime() {
    const m = music();
    return m ? t + (Number(m.offset) || 0) : 0;
  }

  function play() {
    if (!tl.length) return;
    if (t >= total - 1e-3) t = 0;
    playing = true;
    playBtn.replaceChildren(icon('pause', 18));
    clock = { perf: performance.now(), t };
    const m = music();
    if (m?.src) {
      audio.currentTime = musicTime();
      audio.play().catch(() => {});
    }
    curIdx = -1;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    playBtn.replaceChildren(icon('play', 18));
    cancelAnimationFrame(raf);
    audio.pause();
    for (const l of [layerA, layerB]) l.video?.pause();
    draw(true);
  }

  function tick() {
    if (!playing) return;
    const m = music();
    const useAudio = m?.src && !audio.paused && audio.currentTime < (audio.duration || 0) - 0.05;
    t = useAudio ? audio.currentTime - (Number(m.offset) || 0) : clock.t + (performance.now() - clock.perf) / 1000;
    if (useAudio) clock = { perf: performance.now(), t };
    if (t >= total) {
      if (prefs.loop) { t = 0; clock = { perf: performance.now(), t: 0 }; if (m?.src) audio.currentTime = musicTime(); curIdx = -1; } else { t = total - 1e-3; pause(); return; }
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  function seek(time) {
    t = clamp(time, 0, Math.max(0, total - 1e-3));
    clock = { perf: performance.now(), t };
    if (music()?.src) { try { audio.currentTime = musicTime(); } catch { /* not loaded */ } }
    draw(true);
  }

  function jumpShot(d) {
    const i = indexAt(t);
    const local = t - tl[i].start;
    if (d < 0 && local > 0.25) return seek(tl[i].start);
    seek(tl[clamp(i + d, 0, tl.length - 1)].start);
  }

  function step(frames) {
    if (playing) pause();
    seek(Math.round((t * fps()) + frames) / fps());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (stageWrap.requestFullscreen || stageWrap.webkitRequestFullscreen)?.call(stageWrap)?.catch?.(() => {});
  }

  // --- timeline UI ------------------------------------------------------------------------

  const clips = new Map();

  function buildTimeline() {
    track.replaceChildren();
    clips.clear();
    for (const x of tl) {
      const th = h('div.th');
      const f = x.shot.frame;
      if (f?.kind === 'image') th.style.backgroundImage = `url("${mediaUrl(pid, f.src)}")`;
      else if (f?.kind === 'video') th.append(mediaEl(pid, f));
      else th.append(h('div', { style: { padding: '6px', fontSize: '10px', color: 'var(--faint)', lineHeight: 1.3, overflow: 'hidden', height: '100%' } }, x.shot.action || 'No frame'));
      const lbl = h('div.lbl');
      const trim = h('div.trim', { title: 'Drag to change length' });
      const el = h('div.tl-clip', { title: x.shot.action || x.code }, th, lbl, trim);
      el.addEventListener('pointerdown', (e) => {
        if (e.target === trim) return startTrim(e, x.shot.id);
        if (playing) pause();
        scrubFrom(e);
      });
      el.addEventListener('dblclick', () => { app.select([x.shot.id]); app.go('board'); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: 'Edit on storyboard', icon: 'board', onClick: () => { app.select([x.shot.id]); app.go('board'); } },
          { label: 'Set length…', icon: 'film', onClick: async () => {
            const v = parseFloat(await promptDialog(`Length of ${x.code} (seconds)`, String(x.shot.duration), { ok: 'Set' }));
            if (v > 0) store.update(() => { const f2 = store.find(x.shot.id); if (f2) f2.shot.duration = Math.round(v * 100) / 100; });
          } },
        ]);
      });
      clips.set(x.shot.id, { el, lbl, x });
      track.append(el);
    }
    buildAudioLane();
    layoutTimeline();
  }

  function autoPps() {
    const w = timeline.clientWidth || 800;
    return clamp((w - 24) / Math.max(total, 1), 4, 400);
  }

  function layoutTimeline(override) {
    pps = prefs.pps || autoPps();
    zoomIn.value = pps;
    let start = 0;
    const width = [];
    for (const x of tl) {
      const d = override?.id === x.shot.id ? override.dur : x.end - x.start;
      const c = clips.get(x.shot.id);
      if (c) {
        c.el.style.left = `${start * pps}px`;
        c.el.style.width = `${Math.max(3, d * pps - 2)}px`;
        const w = d * pps;
        c.lbl.textContent = w > 110 ? `${x.code.replace('_', ' ')} · ${+d.toFixed(2)}s` : w > 44 ? x.code.slice(-5) : w > 26 ? x.code.slice(-3) : '';
      }
      width.push(start * pps);
      start += d;
    }
    const len = start;
    inner.style.width = `${Math.max(timeline.clientWidth, len * pps + 40)}px`;
    // ruler: pick a tick spacing that leaves ~80px between labels
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const every = steps.find((s) => s * pps >= 70) || 600;
    const ticks = [];
    for (let s = 0; s <= len + every; s += every) ticks.push(h('span', { style: { left: `${s * pps}px` } }, fmtTimecode(s, fps()).slice(3, 8)));
    ruler.replaceChildren(...ticks);
    const seen = new Set();
    marks.replaceChildren(...tl.flatMap((x, i) => {
      if (seen.has(x.scene.id)) return [];
      seen.add(x.scene.id);
      return [h('span', { style: { left: `${width[i]}px` } }, `SC${String(x.scene.number).padStart(2, '0')} ${x.scene.title || ''}`)];
    }));
    layoutAudio();
    head.style.left = `${t * pps}px`;
  }

  function keepHeadVisible() {
    const x = t * pps;
    if (x < timeline.scrollLeft + 20 || x > timeline.scrollLeft + timeline.clientWidth - 60) timeline.scrollLeft = x - 60;
  }

  function highlightClip(id) {
    for (const [cid, c] of clips) c.el.classList.toggle('on', cid === id);
  }

  function timeAtClient(cx) {
    const r = inner.getBoundingClientRect();
    return (cx - r.left) / pps;
  }

  function scrubFrom(e) {
    seek(timeAtClient(e.clientX));
    const move = (ev) => seek(timeAtClient(ev.clientX));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
  ruler.addEventListener('pointerdown', (e) => { if (playing) pause(); scrubFrom(e); });
  marks.addEventListener('pointerdown', (e) => { if (playing) pause(); scrubFrom(e); });

  function startTrim(e, id) {
    e.stopPropagation();
    e.preventDefault();
    if (playing) pause();
    const f = store.find(id);
    const orig = Number(f.shot.duration) || 1;
    const sx = e.clientX;
    const tEl = clips.get(id)?.el.querySelector('.trim');
    tEl?.classList.add('active');
    trimming = { id, dur: orig };
    const move = (ev) => {
      const frames = Math.max(1, Math.round((orig + (ev.clientX - sx) / pps) * fps()));
      trimming.dur = frames / fps();
      layoutTimeline({ id, dur: trimming.dur });
      now.textContent = `${f.code} · ${+trimming.dur.toFixed(2)}s (${frames} fr)`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      tEl?.classList.remove('active');
      const d = Math.round(trimming.dur * 1000) / 1000;
      trimming = null;
      if (d !== orig) store.update(() => { const x = store.find(id); if (x) x.shot.duration = d; });
      else layoutTimeline();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  // --- music -------------------------------------------------------------------------------

  let wave = null;

  function buildAudioLane() {
    const m = music();
    if (!m?.src) {
      wave = null;
      audio.removeAttribute('src');
      const empty = h('div.tl-audio-empty', {
        onclick: () => chooseMusic(),
        ondragover: (e) => { e.preventDefault(); empty.classList.add('file-over'); },
        ondragleave: () => empty.classList.remove('file-over'),
        ondrop: (e) => { e.preventDefault(); empty.classList.remove('file-over'); const d = droppedMedia(e.dataTransfer); if (d.files) setMusic(d.files[0]); },
      }, icon('music', 14), 'Drop a music track or click to add temp music');
      audioLane.replaceChildren(empty);
      return;
    }
    const url = mediaUrl(pid, m.src);
    if (audio.getAttribute('src') !== url) audio.src = url;
    const canvas = h('canvas');
    const lane = h('div.tl-audio', { title: 'Drag to slip the music (change where it starts)' }, h('span.lbl', null, `♪ ${m.name || 'Music'}${m.offset ? ` · starts at ${(+m.offset).toFixed(2)}s` : ''}`), canvas);
    lane.addEventListener('pointerdown', (e) => slipMusic(e));
    lane.addEventListener('contextmenu', (e) => { e.preventDefault(); musicMenu(null, e.clientX, e.clientY); });
    audioLane.replaceChildren(lane);
    wave = { canvas, lane };
    loadPeaks(url).then(() => layoutAudio());
  }

  async function loadPeaks(url) {
    if (peaksCache.has(url)) return peaksCache.get(url);
    const p = (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuf = await ctx.decodeAudioData(buf);
        ctx.close();
        const ch = audioBuf.getChannelData(0);
        const perSec = 200;
        const n = Math.ceil(audioBuf.duration * perSec);
        const block = Math.max(1, Math.floor(ch.length / n));
        const peaks = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let mx = 0;
          for (let j = i * block, end = Math.min(ch.length, j + block); j < end; j += 4) mx = Math.max(mx, Math.abs(ch[j]));
          peaks[i] = mx;
        }
        return { peaks, perSec, duration: audioBuf.duration };
      } catch {
        return null;
      }
    })();
    peaksCache.set(url, p);
    return p;
  }

  async function layoutAudio(slip) {
    const m = music();
    if (!wave || !m?.src) return;
    const data = await peaksCache.get(mediaUrl(pid, m.src));
    const offset = slip ?? (Number(m.offset) || 0);
    const len = Math.max(total, 0.1);
    const W = Math.min(16000, Math.ceil(len * pps));
    const H = 40;
    const { canvas } = wave;
    const dpr = devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    wave.lane.style.width = `${W}px`;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    if (!data) return;
    g.fillStyle = '#4fbf7d';
    for (let x = 0; x < W; x++) {
      const time = x / pps + offset;
      const i = Math.floor(time * data.perSec);
      if (i < 0 || i >= data.peaks.length) continue;
      const span = Math.max(1, Math.floor(data.perSec / pps));
      let mx = 0;
      for (let k = 0; k < span && i + k < data.peaks.length; k++) mx = Math.max(mx, data.peaks[i + k]);
      const hh = Math.max(1, mx * (H - 6));
      g.fillRect(x, (H - hh) / 2, 1, hh);
    }
  }

  function slipMusic(e) {
    const m = music();
    const orig = Number(m.offset) || 0;
    const sx = e.clientX;
    let off = orig;
    const move = (ev) => { off = Math.max(0, orig - (ev.clientX - sx) / pps); layoutAudio(off); };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (Math.abs(off - orig) > 0.005) store.update(() => { store.settings.music.offset = Math.round(off * 1000) / 1000; });
      else if (Math.abs(e.clientX - sx) < 3) { if (playing) pause(); seek(timeAtClient(e.clientX)); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  async function chooseMusic() {
    const [f] = await pickFiles({ accept: 'audio/*', multiple: false });
    if (f) setMusic(f);
  }

  async function setMusic(file) {
    const [r] = await addAll(pid, [file]);
    if (!r) return;
    if (r.kind !== 'audio') return toast('That isn’t an audio file', { type: 'error' });
    store.update((p) => { p.settings.music = { src: r.src, name: r.name, duration: r.duration, offset: 0 }; });
    toast(`Temp music: ${r.name}. Drag the waveform to slip it.`);
  }

  function musicMenu(btnEl, x, y) {
    const m = music();
    const r = btnEl?.getBoundingClientRect();
    menu(x ?? r.left, y ?? r.bottom + 4, [
      { label: m?.src ? 'Replace music…' : 'Add music…', icon: 'music', onClick: chooseMusic },
      m?.src && { label: 'Set start offset…', icon: 'film', onClick: async () => {
        const v = parseFloat(await promptDialog('Music starts at (seconds into the track)', String(m.offset || 0), { ok: 'Set' }));
        if (v >= 0) store.update(() => { store.settings.music.offset = v; });
      } },
      m?.src && { label: 'Remove music', icon: 'trash', danger: true, onClick: () => store.update((p) => { p.settings.music = null; }) },
    ]);
  }

  // --- wiring ---------------------------------------------------------------------------------

  function full() {
    const was = playing;
    if (playing) pause();
    if (!rebuild()) return;
    curIdx = -1;
    buildTimeline();
    draw(true);
    if (was) play();
  }

  function fitStage() {
    const r = stageWrap.getBoundingClientRect();
    const ar = String(store.settings.aspect || '16:9').split(':').map(Number);
    const ratio = ar[0] / (ar[1] || 1) || 16 / 9;
    const W = r.width - 36, H = r.height - 36;
    const w = Math.min(W, H * ratio);
    stage.style.width = `${Math.max(10, w)}px`;
    stage.style.height = `${Math.max(10, w / ratio)}px`;
  }
  const ro = new ResizeObserver(() => { fitStage(); if (!prefs.pps) layoutTimeline(); });
  ro.observe(stageWrap);
  ro.observe(timeline);

  function onKey(e) {
    if (isTyping(e) || mod(e) || e.altKey) return false;
    const k = e.key;
    const handled = {
      ' ': () => (playing ? pause() : play()),
      k: () => pause(), K: () => pause(),
      l: () => play(), L: () => play(),
      j: () => seek(t - 1), J: () => seek(t - 1),
      ArrowLeft: () => (e.shiftKey ? seek(t - 1) : step(-1)),
      ArrowRight: () => (e.shiftKey ? seek(t + 1) : step(1)),
      ArrowUp: () => jumpShot(-1),
      ArrowDown: () => jumpShot(1),
      Home: () => seek(0),
      End: () => seek(total),
      f: () => toggleFullscreen(), F: () => toggleFullscreen(),
      c: () => toggle('captions'),
    }[k];
    if (!handled) return false;
    e.preventDefault();
    handled();
    return true;
  }

  const offChange = store.on('change', () => { if (!trimming) full(); });

  syncToggles();
  if (rebuild()) {
    const start = app.current && tl.find((x) => x.shot.id === app.current);
    t = start ? start.start : 0;
    buildTimeline();
    requestAnimationFrame(() => { fitStage(); layoutTimeline(); draw(true); keepHeadVisible(); });
  }

  return {
    onKey,
    refresh: full,
    unmount: () => {
      pause();
      offChange();
      ro.disconnect();
      audio.removeAttribute('src');
      if (tl.length) {
        const x = tl[indexAt(t)];
        app.selection = new Set([x.shot.id]);
        app.current = x.shot.id;
      }
      root.remove();
    },
  };
}
