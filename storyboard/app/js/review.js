// Mark-up review: circle, box, arrow or scribble on a version's image and
// attach a numbered note to each mark ("replace this table with an oak
// one"). Claude reads the notes plus a snapshot of the image with the marks
// drawn on it, and answers them in the next variation.

import { addMedia, mediaUrl } from './api.js';
import { mediaEl } from './shared.js';
import { shotCode } from './store.js';
import { autosize, btn, clamp, copyText, h, icon, iconBtn, isTyping, mod, toast, uid } from './ui.js';

const TOOLS = [['select', 'cursor', 'Move / select', 'V'], ['ellipse', 'circle', 'Circle', 'O'], ['rect', 'square', 'Box', 'R'], ['arrow', 'arrow', 'Arrow', 'A'], ['pen', 'pen', 'Draw', 'P']];
const RED = '#ff4d4f';
const DONE = '#35c27e';

export function openReview(store, versionId, { onClose } = {}) {
  const pid = store.id;
  const get = () => store.version(versionId);
  const v0 = get();
  if (!v0?.media) { toast('Add an image to this version first'); return null; }
  const where = () => {
    const f = store.find(get()?.shot);
    return f ? `${shotCode(f.scene, f.shot)} · v${get().label}` : `v${get()?.label}`;
  };
  const startMarks = JSON.stringify(v0.marks);
  let tool = v0.marks.length ? 'select' : 'ellipse';
  let selected = null;
  let showNotes = true;
  let box = { w: 1, h: 1 };

  // --- DOM ---------------------------------------------------------------------
  const media = mediaEl(pid, v0.media, { controls: v0.media.kind === 'video', muted: true, loop: false });
  media.classList.add('rv-media');
  media.draggable = false;
  const svg = h('svg.rv-marks', { svg: true });
  const bubbles = h('div.rv-bubbles');
  const frame = h('div.rv-frame', null, media, svg, bubbles);
  const stage = h('div.rv-stage', null, frame);
  const list = h('div.rv-list');
  const noteIn = autosize(h('textarea.input', {
    rows: 2, placeholder: 'Overall note for this version (optional)', value: v0.note || '',
    oninput: (e) => store.update(() => { get().note = e.target.value; }, { key: `vnote:${versionId}`, source: 'review' }),
  }));
  const toolBtns = Object.fromEntries(TOOLS.map(([id, ic, label, key]) => [id, iconBtn(ic, `${label} (${key})`, () => setTool(id))]));
  const notesToggle = h('label.check', { title: 'Show the sticky notes on the image' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => { showNotes = e.target.checked; draw(); } }), 'Notes on image');
  const title = h('b');
  const root = h('div.review', { role: 'dialog', 'aria-label': 'Mark up' },
    h('header.rv-head', null,
      h('div.rv-title', null, icon('marker', 16), title, h('span.faint', null, 'Mark up')),
      h('div.rv-tools', null, ...Object.values(toolBtns), h('span.sep'), notesToggle),
      h('div.row', null, btn('Copy request for Claude', copyRequest, { icon: 'sparkle', cls: 'small', title: 'Copies a message you can paste to Claude' }),
        btn('Done', close, { cls: 'small primary' }))),
    stage,
    h('aside.rv-side', null,
      h('div.rv-sec', null, h('h4', null, 'Notes for Claude'), h('p.faint', null, 'Draw on the image, then say what should change. Claude uses these to write the next variation.')),
      h('div.rv-sec', null, noteIn),
      list));
  document.body.append(root);

  function setTool(t) {
    tool = t;
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === t);
    stage.classList.toggle('drawing', t !== 'select');
  }

  // Fit the media inside the stage, keeping its shape.
  function fit() {
    const v = get();
    const mw = v.media.w || media.naturalWidth || media.videoWidth || 16;
    const mh = v.media.h || media.naturalHeight || media.videoHeight || 9;
    const r = stage.getBoundingClientRect();
    const scale = Math.min((r.width - 48) / mw, (r.height - 48) / mh);
    box = { w: Math.max(50, mw * scale), h: Math.max(50, mh * scale) };
    Object.assign(frame.style, { width: `${box.w}px`, height: `${box.h}px` });
    svg.setAttribute('width', box.w);
    svg.setAttribute('height', box.h);
    draw();
  }

  // --- drawing marks -------------------------------------------------------------
  const P = (x, y) => [x * box.w, y * box.h];

  function shapeEl(m, extra = {}) {
    const color = m.done ? DONE : RED;
    const common = { svg: true, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra };
    const parts = [];
    const both = (tag, attrs) => {
      parts.push(h(tag, { ...common, ...attrs, stroke: 'rgba(0,0,0,.55)', 'stroke-width': 6 }));
      parts.push(h(tag, { ...common, ...attrs, stroke: color, 'stroke-width': 3, 'stroke-dasharray': m.done ? '7 6' : null }));
    };
    if (m.shape === 'ellipse') {
      const [x, y] = P(m.x + m.w / 2, m.y + m.h / 2);
      both('ellipse', { cx: x, cy: y, rx: (m.w * box.w) / 2, ry: (m.h * box.h) / 2 });
    } else if (m.shape === 'rect') {
      const [x, y] = P(m.x, m.y);
      both('rect', { x, y, width: m.w * box.w, height: m.h * box.h, rx: 4 });
    } else if (m.shape === 'arrow' && m.pts?.length === 2) {
      const [[x1, y1], [x2, y2]] = m.pts.map(([a, b]) => P(a, b));
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 16;
      const head = `M${x2 - L * Math.cos(ang - 0.45)},${y2 - L * Math.sin(ang - 0.45)} L${x2},${y2} L${x2 - L * Math.cos(ang + 0.45)},${y2 - L * Math.sin(ang + 0.45)}`;
      both('path', { d: `M${x1},${y1} L${x2},${y2} ${head}` });
    } else if (m.shape === 'pen' && m.pts?.length > 1) {
      both('path', { d: m.pts.map(([a, b], i) => `${i ? 'L' : 'M'}${P(a, b).join(',')}`).join(' ') });
    }
    return parts;
  }

  const anchorOf = (m) => (m.shape === 'ellipse' || m.shape === 'rect' ? [m.x, m.y] : m.pts?.[0] || [0, 0]);

  function draw(live) {
    const v = get();
    if (!v) return close();
    title.textContent = where();
    svg.replaceChildren();
    bubbles.replaceChildren();
    for (const m of [...v.marks, ...(live ? [live] : [])]) {
      const g = h('g', { svg: true, class: `rv-mark${m.id === selected ? ' sel' : ''}`, dataset: { mark: m.id } }, ...shapeEl(m));
      // invisible fat outline so thin shapes are easy to grab
      const hit = shapeEl(m)[1];
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', 16);
      hit.removeAttribute('stroke-dasharray');
      g.append(hit);
      if (m.n) {
        const [ax, ay] = P(...anchorOf(m));
        g.append(h('circle', { svg: true, cx: ax, cy: ay, r: 11, fill: m.done ? DONE : RED, stroke: '#fff', 'stroke-width': 2 }),
          h('text', { svg: true, x: ax, y: ay + 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 12, 'font-weight': 700 }, String(m.n)));
        if (showNotes && m.note) {
          bubbles.append(h(`div.rv-bubble${m.done ? '.done' : ''}`, {
            style: { left: `${clamp(ax + 14, 0, box.w - 180)}px`, top: `${clamp(ay - 10, 0, box.h - 40)}px` },
            onclick: () => focusNote(m.id),
          }, h('b', null, `${m.n}`), m.note));
        }
      }
      svg.append(g);
    }
  }

  function renderList() {
    const v = get();
    if (!v) return;
    const focused = document.activeElement?.closest?.('[data-mark-note]')?.dataset.markNote;
    if (focused && list.querySelector(`[data-mark-note="${focused}"]`) && list.children.length === v.marks.length) {
      // Keep the field being typed in; just refresh the others' state.
      for (const m of v.marks) {
        const row = list.querySelector(`[data-row="${m.id}"]`);
        if (!row) continue;
        row.classList.toggle('done', !!m.done);
        row.querySelector('input[type=checkbox]').checked = !!m.done;
        const reply = row.querySelector('.rv-reply');
        reply.textContent = m.reply ? m.reply : '';
        reply.classList.toggle('hidden', !m.reply);
        if (m.id !== focused) row.querySelector('textarea').value = m.note || '';
      }
      return;
    }
    if (!v.marks.length) {
      list.replaceChildren(h('div.rv-empty', null, icon('circle', 22), h('p', null, 'Pick Circle, Box, Arrow or Draw above and mark the part of the image that should change.')));
      return;
    }
    list.replaceChildren(...v.marks.map((m) => h(`div.rv-row${m.done ? '.done' : ''}${m.id === selected ? '.sel' : ''}`, {
      dataset: { row: m.id },
      onclick: (e) => { if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') { selected = m.id; draw(); renderList(); seekTo(m); } },
    },
    h('span.rv-pin', { style: { background: m.done ? DONE : RED } }, m.n),
    h('div.grow', null,
      autosize(h('textarea.input', {
        rows: 2, value: m.note || '', dataset: { markNote: m.id },
        placeholder: 'What should change here? e.g. Replace this table with a rustic oak one',
        onfocus: () => { selected = m.id; draw(); },
        oninput: (e) => { setMark(m.id, { note: e.target.value }, `mark:${m.id}:note`); draw(); },
      })),
      h('div.rv-reply', { class: m.reply ? '' : 'hidden' }, m.reply || ''),
      h('div.rv-row-foot', null,
        h('label.check', null, h('input', { type: 'checkbox', checked: !!m.done, onchange: (e) => { setMark(m.id, { done: e.target.checked }); draw(); renderList(); } }), 'Resolved'),
        m.t != null && v.media.kind === 'video' ? h('span.faint.mono', null, `@ ${m.t.toFixed(1)}s`) : null,
        h('span.grow'),
        iconBtn('trash', 'Delete this mark', () => removeMark(m.id), 'small'))))));
  }

  function focusNote(id) {
    selected = id;
    draw();
    renderList();
    list.querySelector(`[data-mark-note="${id}"]`)?.focus();
  }

  function seekTo(m) {
    if (media.tagName === 'VIDEO' && m.t != null) { media.pause(); media.currentTime = m.t; }
  }

  // --- edits ----------------------------------------------------------------------
  function setMark(id, fields, key = null) {
    store.update(() => { const m = get().marks.find((x) => x.id === id); if (m) Object.assign(m, fields); }, { key, source: 'review' });
  }

  function addMark(m) {
    const v = get();
    const n = v.marks.reduce((a, x) => Math.max(a, x.n || 0), 0) + 1;
    const mark = { id: uid('mk_'), n, note: '', done: false, reply: '', t: media.tagName === 'VIDEO' ? Math.round(media.currentTime * 10) / 10 : null, ...m };
    store.update(() => { get().marks.push(mark); if (get().status === 'new') get().status = 'rework'; }, { source: 'review' });
    selected = mark.id;
    draw();
    renderList();
    requestAnimationFrame(() => focusNote(mark.id));
  }

  function removeMark(id) {
    store.update(() => { const v = get(); v.marks = v.marks.filter((m) => m.id !== id); }, { source: 'review' });
    if (selected === id) selected = null;
    draw();
    renderList();
  }

  // --- pointer --------------------------------------------------------------------
  const norm = (e) => {
    const r = frame.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (media.tagName === 'VIDEO' && e.target === media && tool === 'select') return; // let video controls work
    const markId = e.target.closest?.('[data-mark]')?.dataset.mark;
    if (tool === 'select') {
      if (!markId) { selected = null; draw(); renderList(); return; }
      return startMove(e, markId);
    }
    if (!frame.contains(e.target) && e.target !== stage) return;
    e.preventDefault();
    const [x0, y0] = norm(e);
    let live = { id: 'live', shape: tool, n: 0 };
    const move = (ev) => {
      const [x, y] = norm(ev);
      if (tool === 'pen') live = { ...live, pts: [...(live.pts || [[x0, y0]]), [x, y]] };
      else if (tool === 'arrow') live = { ...live, pts: [[x0, y0], [x, y]] };
      else live = { ...live, x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      draw(live);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const [x, y] = norm(ev);
      const tiny = Math.hypot((x - x0) * box.w, (y - y0) * box.h) < 8;
      const { id: _l, n: _n, ...shape } = live;
      if (tool === 'pen') {
        if (!shape.pts || shape.pts.length < 3) return draw();
        addMark({ ...shape, pts: simplify(shape.pts) });
      } else if (tool === 'arrow') {
        addMark({ shape: 'arrow', pts: tiny ? [[clamp(x0 - 0.1, 0, 1), clamp(y0 - 0.1, 0, 1)], [x0, y0]] : [[x0, y0], [x, y]] });
      } else if (tiny) {
        const s = 0.12, sh = (s * box.w) / box.h;
        addMark({ shape: tool, x: clamp(x0 - s / 2, 0, 1 - s), y: clamp(y0 - sh / 2, 0, 1 - sh), w: s, h: sh });
      } else addMark(shape);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  function startMove(e, id) {
    e.preventDefault();
    selected = id;
    const m0 = JSON.parse(JSON.stringify(get().marks.find((m) => m.id === id)));
    const [sx, sy] = norm(e);
    let moved = false;
    const move = (ev) => {
      const [x, y] = norm(ev);
      const dx = x - sx, dy = y - sy;
      moved = true;
      const fields = m0.pts ? { pts: m0.pts.map(([a, b]) => [clamp(a + dx, 0, 1), clamp(b + dy, 0, 1)]) }
        : { x: clamp(m0.x + dx, 0, 1 - m0.w), y: clamp(m0.y + dy, 0, 1 - m0.h) };
      setMark(id, fields, `mark:${id}:move`);
      draw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved) focusNote(id);
      renderList();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  // --- keys, request, close -------------------------------------------------------------
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (isTyping(e)) e.target.blur(); else close(); return; }
    if (isTyping(e) || mod(e)) return;
    const t = TOOLS.find((x) => x[3].toLowerCase() === e.key.toLowerCase());
    if (t) { e.preventDefault(); e.stopPropagation(); setTool(t[0]); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); e.stopPropagation(); removeMark(selected); }
  };
  document.addEventListener('keydown', onKey, true);

  async function copyRequest() {
    const open = get().marks.filter((m) => !m.done).length;
    await copyText(`In Storyboard, look at my notes on ${where()}${open ? ` (${open} open)` : ''} and write the prompt for the next variation as a new version under it.`);
    toast('Copied. Paste it into Claude.');
  }

  const offChange = store.on('change', ({ source }) => {
    if (!get()) return close();
    if (source === 'review') return;
    draw();
    renderList();
    if (document.activeElement !== noteIn) noteIn.value = get().note || '';
  });
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  if (media.tagName === 'IMG') media.addEventListener('load', fit, { once: true });
  else media.addEventListener('loadedmetadata', fit, { once: true });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    offChange();
    ro.disconnect();
    root.remove();
    onClose?.();
    const v = get();
    if (v && JSON.stringify(v.marks) !== startMarks) await saveSnapshot(store, versionId, media);
  }

  setTool(tool);
  renderList();
  requestAnimationFrame(fit);
  return close;
}

// Keep freehand lines light: drop points closer than ~0.5% of the image.
function simplify(pts) {
  const out = [pts[0]];
  for (const p of pts.slice(1)) {
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.005) out.push(p);
  }
  return out.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}

// Render the image with its marks and numbers into a PNG Claude can look at.
export async function saveSnapshot(store, versionId, mediaNode) {
  const v = store.version(versionId);
  if (!v?.media) return;
  if (!v.marks.length) {
    if (v.markedSrc) store.update(() => { store.version(versionId).markedSrc = null; }, { source: 'review' });
    return;
  }
  try {
    let src = mediaNode;
    if (!src || src.tagName !== (v.media.kind === 'video' ? 'VIDEO' : 'IMG')) {
      src = v.media.kind === 'video' ? null : await loadImage(mediaUrl(store.id, v.media.src));
    }
    if (!src) return;
    const nw = src.naturalWidth || src.videoWidth, nh = src.naturalHeight || src.videoHeight;
    const scale = Math.min(1, 1600 / Math.max(nw, nh));
    const W = Math.round(nw * scale), H = Math.round(nh * scale);
    const c = h('canvas', { width: W, height: H });
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, W, H);
    const lw = Math.max(3, W / 320);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const m of v.marks) {
      const path = new Path2D();
      if (m.shape === 'ellipse') path.ellipse((m.x + m.w / 2) * W, (m.y + m.h / 2) * H, (m.w * W) / 2, (m.h * H) / 2, 0, 0, Math.PI * 2);
      else if (m.shape === 'rect') path.rect(m.x * W, m.y * H, m.w * W, m.h * H);
      else if (m.pts?.length) {
        m.pts.forEach(([a, b], i) => (i ? path.lineTo(a * W, b * H) : path.moveTo(a * W, b * H)));
        if (m.shape === 'arrow' && m.pts.length === 2) {
          const [[x1, y1], [x2, y2]] = m.pts.map(([a, b]) => [a * W, b * H]);
          const ang = Math.atan2(y2 - y1, x2 - x1), L = lw * 6;
          path.moveTo(x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45));
          path.lineTo(x2, y2);
          path.lineTo(x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45));
        }
      }
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.lineWidth = lw * 2;
      g.stroke(path);
      g.strokeStyle = m.done ? DONE : RED;
      g.lineWidth = lw;
      g.stroke(path);
      const [ax, ay] = (m.shape === 'ellipse' || m.shape === 'rect' ? [m.x, m.y] : m.pts[0]).map((n, i) => n * (i ? H : W));
      const r = lw * 4;
      g.fillStyle = m.done ? DONE : RED;
      g.beginPath();
      g.arc(ax, ay, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = `700 ${Math.round(r * 1.2)}px -apple-system, Helvetica, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(m.n), ax, ay + 1);
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const ref = await addMedia(store.id, new File([blob], `marked_v${v.label}.png`, { type: 'image/png' }));
    store.update(() => { const x = store.version(versionId); if (x) x.markedSrc = ref.src; }, { source: 'review' });
  } catch {
    /* the notes still reach Claude as text; the picture is a bonus */
  }
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
