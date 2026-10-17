// The open project: data model, undo/redo, and autosave to server.py.
//
// project = {
//   id, name, rev, settings: { aspect, fps, width, height, duration, look, negative, takes, music },
//   scenes: [{ id, number, title, synopsis, collapsed, shots: [shot] }],
//   boards: [{ id, name, items: [item], links: [{ id, from, to }], view: { x, y, z } }],
// }
// shot  = { id, number, frame: {src, kind, w, h, duration} | null, action, dialogue,
//           size, angle, move, lens, duration, transition, prompt, negative, seed,
//           takes, model, status, notes, refs: [{src, kind}] }
// item  = { id, type: image|video|note|text|swatch|section|link, x, y, w, h, ...type fields }

import { api } from './api.js';
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
  return p;
}

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
    if (!this.dirty || this.status === 'conflict') return;
    clearTimeout(this.retry);
    this.saving = true;
    this.dirty = false;
    this.setStatus('saving');
    try {
      const r = await api.save(this.id, this.p, this.rev);
      this.rev = r.rev;
      this.setStatus(this.dirty ? 'pending' : 'saved');
    } catch (e) {
      this.dirty = true;
      if (e.status === 409) {
        this.setStatus('conflict');
        this.emit('conflict');
      } else {
        this.setStatus('error', e.message);
        this.retry = setTimeout(() => this.save(), 4000);
      }
    } finally {
      this.saving = false;
      if (this.again) { this.again = false; this.save(); }
    }
  }

  // Overwrite whatever is on disk with this window's version.
  async forceSave() {
    const disk = await api.get(this.id);
    this.rev = disk.rev;
    this.status = 'pending';
    this.dirty = true;
    return this.save();
  }

  // Called on page hide: send unsaved work even if the tab is closing.
  flush() {
    if (!this.dirty || this.status === 'conflict') return;
    this.saveSoon.cancel();
    api.save(this.id, this.p, this.rev, true);
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
  board(id) { return this.p.boards.find((b) => b.id === id) || this.p.boards[0]; }
  totalSeconds() { return this.p.scenes.reduce((t, sc) => t + sc.shots.reduce((u, s) => u + (Number(s.duration) || 0), 0), 0); }
}

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
