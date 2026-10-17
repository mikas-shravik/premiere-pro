// Export dialog: Premiere animatic XML, shots.csv for ai-footage/gen_clip.py,
// a printable PDF board, a spreadsheet shot list, prompts and a .zip package.

import { addMedia, api } from './api.js';
import { buildPrompt, cameraLine, fullPrompt, genAspect, statusOf } from './vocab.js';
import { btn, copyText, field, h, icon, modal, select, toast } from './ui.js';

export function openExport(app) {
  const store = app.store;
  const opt = (ic, title, desc, run) => h('button.export-opt', { type: 'button', onclick: () => { close(); run(); } },
    h('div.ei', null, icon(ic, 18)), h('div', null, h('b', null, title), h('span', null, desc)), icon('arrow', 14));
  let close;
  modal({
    title: 'Export', wide: true,
    body: (c) => {
      close = c;
      return h('div.export-list', null,
        opt('film', 'Premiere Pro animatic (XML)', 'A sequence with every shot at its length, a marker per shot with action and dialogue, and your temp music. Shots without a frame get a text slate.', () => exportPremiere(store)),
        opt('wand', 'Shot list for gen_clip.py (CSV)', 'Prompts, seeds, lengths and takes in the format ai-footage/gen_clip.py batch reads, to generate clips locally or on fal.ai.', () => exportGenCsv(app)),
        opt('printer', 'Storyboard PDF', 'A printable board with frames and notes. Use Save as PDF in the print dialog.', () => exportPrint(store)),
        opt('list', 'Shot list spreadsheet (CSV)', 'Every field of every shot, for Excel, Numbers or Google Sheets.', () => exportSheet(store)),
        opt('copy', 'Copy all prompts', 'Every shot’s full prompt with its shot code, ready to paste into Higgsfield one by one.', () => copyAllPrompts(store)),
        opt('folder', 'Package project (.zip)', 'The project and all its media in one file, to back up or send to someone with Storyboard.', () => exportZip(store)));
    },
  });
}

function framesOf(sec, fps) { return Math.max(1, Math.round((Number(sec) || 0) * Number(fps))); }

function resultDialog(title, r, extra) {
  modal({
    title,
    body: h('div', { style: { display: 'grid', gap: '12px' } },
      h('p.muted', null, 'Saved to:'), h('div.code-block', null, r.path), extra),
    actions: [
      { label: 'Show in Finder', onClick: () => { api.reveal(r.storeId, r.rel); return false; } },
      { label: 'Download a copy', onClick: () => { location.href = r.url; return false; } },
      { label: 'Done', primary: true, value: true },
    ],
  });
}

// --- Premiere ------------------------------------------------------------------

async function exportPremiere(store) {
  const shots = store.shots();
  if (!shots.length) return toast('No shots to export yet');
  const { fps } = store.settings;
  const need = shots.filter((x) => !x.shot.frame);
  const closeBusy = need.length ? toast(`Drawing ${need.length} slate${need.length > 1 ? 's' : ''}…`, { timeout: 0 }) : null;
  const slates = new Map();
  try {
    await Promise.all(need.map(async (x) => {
      try {
        const file = await renderSlate(x, store.settings);
        slates.set(x.shot.id, await addMedia(store.id, file));
      } catch { /* shot stays as a gap */ }
    }));
  } finally {
    closeBusy?.();
  }
  const m = store.settings.music;
  const spec = {
    name: store.p.name, fps, width: store.settings.width, height: store.settings.height,
    shots: shots.map((x) => {
      const f = x.shot.frame || slates.get(x.shot.id);
      return {
        code: x.code, src: f?.src, kind: f?.kind, w: f?.w, h: f?.h,
        frames: framesOf(x.shot.duration, fps),
        srcFrames: f?.kind === 'video' && f.duration ? Math.floor(f.duration * Number(fps)) : null,
        prompt: fullPrompt(x.shot, store.settings), action: x.shot.action, dialogue: x.shot.dialogue, camera: cameraLine(x.shot),
      };
    }),
    music: m?.src ? { src: m.src, frames: m.duration ? Math.floor(m.duration * Number(fps)) : null, offsetFrames: Math.round((Number(m.offset) || 0) * Number(fps)) } : null,
  };
  try {
    const r = await api.export(store.id, 'xml', spec);
    resultDialog('Premiere animatic ready', { ...r, storeId: store.id }, h('div', { style: { display: 'grid', gap: '8px' } },
      h('p', null, 'In Premiere Pro: ', h('b', null, 'File › Import…'), ' and pick that XML. You get a sequence called ', h('b', null, `${store.p.name} - Animatic`), '.'),
      h('p.muted', null, 'Tip: stills come in at their own size. Select all clips in the sequence, right-click › Set to Frame Size. Markers carry each shot’s action and dialogue; the Description column carries its prompt.')));
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

// A text card for a shot with no frame: code, action, dialogue and camera.
async function renderSlate(x, settings) {
  const scale = Math.min(1, 1920 / Math.max(settings.width, settings.height));
  const W = Math.round(settings.width * scale), H = Math.round(settings.height * scale);
  const c = h('canvas', { width: W, height: H });
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
  grad.addColorStop(0, '#1d1d21');
  grad.addColorStop(1, '#0a0a0b');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const u = Math.min(W, H) / 1080;
  const font = '-apple-system, "Helvetica Neue", Arial, sans-serif';
  const mono = 'Menlo, "SF Mono", Consolas, monospace';
  const left = W * 0.08;
  let y = H * 0.2;
  g.fillStyle = '#ffb224';
  g.font = `600 ${44 * u}px ${mono}`;
  g.fillText(x.code, left, y);
  if (x.scene.title) {
    g.fillStyle = '#9b9ba5';
    g.font = `500 ${32 * u}px ${font}`;
    g.fillText(x.scene.title, left, y + 52 * u);
  }
  y = H * 0.4;
  g.fillStyle = '#ececf0';
  g.font = `500 ${58 * u}px ${font}`;
  y = wrap(g, x.shot.action || 'No description', left, y, W * 0.84, 72 * u, 5);
  if (x.shot.dialogue) {
    g.fillStyle = '#e6d3a6';
    g.font = `italic 400 ${44 * u}px ${font}`;
    y = wrap(g, `“${x.shot.dialogue}”`, left, y + 30 * u, W * 0.84, 56 * u, 3);
  }
  g.fillStyle = '#686871';
  g.font = `500 ${30 * u}px ${mono}`;
  g.fillText([cameraLine(x.shot), `${+Number(x.shot.duration).toFixed(2)}s`].filter(Boolean).join('  ·  '), left, H * 0.9);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return new File([blob], `slate_${x.code}.png`, { type: 'image/png' });
}

function wrap(g, text, x, y, maxW, lh, maxLines) {
  const words = text.split(/\s+/);
  let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(test).width > maxW && line) {
      g.fillText(++n >= maxLines && i < words.length ? `${line}…` : line, x, y);
      y += lh;
      line = words[i];
      if (n >= maxLines) return y;
    } else line = test;
  }
  if (line) { g.fillText(line, x, y); y += lh; }
  return y;
}

// --- gen_clip.py CSV -------------------------------------------------------------

async function exportGenCsv(app) {
  const store = app.store;
  let which = app.selection.size > 1 ? 'selected' : 'todo';
  const ok = await modal({
    title: 'Shot list for gen_clip.py',
    body: h('div', { style: { display: 'grid', gap: '12px' } },
      field('Which shots', select([['todo', 'Not generated yet (Idea, Prompt ready)'], ['all', 'All shots'], ['selected', `Selected on the storyboard (${app.selection.size})`]], which, (v) => { which = v; })),
      h('p.muted', null, 'Each row uses the shot’s full prompt (project look + prompt, or a prompt built from its fields), its negative prompt, seed, length rounded to whole seconds, the project aspect ratio and its takes.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Export CSV', primary: true, value: true }],
  });
  if (!ok) return;
  const s = store.settings;
  const picked = store.shots()
    .filter((x) => (which === 'all' ? true : which === 'selected' ? app.selection.has(x.shot.id) : ['idea', 'prompt'].includes(x.shot.status)));
  // A shot with no prompt, action or camera fields has nothing to generate.
  const usable = picked.filter((x) => (x.shot.prompt || '').trim() || buildPrompt(x.shot));
  const skipped = picked.length - usable.length;
  const rows = usable
    .map((x) => ({
      shot: x.code, prompt: fullPrompt(x.shot, s), negative: x.shot.negative || s.negative || '', seed: x.shot.seed || '',
      duration: Math.max(1, Math.round(Number(x.shot.duration) || 1)), aspect: genAspect(s.aspect), takes: Number(x.shot.takes) || Number(s.takes) || 1,
    }));
  if (!rows.length) return toast(skipped ? `None of those ${skipped} shots has a prompt or description yet` : 'No shots match that choice');
  try {
    const r = await api.export(store.id, 'csv', { rows });
    const cmd = `cd "${r.tools || 'premiere-pro/ai-footage'}"\npython3 gen_clip.py batch "${r.path}" --backend local`;
    resultDialog(`${rows.length} shot${rows.length > 1 ? 's' : ''} exported`, { ...r, storeId: store.id }, h('div', { style: { display: 'grid', gap: '8px' } },
      h('p', null, 'To generate them with your local LTX model, paste this into Terminal (use ', h('code', null, '--backend fal'), ' for fal.ai):'),
      h('div.code-block', null, cmd),
      h('div', null, btn('Copy command', async () => { await copyText(cmd); toast('Command copied'); }, { icon: 'copy', cls: 'small' })),
      skipped ? h('p.muted', null, `${skipped} shot${skipped > 1 ? 's were' : ' was'} left out because ${skipped > 1 ? 'they have' : 'it has'} no prompt or description yet.`) : null,
      h('p.muted', null, 'Finished takes land in ai-footage/incoming as SC01_SH010_v001.mp4… and show up in each shot’s inspector, ready to use as its frame.')));
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

// --- print / PDF ---------------------------------------------------------------------

async function exportPrint(store) {
  const opts = { layout: '6', fields: new Set(['action', 'dialogue', 'camera']) };
  const check = (k, label) => h('label.check', null, h('input', { type: 'checkbox', checked: opts.fields.has(k), onchange: (e) => (e.target.checked ? opts.fields.add(k) : opts.fields.delete(k)) }), label);
  const ok = await modal({
    title: 'Storyboard PDF',
    body: h('div', { style: { display: 'grid', gap: '14px' } },
      field('Layout', select([['6', '6 per page (3 × 2), landscape'], ['4', '4 per page (2 × 2), landscape'], ['9', '9 per page (3 × 3), portrait'], ['3', 'Shot list: 3 per page with all notes, portrait'], ['12', 'Thumbnails: 12 per page (4 × 3)']], opts.layout, (v) => { opts.layout = v; })),
      field('Show under each frame', h('div', { style: { display: 'grid', gap: '8px' } },
        check('action', 'Action / description'), check('dialogue', 'Dialogue / VO'), check('camera', 'Camera (size, angle, move, lens) and length'),
        check('prompt', 'AI prompt'), check('notes', 'Notes'), check('status', 'Status')))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Open print view', primary: true, value: true }],
  });
  if (!ok) return;
  await store.save();
  window.open(`/print.html?p=${encodeURIComponent(store.id)}&layout=${opts.layout}&f=${[...opts.fields].join(',')}`, '_blank');
}

// --- spreadsheet, prompts, zip -----------------------------------------------------------

function exportSheet(store) {
  const cols = ['Scene', 'Scene title', 'Shot', 'Size', 'Angle', 'Movement', 'Lens', 'Length (s)', 'Frames', 'Transition', 'Action', 'Dialogue / VO', 'Status', 'Made with', 'Seed', 'Prompt', 'Notes', 'Frame file'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(q).join(',')];
  for (const x of store.shots()) {
    const s = x.shot;
    lines.push([x.scene.number, x.scene.title, x.code, s.size, s.angle, s.move, s.lens, s.duration, framesOf(s.duration, store.settings.fps), s.transition,
      s.action, s.dialogue, statusOf(s.status).label, s.model, s.seed, fullPrompt(s, store.settings), s.notes, s.frame?.src || ''].map(q).join(','));
  }
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${store.p.name.replace(/[^\w\- ]+/g, '').trim() || 'storyboard'} shot list.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function copyAllPrompts(store) {
  const list = store.shots();
  if (!list.length) return toast('No shots yet');
  await copyText(list.map((x) => `${x.code}${x.shot.duration ? ` (${x.shot.duration}s)` : ''}\n${fullPrompt(x.shot, store.settings)}`).join('\n\n'));
  toast(`${list.length} prompts copied`);
}

async function exportZip(store) {
  await store.save();
  const close = toast('Packaging project…', { timeout: 0 });
  try {
    const r = await api.export(store.id, 'zip');
    close();
    resultDialog('Project packaged', { ...r, storeId: store.id }, h('p.muted', null, 'To open it on another Mac, unzip it into that computer’s Storyboards folder (Documents › Storyboards).'));
  } catch (e) {
    close();
    toast(e.message, { type: 'error' });
  }
}
