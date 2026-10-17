// Moodboard view: an infinite canvas per board for reference images, clips,
// sticky notes, headings, color swatches, links and arrows between them.
// Coordinates are "world" units; the view is a pan (x, y) and zoom (z).

import { addMedia, api, mediaUrl } from './api.js';
import { addAll, lightbox, mediaEl } from './shared.js';
import { insertShot, newBoard, newScene, nextSceneNumber, trackFrame } from './store.js';
import { NOTE_COLORS, noteColor } from './vocab.js';
import {
  clamp, confirmDialog, copyText, droppedMedia, h, icon, iconBtn, isTyping, menu, mod, modKey, pickFiles,
  promptDialog, toast, uid,
} from './ui.js';

const MARK = 'storyboard-items:';
const TOOLS = [['select', 'cursor', 'Select', 'V'], ['hand', 'hand', 'Pan', 'H'], ['note', 'note', 'Sticky note', 'N'], ['text', 'text', 'Text', 'T'], ['section', 'frame', 'Section', 'S'], ['swatch', 'swatch', 'Color swatch', 'C']];
const SWATCH_SEED = ['#e4572e', '#f3a712', '#29335c', '#669bbc', '#a8c686', '#8e7dbe', '#2d2d2a', '#f0e6d2'];
const TEXT_SIZES = [['S', 20], ['M', 32], ['L', 56], ['XL', 96]];

function viewKey(pid, bid) { return `storyboard.view.${pid}.${bid}`; }
function loadView(pid, bid) { try { return JSON.parse(localStorage.getItem(viewKey(pid, bid))); } catch { return null; } }
function saveView(pid, bid, v) { try { localStorage.setItem(viewKey(pid, bid), JSON.stringify(v)); localStorage.setItem(`storyboard.board.${pid}`, bid); } catch { /* private mode */ } }

export function mount(host, { store, app }) {
  const pid = store.id;
  let boardId = (() => { try { return localStorage.getItem(`storyboard.board.${pid}`); } catch { return null; } })();
  if (!store.p.boards.some((b) => b.id === boardId)) boardId = store.p.boards[0].id;
  let view = { x: 0, y: 0, z: 1 };
  let tool = 'select';
  let spaceHeld = false;
  let editing = null;
  let dragging = false;
  const selection = new Set();
  const els = new Map(); // item id -> { el, body, sig }

  const board = () => store.board(boardId);
  const itemById = (id) => board().items.find((i) => i.id === id);

  // --- DOM ------------------------------------------------------------------------

  const dots = h('div.mb-dots');
  const linkG = h('g', { svg: true, transform: 'translate(50000 50000)' });
  const ghost = h('path.ghost', { svg: true, d: '', 'marker-end': 'url(#mb-arrow-sel)' });
  const svg = h('svg.mb-links', { svg: true, style: { left: '-50000px', top: '-50000px', width: '100000px', height: '100000px' } },
    h('defs', { svg: true },
      marker('mb-arrow', '#8a8a94'), marker('mb-arrow-sel', '#ffb224')),
    linkG, h('g', { svg: true, transform: 'translate(50000 50000)' }, ghost));
  const world = h('div.mb-world', null, svg);
  const marquee = h('div.marquee.hidden');
  const canvas = h('div.mb-canvas', { tabIndex: 0 }, dots, world, marquee);
  const selbar = h('div.mb-selbar.hidden');
  const zoomLabel = h('button.zoom-label', { type: 'button', title: 'Zoom to 100% (⇧0)', onclick: () => zoomTo(1) }, '100%');
  const toolBtns = {};
  const toolbar = h('div.mb-toolbar', null,
    TOOLS.map(([id, ic, label, key]) => (toolBtns[id] = iconBtn(ic, `${label} (${key})`, () => setTool(id)))),
    h('span.sep'),
    iconBtn('upload', 'Add images or clips', async () => placeMedia(await pickFiles({ accept: 'image/*,video/*' }), centerWorld())),
    iconBtn('link', 'Add a link', addLinkPrompt),
    h('span.sep'),
    iconBtn('minus', 'Zoom out (−)', () => zoomBy(1 / 1.25)), zoomLabel, iconBtn('plus', 'Zoom in (+)', () => zoomBy(1.25)),
    iconBtn('fit', 'Zoom to fit (⇧1)', () => fit()));
  const tabs = h('div.mb-tabs');
  const hint = h('div.mb-hint.hidden');
  const root = h('div.mb', null, canvas, selbar, toolbar, tabs, hint);
  host.append(root);

  function marker(id, color) {
    return h('marker', { svg: true, id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      h('path', { svg: true, d: 'M0,0 L10,5 L0,10 z', fill: color, style: 'stroke:none' }));
  }

  // --- view ------------------------------------------------------------------------

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    const g = 24 * view.z;
    dots.style.backgroundSize = `${g}px ${g}px`;
    dots.style.backgroundPosition = `${view.x}px ${view.y}px`;
    dots.style.opacity = view.z < 0.3 ? 0 : 1;
    zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
    placeSelbar();
    saveViewSoon();
  }
  let viewTimer;
  const saveViewSoon = () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => saveView(pid, boardId, view), 300); };

  const canvasRect = () => canvas.getBoundingClientRect();
  function toWorld(cx, cy) {
    const r = canvasRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  }
  function centerWorld() {
    const r = canvasRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  function zoomAt(z, cx, cy) {
    const r = canvasRect();
    const px = cx - r.left, py = cy - r.top;
    const nz = clamp(z, 0.05, 4);
    view.x = px - ((px - view.x) / view.z) * nz;
    view.y = py - ((py - view.y) / view.z) * nz;
    view.z = nz;
    applyView();
  }
  function zoomBy(f) { const r = canvasRect(); zoomAt(view.z * f, r.left + r.width / 2, r.top + r.height / 2); }
  function zoomTo(z) { const r = canvasRect(); zoomAt(z, r.left + r.width / 2, r.top + r.height / 2); }

  function bounds(items) {
    if (!items.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
      const r = rectOf(it);
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, it.type === 'section' ? r.y - 36 : r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function fit(items = board().items) {
    const r = canvasRect();
    const b = bounds(items);
    if (!b || !r.width) { view = { x: r.width / 2, y: r.height / 2, z: 1 }; return applyView(); }
    const pad = 90;
    const z = clamp(Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2 - 60) / b.h), 0.05, 1);
    view = { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: (r.height - 60) / 2 - (b.y + b.h / 2) * z };
    applyView();
  }

  // --- rendering --------------------------------------------------------------------

  function rectOf(it) {
    const e = els.get(it.id);
    const hgt = it.type === 'text' && e?.el.isConnected ? e.el.offsetHeight : it.h;
    return { x: it.x, y: it.y, w: it.w, h: hgt || it.h || 40 };
  }

  function contentSig(it) {
    return JSON.stringify([it.type, it.src, it.text, it.color, it.title, it.url, it.size]);
  }

  function buildBody(it, e) {
    const body = [];
    if (it.type === 'image') body.push(h('img', { src: mediaUrl(pid, it.src), draggable: false, decoding: 'async', alt: '' }));
    if (it.type === 'video') {
      const v = mediaEl(pid, { src: it.src, kind: 'video' });
      body.push(v, h('span.vid-badge', null, icon('video', 12)));
      e.el.onmouseenter = () => v.play().catch(() => {});
      e.el.onmouseleave = () => v.pause();
    }
    if (it.type === 'note' || it.type === 'text') {
      const txt = h('div.txt', { dataset: { ph: it.type === 'note' ? 'Type an idea…' : 'Heading' }, spellcheck: true });
      txt.textContent = it.text || '';
      txt.addEventListener('input', () => commitText(it.id, txt));
      txt.addEventListener('blur', () => stopEditing(it.id, txt));
      txt.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); txt.blur(); } ev.stopPropagation(); });
      txt.addEventListener('paste', (ev) => { ev.preventDefault(); document.execCommand('insertText', false, ev.clipboardData.getData('text/plain')); });
      body.push(txt);
    }
    if (it.type === 'section') {
      const t = h('div.sec-title', { spellcheck: false });
      t.textContent = it.title || 'Section';
      t.addEventListener('blur', () => {
        t.contentEditable = 'false';
        const v = t.textContent.trim() || 'Section';
        if (v !== itemById(it.id)?.title) store.update(() => { itemById(it.id).title = v; });
        editing = null;
      });
      t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); t.blur(); } ev.stopPropagation(); });
      body.push(t);
    }
    if (it.type === 'swatch') {
      body.push(h('div.chipc', { style: { background: it.color } }),
        h('div.hex', null, h('span', null, (it.color || '').toUpperCase()), h('span.faint', null, rgbOf(it.color))));
    }
    if (it.type === 'link') {
      let host = it.url;
      try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
      body.push(h('div.dom', null, icon('link', 12), host), h('div.ttl', null, it.title || host),
        h('a', { href: it.url, target: '_blank', rel: 'noopener', draggable: false, onpointerdown: (ev) => ev.stopPropagation() }, it.url));
    }
    return body;
  }

  function renderItems() {
    const b = board();
    const seen = new Set();
    const order = [...b.items.filter((i) => i.type === 'section'), ...b.items.filter((i) => i.type !== 'section')];
    order.forEach((it, idx) => {
      seen.add(it.id);
      let e = els.get(it.id);
      if (!e) {
        e = { el: h(`div.item.item-${it.type}`, { dataset: { id: it.id } }) };
        e.handles = [h('div.handle.resize', { dataset: { h: 'resize' }, title: 'Resize' }), h('div.handle.connect', { dataset: { h: 'connect' }, title: 'Drag to another item to connect' })];
        els.set(it.id, e);
        world.append(e.el);
      }
      const sig = contentSig(it);
      if (e.sig !== sig && !(editing === it.id)) {
        e.sig = sig;
        e.el.replaceChildren(...buildBody(it, e), ...e.handles);
      }
      const st = e.el.style;
      st.left = `${it.x}px`;
      st.top = `${it.y}px`;
      st.width = `${it.w}px`;
      st.height = it.type === 'text' ? 'auto' : `${it.h}px`;
      st.zIndex = it.type === 'section' ? 1 : 10 + idx;
      if (it.type === 'note') {
        st.background = noteColor(it.color);
        e.el.classList.toggle('dark', it.color === 'dark');
      }
      if (it.type === 'text') st.fontSize = `${it.size || 32}px`;
      e.el.classList.toggle('sel', selection.has(it.id));
      e.el.classList.toggle('solo', selection.size === 1);
    });
    for (const [id, e] of els) if (!seen.has(id)) { e.el.remove(); els.delete(id); }
    renderLinks();
    placeSelbar();
  }

  function edgePoint(r, tx, ty, pad = 8) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const t = Math.min((r.w / 2 + pad) / Math.abs(dx || 1e-9), (r.h / 2 + pad) / Math.abs(dy || 1e-9));
    return { x: cx + dx * Math.min(t, 1), y: cy + dy * Math.min(t, 1) };
  }

  function renderLinks(live) {
    const b = board();
    const rects = new Map(b.items.map((it) => [it.id, live?.get(it.id) || rectOf(it)]));
    linkG.replaceChildren(...b.links.flatMap((l) => {
      const a = rects.get(l.from), c = rects.get(l.to);
      if (!a || !c) return [];
      const p1 = edgePoint(a, c.x + c.w / 2, c.y + c.h / 2);
      const p2 = edgePoint(c, a.x + a.w / 2, a.y + a.h / 2);
      const d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
      const on = selection.has(l.id);
      return [
        h('path.hit', { svg: true, d, dataset: { link: l.id } }),
        h(`path${on ? '.sel' : ''}`, { svg: true, d, dataset: { link: l.id }, 'marker-end': `url(#${on ? 'mb-arrow-sel' : 'mb-arrow'})` }),
      ];
    }));
  }

  function renderTabs() {
    tabs.replaceChildren(...store.p.boards.map((b) => h(`button.mb-tab${b.id === boardId ? '.on' : ''}`, {
      type: 'button', title: 'Double-click to rename',
      onclick: () => switchBoard(b.id),
      ondblclick: () => renameBoard(b),
      oncontextmenu: (e) => { e.preventDefault(); boardMenu(e.clientX, e.clientY, b); },
    }, b.name)), iconBtn('plus', 'New board', addBoard, 'small'));
  }

  function render() {
    if (!store.p.boards.some((b) => b.id === boardId)) boardId = store.p.boards[0].id;
    for (const id of [...selection]) if (!itemById(id) && !board().links.some((l) => l.id === id)) selection.delete(id);
    renderTabs();
    renderItems();
  }

  // --- selection bar -------------------------------------------------------------------

  function selectedItems() { return board().items.filter((i) => selection.has(i.id)); }

  function placeSelbar() {
    const items = selectedItems();
    if (!items.length || dragging || editing) { selbar.classList.add('hidden'); return; }
    const b = bounds(items);
    const r = canvasRect();
    const sx = b.x * view.z + view.x + (b.w * view.z) / 2;
    let sy = b.y * view.z + view.y - 12;
    if (sy < 56) sy = (b.y + b.h) * view.z + view.y + 56;
    selbar.style.left = `${clamp(sx, 160, r.width - 160)}px`;
    selbar.style.top = `${sy}px`;
    selbar.classList.remove('hidden');
  }

  function renderSelbar() {
    const items = selectedItems();
    if (!items.length) { selbar.replaceChildren(); placeSelbar(); return; }
    const types = new Set(items.map((i) => i.type));
    const parts = [];
    if (types.size === 1 && types.has('note')) {
      parts.push(...NOTE_COLORS.map(([k, c]) => h(`button.dot${items.every((i) => i.color === k) ? '.on' : ''}`, {
        type: 'button', title: k, style: { background: c },
        onclick: () => store.update(() => selectedItems().forEach((i) => { i.color = k; })),
      })), h('span.sep'));
    }
    if (types.size === 1 && types.has('text')) {
      parts.push(...TEXT_SIZES.map(([l, px]) => h(`button.btn.small.ghost${items.every((i) => i.size === px) ? '.on' : ''}`, {
        type: 'button', style: { padding: '0 8px', height: '28px' }, onclick: () => store.update(() => selectedItems().forEach((i) => { i.size = px; })),
      }, l)), h('span.sep'));
    }
    const media = items.filter((i) => i.type === 'image' || i.type === 'video');
    if (items.length === 1 && items[0].type === 'image') parts.push(iconBtn('palette', 'Extract color palette', () => extractPalette(items[0])));
    if (media.length) {
      parts.push(iconBtn('board', media.length > 1 ? `Make ${media.length} shots from these` : 'Make a shot from this', () => makeShots(media)));
      if (items.length === 1) {
        parts.push(iconBtn('expand', 'Open large', () => lightbox(pid, { src: items[0].src, kind: items[0].type })));
        parts.push(iconBtn('folder', 'Show file in Finder', () => api.reveal(pid, items[0].src)));
      }
      parts.push(h('span.sep'));
    }
    if (items.length === 1 && items[0].type === 'swatch') {
      parts.push(iconBtn('copy', 'Copy hex', async () => { await copyText(items[0].color.toUpperCase()); toast(`${items[0].color.toUpperCase()} copied`); }),
        iconBtn('swatch', 'Change color', () => pickColor(items[0])), h('span.sep'));
    }
    if (items.length === 1 && items[0].type === 'link') parts.push(iconBtn('arrow', 'Open link', () => window.open(items[0].url, '_blank', 'noopener')), h('span.sep'));
    if (items.length > 1) parts.push(iconBtn('grid', 'Tidy into a grid', () => tidy(items)), h('span.sep'));
    parts.push(
      iconBtn('layers', 'Bring to front', () => restack(true)),
      iconBtn('copy', `Duplicate (${modKey}D)`, duplicate),
      iconBtn('trash', 'Delete (⌫)', removeSelection));
    selbar.replaceChildren(...parts);
    placeSelbar();
  }

  function select(ids, add = false) {
    if (!add) selection.clear();
    ids.forEach((id) => selection.add(id));
    for (const [id, e] of els) {
      e.el.classList.toggle('sel', selection.has(id));
      e.el.classList.toggle('solo', selection.size === 1);
    }
    renderLinks();
    renderSelbar();
  }

  // --- text editing ---------------------------------------------------------------------

  let textTimer;
  function commitText(id, txt) {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      const it = itemById(id);
      if (!it || it.text === txt.innerText) return;
      store.update(() => { it.text = txt.innerText; if (it.type === 'text') it.h = els.get(id)?.el.offsetHeight || it.h; }, { key: `text:${id}`, source: 'mood-text' });
    }, 300);
  }

  function stopEditing(id, txt) {
    clearTimeout(textTimer);
    txt.contentEditable = 'false';
    editing = null;
    const it = itemById(id);
    if (it && it.text !== txt.innerText) store.update(() => { it.text = txt.innerText; if (it.type === 'text') it.h = els.get(id)?.el.offsetHeight || it.h; }, { key: `text:${id}`, source: 'mood-text' });
    else { els.get(id) && (els.get(id).sig = null); renderItems(); }
    placeSelbar();
  }

  function startEditing(id) {
    const e = els.get(id);
    const it = itemById(id);
    if (!e || !it) return;
    const target = it.type === 'section' ? e.el.querySelector('.sec-title') : e.el.querySelector('.txt');
    if (!target) return;
    editing = id;
    selbar.classList.add('hidden');
    target.contentEditable = 'true';
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  // --- creating ----------------------------------------------------------------------------

  function addItems(items, { edit = false } = {}) {
    store.update(() => board().items.push(...items));
    select(items.map((i) => i.id));
    if (edit && items.length === 1) startEditing(items[0].id);
  }

  // Slide a group of new items down until it doesn't cover anything.
  function freeSpot(items) {
    const others = board().items.filter((o) => o.type !== 'section').map(rectOf);
    const b = bounds(items);
    let dy = 0;
    const hits = () => others.some((r) => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + dy + b.h && r.y + r.h > b.y + dy);
    for (let i = 0; i < 200 && hits(); i++) dy += 20;
    items.forEach((it) => { it.y += dy; });
    return items;
  }

  function createAt(type, pt) {
    if (type === 'note') return addItems([{ id: uid('it_'), type, x: pt.x - 110, y: pt.y - 75, w: 220, h: 150, text: '', color: 'yellow' }], { edit: true });
    if (type === 'text') return addItems([{ id: uid('it_'), type, x: pt.x, y: pt.y - 20, w: 420, h: 44, text: '', size: 32 }], { edit: true });
    if (type === 'swatch') {
      const n = board().items.filter((i) => i.type === 'swatch').length;
      const it = { id: uid('it_'), type, x: pt.x - 55, y: pt.y - 65, w: 110, h: 130, color: SWATCH_SEED[n % SWATCH_SEED.length] };
      addItems([it]);
      pickColor(it);
    }
  }

  function pickColor(it) {
    const input = h('input', { type: 'color', value: it.color, style: { position: 'fixed', left: '-100px', opacity: 0 } });
    document.body.append(input);
    input.addEventListener('input', () => store.update(() => { const x = itemById(it.id); if (x) x.color = input.value; }, { key: `color:${it.id}` }));
    input.addEventListener('change', () => input.remove());
    input.addEventListener('blur', () => setTimeout(() => input.remove(), 200));
    input.click();
  }

  // Upload files/links and lay them out in rows starting at `pt`.
  async function placeMedia(inputs, pt) {
    const refs = (await addAll(pid, inputs)).filter((r) => r.kind !== 'audio');
    if (refs.length) addItems(layoutMedia(refs, pt));
  }

  // Media refs -> board items in rows, centred on `pt`.
  function layoutMedia(refs, pt) {
    const cols = Math.min(4, Math.ceil(Math.sqrt(refs.length)));
    const gap = 24;
    let x = 0, y = 0, rowH = 0;
    const items = refs.map((r, i) => {
      const ratio = r.w && r.h ? r.h / r.w : 9 / 16;
      const w = Math.round(r.w ? clamp(r.w / 2, 160, 320) : 320);
      const it = { id: uid('it_'), type: r.kind === 'video' ? 'video' : 'image', src: r.src, x, y, w, h: Math.round(w * ratio), mw: r.w, mh: r.h, duration: r.duration, name: r.name };
      rowH = Math.max(rowH, it.h);
      x += w + gap;
      if ((i + 1) % cols === 0) { x = 0; y += rowH + gap; rowH = 0; }
      return it;
    });
    const b = bounds(items);
    for (const it of items) { it.x = Math.round(it.x - b.w / 2 + pt.x); it.y = Math.round(it.y - b.h / 2 + pt.y); }
    return items;
  }

  // An image/video link is downloaded into the project; any other page
  // becomes a link card.
  async function placeUrl(url, pt) {
    let r = null;
    try { r = await addMedia(pid, url); } catch { /* not media */ }
    if (r && r.kind !== 'audio') addItems(layoutMedia([r], pt));
    else addLink(url, pt);
  }

  function addLink(url, pt = centerWorld(), title = '') {
    addItems([{ id: uid('it_'), type: 'link', url, title, x: pt.x - 140, y: pt.y - 45, w: 280, h: 92 }]);
  }

  async function addLinkPrompt() {
    const url = await promptDialog('Add a link', '', { label: 'Web address (YouTube, Vimeo, Pinterest, an article…)', placeholder: 'https://', ok: 'Add' });
    if (!url) return;
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(full)) placeUrl(full, centerWorld());
    else addLink(full);
  }

  // --- actions on the selection --------------------------------------------------------------

  function removeSelection() {
    if (!selection.size) return;
    const n = selection.size;
    store.update(() => {
      const b = board();
      b.items = b.items.filter((i) => !selection.has(i.id));
      const alive = new Set(b.items.map((i) => i.id));
      b.links = b.links.filter((l) => !selection.has(l.id) && alive.has(l.from) && alive.has(l.to));
    });
    selection.clear();
    renderSelbar();
    toast(`Deleted ${n} item${n > 1 ? 's' : ''}`, { action: 'Undo', onAction: () => store.undo() });
  }

  function duplicate() {
    const items = selectedItems();
    if (!items.length) return;
    const map = new Map();
    const copies = items.map((i) => { const c = { ...JSON.parse(JSON.stringify(i)), id: uid('it_'), x: i.x + 30, y: i.y + 30 }; map.set(i.id, c.id); return c; });
    store.update(() => {
      const b = board();
      b.items.push(...copies);
      for (const l of [...b.links]) if (map.has(l.from) && map.has(l.to)) b.links.push({ id: uid('ln_'), from: map.get(l.from), to: map.get(l.to) });
    });
    select(copies.map((c) => c.id));
  }

  function restack(front) {
    store.update(() => {
      const b = board();
      const picked = b.items.filter((i) => selection.has(i.id));
      const rest = b.items.filter((i) => !selection.has(i.id));
      b.items = front ? [...rest, ...picked] : [...picked, ...rest];
    });
  }

  function tidy(items) {
    const list = [...items].filter((i) => i.type !== 'section').sort((a, b) => a.y - b.y || a.x - b.x);
    const cols = Math.ceil(Math.sqrt(list.length));
    const b = bounds(list);
    const gap = 24;
    store.update(() => {
      let x = b.x, y = b.y, rowH = 0;
      list.forEach((ref, i) => {
        const it = itemById(ref.id);
        it.x = x; it.y = y;
        rowH = Math.max(rowH, rectOf(it).h);
        x += it.w + gap;
        if ((i + 1) % cols === 0) { x = b.x; y += rowH + gap; rowH = 0; }
      });
    });
  }

  function makeShots(media) {
    const sorted = [...media].sort((a, b) => a.y - b.y || a.x - b.x);
    const shots = store.update((p) => {
      let scene = p.scenes.at(-1);
      if (!scene) { scene = newScene({ number: nextSceneNumber(p) }); p.scenes.push(scene); }
      return sorted.map((it) => {
        const shot = insertShot(p, scene, scene.shots.length, {
          frame: { src: it.src, kind: it.type, w: it.mw, h: it.mh, duration: it.duration, name: it.name },
          status: it.type === 'video' ? 'generated' : 'idea',
        });
        trackFrame(p, shot);
        return shot;
      });
    });
    toast(`${shots.length} shot${shots.length > 1 ? 's' : ''} added to the storyboard`, { action: 'Show', onAction: () => { app.select(shots.map((s) => s.id), shots[0].id); app.go('board'); } });
  }

  async function extractPalette(it) {
    try {
      const img = new Image();
      img.src = mediaUrl(pid, it.src);
      await img.decode();
      const W = 72, H = Math.max(1, Math.round((72 * img.naturalHeight) / img.naturalWidth));
      const c = h('canvas', { width: W, height: H });
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      const colors = kmeans(ctx.getImageData(0, 0, W, H).data, 6).slice(0, 5);
      const r = rectOf(it);
      const sw = 110, gap = 12;
      const items = freeSpot(colors.map((hex, i) => ({ id: uid('it_'), type: 'swatch', color: hex, x: r.x + i * (sw + gap), y: r.y + r.h + 24, w: sw, h: 130 })));
      store.update(() => {
        const b = board();
        b.items.push(...items);
      });
      select(items.map((x) => x.id));
    } catch {
      toast('Couldn’t read colors from this image', { type: 'error' });
    }
  }

  // --- boards ---------------------------------------------------------------------------------

  function switchBoard(id) {
    if (id === boardId) return;
    document.activeElement?.blur?.();
    boardId = id;
    selection.clear();
    for (const e of els.values()) e.el.remove();
    els.clear();
    render();
    const v = loadView(pid, id);
    if (v) { view = v; applyView(); } else fit();
    saveView(pid, id, view);
    renderSelbar();
  }

  function addBoard() {
    const b = store.update((p) => { const nb = newBoard(`Board ${p.boards.length + 1}`); p.boards.push(nb); return nb; });
    switchBoard(b.id);
    renameBoard(b);
  }

  async function renameBoard(b) {
    const name = await promptDialog('Rename board', b.name, { ok: 'Rename' });
    if (name) store.update(() => { store.board(b.id).name = name; });
  }

  function boardMenu(x, y, b) {
    menu(x, y, [
      { label: 'Rename…', icon: 'text', onClick: () => renameBoard(b) },
      { label: 'Duplicate', icon: 'copy', onClick: () => {
        const copy = store.update((p) => {
          const c = JSON.parse(JSON.stringify(store.board(b.id)));
          const ids = new Map();
          c.id = uid('bd_');
          c.name = `${b.name} copy`;
          c.items.forEach((i) => { const n = uid('it_'); ids.set(i.id, n); i.id = n; });
          c.links = c.links.map((l) => ({ id: uid('ln_'), from: ids.get(l.from), to: ids.get(l.to) }));
          p.boards.splice(p.boards.indexOf(store.board(b.id)) + 1, 0, c);
          return c;
        });
        switchBoard(copy.id);
      } },
      '-',
      { label: 'Delete board', icon: 'trash', danger: true, disabled: store.p.boards.length < 2, onClick: async () => {
        if (store.board(b.id).items.length && !(await confirmDialog(`Delete “${b.name}” and its ${store.board(b.id).items.length} items?`, { title: 'Delete board?', ok: 'Delete', danger: true }))) return;
        store.update((p) => { p.boards = p.boards.filter((x) => x.id !== b.id); });
        if (boardId === b.id) switchBoard(store.p.boards[0].id);
      } },
    ]);
  }

  // --- pointer interaction ---------------------------------------------------------------------

  function setTool(t) {
    tool = t;
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === t);
    canvas.className = `mb-canvas tool-${t}${spaceHeld ? ' panning' : ''}`;
    hint.textContent = { note: 'Click to place a sticky note', text: 'Click to place a heading', section: 'Drag to draw a section', swatch: 'Click to place a color swatch' }[t] || '';
    hint.classList.toggle('hidden', !hint.textContent);
  }

  function track(e, onMove, onUp) {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      onMove(ev, ev.clientX - sx, ev.clientY - sy);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      onUp?.(ev, moved);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function startPan(e) {
    const ox = view.x, oy = view.y;
    canvas.classList.add('panning');
    track(e, (ev, dx, dy) => { view.x = ox + dx; view.y = oy + dy; applyView(); }, () => { if (!spaceHeld && tool !== 'hand') canvas.classList.remove('panning'); });
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (editing && e.target.closest('[contenteditable="true"]')) return;
    if (editing) document.activeElement?.blur();
    canvas.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && (spaceHeld || tool === 'hand'))) { e.preventDefault(); return startPan(e); }
    if (e.button !== 0) return;
    const pt = toWorld(e.clientX, e.clientY);

    if (tool === 'note' || tool === 'text' || tool === 'swatch') { createAt(tool, pt); setTool('select'); return; }
    if (tool === 'section') return drawSection(e, pt);

    const handle = e.target.closest('.handle');
    const itemEl = e.target.closest('.item');
    const linkId = e.target.closest('[data-link]')?.dataset.link;
    if (handle && itemEl) {
      e.stopPropagation();
      return handle.dataset.h === 'resize' ? startResize(e, itemEl.dataset.id) : startConnect(e, itemEl.dataset.id);
    }
    if (itemEl) return startMove(e, itemEl.dataset.id);
    if (linkId) { select([linkId], e.shiftKey); return; }
    startMarquee(e, pt);
  });

  function startMove(e, id) {
    const wasSelected = selection.has(id);
    if (e.shiftKey) { if (!wasSelected) select([id], true); } else if (!wasSelected) select([id]);
    const moving = new Map();
    for (const it of selectedItems()) {
      moving.set(it.id, { x: it.x, y: it.y });
      if (it.type === 'section') {
        for (const o of board().items) {
          if (o.id === it.id || o.type === 'section') continue;
          const r = rectOf(o);
          if (r.x >= it.x && r.y >= it.y && r.x + r.w <= it.x + it.w && r.y + r.h <= it.y + it.h) moving.set(o.id, { x: o.x, y: o.y });
        }
      }
    }
    track(e, (ev, dx, dy) => {
      dragging = true;
      selbar.classList.add('hidden');
      const live = new Map();
      for (const [mid, o] of moving) {
        const el = els.get(mid)?.el;
        const it = itemById(mid);
        if (!el || !it) continue;
        const nx = o.x + dx / view.z, ny = o.y + dy / view.z;
        el.style.left = `${nx}px`;
        el.style.top = `${ny}px`;
        live.set(mid, { ...rectOf(it), x: nx, y: ny });
      }
      renderLinks(live);
    }, (ev, moved) => {
      dragging = false;
      if (moved) {
        const dx = (ev.clientX - e.clientX) / view.z, dy = (ev.clientY - e.clientY) / view.z;
        store.update(() => { for (const [mid, o] of moving) { const it = itemById(mid); if (it) { it.x = Math.round(o.x + dx); it.y = Math.round(o.y + dy); } } });
      } else if (e.shiftKey && wasSelected) {
        selection.delete(id);
        select([...selection]);
      } else if (!e.shiftKey && selection.size > 1) {
        select([id]);
      }
      placeSelbar();
    });
  }

  function startResize(e, id) {
    const it = itemById(id);
    const o = { w: it.w, h: rectOf(it).h };
    const ratio = o.h / o.w;
    const keep = it.type === 'image' || it.type === 'video';
    const el = els.get(id).el;
    track(e, (ev, dx, dy) => {
      dragging = true;
      let w = Math.max(40, o.w + dx / view.z);
      let hh = Math.max(30, o.h + dy / view.z);
      if (keep !== ev.shiftKey) hh = w * ratio;
      el.style.width = `${w}px`;
      if (it.type !== 'text') el.style.height = `${hh}px`;
      el.dataset.w = w;
      el.dataset.h = hh;
      renderLinks(new Map([[id, { x: it.x, y: it.y, w, h: it.type === 'text' ? el.offsetHeight : hh }]]));
    }, (ev, moved) => {
      dragging = false;
      if (moved) store.update(() => { const x = itemById(id); x.w = Math.round(+el.dataset.w); x.h = Math.round(x.type === 'text' ? el.offsetHeight : +el.dataset.h); });
      placeSelbar();
    });
  }

  function startConnect(e, id) {
    const from = itemById(id);
    let target = null;
    track(e, (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const r = rectOf(from);
      const a = edgePoint(r, p.x, p.y);
      ghost.setAttribute('d', `M${a.x},${a.y} L${p.x},${p.y}`);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.item');
      const tid = over?.dataset.id;
      if (target && target !== tid) els.get(target)?.el.classList.remove('link-target');
      target = tid && tid !== id ? tid : null;
      if (target) els.get(target)?.el.classList.add('link-target');
    }, () => {
      ghost.setAttribute('d', '');
      if (target) {
        els.get(target)?.el.classList.remove('link-target');
        const b = board();
        if (!b.links.some((l) => (l.from === id && l.to === target) || (l.from === target && l.to === id))) {
          store.update(() => board().links.push({ id: uid('ln_'), from: id, to: target }));
        }
      }
    });
  }

  function startMarquee(e, p0) {
    const base = e.shiftKey ? new Set(selection) : new Set();
    if (!e.shiftKey) select([]);
    track(e, (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y), w = Math.abs(p.x - p0.x), hh = Math.abs(p.y - p0.y);
      Object.assign(marquee.style, { left: `${x * view.z + view.x}px`, top: `${y * view.z + view.y}px`, width: `${w * view.z}px`, height: `${hh * view.z}px` });
      marquee.classList.remove('hidden');
      const hit = board().items.filter((it) => {
        const r = rectOf(it);
        if (it.type === 'section') return r.x >= x && r.y >= y && r.x + r.w <= x + w && r.y + r.h <= y + hh;
        return r.x < x + w && r.x + r.w > x && r.y < y + hh && r.y + r.h > y;
      }).map((i) => i.id);
      select([...base, ...hit]);
    }, () => marquee.classList.add('hidden'));
  }

  function drawSection(e, p0) {
    const it = { id: uid('it_'), type: 'section', title: 'Section', x: p0.x, y: p0.y, w: 600, h: 400 };
    let created = false;
    track(e, (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      Object.assign(it, { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.max(80, Math.abs(p.x - p0.x)), h: Math.max(60, Math.abs(p.y - p0.y)) });
      if (!created) { created = true; store.update(() => board().items.push(it)); } else store.update(() => Object.assign(itemById(it.id), it), { key: `draw:${it.id}` });
    }, (ev, moved) => {
      if (!moved) { it.x -= 300; it.y -= 200; store.update(() => board().items.push(it)); }
      setTool('select');
      select([it.id]);
      requestAnimationFrame(() => startEditing(it.id));
    });
  }

  canvas.addEventListener('dblclick', (e) => {
    const itemEl = e.target.closest('.item');
    if (!itemEl) {
      if (e.target.closest('.sec-title, [data-link]')) return;
      return createAt('note', toWorld(e.clientX, e.clientY));
    }
    const it = itemById(itemEl.dataset.id);
    if (!it) return;
    if (it.type === 'note' || it.type === 'text' || it.type === 'section') startEditing(it.id);
    else if (it.type === 'image' || it.type === 'video') lightbox(pid, { src: it.src, kind: it.type });
    else if (it.type === 'swatch') pickColor(it);
    else if (it.type === 'link') window.open(it.url, '_blank', 'noopener');
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const itemEl = e.target.closest('.item');
    const pt = toWorld(e.clientX, e.clientY);
    if (itemEl && !selection.has(itemEl.dataset.id)) select([itemEl.dataset.id]);
    if (!itemEl) {
      return menu(e.clientX, e.clientY, [
        { label: 'Sticky note', icon: 'note', kbd: 'N', onClick: () => createAt('note', pt) },
        { label: 'Text', icon: 'text', kbd: 'T', onClick: () => createAt('text', pt) },
        { label: 'Color swatch', icon: 'swatch', kbd: 'C', onClick: () => createAt('swatch', pt) },
        { label: 'Images or clips…', icon: 'upload', onClick: async () => placeMedia(await pickFiles({ accept: 'image/*,video/*' }), pt) },
        { label: 'Link…', icon: 'link', onClick: addLinkPrompt },
        '-',
        { label: 'Select all', kbd: `${modKey}A`, onClick: () => select(board().items.map((i) => i.id)) },
        { label: 'Zoom to fit', icon: 'fit', kbd: '⇧1', onClick: () => fit() },
      ]);
    }
    const items = selectedItems();
    const media = items.filter((i) => i.type === 'image' || i.type === 'video');
    menu(e.clientX, e.clientY, [
      media.length && { label: media.length > 1 ? `Make ${media.length} shots` : 'Make a shot', icon: 'board', onClick: () => makeShots(media) },
      items.length === 1 && items[0].type === 'image' && { label: 'Extract palette', icon: 'palette', onClick: () => extractPalette(items[0]) },
      items.length > 1 && { label: 'Tidy into a grid', icon: 'grid', onClick: () => tidy(items) },
      { label: 'Zoom to selection', icon: 'fit', onClick: () => fit(items) },
      '-',
      { label: 'Bring to front', icon: 'layers', onClick: () => restack(true) },
      { label: 'Send to back', icon: 'layers', onClick: () => restack(false) },
      { label: 'Duplicate', icon: 'copy', kbd: `${modKey}D`, onClick: duplicate },
      { label: 'Delete', icon: 'trash', kbd: '⌫', danger: true, onClick: removeSelection },
    ]);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0085));
      zoomAt(view.z * f, e.clientX, e.clientY);
    } else {
      view.x -= e.deltaX * (e.deltaMode ? 20 : 1);
      view.y -= e.deltaY * (e.deltaMode ? 20 : 1);
      applyView();
    }
  }, { passive: false });

  // Drag files or images from Finder / a web page straight onto the board.
  let dragDepth = 0;
  const overlay = h('div.drop-overlay.hidden', null, 'Drop to add to the board');
  root.append(overlay);
  root.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list')) { dragDepth++; overlay.classList.remove('hidden'); } });
  root.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.add('hidden'); });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    const pt = toWorld(e.clientX, e.clientY);
    const m = droppedMedia(e.dataTransfer);
    if (m.files) placeMedia(m.files, pt);
    else if (m.url) placeUrl(m.url, pt);
    else {
      const t = e.dataTransfer.getData('text/plain');
      if (t) addItems([{ id: uid('it_'), type: 'note', x: pt.x - 110, y: pt.y - 75, w: 220, h: 150, text: t.slice(0, 2000), color: 'yellow' }]);
    }
  });

  // --- keyboard + clipboard ------------------------------------------------------------------

  function onKey(e) {
    if (e.type === 'keyup') return false;
    if (isTyping(e)) return false;
    const k = e.key;
    if (k === ' ') { if (!spaceHeld) { spaceHeld = true; canvas.classList.add('panning'); } e.preventDefault(); return true; }
    if (mod(e)) {
      const lk = k.toLowerCase();
      if (lk === 'a') { e.preventDefault(); select(board().items.map((i) => i.id)); return true; }
      if (lk === 'd') { e.preventDefault(); duplicate(); return true; }
      if (lk === 'c' && selection.size) { e.preventDefault(); copyItems(); return true; }
      if (lk === 'x' && selection.size) { e.preventDefault(); copyItems(); removeSelection(); return true; }
      if (lk === '0') { e.preventDefault(); zoomTo(1); return true; }
      if (k === '=' || k === '+') { e.preventDefault(); zoomBy(1.25); return true; }
      if (k === '-') { e.preventDefault(); zoomBy(1 / 1.25); return true; }
      return false;
    }
    if (k === '!' || (e.shiftKey && e.code === 'Digit1')) { e.preventDefault(); fit(); return true; }
    if (k === ')' || (e.shiftKey && e.code === 'Digit0')) { e.preventDefault(); zoomTo(1); return true; }
    if (k === 'Delete' || k === 'Backspace') { if (selection.size) { e.preventDefault(); removeSelection(); } return true; }
    if (k === 'Escape') { if (tool !== 'select') setTool('select'); else select([]); return true; }
    if (k === 'Enter' && selection.size === 1) { e.preventDefault(); startEditing([...selection][0]); return true; }
    if (k === '+' || k === '=') { zoomBy(1.25); return true; }
    if (k === '-') { zoomBy(1 / 1.25); return true; }
    if (k.startsWith('Arrow') && selection.size) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k];
      store.update(() => selectedItems().forEach((i) => { i.x += dx; i.y += dy; }), { key: 'nudge' });
      return true;
    }
    if (e.altKey) return false;
    const t = TOOLS.find((x) => x[3].toLowerCase() === k.toLowerCase());
    if (t && !e.shiftKey) { setTool(t[0]); return true; }
    return false;
  }

  const onKeyUp = (e) => {
    if (e.key === ' ' && spaceHeld) { spaceHeld = false; if (tool !== 'hand') canvas.classList.remove('panning'); }
  };
  addEventListener('keyup', onKeyUp);
  const onBlurWin = () => { spaceHeld = false; canvas.classList.remove('panning'); };
  addEventListener('blur', onBlurWin);

  async function copyItems() {
    const items = selectedItems();
    const ids = new Set(items.map((i) => i.id));
    const links = board().links.filter((l) => ids.has(l.from) && ids.has(l.to));
    await copyText(MARK + JSON.stringify({ pid, items, links }));
    toast(`Copied ${items.length} item${items.length > 1 ? 's' : ''}`);
  }

  const onPaste = (e) => {
    if (isTyping(e) || document.querySelector('.modal-back')) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    const pt = centerWorld();
    if (text.startsWith(MARK)) {
      e.preventDefault();
      try {
        const data = JSON.parse(text.slice(MARK.length));
        const ids = new Map();
        const b0 = bounds(data.items);
        const items = data.items.filter((i) => data.pid === pid || !i.src).map((i) => {
          const n = uid('it_');
          ids.set(i.id, n);
          return { ...i, id: n, x: Math.round(i.x - b0.x - b0.w / 2 + pt.x), y: Math.round(i.y - b0.y - b0.h / 2 + pt.y) };
        });
        store.update(() => {
          board().items.push(...items);
          for (const l of data.links || []) if (ids.has(l.from) && ids.has(l.to)) board().links.push({ id: uid('ln_'), from: ids.get(l.from), to: ids.get(l.to) });
        });
        select(items.map((i) => i.id));
      } catch { /* ignore malformed clipboard */ }
      return;
    }
    const m = droppedMedia(e.clipboardData);
    if (m.files) { e.preventDefault(); placeMedia(m.files, pt); return; }
    const url = (m.url || text).trim();
    if (/^https?:\/\/\S+$/.test(url)) { e.preventDefault(); placeUrl(url, pt); return; }
    if (text.trim()) { e.preventDefault(); addItems([{ id: uid('it_'), type: 'note', x: pt.x - 110, y: pt.y - 75, w: 220, h: 150, text: text.trim().slice(0, 2000), color: 'yellow' }]); }
  };
  document.addEventListener('paste', onPaste);

  const offChange = store.on('change', ({ source }) => {
    render();
    if (source !== 'mood-text') renderSelbar();
  });

  // --- start --------------------------------------------------------------------------------

  setTool('select');
  render();
  renderSelbar();
  const saved = loadView(pid, boardId);
  requestAnimationFrame(() => {
    if (saved) { view = saved; applyView(); } else fit();
    renderLinks();
  });
  const ro = new ResizeObserver(() => placeSelbar());
  ro.observe(canvas);

  return {
    onKey,
    refresh: render,
    unmount: () => {
      if (editing) document.activeElement?.blur();
      offChange();
      ro.disconnect();
      clearTimeout(viewTimer);
      saveView(pid, boardId, view);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', onBlurWin);
      document.removeEventListener('paste', onPaste);
      root.remove();
    },
  };
}

function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Dominant colors: k-means on downsampled pixels, biggest clusters first,
// near-duplicates dropped.
function kmeans(data, k) {
  const px = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 127) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centers = [px[Math.floor(px.length / 2)].slice()];
  while (centers.length < k) {
    let best = px[0], bestD = -1;
    for (let i = 0; i < px.length; i += 3) {
      const d = Math.min(...centers.map((c) => d2(px[i], c)));
      if (d > bestD) { bestD = d; best = px[i]; }
    }
    centers.push(best.slice());
  }
  let counts = [];
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = centers.map(() => 0);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } });
      sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2];
      counts[bi]++;
    }
    centers.forEach((c, i) => { if (counts[i]) { c[0] = sums[i][0] / counts[i]; c[1] = sums[i][1] / counts[i]; c[2] = sums[i][2] / counts[i]; } });
  }
  const ranked = centers.map((c, i) => ({ c, n: counts[i] })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  const out = [];
  for (const { c } of ranked) if (!out.some((o) => d2(o, c) < 600)) out.push(c);
  return out.map((c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`);
}
