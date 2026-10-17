// The open project: data model, undo/redo, and autosave to server.py.
//
// project = {
//   id, name, rev, settings: { aspect, fps, width, height, duration, look, negative, takes, music },
//   scenes: [{ id, number, title, synopsis, collapsed, shots: [shot] }],
//   boards: [{ id, name, items: [item], links: [{ id, from, to }], view: { x, y, z } }],
//   versions: [version],
// }
// shot  = { id, number, frame: {src, kind, w, h, duration} | null, action, dialogue,
//           size, angle, move, lens, duration, transition, prompt, negative, seed,
//           takes, model, status, notes, refs: [{src, kind}] }
// item  = { id, type: image|video|note|text|swatch|section|link, x, y, w, h, ...type fields }
// version = { id, shot, parent, label: '1.2', media | null, prompt, note,
//             status: new|rework|option|picked, by: you|claude, created,
//             marks: [mark], markedSrc }   one node of a shot's evolution tree
// mark  = { id, n, shape: ellipse|rect|arrow|pen, x, y, w, h, pts, t, note, done, reply }
//         (coordinates are 0-1 fractions of the image)

import { api } from './api.js';
import { deepEqual, merge3 } from './merge.js';
import { debounce, pad, uid } from './ui.js';

export const VERSION = 1;

export function newShot(settings, over = {}) {
  return {
    id: uid('sh_'), number: 10, frame: null, action: '', dialogue: '', size: '', angle: '', move: '',
    lens: '', duration: Number(settings?.duration) || 3, transition: 'Cut', prompt: '', negative: '',
    seed: '', takes: '', model: '', status: 'idea', notes: '', refs: [], ...over,
  };
}
export const newScene = (over = {}) => ({ id: uid('sc_'), number: 1, title: '', synopsis: '', collapsed: false, shots: [], ...over });
export const newBoard = (name = 'Moodboard', items = []) => ({ id: uid('bd_'), name, items, links: [], view: { x: 0, y: 0, z: 1 } });

export function normalize(p) {
  p.version = VERSION;
  p.settings = { aspect: '16:9', fps: '24', width: 1920, height: 1080, duration: 3, look: '', negative: '', takes: 1, music: null, ...(p.settings || {}) };
  p.scenes = (p.scenes || []).map((sc) => ({ ...newScene(), ...sc, shots: (sc.shots || []).map((s) => ({ ...newShot(p.settings), ...s, refs: s.refs || [] })) }));
  p.boards = (p.boards?.length ? p.boards : [newBoard()]).map((b) => ({ ...newBoard(), ...b, items: b.items || [], links: b.links || [], view: { x: 0, y: 0, z: 1, ...(b.view || {}) } }));
  p.versions = (p.versions || []).map((v) => ({
    parent: null, label: '1', media: null, prompt: '', note: '', status: 'new', by: 'you', created: 0, markedSrc: null, ...v, marks: v.marks || [],
  }));
  return p;
}

// --- version trees (call inside store.update) ---------------------------------

export const versionsOf = (p, shotId) => p.versions.filter((v) => v.shot === shotId);
export const childrenOf = (p, id) => p.versions.filter((v) => v.parent === id).sort((a, b) => a.created - b.created);

// Labels are stable: 1, 2, 3 for first references, 1.1, 1.2 for variations of 1.
function nextLabel(p, shotId, parentId) {
  const parent = parentId && p.versions.find((v) => v.id === parentId);
  const siblings = p.versions.filter((v) => v.shot === shotId && (v.parent || null) === (parentId || null));
  const n = siblings.reduce((m, v) => Math.max(m, Number(String(v.label).split('.').pop()) || 0), 0) + 1;
  return parent ? `${parent.label}.${n}` : String(n);
}

export function addVersion(p, shotId, parentId = null, over = {}) {
  const v = {
    id: uid('v_'), shot: shotId, parent: parentId || null, label: nextLabel(p, shotId, parentId), media: null,
    prompt: '', note: '', status: 'new', by: 'you', created: Date.now(), marks: [], markedSrc: null, ...over,
  };
  p.versions.push(v);
  return v;
}

export function deleteVersion(p, id) {
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of p.versions) if (v.parent && gone.has(v.parent) && !gone.has(v.id)) { gone.add(v.id); grew = true; }
  }
  p.versions = p.versions.filter((v) => !gone.has(v.id));
  return gone.size;
}

export const subtreeSize = (p, id) => 1 + childrenOf(p, id).reduce((n, c) => n + subtreeSize(p, c.id), 0);

// Picking a version makes it the shot's frame; a previous pick becomes an option.
export function pickVersion(p, id) {
  const v = p.versions.find((x) => x.id === id);
  if (!v) return;
  for (const o of versionsOf(p, v.shot)) if (o.status === 'picked' && o !== v) o.status = 'option';
  v.status = 'picked';
  if (v.media) {
    for (const sc of p.scenes) {
      const shot = sc.shots.find((s) => s.id === v.shot);
      if (shot) shot.frame = { ...v.media };
    }
  }
}

// Every frame a shot gets is remembered in its tree, so the history builds
// itself while you work on the storyboard.
export function trackFrame(p, shot, extra = {}) {
  if (!shot?.frame?.src) return null;
  let v = versionsOf(p, shot.id).find((x) => x.media?.src === shot.frame.src);
  if (!v) v = addVersion(p, shot.id, null, { prompt: shot.prompt || '', ...extra, media: { ...shot.frame } });
  pickVersion(p, v.id);
  return v;
}

export const openMarks = (v) => (v?.marks || []).filter((m) => !m.done);

export const shotCode = (scene, shot) => `SC${pad(scene.number, 2)}_SH${pad(shot.number, 3)}`;

// --- starting points for new projects ----------------------------------------

const note = (x, y, text, color = 'yellow', w = 220, hgt = 150) => ({ id: uid('it_'), type: 'note', x, y, w, h: hgt, text, color });
const section = (x, y, w, hgt, title) => ({ id: uid('it_'), type: 'section', x, y, w, h: hgt, title });
const moodBoard = () => newBoard('Look & feel', [
  section(-40, -60, 760, 520, 'Look & lighting'),
  section(760, -60, 520, 520, 'Color palette'),
  section(-40, 500, 760, 460, 'Characters & wardrobe'),
  section(760, 500, 520, 460, 'Locations'),
  note(0, 0, 'Drop reference stills, frames from films, Higgsfield generations… anything that nails the look.', 'yellow', 260, 140),
  note(800, 0, 'Select an image → “Extract palette” to pull its colors here.', 'blue', 240, 120),
]);
const ideasBoard = () => newBoard('Ideas', [
  note(0, 0, 'Core idea in one line', 'orange', 240, 120),
  note(320, -80, 'What should the audience feel?', 'pink'),
  note(320, 120, 'Key visual moment', 'purple'),
  note(620, 20, 'Ending / payoff', 'green'),
]);

function scenesFrom(spec, settings) {
  return spec.map(([title, synopsis, shots], i) => newScene({
    number: i + 1, title, synopsis,
    shots: Array.from({ length: shots }, (_, k) => newShot(settings, { number: (k + 1) * 10 })),
  }));
}

export const TEMPLATES = [
  { id: 'blank', label: 'Blank', desc: 'One empty scene and a moodboard', scenes: [['', '', 1]] },
  { id: 'commercial', label: '30-second spot', desc: 'Hook → problem → product → payoff → end card', duration: 2.5, scenes: [
    ['Hook', 'Grab attention in the first 2 seconds', 2], ['Problem', 'The tension the product solves', 2],
    ['Product', 'Hero shots, features in action', 4], ['Payoff', 'Life with the product, emotion', 3], ['End card', 'Logo, tagline, call to action', 1]] },
  { id: 'music', label: 'Music video', desc: 'Intro, verses, choruses, bridge, outro', duration: 2, scenes: [
    ['Intro', '', 2], ['Verse 1', '', 4], ['Chorus 1', '', 4], ['Verse 2', '', 4], ['Chorus 2', '', 4], ['Bridge', '', 3], ['Final chorus', '', 4], ['Outro', '', 2]] },
  { id: 'short', label: 'Short film', desc: 'Three acts: setup, confrontation, resolution', duration: 4, scenes: [
    ['Act 1 · Setup', 'World, character, what they want', 3], ['Inciting incident', 'Everything changes', 2],
    ['Act 2 · Confrontation', 'Obstacles escalate', 4], ['Climax', 'The decisive moment', 3], ['Act 3 · Resolution', 'New normal', 2]] },
];

export function projectFromTemplate(tplId, settings) {
  const tpl = TEMPLATES.find((t) => t.id === tplId) || TEMPLATES[0];
  const s = { ...settings, duration: tpl.duration || settings.duration || 3 };
  return normalize({ settings: s, scenes: scenesFrom(tpl.scenes, s), boards: [moodBoard(), ideasBoard()] });
}

// --- store -------------------------------------------------------------------

export class Store extends EventTarget {
  constructor(project) {
    super();
    this.id = project.id;
    this.rev = project.rev;
    this.path = project.path;
    delete project.path;
    this.p = normalize(project);
    this.past = [];
    this.future = [];
    this.lastKey = null;
    this.lastTime = 0;
    this.dirty = false;
    this.status = 'saved';
    this.saveSoon = debounce(() => this.save(), 600);
    this.clientId = uid('c_');
    // Existing frames join their shot's version tree the first time a project opens.
    const before = this.p.versions.length;
    for (const sc of this.p.scenes) for (const s of sc.shots) if (s.frame && !versionsOf(this.p, s.id).some((v) => v.media?.src === s.frame.src)) trackFrame(this.p, s);
    this.base = clone(this.p);
    if (this.p.versions.length !== before) { this.base.versions = []; this.dirty = true; this.saveSoon(); }
    this.listen();
  }

  // Live updates: the server announces every save. Saves from Claude or
  // another window are merged into this one without a reload.
  listen() {
    if (typeof EventSource === 'undefined') return;
    this.events = new EventSource(`/api/projects/${encodeURIComponent(this.id)}/events`);
    this.events.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.client !== this.clientId && ev.rev > this.rev) this.pull(ev);
    };
  }

  close() {
    this.events?.close();
    this.events = null;
    clearTimeout(this.presenceTimer);
  }

  async pull(ev = {}) {
    if (this.saving || this.pulling) { this.pendingPull = ev; return; }
    this.pulling = true;
    try {
      const theirs = await api.get(this.id);
      delete theirs.path;
      if (theirs.rev <= this.rev) return;
      const incoming = normalize(theirs);
      const merged = merge3(this.base, clone(this.p), incoming);
      this.past.push(JSON.stringify(this.p));
      if (this.past.length > 300) this.past.shift();
      this.future = [];
      this.lastKey = null;
      this.p = normalize(merged);
      this.base = clone(incoming);
      this.rev = theirs.rev;
      this.dirty = !sameDoc(this.p, this.base);
      if (this.dirty) { this.setStatus('pending'); this.saveSoon(); } else this.setStatus('saved');
      this.emit('change', { source: 'remote', actor: ev.actor, summary: ev.summary, touched: ev.touched || [] });
    } catch (e) {
      this.setStatus('error', e.message);
    } finally {
      this.pulling = false;
      if (this.pendingPull) { const next = this.pendingPull; this.pendingPull = null; this.pull(next); }
    }
  }

  // What the person is looking at, so Claude can act on "this shot".
  setPresence(info) {
    this.presence = { ...this.presence, ...info };
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => api.presence(this.id, this.presence).catch(() => {}), 250);
  }

  on(type, fn) {
    const f = (e) => fn(e.detail || {});
    this.addEventListener(type, f);
    return () => this.removeEventListener(type, f);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Change the project inside fn(project). Edits sharing a `key` within ~1s
  // (typing in one field, dragging one thing) collapse into a single undo step.
  update(fn, { key = null, source = null } = {}) {
    const now = performance.now();
    if (!(key && key === this.lastKey && now - this.lastTime < 1200)) {
      this.past.push(JSON.stringify(this.p));
      if (this.past.length > 300) this.past.shift();
      this.future = [];
    }
    this.lastKey = key;
    this.lastTime = now;
    const r = fn(this.p);
    this.changed(source);
    return r;
  }

  changed(source) {
    this.dirty = true;
    this.p.updated = Date.now();
    this.setStatus('pending');
    this.saveSoon();
    this.emit('change', { source });
  }

  undo() { return this.step(this.past, this.future, 'undo'); }
  redo() { return this.step(this.future, this.past, 'redo'); }
  step(from, to, source) {
    if (!from.length) return false;
    to.push(JSON.stringify(this.p));
    this.p = normalize(JSON.parse(from.pop()));
    this.lastKey = null;
    this.changed(source);
    return true;
  }

  setStatus(s, message = '') {
    this.status = s;
    this.emit('status', { status: s, message });
  }

  async save() {
    if (this.saving) { this.again = true; return; }
    if (!this.dirty || this.pulling) return;
    clearTimeout(this.retry);
    this.saving = true;
    this.dirty = false;
    this.setStatus('saving');
    const sent = JSON.stringify(this.p);
    try {
      const r = await api.save(this.id, this.p, this.rev, { client: this.clientId });
      this.rev = r.rev;
      this.base = JSON.parse(sent);
      this.setStatus(this.dirty ? 'pending' : 'saved');
    } catch (e) {
      this.dirty = true;
      if (e.status === 409) {
        // Saved elsewhere since we last synced: merge theirs in, then save again.
        this.pendingPull ??= {};
      } else {
        this.setStatus('error', e.message);
        this.retry = setTimeout(() => this.save(), 4000);
      }
    } finally {
      this.saving = false;
      if (this.pendingPull) { const next = this.pendingPull; this.pendingPull = null; this.pull(next); } else if (this.again) { this.again = false; this.save(); }
    }
  }

  // Called on page hide: send unsaved work even if the tab is closing.
  flush() {
    if (!this.dirty) return;
    this.saveSoon.cancel();
    api.save(this.id, this.p, this.rev, { keepalive: true, client: this.clientId });
    this.dirty = false;
  }

  // --- lookups ---------------------------------------------------------------

  get settings() { return this.p.settings; }

  shots() {
    const out = [];
    let t = 0;
    this.p.scenes.forEach((scene, si) => scene.shots.forEach((shot, hi) => {
      const d = Math.max(0.04, Number(shot.duration) || 0);
      out.push({ shot, scene, si, hi, index: out.length, start: t, end: t + d, code: shotCode(scene, shot) });
      t += d;
    }));
    return out;
  }

  find(shotId) {
    for (const [si, scene] of this.p.scenes.entries()) {
      const hi = scene.shots.findIndex((s) => s.id === shotId);
      if (hi >= 0) return { scene, shot: scene.shots[hi], si, hi, code: shotCode(scene, scene.shots[hi]) };
    }
    return null;
  }

  scene(id) { return this.p.scenes.find((s) => s.id === id); }
  version(id) { return this.p.versions.find((v) => v.id === id); }
  board(id) { return this.p.boards.find((b) => b.id === id) || this.p.boards[0]; }
  totalSeconds() { return this.p.scenes.reduce((t, sc) => t + sc.shots.reduce((u, s) => u + (Number(s.duration) || 0), 0), 0); }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
// Equal apart from the bookkeeping fields every save touches.
const sameDoc = (a, b) => deepEqual({ ...a, rev: 0, updated: 0 }, { ...b, rev: 0, updated: 0 });

// --- shot numbering (call inside store.update) --------------------------------
// Shots keep their number when others move, like a real shot list: inserts
// between SH010 and SH020 become SH015. "Renumber" in Settings tidies up.

export function numberForInsert(scene, index) {
  const before = scene.shots[index - 1]?.number ?? 0;
  const after = scene.shots[index]?.number;
  if (after == null) return Math.floor(before / 10) * 10 + 10;
  if (after - before >= 2) {
    const mid = Math.floor((before + after) / 2);
    const round5 = Math.round(mid / 5) * 5;
    return round5 > before && round5 < after ? round5 : mid;
  }
  return null;
}

export function renumberScene(scene) {
  scene.shots.forEach((s, i) => { s.number = (i + 1) * 10; });
}

export function insertShot(p, scene, index, over = {}) {
  const shot = newShot(p.settings, over);
  let n = numberForInsert(scene, index);
  scene.shots.splice(index, 0, shot);
  if (n == null) renumberScene(scene);
  else shot.number = n;
  return shot;
}

// A scene's shots after moves: keep numbers unless they're now out of order.
export function fixOrder(scene) {
  for (let i = 1; i < scene.shots.length; i++) {
    if (scene.shots[i].number <= scene.shots[i - 1].number) {
      const n = numberForInsert({ shots: scene.shots.filter((_, k) => k !== i) }, i);
      if (n == null) return renumberScene(scene);
      scene.shots[i].number = n;
    }
  }
}

export function nextSceneNumber(p) {
  return p.scenes.reduce((m, s) => Math.max(m, s.number || 0), 0) + 1;
}
