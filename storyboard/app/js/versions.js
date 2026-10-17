// Versions view: every shot's evolution tree on one zoomable board. Scenes
// run left to right in story order; under each shot hang its first
// references, and under each of those the variations made from it, so the
// whole project's history reads like a timeline that grows downward.

import { api } from './api.js';
import { addAll, mediaEl } from './shared.js';
import { openReview } from './review.js';
import { addVersion, childrenOf, deleteVersion, openMarks, pickVersion, shotCode, subtreeSize, versionsOf } from './store.js';
import { aspectRatio, fullPrompt, VSTATUS, vstatusOf } from './vocab.js';
import {
  autosize, btn, clamp, confirmDialog, copyText, droppedMedia, field, h, icon, iconBtn, isTyping, menu, mod,
  pickFiles, toast,
} from './ui.js';

const GAP_X = 22, GAP_Y = 56, LANE_GAP = 44, SCENE_GAP = 120, MIN_SCENE_W = 300;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function mount(host, { store, app, opts }) {
  const pid = store.id;
  const prefsKey = `storyboard.tree.${pid}`;
  let prefs = { scene: '', hideEmpty: false, view: null };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(prefsKey) || '{}') }; } catch { /* ignore */ }
  const savePrefs = () => { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch { /* ignore */ } };
  let view = prefs.view || { x: 60, y: 120, z: 0.8 };
  let sel = null;                // { kind: 'node' | 'shot', id }
  let layoutCache = { boxes: new Map(), bounds: null };
  const els = new Map();         // key -> { el, sig }

  // --- DOM --------------------------------------------------------------------------
  const dots = h('div.mb-dots');
  const edgeG = h('g', { svg: true, transform: 'translate(50000 50000)' });
  const svg = h('svg.v-edges', { svg: true, style: { left: '-50000px', top: '-50000px', width: '100000px', height: '100000px' } }, edgeG);
  const world = h('div.mb-world', null, svg);
  const canvas = h('div.mb-canvas.v-canvas', { tabIndex: 0 }, dots, world);
  const sceneSel = h('select.input', { style: { height: '30px', width: '190px' }, onchange: (e) => { prefs.scene = e.target.value; savePrefs(); render(); start(); } });
  const emptyToggle = h('label.check', { title: 'Hide shots that have no versions yet' }, h('input', { type: 'checkbox', checked: prefs.hideEmpty, onchange: (e) => { prefs.hideEmpty = e.target.checked; savePrefs(); render(); start(); } }), 'Only shots with versions');
  const topbar = h('div.v-topbar', null, icon('tree', 15), h('b', null, 'Versions'), sceneSel, emptyToggle,
    h('span.faint.v-legend', null, VSTATUS.map((s) => h('span', { title: s.hint }, h('i', { style: { background: s.color } }), s.label))));
  const zoomLabel = h('button.zoom-label', { type: 'button', title: 'Zoom to 100%', onclick: () => zoomTo(1) }, '100%');
  const toolbar = h('div.mb-toolbar', null,
    iconBtn('minus', 'Zoom out', () => zoomBy(1 / 1.25)), zoomLabel, iconBtn('plus', 'Zoom in', () => zoomBy(1.25)),
    iconBtn('fit', 'Fit everything (F)', () => fit()));
  const stageWrap = h('div.v-stage', null, canvas, topbar, toolbar);
  const panel = h('aside.insp.v-panel');
  const root = h('div.v-view', null, stageWrap, panel);
  host.append(root);

  // --- layout ---------------------------------------------------------------------
  function sizes() {
    const ar = aspectRatio(store.settings.aspect);
    const w = ar >= 1 ? 176 : 118;
    const th = Math.round(Math.min(220, w / ar));
    return { w, th, nodeH: th + 38, shotH: th + 64 };
  }

  function layout() {
    const { w, nodeH, shotH } = sizes();
    const boxes = new Map();
    const edges = [];
    const scenes = [];
    const p = store.p;
    const width = (v) => {
      const kids = childrenOf(p, v.id);
      return kids.length ? Math.max(w, kids.reduce((s, k) => s + width(k), 0) + GAP_X * (kids.length - 1)) : w;
    };
    const place = (v, left, y, lineage) => {
      const span = width(v);
      const x = left + span / 2 - w / 2;
      boxes.set(v.id, { kind: 'node', id: v.id, x, y, w, h: nodeH, v, lineage: lineage.has(v.id) });
      const kids = childrenOf(p, v.id);
      const kidsW = kids.reduce((s, k) => s + width(k), 0) + GAP_X * Math.max(0, kids.length - 1);
      let kx = left + (span - kidsW) / 2;
      for (const k of kids) {
        const kw = width(k);
        const cx = kx + kw / 2;
        edges.push({ x1: x + w / 2, y1: y + nodeH, x2: cx, y2: y + nodeH + GAP_Y, on: lineage.has(k.id) });
        place(k, kx, y + nodeH + GAP_Y, lineage);
        kx += kw + GAP_X;
      }
    };
    let x = 0;
    for (const scene of p.scenes) {
      if (prefs.scene && prefs.scene !== scene.id) continue;
      const lanes = [];
      for (const shot of scene.shots) {
        const all = versionsOf(p, shot.id);
        // "Only shots with versions" hides the rest, except the one you came to work on.
        const focused = sel && (sel.id === shot.id || (sel.kind === 'node' && store.version(sel.id)?.shot === shot.id));
        if (prefs.hideEmpty && !all.length && !focused) continue;
        const roots = all.filter((v) => !v.parent || !all.some((o) => o.id === v.parent)).sort((a, b) => a.created - b.created);
        const rootsW = roots.reduce((s, r) => s + width(r), 0) + GAP_X * Math.max(0, roots.length - 1);
        lanes.push({ shot, all, roots, rootsW, laneW: Math.max(w, rootsW) });
      }
      if (!lanes.length) continue;
      // Narrow scenes get room for their title; their lanes sit centred under it.
      const lanesW = lanes.reduce((s, l) => s + l.laneW, 0) + LANE_GAP * (lanes.length - 1);
      const sceneW = Math.max(MIN_SCENE_W, lanesW);
      const x0 = x;
      x += (sceneW - lanesW) / 2;
      let vcount = 0;
      for (const { shot, all, roots, rootsW, laneW } of lanes) {
        vcount += all.length;
        // The path from the first reference to the picked version is highlighted.
        const lineage = new Set();
        let cur = all.find((v) => v.status === 'picked');
        while (cur) { lineage.add(cur.id); cur = all.find((v) => v.id === cur.parent); }
        const sx = x + laneW / 2 - w / 2;
        boxes.set(shot.id, { kind: 'shot', id: shot.id, x: sx, y: 0, w, h: shotH, shot, scene, total: all.length, open: all.reduce((n, v) => n + openMarks(v).length, 0) });
        const rowY = shotH + GAP_Y;
        if (!roots.length) {
          boxes.set(`add:${shot.id}`, { kind: 'add', id: `add:${shot.id}`, shotId: shot.id, x: sx, y: rowY, w, h: nodeH });
          edges.push({ x1: sx + w / 2, y1: shotH, x2: sx + w / 2, y2: rowY, dashed: true });
        }
        let rx = x + (laneW - rootsW) / 2;
        for (const r of roots) {
          const rw = width(r);
          edges.push({ x1: sx + w / 2, y1: shotH, x2: rx + rw / 2, y2: rowY, on: lineage.has(r.id) });
          place(r, rx, rowY, lineage);
          rx += rw + GAP_X;
        }
        x += laneW + LANE_GAP;
      }
      scenes.push({ id: scene.id, scene, x: x0, w: sceneW, count: lanes.length, vcount });
      x = x0 + sceneW + SCENE_GAP;
    }
    let x1 = Infinity, y1 = -90, x2 = -Infinity, y2 = 0;
    for (const b of boxes.values()) { x1 = Math.min(x1, b.x); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
    return { boxes, edges, scenes, bounds: boxes.size ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null };
  }

  // --- rendering --------------------------------------------------------------------
  function render() {
    sceneSel.replaceChildren(h('option', { value: '' }, 'All scenes'),
      ...store.p.scenes.map((s) => h('option', { value: s.id, selected: prefs.scene === s.id }, `SC${String(s.number).padStart(2, '0')} ${s.title || ''}`)));
    if (prefs.scene && !store.scene(prefs.scene)) prefs.scene = '';
    const L = layout();
    layoutCache = L;
    const seen = new Set();
    const keep = (key, sig, build, b) => {
      seen.add(key);
      let e = els.get(key);
      if (!e) { e = { el: h('div') }; els.set(key, e); world.append(e.el); }
      if (e.sig !== sig) {
        e.sig = sig;
        const fresh = build();
        e.el.replaceWith(fresh);
        e.el = fresh;
      }
      Object.assign(e.el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: b.h ? `${b.h}px` : '' });
      return e.el;
    };
    const { th } = sizes();
    for (const s of L.scenes) {
      keep(`scene:${s.id}`, JSON.stringify([s.scene.number, s.scene.title, s.count, s.vcount]), () => h('div.v-scene', { dataset: { scene: s.id }, title: s.scene.title || '' },
        h('span.scene-num', null, `SC${String(s.scene.number).padStart(2, '0')}`), h('b', null, s.scene.title || 'Untitled scene'),
        h('span.faint', null, `${s.count} shot${s.count === 1 ? '' : 's'} · ${s.vcount} version${s.vcount === 1 ? '' : 's'}`)), { x: s.x, y: -78, w: s.w });
    }
    for (const b of L.boxes.values()) {
      const isSel = sel && sel.id === b.id;
      if (b.kind === 'shot') {
        const code = shotCode(b.scene, b.shot);
        const sig = JSON.stringify([code, b.shot.frame?.src, b.shot.action, b.total, b.open, isSel, th]);
        keep(b.id, sig, () => h(`div.v-shot${isSel ? '.sel' : ''}`, { dataset: { shot: b.id } },
          h('div.v-shot-head', null, h('span.mono', null, code.replace('_', ' · ')), h('span.faint', null, b.total ? `${b.total}` : '')),
          h('div.v-thumb', { style: { height: `${th}px` } }, b.shot.frame ? mediaEl(pid, b.shot.frame) : h('div.v-ph', null, icon('image', 18))),
          h('div.v-shot-act', null, b.shot.action || h('span.faint', null, 'No description')),
          b.open ? h('span.v-open', { title: 'Open notes' }, icon('marker', 11), b.open) : null), b);
      } else if (b.kind === 'add') {
        keep(b.id, `add:${th}`, () => h('div.v-add', { dataset: { add: b.shotId }, title: 'Drop the first references for this shot, or click to browse' },
          icon('plus', 18), h('span', null, 'Drop references'), h('small.faint', null, 'or click to browse')), b);
      } else {
        const v = b.v;
        const st = vstatusOf(v.status);
        const open = openMarks(v).length;
        const sig = JSON.stringify([v.label, v.media?.src, v.status, open, v.marks.length, v.by, v.prompt?.slice(0, 120), b.lineage, isSel, th]);
        keep(b.id, sig, () => h(`div.v-node${isSel ? '.sel' : ''}${b.lineage ? '.lineage' : ''}${v.status === 'picked' ? '.picked' : ''}`, { dataset: { node: v.id }, style: { '--st': st.color } },
          h('div.v-thumb', { style: { height: `${th}px` } },
            v.media ? mediaEl(pid, v.media, { hoverPlay: true }) : h('div.v-ph.v-ph-prompt', null, h('b', null, 'Waiting for image'), h('span', null, v.prompt || 'Drop the generated image here')),
            h('span.badge.v-label', null, `v${v.label}`),
            open ? h('span.v-open', { title: `${open} open note${open > 1 ? 's' : ''}` }, icon('marker', 11), open) : null,
            v.by === 'claude' ? h('span.v-by', { title: 'Prompt written by Claude' }, icon('sparkle', 11), 'Claude') : null),
          h('div.v-foot', null, h('i', { style: { background: st.color } }), h('span', null, st.label), h('span.grow'), h('span.faint', null, fmtDate(v.created)))), b);
      }
    }
    for (const [key, e] of els) if (!seen.has(key)) { e.el.remove(); els.delete(key); }
    edgeG.replaceChildren(...L.edges.map((e) => {
      const my = (e.y1 + e.y2) / 2;
      return h(`path${e.on ? '.on' : ''}${e.dashed ? '.dashed' : ''}`, { svg: true, d: `M${e.x1},${e.y1} V${my} H${e.x2} V${e.y2}` });
    }));
    if (!L.boxes.size) {
      if (!root.querySelector('.v-empty')) {
        stageWrap.append(h('div.v-empty', null, h('h3', null, prefs.hideEmpty ? 'No versions yet' : 'No shots yet'),
          h('p.muted', null, prefs.hideEmpty ? 'Untick “Only shots with versions” to drop references onto any shot.' : 'Add shots on the Storyboard tab and they appear here.')));
      }
    } else root.querySelector('.v-empty')?.remove();
    renderPanel();
  }

  // --- view ------------------------------------------------------------------------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    const g = 24 * view.z;
    dots.style.backgroundSize = `${g}px ${g}px`;
    dots.style.backgroundPosition = `${view.x}px ${view.y}px`;
    dots.style.opacity = view.z < 0.3 ? 0 : 1;
    zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
    prefs.view = view;
    clearTimeout(applyView.t);
    applyView.t = setTimeout(savePrefs, 400);
  }
  function zoomAt(z, cx, cy) {
    const r = canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const nz = clamp(z, 0.08, 2.5);
    view = { x: px - ((px - view.x) / view.z) * nz, y: py - ((py - view.y) / view.z) * nz, z: nz };
    applyView();
  }
  const zoomBy = (f) => { const r = canvas.getBoundingClientRect(); zoomAt(view.z * f, r.left + r.width / 2, r.top + r.height / 2); };
  const zoomTo = (z) => { const r = canvas.getBoundingClientRect(); zoomAt(z, r.left + r.width / 2, r.top + r.height / 2); };
  function fit(b = layoutCache.bounds) {
    const r = canvas.getBoundingClientRect();
    if (!b || !r.width) return applyView();
    const pad = 70;
    const z = clamp(Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2 - 50) / b.h), 0.08, 1.1);
    view = { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: (r.height - 40) / 2 - (b.y + b.h / 2) * z + 20 };
    applyView();
  }
  // Big projects don't fit at a readable size, so start at the first scene
  // and let the rest scroll in from the right (F still fits everything).
  function start(b = layoutCache.bounds) {
    const r = canvas.getBoundingClientRect();
    if (!b || !r.width) return applyView();
    const pad = 70;
    const fitsZ = Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2 - 50) / b.h);
    if (fitsZ >= 0.5) return fit(b);
    const z = clamp((r.height - pad * 2 - 50) / b.h, 0.5, 0.9);
    view = { z, x: pad - b.x * z, y: (r.height - 40) / 2 - (b.y + b.h / 2) * z + 20 };
    applyView();
  }
  function focusShot(shotId) {
    const boxes = [...layoutCache.boxes.values()].filter((b) => b.id === shotId || b.v?.shot === shotId || b.shotId === shotId);
    if (!boxes.length) return;
    const x1 = Math.min(...boxes.map((b) => b.x)), x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    const r = canvas.getBoundingClientRect();
    const z = clamp(Math.min(1, (r.width - 160) / (x2 - x1), (r.height - 160) / (y2 + 90)), 0.2, 1);
    view = { z, x: r.width / 2 - ((x1 + x2) / 2) * z, y: 110 };
    applyView();
  }

  // --- side panel ------------------------------------------------------------------------
  function renderPanel() {
    const focusedField = panel.contains(document.activeElement) && document.activeElement.dataset.vfield;
    const keepScroll = panel.scrollTop;
    if (sel?.kind === 'node' && store.version(sel.id)) {
      if (focusedField && panel.dataset.for === sel.id) return refreshPanelState();
      panel.replaceChildren(...nodePanel(store.version(sel.id)));
    } else if (sel?.kind === 'shot' && store.find(sel.id)) {
      panel.replaceChildren(...shotPanel(store.find(sel.id)));
    } else {
      sel = null;
      panel.replaceChildren(overview());
    }
    if (panel.dataset.for === (sel?.id || '')) panel.scrollTop = keepScroll;
    panel.dataset.for = sel?.id || '';
  }

  // Status buttons and notes change while someone types in the prompt box.
  function refreshPanelState() {
    const v = store.version(sel.id);
    panel.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('on', b.dataset.status === v.status));
    const notes = panel.querySelector('.v-notes');
    if (notes) notes.replaceWith(notesBlock(v));
  }

  const setV = (id, fields, key = null) => store.update(() => { const v = store.version(id); if (v) Object.assign(v, fields); }, { key, source: key ? 'versions-panel' : null });

  function notesBlock(v) {
    const open = openMarks(v);
    const done = v.marks.length - open.length;
    return h('div.v-notes', null,
      h('div.sec-head', null, h('h4', null, 'Mark-up notes'), h('span.faint', null, v.marks.length ? `${open.length} open · ${done} resolved` : 'none yet')),
      ...v.marks.map((m) => h(`div.v-note${m.done ? '.done' : ''}`, null,
        h('span.rv-pin', { style: { background: m.done ? '#35c27e' : '#ff4d4f' } }, m.n),
        h('div', null, h('div', null, m.note || h('span.faint', null, '(no text)')), m.reply ? h('div.rv-reply', null, m.reply) : null))),
      v.media ? btn(v.marks.length ? 'Review & mark up' : 'Mark up this image', () => openReview(store, v.id), { icon: 'marker', cls: 'small' }) : null);
  }

  function nodePanel(v) {
    const f = store.find(v.shot);
    const code = f ? shotCode(f.scene, f.shot) : '';
    const kids = childrenOf(store.p, v.id).length;
    const preview = h('div.insp-frame', {
      title: v.media ? 'Double-click to mark up' : 'Drop the generated image here',
      ondblclick: () => v.media && openReview(store, v.id),
      ondragover: (e) => { e.preventDefault(); preview.classList.add('file-over'); },
      ondragleave: () => preview.classList.remove('file-over'),
      ondrop: (e) => { e.preventDefault(); preview.classList.remove('file-over'); dropOnNode(v.id, e.dataTransfer); },
    }, v.media ? mediaEl(pid, v.media, { controls: v.media.kind === 'video' }) : h('div.frame-empty', { onclick: async () => fillNode(v.id, await pickFiles({ multiple: false })) }, icon('image', 22), h('span', null, 'Drop the generated image or clip here, or click to browse')));
    const promptIn = autosize(h('textarea.input.prompt-box', {
      rows: 3, value: v.prompt || '', dataset: { vfield: 'prompt' }, placeholder: 'The prompt this version was made with (or should be made with)',
      oninput: (e) => setV(v.id, { prompt: e.target.value }, `v:${v.id}:prompt`),
    }));
    const noteIn = autosize(h('textarea.input', {
      rows: 2, value: v.note || '', dataset: { vfield: 'note' }, placeholder: 'Why keep it, or what to change next',
      oninput: (e) => setV(v.id, { note: e.target.value }, `v:${v.id}:note`),
    }));
    return [
      h('div.insp-head', null, h('span.insp-code', null, `${code} · v${v.label}`), h('div.grow'),
        v.by === 'claude' ? h('span.v-by.inline', null, icon('sparkle', 11), 'Claude') : null,
        iconBtn('dots', 'Version actions', (e) => { const r = e.currentTarget.getBoundingClientRect(); nodeMenu(r.left - 160, r.bottom + 4, v); }, 'small')),
      preview,
      h('div.insp-section', null,
        h('div.v-status', null, VSTATUS.map((s) => h(`button${v.status === s.id ? '.on' : ''}`, {
          type: 'button', title: s.hint, dataset: { status: s.id }, style: { '--st': s.color },
          onclick: () => (s.id === 'picked' ? pick(v.id) : setV(v.id, { status: s.id })),
        }, h('i'), s.label))),
        v.status === 'picked' ? h('p.faint', { style: { margin: 0, fontSize: '12px' } }, `This is ${code}’s frame on the storyboard.`)
          : v.media ? btn('Pick as final', () => pick(v.id), { icon: 'check', cls: 'small primary' }) : null),
      h('div.insp-section', null, notesBlock(v)),
      h('div.insp-section', null,
        h('div.sec-head', null, h('h4', null, 'Prompt'), btn('Copy', async () => { await copyText(fullPrompt({ ...f?.shot, prompt: store.version(v.id).prompt }, store.settings)); toast('Prompt copied'); }, { icon: 'copy', cls: 'small ghost' })),
        promptIn,
        field('Note', noteIn)),
      h('div.insp-section', null,
        h('div.v-actions', null,
          btn('Add variation', () => newChild(v.id), { icon: 'plus', cls: 'small', title: 'An empty version under this one, for the next prompt' }),
          btn('Add images as variations…', async () => addChildren(v.id, await pickFiles()), { icon: 'upload', cls: 'small' }),
          btn('Copy request for Claude', () => copyRequest(v), { icon: 'sparkle', cls: 'small', title: 'A message to paste into Claude' }),
          btn(kids ? `Delete with ${subtreeSize(store.p, v.id) - 1} below` : 'Delete', () => removeNode(v.id), { icon: 'trash', cls: 'small danger' })),
        h('p.faint', { style: { margin: 0, fontSize: '12px' } }, `Added ${new Date(v.created || Date.now()).toLocaleString()} by ${v.by === 'claude' ? 'Claude' : 'you'}`)),
    ];
  }

  function shotPanel(f) {
    const all = versionsOf(store.p, f.shot.id);
    const code = shotCode(f.scene, f.shot);
    return [
      h('div.insp-head', null, h('span.insp-code', null, code), h('div.grow'), btn('Open on Storyboard', () => { app.select([f.shot.id]); app.go('board'); }, { cls: 'small ghost' })),
      h('div.insp-frame', null, f.shot.frame ? mediaEl(pid, f.shot.frame, { controls: f.shot.frame.kind === 'video' }) : h('div.frame-empty', null, icon('image', 22), h('span', null, 'No frame picked yet'))),
      h('div.insp-section', null,
        h('p', { style: { margin: 0 } }, f.shot.action || h('span.faint', null, 'No description')),
        h('p.faint', { style: { margin: 0, fontSize: '12px' } }, `${all.length} version${all.length === 1 ? '' : 's'} · ${all.filter((v) => v.status === 'option').length} options · ${all.reduce((n, v) => n + openMarks(v).length, 0)} open notes`),
        h('div.v-actions', null,
          btn('Add references…', async () => addRoots(f.shot.id, await pickFiles()), { icon: 'upload', cls: 'small primary' }),
          btn('Empty version', () => newRoot(f.shot.id), { icon: 'plus', cls: 'small', title: 'A placeholder for a prompt you haven’t generated yet' }))),
    ];
  }

  function overview() {
    const all = store.p.versions.filter((v) => store.find(v.shot));
    const open = all.reduce((n, v) => n + openMarks(v).length, 0);
    const k = (keys, what) => [h('span', null, keys.split(' ').map((x) => h('kbd', null, x))), h('span', null, what)];
    return h('div.overview', null,
      h('h3', null, 'Versions'),
      h('div.big-stats', null,
        h('div.big-stat', null, h('b', null, all.length), h('span', null, 'versions')),
        h('div.big-stat', null, h('b', null, all.filter((v) => v.status === 'picked').length), h('span', null, 'picked')),
        h('div.big-stat', null, h('b', null, open), h('span', null, 'open notes'))),
      h('div.legend', null, VSTATUS.map((s) => h('div', null, h('i', { style: { background: s.color } }), `${s.label}: ${s.hint}`))),
      h('div', null, h('h4.muted', { style: { margin: '0 0 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'How it works'),
        h('div.shortcuts', null,
          k('Drop', 'Images onto a shot → its first references'),
          k('Drop', 'Images onto a version → variations of it'),
          k('Dbl-click', 'Mark up a version for Claude'),
          k('P', 'Pick the selected version as final'),
          k('↑ ↓ ← →', 'Move around the tree'),
          k('⌫', 'Delete a version (and what grew from it)'),
          k('F', 'Fit everything'))));
  }

  // --- edits -----------------------------------------------------------------------------
  const choose = (s) => {
    sel = s;
    render();
    store.setPresence({ view: 'versions', version: s?.kind === 'node' ? s.id : null, shot: s ? (s.kind === 'shot' ? s.id : store.version(s.id)?.shot) : null });
  };

  function pick(id) {
    store.update((p) => pickVersion(p, id));
    const v = store.version(id);
    const f = store.find(v.shot);
    if (f) toast(`v${v.label} is now ${shotCode(f.scene, f.shot)}’s frame`);
  }

  async function addRoots(shotId, inputs) {
    const refs = (await addAll(pid, inputs)).filter((r) => r.kind !== 'audio');
    if (!refs.length) return;
    const made = store.update((p) => refs.map((r) => addVersion(p, shotId, null, { media: mediaOf(r) })));
    choose({ kind: 'node', id: made[0].id });
  }

  async function addChildren(parentId, inputs) {
    const refs = (await addAll(pid, inputs)).filter((r) => r.kind !== 'audio');
    if (!refs.length) return;
    const parent = store.version(parentId);
    const made = store.update((p) => refs.map((r) => addVersion(p, parent.shot, parentId, { media: mediaOf(r), prompt: parent.prompt })));
    if (parent.status === 'new') setV(parentId, { status: 'rework' });
    choose({ kind: 'node', id: made[0].id });
  }

  // A placeholder (Claude's next prompt, say) gets the first file; extra
  // files become its siblings.
  async function fillNode(id, inputs) {
    const refs = (await addAll(pid, inputs)).filter((r) => r.kind !== 'audio');
    if (!refs.length) return;
    const v = store.version(id);
    store.update((p) => {
      const x = p.versions.find((n) => n.id === id);
      x.media = mediaOf(refs[0]);
      for (const r of refs.slice(1)) addVersion(p, x.shot, x.parent, { media: mediaOf(r), prompt: x.prompt });
    });
    choose({ kind: 'node', id: v.id });
  }

  function dropOnNode(id, dt) {
    const m = droppedMedia(dt);
    const inputs = m.files || (m.url ? [m.url] : []);
    if (!inputs.length) return;
    const v = store.version(id);
    v.media ? addChildren(id, inputs) : fillNode(id, inputs);
  }

  function newChild(parentId) {
    const parent = store.version(parentId);
    const v = store.update((p) => addVersion(p, parent.shot, parentId, { prompt: parent.prompt }));
    choose({ kind: 'node', id: v.id });
    requestAnimationFrame(() => panel.querySelector('[data-vfield="prompt"]')?.focus());
  }

  function newRoot(shotId) {
    const v = store.update((p) => addVersion(p, shotId, null, { prompt: store.find(shotId)?.shot.prompt || '' }));
    choose({ kind: 'node', id: v.id });
  }

  async function removeNode(id) {
    const n = subtreeSize(store.p, id);
    const v = store.version(id);
    if (n > 1 && !(await confirmDialog(`Delete v${v.label} and the ${n - 1} version${n > 2 ? 's' : ''} that grew from it? The image files stay in the project folder.`, { title: 'Delete versions?', ok: 'Delete', danger: true }))) return;
    const parent = v.parent;
    store.update((p) => deleteVersion(p, id));
    sel = parent && store.version(parent) ? { kind: 'node', id: parent } : { kind: 'shot', id: v.shot };
    render();
    toast(`Deleted ${n} version${n > 1 ? 's' : ''}`, { action: 'Undo', onAction: () => store.undo() });
  }

  async function copyRequest(v) {
    const f = store.find(v.shot);
    const open = openMarks(v).length;
    await copyText(`In Storyboard, look at ${f ? shotCode(f.scene, f.shot) : 'this shot'} v${v.label}${open ? ` and my ${open} open note${open > 1 ? 's' : ''} on it` : ''}, then write the prompt for the next variation as a new version under it.`);
    toast('Copied. Paste it into Claude.');
  }

  function nodeMenu(x, y, v) {
    menu(x, y, [
      v.media && { label: 'Mark up…', icon: 'marker', kbd: 'Enter', onClick: () => openReview(store, v.id) },
      v.media && v.status !== 'picked' && { label: 'Pick as final', icon: 'check', kbd: 'P', onClick: () => pick(v.id) },
      { heading: 'Status' },
      ...VSTATUS.map((s) => ({ label: s.label, swatch: s.color, checked: v.status === s.id, onClick: () => (s.id === 'picked' ? pick(v.id) : setV(v.id, { status: s.id })) })),
      '-',
      { label: 'Add variation', icon: 'plus', onClick: () => newChild(v.id) },
      { label: 'Add images as variations…', icon: 'upload', onClick: async () => addChildren(v.id, await pickFiles()) },
      { label: 'Copy request for Claude', icon: 'sparkle', onClick: () => copyRequest(v) },
      v.media && { label: 'Show file in Finder', icon: 'folder', onClick: () => api.reveal(pid, v.media.src) },
      '-',
      { label: 'Delete', icon: 'trash', kbd: '⌫', danger: true, onClick: () => removeNode(v.id) },
    ]);
  }

  // --- pointer ----------------------------------------------------------------------------
  let spaceHeld = false;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    const target = e.target.closest('[data-node],[data-shot],[data-add]');
    if (e.button === 1 || (e.button === 0 && (spaceHeld || !target))) {
      e.preventDefault();
      const ox = view.x, oy = view.y, sx = e.clientX, sy = e.clientY;
      let moved = false;
      canvas.classList.add('panning');
      const move = (ev) => { moved = true; view = { ...view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }; applyView(); };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        canvas.classList.remove('panning');
        if (!moved && !target && sel) choose(null);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0 || !target) return;
    if (target.dataset.node) choose({ kind: 'node', id: target.dataset.node });
    else if (target.dataset.shot) choose({ kind: 'shot', id: target.dataset.shot });
    else if (target.dataset.add) pickFiles().then((files) => addRoots(target.dataset.add, files));
  });
  canvas.addEventListener('dblclick', (e) => {
    const n = e.target.closest('[data-node]');
    if (n && store.version(n.dataset.node)?.media) openReview(store, n.dataset.node);
  });
  canvas.addEventListener('contextmenu', (e) => {
    const n = e.target.closest('[data-node]');
    const s = e.target.closest('[data-shot]');
    if (!n && !s) return;
    e.preventDefault();
    if (n) { choose({ kind: 'node', id: n.dataset.node }); nodeMenu(e.clientX, e.clientY, store.version(n.dataset.node)); }
    else {
      choose({ kind: 'shot', id: s.dataset.shot });
      menu(e.clientX, e.clientY, [
        { label: 'Add references…', icon: 'upload', onClick: async () => addRoots(s.dataset.shot, await pickFiles()) },
        { label: 'Empty version', icon: 'plus', onClick: () => newRoot(s.dataset.shot) },
        { label: 'Open on Storyboard', icon: 'board', onClick: () => { app.select([s.dataset.shot]); app.go('board'); } },
      ]);
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(view.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0085)), e.clientX, e.clientY);
    else { view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY }; applyView(); }
  }, { passive: false });

  // Drag images from Finder or Higgsfield onto a shot or a version.
  canvas.addEventListener('dragover', (e) => {
    const t = e.target.closest('[data-node],[data-shot],[data-add]');
    canvas.querySelectorAll('.file-over').forEach((x) => x !== t && x.classList.remove('file-over'));
    if (t) { e.preventDefault(); t.classList.add('file-over'); }
  });
  canvas.addEventListener('dragleave', (e) => { if (!canvas.contains(e.relatedTarget)) canvas.querySelectorAll('.file-over').forEach((x) => x.classList.remove('file-over')); });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    canvas.querySelectorAll('.file-over').forEach((x) => x.classList.remove('file-over'));
    const t = e.target.closest('[data-node],[data-shot],[data-add]');
    if (!t) return toast('Drop onto a shot to add references, or onto a version to add variations of it');
    const m = droppedMedia(e.dataTransfer);
    const inputs = m.files || (m.url ? [m.url] : []);
    if (!inputs.length) return;
    if (t.dataset.node) dropOnNode(t.dataset.node, e.dataTransfer);
    else addRoots(t.dataset.shot || t.dataset.add, inputs);
  });

  // --- keys ------------------------------------------------------------------------------
  function move(dir) {
    if (!sel) return;
    if (sel.kind === 'shot') {
      const roots = versionsOf(store.p, sel.id).filter((v) => !v.parent).sort((a, b) => a.created - b.created);
      if (dir === 'down' && roots[0]) choose({ kind: 'node', id: roots[0].id });
      return;
    }
    const v = store.version(sel.id);
    if (dir === 'up') return choose(v.parent ? { kind: 'node', id: v.parent } : { kind: 'shot', id: v.shot });
    if (dir === 'down') { const k = childrenOf(store.p, v.id)[0]; if (k) choose({ kind: 'node', id: k.id }); return; }
    const sibs = v.parent ? childrenOf(store.p, v.parent) : versionsOf(store.p, v.shot).filter((x) => !x.parent).sort((a, b) => a.created - b.created);
    const i = sibs.findIndex((x) => x.id === v.id) + (dir === 'right' ? 1 : -1);
    if (sibs[i]) choose({ kind: 'node', id: sibs[i].id });
  }

  function onKey(e) {
    if (e.key === ' ' && !isTyping(e)) { spaceHeld = e.type === 'keydown'; e.preventDefault(); return true; }
    if (isTyping(e) || mod(e) || e.altKey) return false;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.key]) { e.preventDefault(); move(map[e.key]); return true; }
    if (e.key === 'f' || e.key === 'F') { fit(); return true; }
    if (e.key === 'Escape' && sel) { choose(null); return true; }
    if (sel?.kind === 'node') {
      const v = store.version(sel.id);
      if (e.key === 'Enter' && v.media) { e.preventDefault(); openReview(store, v.id); return true; }
      if ((e.key === 'p' || e.key === 'P') && v.media) { pick(v.id); return true; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeNode(v.id); return true; }
    }
    return false;
  }
  const onKeyUp = (e) => { if (e.key === ' ') spaceHeld = false; };
  addEventListener('keyup', onKeyUp);

  // Typing in the panel re-renders the tree but keeps the field being edited.
  const offChange = store.on('change', () => {
    if (sel?.kind === 'node' && !store.version(sel.id)) sel = null;
    render();
  });

  // --- start ------------------------------------------------------------------------------
  render();
  if (opts?.version && store.version(opts.version)) sel = { kind: 'node', id: opts.version };
  else if (opts?.shot && store.find(opts.shot)) sel = { kind: 'shot', id: opts.shot };
  else if (app.current && store.find(app.current)) sel = { kind: 'shot', id: app.current };
  render();
  requestAnimationFrame(() => {
    if (opts?.shot || opts?.version || (!prefs.view && sel)) focusShot(sel?.kind === 'node' ? store.version(sel.id).shot : sel.id);
    else if (prefs.view) applyView();
    else start();
  });

  return {
    onKey,
    refresh: render,
    unmount: () => {
      offChange();
      removeEventListener('keyup', onKeyUp);
      savePrefs();
      if (sel) {
        const shotId = sel.kind === 'shot' ? sel.id : store.version(sel.id)?.shot;
        if (shotId) { app.selection = new Set([shotId]); app.current = shotId; }
      }
      root.remove();
    },
  };
}

const mediaOf = (r) => ({ src: r.src, kind: r.kind, w: r.w, h: r.h, duration: r.duration, name: r.name });
