// Storyboard view: scenes of shot cards (grid or list), a scene outline on
// the left and an inspector on the right for the selected shot.

import { api, mediaUrl, probe } from './api.js';
import { addAll, emptyFrame, lightbox, mediaEl, pickFromBoards } from './shared.js';
import { fixOrder, insertShot, newScene, nextSceneNumber, numberForInsert, openMarks, renumberScene, shotCode, trackFrame, versionsOf } from './store.js';
import { openReview } from './review.js';
import { ANGLES, aspectRatio, buildPrompt, cameraLine, fullPrompt, LENSES, MOVES, SIZES, STATUSES, statusOf, TRANSITIONS } from './vocab.js';
import {
  autosize, btn, clamp, confirmDialog, copyText, droppedMedia, field, fmtDuration, h, icon, iconBtn, isTyping,
  menu, menuFrom, mod, modKey, pickFiles, promptDialog, select, toast, uid,
} from './ui.js';

const PREFS_KEY = 'storyboard.prefs';
function loadPrefs() {
  try { return { mode: 'grid', cardW: 250, inspector: true, text: true, fit: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { mode: 'grid', cardW: 250, inspector: true, text: true, fit: false }; }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

const SHOT_MIME = 'application/x-storyboard-shots';
const SCENE_MIME = 'application/x-storyboard-scene';
const toFrame = (r) => ({ src: r.src, kind: r.kind, w: r.w, h: r.h, duration: r.duration, name: r.name });
const hasType = (e, t) => [...(e.dataTransfer?.types || [])].includes(t);
const isExternal = (e) => hasType(e, 'Files') || hasType(e, 'text/uri-list') || hasType(e, 'text/html');

export function mount(host, { store, app }) {
  const pid = store.id;
  const prefs = loadPrefs();
  const filter = { q: '', status: '' };
  const cards = new Map();   // shot id -> card view
  const scenes = new Map();  // scene id -> scene view
  let takes = {};
  let dragIds = null;
  let lastClicked = null;

  const sel = () => app.selection;
  const single = () => (sel().size === 1 ? store.find([...sel()][0]) : null);

  // --- layout -------------------------------------------------------------------

  const sceneList = h('div.scene-list');
  const sideFoot = h('div.side-foot');
  const side = h('aside.sb-side', null,
    h('div.side-head', null, h('h4', null, 'Scenes'), iconBtn('plus', 'New scene (⇧N)', () => addScene())),
    sceneList, sideFoot);

  const scroll = h('div.sb-scroll', { tabIndex: -1 });
  const searchIn = h('input.input', { type: 'search', placeholder: 'Search shots…', oninput: (e) => { filter.q = e.target.value.trim().toLowerCase(); renderMain(); } });
  const statusFilter = select([['', 'All statuses'], ...STATUSES.map((s) => [s.id, s.label])], '', (v) => { filter.status = v; renderMain(); }, { style: { width: '150px', height: '30px' } });
  const modeSeg = h('div.seg.small', null,
    h('button', { type: 'button', title: 'Cards', onclick: () => setMode('grid') }, icon('grid')),
    h('button', { type: 'button', title: 'Shot list', onclick: () => setMode('list') }, icon('list')));
  const sizeRange = h('input', { type: 'range', min: 160, max: 460, step: 10, value: prefs.cardW, title: 'Card size', oninput: (e) => { prefs.cardW = +e.target.value; root.style.setProperty('--card-w', `${cardWidth()}px`); savePrefs(prefs); } });
  // Vertical formats get narrower cards so a row still shows several shots.
  const cardWidth = () => Math.round(prefs.cardW * clamp(aspectRatio(store.settings.aspect), 0.6, 1));
  const zoomCtl = h('div.zoom-ctl', null, icon('image', 13), sizeRange, icon('image', 18));
  const inspBtn = iconBtn('layers', 'Show / hide inspector', () => { prefs.inspector = !prefs.inspector; savePrefs(prefs); layout(); });
  const tools = h('div.sb-tools', null,
    modeSeg, h('div.search', null, icon('search', 14), searchIn), statusFilter, h('div.grow'), zoomCtl,
    iconBtn('eye', 'View options', (e) => menuFrom(e.currentTarget, [
      { label: 'Show text on cards', checked: prefs.text, onClick: () => { prefs.text = !prefs.text; savePrefs(prefs); layout(); } },
      { label: 'Show whole frame (no crop)', checked: prefs.fit, onClick: () => { prefs.fit = !prefs.fit; savePrefs(prefs); layout(); } },
      '-',
      { label: 'Expand all scenes', onClick: () => store.update((p) => p.scenes.forEach((s) => { s.collapsed = false; })) },
      { label: 'Collapse all scenes', onClick: () => store.update((p) => p.scenes.forEach((s) => { s.collapsed = true; })) },
    ])), inspBtn);
  const main = h('section.sb-main', null, tools, scroll);
  const insp = h('aside.insp');
  const root = h('div.sb', null, side, main, insp);
  host.append(root);

  function layout() {
    root.classList.toggle('no-inspector', !prefs.inspector);
    root.classList.toggle('compact', !prefs.text);
    inspBtn.classList.toggle('on', prefs.inspector);
    root.style.setProperty('--card-w', `${cardWidth()}px`);
    modeSeg.children[0].classList.toggle('on', prefs.mode === 'grid');
    modeSeg.children[1].classList.toggle('on', prefs.mode === 'list');
    zoomCtl.classList.toggle('hidden', prefs.mode !== 'grid');
    for (const c of cards.values()) c.frame.classList.toggle('fit', prefs.fit);
    renderMain();
  }
  function setMode(m) { prefs.mode = m; savePrefs(prefs); scroll.replaceChildren(); cards.clear(); scenes.clear(); layout(); }

  // --- sidebar ------------------------------------------------------------------

  function renderSide() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
    let total = 0, n = 0;
    sceneList.replaceChildren(...store.p.scenes.map((scene) => {
      const dur = scene.shots.reduce((t, s) => t + (Number(s.duration) || 0), 0);
      scene.shots.forEach((s) => { counts[s.status in counts ? s.status : 'idea']++; n++; });
      total += dur;
      const item = h('button.scene-item', {
        type: 'button', draggable: true, title: scene.synopsis || '',
        onclick: () => scrollToScene(scene.id),
        ondragstart: (e) => { e.dataTransfer.setData(SCENE_MIME, scene.id); e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => {
          if (!hasType(e, SCENE_MIME)) return;
          e.preventDefault();
          const r = item.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          item.classList.toggle('drop-before', !after);
          item.classList.toggle('drop-after', after);
        },
        ondragleave: () => item.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          const id = e.dataTransfer.getData(SCENE_MIME);
          const after = item.classList.contains('drop-after');
          item.classList.remove('drop-before', 'drop-after');
          if (!id || id === scene.id) return;
          e.preventDefault();
          store.update((p) => {
            const from = p.scenes.findIndex((s) => s.id === id);
            const [moved] = p.scenes.splice(from, 1);
            const to = p.scenes.findIndex((s) => s.id === scene.id) + (after ? 1 : 0);
            p.scenes.splice(to, 0, moved);
          });
        },
        oncontextmenu: (e) => { e.preventDefault(); sceneMenu(e.clientX, e.clientY, scene); },
      }, h('span.scene-num', null, `SC${String(scene.number).padStart(2, '0')}`), h('span.t', null, scene.title || h('span.faint', null, 'Untitled scene')), h('span.d', null, fmtDuration(dur)));
      return item;
    }));
    sideFoot.replaceChildren(
      h('div.stat-row', null, h('span', null, 'Shots'), h('b', null, n)),
      h('div.stat-row', null, h('span', null, 'Runtime'), h('b', null, fmtDuration(total))),
      h('div.status-bar', { title: STATUSES.map((s) => `${s.label}: ${counts[s.id]}`).join('\n') },
        STATUSES.map((s) => h('i', { style: { background: s.color, width: `${n ? (counts[s.id] / n) * 100 : 0}%` } }))));
  }

  function scrollToScene(id) {
    const row = scroll.querySelector(`[data-scene="${id}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- main: grid --------------------------------------------------------------------

  const matches = (scene, shot) => {
    if (filter.status && shot.status !== filter.status) return false;
    if (!filter.q) return true;
    return [shotCode(scene, shot), shot.action, shot.dialogue, shot.prompt, shot.notes, shot.size, shot.move, scene.title].join(' ').toLowerCase().includes(filter.q);
  };

  function renderMain() {
    if (prefs.mode === 'list') return renderList();
    const { p } = store;
    if (!p.scenes.length) {
      scroll.replaceChildren(h('div.sb-empty', null, h('h3', null, 'No scenes yet'), h('p', null, 'Add a scene, then drop stills or clips onto it.'), btn('Add scene', () => addScene(), { icon: 'plus', cls: 'primary' })));
      scenes.clear();
      cards.clear();
      return;
    }
    scroll.querySelector('.sb-empty')?.remove();
    const seenScenes = new Set(), seenShots = new Set();
    p.scenes.forEach((scene, i) => {
      seenScenes.add(scene.id);
      const sv = scenes.get(scene.id) || makeScene(scene);
      patchScene(sv, scene);
      if (scroll.children[i] !== sv.el) scroll.insertBefore(sv.el, scroll.children[i] || null);
      let k = 0;
      for (const shot of scene.shots) {
        if (!matches(scene, shot)) continue;
        seenShots.add(shot.id);
        const c = cards.get(shot.id) || makeCard(shot.id);
        patchCard(c, scene, shot);
        if (sv.grid.children[k] !== c.el) sv.grid.insertBefore(c.el, sv.grid.children[k] || null);
        k++;
      }
      if (sv.grid.children[k] !== sv.add) sv.grid.insertBefore(sv.add, sv.grid.children[k] || null);
      while (sv.grid.children.length > k + 1) sv.grid.lastChild.remove();
      sv.add.classList.toggle('hidden', !!(filter.q || filter.status));
    });
    for (const [id, sv] of scenes) if (!seenScenes.has(id)) { sv.el.remove(); scenes.delete(id); }
    for (const [id, c] of cards) if (!seenShots.has(id)) { c.el.remove(); cards.delete(id); }
    let addBar = scroll.querySelector('.add-scene');
    if (!addBar) addBar = h('div.add-scene', null, btn('Add scene', () => addScene(), { icon: 'plus' }));
    scroll.append(addBar);
  }

  function makeScene(scene) {
    const id = scene.id;
    const sv = {};
    sv.num = h('span.scene-num', { title: 'Scene number' });
    sv.title = h('input.scene-title', {
      placeholder: 'Scene title — e.g. INT. WAREHOUSE – NIGHT', spellcheck: false,
      oninput: (e) => store.update(() => { store.scene(id).title = e.target.value; }, { key: `scene:${id}:title`, source: 'scene' }),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
    });
    sv.syn = h('input.scene-syn', {
      placeholder: 'What happens in this scene…', spellcheck: false,
      oninput: (e) => store.update(() => { store.scene(id).synopsis = e.target.value; }, { key: `scene:${id}:syn`, source: 'scene' }),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
    });
    sv.meta = h('span.scene-meta');
    sv.grid = h('div.shot-grid');
    sv.add = h('button.add-card', {
      type: 'button', title: 'New shot (N) — or drop images/clips here',
      onclick: () => addShot(id),
      ondragover: (e) => { if (isExternal(e) || dragIds) { e.preventDefault(); sv.add.classList.add('file-over'); } },
      ondragleave: () => sv.add.classList.remove('file-over'),
      ondrop: (e) => {
        sv.add.classList.remove('file-over');
        e.preventDefault();
        e.stopPropagation();
        if (dragIds) return moveShots(dragIds, id, store.scene(id).shots.length);
        const m = droppedMedia(e.dataTransfer);
        addShotsFrom(id, store.scene(id).shots.length, m.files || (m.url ? [m.url] : []));
      },
    }, icon('plus', 20), h('span', null, 'Add shot'), h('small.faint', null, 'or drop stills / clips'));
    sv.el = h('section.scene', { dataset: { scene: id } },
      h('div.scene-head', null,
        iconBtn('chevron', 'Collapse / expand', () => store.update(() => { const s = store.scene(id); s.collapsed = !s.collapsed; }), 'small collapse-btn'),
        sv.num, sv.title, sv.meta,
        iconBtn('plus', 'Add shot', () => addShot(id), 'small'),
        iconBtn('dots', 'Scene actions', (e) => { const r = e.currentTarget.getBoundingClientRect(); sceneMenu(r.left, r.bottom + 4, store.scene(id)); }, 'small')),
      sv.syn, sv.grid);
    sv.el.querySelector('.collapse-btn .ico').style.transform = 'rotate(90deg)';
    // Dropping files on empty space in a scene adds shots at its end.
    sv.grid.addEventListener('dragover', (e) => { if (e.target === sv.grid && (isExternal(e) || dragIds)) e.preventDefault(); });
    sv.grid.addEventListener('drop', (e) => {
      if (e.target !== sv.grid) return;
      e.preventDefault();
      if (dragIds) return moveShots(dragIds, id, store.scene(id).shots.length);
      const m = droppedMedia(e.dataTransfer);
      addShotsFrom(id, store.scene(id).shots.length, m.files || (m.url ? [m.url] : []));
    });
    scenes.set(id, sv);
    return sv;
  }

  function patchScene(sv, scene) {
    sv.num.textContent = `SC${String(scene.number).padStart(2, '0')}`;
    if (document.activeElement !== sv.title) sv.title.value = scene.title;
    if (document.activeElement !== sv.syn) sv.syn.value = scene.synopsis;
    const dur = scene.shots.reduce((t, s) => t + (Number(s.duration) || 0), 0);
    sv.meta.textContent = `${scene.shots.length} shot${scene.shots.length === 1 ? '' : 's'} · ${fmtDuration(dur)}`;
    sv.el.classList.toggle('collapsed', !!scene.collapsed);
    sv.el.querySelector('.collapse-btn .ico').style.transform = scene.collapsed ? '' : 'rotate(90deg)';
  }

  function makeCard(id) {
    const c = { id };
    c.media = h('div', { style: { position: 'absolute', inset: 0 } });
    c.code = h('span.badge.code');
    c.trans = h('span.badge.trans');
    c.dot = h('i.status-dot');
    c.kind = h('span.badge.kind', null, icon('video', 12));
    c.dur = h('span.badge.dur');
    c.frame = h(`div.frame${prefs.fit ? '.fit' : ''}`, null, c.media, c.code, c.trans, c.dot, c.kind, c.dur);
    c.chips = h('div.chips');
    c.action = h('div.card-action');
    c.dialogue = h('div.card-dialogue');
    c.el = h('div.card', { draggable: true, dataset: { shot: id } }, c.frame, h('div.card-body', null, c.chips, c.action, c.dialogue));

    c.el.addEventListener('click', (e) => clickShot(e, id));
    c.el.addEventListener('dblclick', () => focusField('action'));
    c.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sel().has(id)) app.select([id]);
      shotMenu(e.clientX, e.clientY);
    });
    c.el.addEventListener('dragstart', (e) => {
      if (!sel().has(id)) app.select([id]);
      dragIds = new Set(sel());
      e.dataTransfer.setData(SHOT_MIME, [...dragIds].join(','));
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => dragIds?.forEach((sid) => cards.get(sid)?.el.classList.add('dragging')));
    });
    c.el.addEventListener('dragend', () => {
      dragIds = null;
      for (const x of cards.values()) x.el.classList.remove('dragging', 'drop-before', 'drop-after', 'file-over');
    });
    c.el.addEventListener('dragover', (e) => {
      if (dragIds) {
        if (dragIds.has(id)) return;
        e.preventDefault();
        const r = c.el.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        c.el.classList.toggle('drop-before', !after);
        c.el.classList.toggle('drop-after', after);
      } else if (isExternal(e)) {
        e.preventDefault();
        c.el.classList.add('file-over');
      }
    });
    c.el.addEventListener('dragleave', (e) => { if (!c.el.contains(e.relatedTarget)) c.el.classList.remove('drop-before', 'drop-after', 'file-over'); });
    c.el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = c.el.classList.contains('drop-after');
      c.el.classList.remove('drop-before', 'drop-after', 'file-over');
      const f = store.find(id);
      if (!f) return;
      if (dragIds) return moveShots(dragIds, f.scene.id, f.hi + (after ? 1 : 0));
      const m = droppedMedia(e.dataTransfer);
      setFrameFrom(id, m.files || (m.url ? [m.url] : []));
    });
    cards.set(id, c);
    return c;
  }

  function patchCard(c, scene, shot) {
    const fsig = shot.frame?.src || '';
    if (c.fsig !== fsig) {
      c.fsig = fsig;
      c.media.replaceChildren(shot.frame ? mediaEl(pid, shot.frame, { hoverPlay: true }) : emptyFrame('Drop, paste or double-click'));
    }
    const st = statusOf(shot.status);
    const t = takes[shotCode(scene, shot)]?.length || 0;
    const vs = versionsOf(store.p, shot.id);
    const notes = vs.reduce((n, v) => n + openMarks(v).length, 0);
    const sig = JSON.stringify([shotCode(scene, shot), shot.duration, st.id, shot.transition, shot.size, shot.angle, shot.move, shot.lens, shot.action, shot.dialogue, shot.frame?.kind, t, vs.length, notes, sel().has(shot.id)]);
    if (c.sig === sig) return;
    c.sig = sig;
    c.code.textContent = shotCode(scene, shot).replace('_', ' · ');
    c.dur.textContent = fmtDuration(Number(shot.duration) || 0);
    c.dot.style.background = st.color;
    c.dot.title = st.label;
    c.kind.classList.toggle('hidden', shot.frame?.kind !== 'video');
    c.trans.textContent = shot.transition;
    c.trans.classList.toggle('hidden', !shot.transition || shot.transition === 'Cut');
    c.chips.replaceChildren(...[
      ...[shot.size, shot.angle && shot.angle !== 'Eye level' ? shot.angle : '', shot.move && shot.move !== 'Static' ? shot.move : ''].filter(Boolean).map((x) => h('span.chip', null, x)),
      shot.lens && h('span.chip.lens', null, shot.lens),
      t && !shot.frame && h('span.chip', { style: { color: '#b07cff' } }, `${t} take${t > 1 ? 's' : ''}`),
      vs.length > 1 && h('span.chip', { title: 'Versions in this shot’s tree' }, `${vs.length} versions`),
      notes && h('span.chip.notes', { title: 'Open mark-up notes' }, `${notes} note${notes > 1 ? 's' : ''}`),
    ].filter(Boolean));
    c.chips.classList.toggle('hidden', !c.chips.children.length);
    c.action.textContent = shot.action || 'No description yet';
    c.action.classList.toggle('empty', !shot.action);
    c.dialogue.textContent = shot.dialogue ? `“${shot.dialogue}”` : '';
    c.dialogue.classList.toggle('hidden', !shot.dialogue);
    c.el.classList.toggle('sel', sel().has(shot.id));
  }

  // --- main: list -------------------------------------------------------------------

  function renderList() {
    cards.clear();
    scenes.clear();
    const rows = [];
    for (const scene of store.p.scenes) {
      const shots = scene.shots.filter((s) => matches(scene, s));
      if (!shots.length && (filter.q || filter.status)) continue;
      rows.push(h('tr.scene-row', { dataset: { scene: scene.id } }, h('td', { colSpan: 7 }, h('span.scene-num', null, `SC${String(scene.number).padStart(2, '0')}`), ' ', scene.title || h('span.faint', null, 'Untitled scene'))));
      for (const shot of shots) {
        const st = statusOf(shot.status);
        rows.push(h(`tr.shot-row${sel().has(shot.id) ? '.sel' : ''}`, {
          dataset: { shot: shot.id },
          onclick: (e) => clickShot(e, shot.id),
          ondblclick: () => focusField('action'),
          oncontextmenu: (e) => { e.preventDefault(); if (!sel().has(shot.id)) app.select([shot.id]); shotMenu(e.clientX, e.clientY); },
        },
        h('td', null, h('div.thumb', null, shot.frame ? mediaEl(pid, shot.frame) : null)),
        h('td.mono', { style: { whiteSpace: 'nowrap' } }, shotCode(scene, shot)),
        h('td', { style: { whiteSpace: 'nowrap' } }, cameraLine(shot) || h('span.faint', null, '—')),
        h('td.mono', null, fmtDuration(Number(shot.duration) || 0)),
        h('td', null, h('div.clamp', null, shot.action || h('span.faint', null, '—'))),
        h('td', null, h('div.clamp', { style: { fontStyle: 'italic', color: '#d9c9a3' } }, shot.dialogue || '')),
        h('td', null, h('span.st-pill', null, h('i', { style: { background: st.color } }), st.label))));
      }
    }
    scroll.replaceChildren(h('table.shot-table', null,
      h('thead', null, h('tr', null, ['', 'Shot', 'Camera', 'Length', 'Action', 'Dialogue / VO', 'Status'].map((t) => h('th', null, t)))),
      h('tbody', null, rows)));
  }

  // --- selection --------------------------------------------------------------------

  function clickShot(e, id) {
    if (e.shiftKey && lastClicked) {
      const order = store.shots().map((x) => x.shot.id);
      const [a, b] = [order.indexOf(lastClicked), order.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0) app.select([...new Set([...(mod(e) ? sel() : []), ...order.slice(a, b + 1)])], id);
    } else if (mod(e)) {
      const s = new Set(sel());
      s.has(id) ? s.delete(id) : s.add(id);
      app.select([...s], s.has(id) ? id : [...s].pop() ?? null);
      lastClicked = id;
    } else {
      app.select([id]);
      lastClicked = id;
    }
  }

  function onSelect() {
    renderMain();
    renderInspector();
    if (app.current) revealShot(app.current);
  }

  function revealShot(id) {
    const el = cards.get(id)?.el || scroll.querySelector(`[data-shot="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function stepSelection(delta) {
    const order = store.shots().filter((x) => matches(x.scene, x.shot)).map((x) => x.shot.id);
    if (!order.length) return;
    const cur = app.current && order.indexOf(app.current);
    const next = cur == null || cur < 0 ? (delta > 0 ? 0 : order.length - 1) : clamp(cur + delta, 0, order.length - 1);
    app.select([order[next]]);
    lastClicked = order[next];
  }

  // --- edits --------------------------------------------------------------------------

  function addScene(afterId) {
    const scene = store.update((p) => {
      const sc = newScene({ number: nextSceneNumber(p) });
      insertShot(p, sc, 0);
      const at = afterId ? p.scenes.findIndex((s) => s.id === afterId) + 1 : p.scenes.length;
      p.scenes.splice(at, 0, sc);
      return sc;
    });
    app.select([scene.shots[0].id]);
    requestAnimationFrame(() => { const sv = scenes.get(scene.id); sv?.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); sv?.title.focus(); });
  }

  function addShot(sceneId, index, over = {}) {
    if (!store.p.scenes.length) return addScene();
    const shot = store.update((p) => {
      let scene, at;
      if (sceneId) { scene = store.scene(sceneId); at = index ?? scene.shots.length; } else {
        const f = app.current && store.find(app.current);
        scene = f ? f.scene : p.scenes[p.scenes.length - 1];
        at = f ? f.hi + 1 : scene.shots.length;
      }
      return insertShot(p, scene, at, over);
    });
    app.select([shot.id]);
    return shot;
  }

  async function setFrameFrom(shotId, inputs) {
    const media = inputs.filter((x) => typeof x === 'string' || !x.type?.startsWith('audio/'));
    if (inputs.length && !media.length) return toast('Drop music in the Animatic tab to use it as a temp track.');
    const refs = (await addAll(pid, media)).filter((r) => r.kind !== 'audio');
    if (!refs.length) return;
    const created = store.update((p) => {
      const f = store.find(shotId);
      if (!f) return [];
      f.shot.frame = toFrame(refs[0]);
      trackFrame(p, f.shot);
      if (refs[0].kind === 'video' && ['idea', 'prompt'].includes(f.shot.status)) f.shot.status = 'generated';
      return refs.slice(1).map((r, i) => {
        const s = insertShot(p, f.scene, f.hi + 1 + i, { frame: toFrame(r), status: r.kind === 'video' ? 'generated' : 'idea' });
        trackFrame(p, s);
        return s;
      });
    });
    if (created.length) toast(`Added ${created.length} more shot${created.length > 1 ? 's' : ''} after ${store.find(shotId)?.code}`);
    app.select([shotId]);
  }

  async function addShotsFrom(sceneId, index, inputs) {
    const refs = (await addAll(pid, inputs)).filter((r) => r.kind !== 'audio');
    if (!refs.length) return;
    const shots = store.update((p) => {
      const scene = store.scene(sceneId);
      return refs.map((r, i) => {
        const s = insertShot(p, scene, Math.min(index + i, scene.shots.length), { frame: toFrame(r), status: r.kind === 'video' ? 'generated' : 'idea' });
        trackFrame(p, s);
        return s;
      });
    });
    app.select(shots.map((s) => s.id), shots[0].id);
  }

  function moveShots(ids, sceneId, index) {
    const ok = store.update((p) => {
      const target = store.scene(sceneId);
      const anchor = target.shots.slice(index).find((s) => !ids.has(s.id));
      const moving = [];
      for (const sc of p.scenes) sc.shots = sc.shots.filter((s) => (ids.has(s.id) ? (moving.push(s), false) : true));
      const at = anchor ? target.shots.indexOf(anchor) : target.shots.length;
      target.shots.splice(at, 0, ...moving);
      renumberMoved(target, ids);
      return moving.length;
    });
    dragIds = null;
    return ok;
  }

  function renumberMoved(scene, ids) {
    for (let i = 0; i < scene.shots.length; i++) {
      const s = scene.shots[i];
      if (!ids.has(s.id)) continue;
      const before = scene.shots[i - 1]?.number ?? 0;
      const next = scene.shots.slice(i + 1).find((x) => !ids.has(x.id));
      const n = numberForInsert({ shots: next ? [{ number: before }, { number: next.number }] : [{ number: before }] }, 1);
      if (n == null) return renumberScene(scene);
      s.number = n;
    }
    fixOrder(scene);
  }

  function deleteShots(ids = [...sel()]) {
    if (!ids.length) return;
    const order = store.shots().map((x) => x.shot.id);
    const firstIdx = Math.min(...ids.map((id) => order.indexOf(id)));
    store.update((p) => { for (const sc of p.scenes) sc.shots = sc.shots.filter((s) => !ids.includes(s.id)); });
    const rest = store.shots().map((x) => x.shot.id);
    app.select(rest.length ? [rest[Math.min(firstIdx, rest.length - 1)]] : []);
    toast(`Deleted ${ids.length} shot${ids.length > 1 ? 's' : ''}`, { action: 'Undo', onAction: () => store.undo() });
  }

  function duplicateShots(ids = [...sel()]) {
    const copies = store.update((p) => ids.map((id) => {
      const f = store.find(id);
      if (!f) return null;
      const { id: _drop, number: _n, ...rest } = JSON.parse(JSON.stringify(f.shot));
      return insertShot(p, f.scene, f.hi + 1, rest);
    }).filter(Boolean));
    if (copies.length) app.select(copies.map((s) => s.id));
  }

  function sceneMenu(x, y, scene) {
    menu(x, y, [
      { label: 'Add shot', icon: 'plus', onClick: () => addShot(scene.id) },
      { label: 'Add images / clips as shots…', icon: 'upload', onClick: async () => addShotsFrom(scene.id, scene.shots.length, await pickFiles()) },
      { label: 'New scene below', icon: 'plus', onClick: () => addScene(scene.id) },
      { label: 'Duplicate scene', icon: 'copy', onClick: () => store.update((p) => {
        const copy = JSON.parse(JSON.stringify(scene));
        copy.id = uid('sc_');
        copy.number = nextSceneNumber(p);
        copy.title = scene.title ? `${scene.title} (copy)` : '';
        copy.shots.forEach((s) => { s.id = uid('sh_'); });
        p.scenes.splice(p.scenes.indexOf(scene) + 1, 0, copy);
      }) },
      { label: 'Renumber shots in this scene', icon: 'list', onClick: () => store.update(() => renumberScene(scene)) },
      { label: 'Change scene number…', icon: 'text', onClick: async () => {
        const v = await promptDialog('Scene number', String(scene.number), { ok: 'Set' });
        const n = parseInt(v, 10);
        if (!n || n < 1) return;
        if (store.p.scenes.some((s) => s !== scene && s.number === n)) return toast(`SC${String(n).padStart(2, '0')} already exists`, { type: 'error' });
        store.update(() => { scene.number = n; });
      } },
      '-',
      { label: scene.collapsed ? 'Expand' : 'Collapse', icon: 'arrow', onClick: () => store.update(() => { scene.collapsed = !scene.collapsed; }) },
      { label: 'Move up', icon: 'back', disabled: store.p.scenes[0] === scene, onClick: () => moveScene(scene, -1) },
      { label: 'Move down', icon: 'arrow', disabled: store.p.scenes.at(-1) === scene, onClick: () => moveScene(scene, 1) },
      '-',
      { label: 'Delete scene', icon: 'trash', danger: true, onClick: async () => {
        if (scene.shots.length && !(await confirmDialog(`Delete “${scene.title || `SC${scene.number}`}” and its ${scene.shots.length} shot(s)? Media files stay in the project folder.`, { title: 'Delete scene?', ok: 'Delete', danger: true }))) return;
        store.update((p) => { p.scenes = p.scenes.filter((s) => s !== scene); });
        toast('Scene deleted', { action: 'Undo', onAction: () => store.undo() });
      } },
    ]);
  }

  function moveScene(scene, d) {
    store.update((p) => {
      const i = p.scenes.indexOf(scene);
      p.scenes.splice(i, 1);
      p.scenes.splice(clamp(i + d, 0, p.scenes.length), 0, scene);
    });
  }

  function shotMenu(x, y) {
    const ids = [...sel()];
    const one = single();
    menu(x, y, [
      one && { label: 'Quick look', icon: 'eye', kbd: 'Space', onClick: () => quickLook() },
      one && { label: 'Play from here', icon: 'play', onClick: () => app.go('animatic') },
      { label: ids.length > 1 ? `Copy ${ids.length} prompts` : 'Copy prompt', icon: 'copy', kbd: `${modKey}C`, onClick: copyPrompts },
      '-',
      { label: 'Insert shot after', icon: 'plus', kbd: 'N', onClick: () => addShot() },
      { label: 'Duplicate', icon: 'copy', kbd: `${modKey}D`, onClick: () => duplicateShots() },
      { heading: 'Status' },
      ...STATUSES.map((s) => ({ label: s.label, swatch: s.color, checked: one && one.shot.status === s.id, onClick: () => store.update(() => ids.forEach((id) => { const f = store.find(id); if (f) f.shot.status = s.id; })) })),
      '-',
      one?.shot.frame && { label: 'Show file in Finder', icon: 'folder', onClick: () => api.reveal(pid, one.shot.frame.src) },
      one?.shot.frame && { label: 'Remove frame', icon: 'image', onClick: () => store.update(() => { one.shot.frame = null; }) },
      { label: ids.length > 1 ? `Delete ${ids.length} shots` : 'Delete shot', icon: 'trash', kbd: '⌫', danger: true, onClick: () => deleteShots(ids) },
    ]);
  }

  async function copyPrompts() {
    const list = store.shots().filter((x) => sel().has(x.shot.id));
    if (!list.length) return;
    const text = list.length === 1 ? fullPrompt(list[0].shot, store.settings)
      : list.map((x) => `${x.code}\n${fullPrompt(x.shot, store.settings)}`).join('\n\n');
    await copyText(text);
    toast(list.length === 1 ? 'Prompt copied — paste it into Higgsfield' : `${list.length} prompts copied`);
  }

  function quickLook() {
    const f = single();
    if (!f) return;
    if (f.shot.frame) lightbox(pid, f.shot.frame, [h('b', null, f.code), f.shot.action]);
    else toast('This shot has no frame yet');
  }

  function focusField(name) {
    if (!prefs.inspector) { prefs.inspector = true; savePrefs(prefs); layout(); }
    requestAnimationFrame(() => insp.querySelector(`[data-field="${name}"]`)?.focus());
  }

  // --- inspector ------------------------------------------------------------------------

  // What the inspector shows; if a live change leaves it the same, skip redrawing.
  const inspectorSig = () => {
    const f = single();
    if (!f || sel().size > 1) return null;
    return JSON.stringify([f.code, f.shot, versionsOf(store.p, f.shot.id), store.settings.look, store.settings.fps]);
  };

  function renderInspector({ remote = false } = {}) {
    const sig = inspectorSig();
    if (remote && sig && sig === insp.dataset.sig) return;
    const scrollTop = insp.scrollTop;
    const keep = insp.dataset.shot;
    // Keep the field being typed in focused, with its cursor, across a redraw.
    const active = insp.contains(document.activeElement) ? document.activeElement : null;
    const focus = active?.dataset.field && { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd };
    if (sel().size > 1) insp.replaceChildren(...multiInspector());
    else if (single()) insp.replaceChildren(...shotInspector(single()));
    else insp.replaceChildren(overview());
    insp.dataset.shot = single()?.shot.id || '';
    insp.dataset.sig = sig || '';
    if (keep && keep === insp.dataset.shot) {
      insp.scrollTop = scrollTop;
      const el = focus && insp.querySelector(`[data-field="${focus.field}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        try { el.setSelectionRange(focus.start, focus.end); } catch { /* number inputs */ }
      }
    }
  }

  function shotInspector(f) {
    const { shot } = f;
    const id = shot.id;
    const get = () => store.find(id)?.shot;
    const set = (key, value) => {
      store.update(() => { const s = get(); if (s) s[key] = value; }, { key: `${id}:${key}`, source: 'inspector' });
      syncPreview();
    };
    // Show what Copy/Export will produce when it differs from the prompt box
    // (project look added, or a prompt built from the fields).
    const syncPreview = () => {
      const s = get();
      const full = fullPrompt(s, store.settings);
      preview.replaceChildren(h('b', null, 'Copies as: '), full);
      preview.classList.toggle('hidden', !full || !(store.settings.look || '').trim());
      promptIn.placeholder = buildPrompt(s) || 'Describe the shot, or fill in the fields above and press Build.';
    };
    const text = (key, props = {}) => autosize(h('textarea.input', {
      value: shot[key] || '', rows: 2, dataset: { field: key }, spellcheck: true, ...props,
      oninput: (e) => set(key, e.target.value),
    }));
    const sel3 = (list, key) => select(list.map(([v, l]) => [v, l]), shot[key], (v) => set(key, v));

    // header
    const numIn = h('input.input.insp-num.mono', {
      type: 'number', value: shot.number, min: 1, title: 'Shot number',
      onchange: (e) => {
        const n = parseInt(e.target.value, 10);
        const cur = store.find(id);
        if (!n || n < 1) { e.target.value = cur.shot.number; return; }
        if (cur.scene.shots.some((s) => s.id !== id && s.number === n)) { toast(`SH${String(n).padStart(3, '0')} already exists in this scene`, { type: 'error' }); e.target.value = cur.shot.number; return; }
        store.update(() => { cur.shot.number = n; });
      },
    });
    const st = statusOf(shot.status);
    const statusSel = h('label.status-select', null, h('i', { style: { background: st.color } }),
      select(STATUSES.map((s) => [s.id, s.label]), shot.status, (v) => store.update(() => { get().status = v; })));
    statusSel.querySelector('select').className = '';
    Object.assign(statusSel.querySelector('select').style, { background: 'transparent', border: 0, outline: 'none', appearance: 'none', cursor: 'pointer' });

    // frame
    const frameBox = h('div.insp-frame', {
      ondragover: (e) => { if (isExternal(e)) { e.preventDefault(); frameBox.classList.add('file-over'); } },
      ondragleave: () => frameBox.classList.remove('file-over'),
      ondrop: (e) => { e.preventDefault(); frameBox.classList.remove('file-over'); const m = droppedMedia(e.dataTransfer); setFrameFrom(id, m.files || (m.url ? [m.url] : [])); },
    }, shot.frame ? mediaEl(pid, shot.frame, { controls: shot.frame.kind === 'video' }) : h('div', { onclick: async () => setFrameFrom(id, await pickFiles({ multiple: false })) }, emptyFrame('Drop or paste a still / clip, or click to browse')));
    if (shot.frame?.kind === 'image') frameBox.addEventListener('dblclick', quickLook);

    const frameActions = h('div.frame-actions', null,
      btn(shot.frame ? 'Replace' : 'Browse…', async () => setFrameFrom(id, await pickFiles({ multiple: false })), { icon: 'upload', cls: 'small ghost' }),
      btn('From moodboard', async () => { const [r] = await pickFromBoards(store, { multiple: false, title: 'Use as frame' }); if (r) store.update((p) => { get().frame = toFrame(r); trackFrame(p, get()); }); }, { icon: 'mood', cls: 'small ghost' }),
      shot.frame && btn('Finder', () => api.reveal(pid, shot.frame.src), { icon: 'folder', cls: 'small ghost', title: 'Show file in Finder (drag it into Higgsfield or Premiere from there)' }),
      shot.frame && iconBtn('trash', 'Remove frame', () => store.update(() => { get().frame = null; }), 'small'));

    // prompt
    const promptIn = autosize(h('textarea.input.prompt-box', {
      value: shot.prompt || '', rows: 3, dataset: { field: 'prompt' },
      placeholder: buildPrompt(shot) || 'Describe the shot, or fill in the fields above and press Build.',
      oninput: (e) => set('prompt', e.target.value),
    }));
    const preview = h('div.prompt-preview', { title: 'What gets copied and exported' });
    const buildBtn = btn('Build', () => {
      const v = buildPrompt(get());
      if (!v) return toast('Fill in the action or camera fields first');
      promptIn.value = v;
      promptIn.dispatchEvent(new Event('input'));
    }, { icon: 'wand', cls: 'small ghost', title: 'Write a prompt from the shot fields' });
    const copyBtn = btn('Copy', async () => { await copyText(fullPrompt(get(), store.settings)); toast('Prompt copied — paste it into Higgsfield'); }, { icon: 'copy', cls: 'small', title: `Copy the full prompt, with the project look (${modKey}C)` });

    const durIn = h('input.input.mono', {
      type: 'number', min: 0.1, step: 0.5, value: shot.duration, dataset: { field: 'duration' },
      oninput: (e) => { const v = parseFloat(e.target.value); if (v > 0) { set('duration', Math.round(v * 100) / 100); frames.textContent = `${Math.round(v * Number(store.settings.fps))} fr`; } },
    });
    const frames = h('small.faint.mono', null, `${Math.round((Number(shot.duration) || 0) * Number(store.settings.fps))} fr @ ${store.settings.fps}`);
    const lensIn = h('input.input', { value: shot.lens || '', list: 'sb-lenses', placeholder: '35mm', dataset: { field: 'lens' }, oninput: (e) => set('lens', e.target.value) });

    // refs
    const refsBox = h('div.refs');
    const renderRefs = () => {
      const s = get();
      refsBox.replaceChildren(...s.refs.map((r, i) => h('div.ref', { onclick: () => lightbox(pid, r) },
        mediaEl(pid, r, { hoverPlay: true }),
        h('button.x', { type: 'button', title: 'Remove reference', onclick: (e) => { e.stopPropagation(); store.update(() => { get().refs.splice(i, 1); }, { source: 'inspector' }); renderRefs(); } }, icon('close', 12)))),
      h('button.ref.ref-add', {
        type: 'button', title: 'Add reference images (drop files here)',
        onclick: (e) => menuFrom(e.currentTarget, [
          { label: 'From moodboards…', icon: 'mood', onClick: async () => addRefs(await pickFromBoards(store, { title: 'Add references' })) },
          { label: 'Browse files…', icon: 'upload', onClick: async () => addRefs(await addAll(pid, await pickFiles())) },
        ]),
        ondragover: (e) => { if (isExternal(e)) { e.preventDefault(); e.currentTarget.classList.add('file-over'); } },
        ondragleave: (e) => e.currentTarget.classList.remove('file-over'),
        ondrop: async (e) => { e.preventDefault(); e.currentTarget.classList.remove('file-over'); const m = droppedMedia(e.dataTransfer); addRefs(await addAll(pid, m.files || (m.url ? [m.url] : []))); },
      }, icon('plus', 18)));
    };
    const addRefs = (refs) => {
      if (!refs.length) return;
      store.update(() => { const s = get(); for (const r of refs) if (!s.refs.some((x) => x.src === r.src)) s.refs.push({ src: r.src, kind: r.kind }); }, { source: 'inspector' });
      renderRefs();
    };
    renderRefs();
    syncPreview();

    // takes from ai-footage/incoming
    const myTakes = takes[f.code] || [];
    const takesBox = myTakes.length ? h('div.insp-section', null,
      h('div.sec-head', null, h('h4', null, `Generated takes · ${myTakes.length}`), iconBtn('history', 'Rescan takes folder', () => loadTakes(true), 'small')),
      h('div.takes', null, myTakes.map((t) => h('div.take', {
        title: t.prompt || t.name,
        onclick: (e) => menu(e.clientX, e.clientY, [
          { label: 'Use as frame', icon: 'check', onClick: async () => {
            const r = await api.importTake(pid, t.name).catch((err) => toast(err.message, { type: 'error' }));
            if (!r) return;
            const meta = await probe(mediaUrl(pid, r.src), r.kind);
            store.update((p) => {
              const s = get();
              s.frame = toFrame({ ...r, ...meta });
              trackFrame(p, s, { prompt: t.prompt || s.prompt || '', note: `Take v${String(t.version).padStart(3, '0')}${t.model ? ` · ${t.model}` : ''}${t.seed !== '' ? ` · seed ${t.seed}` : ''}` });
              if (['idea', 'prompt'].includes(s.status)) s.status = 'generated';
              if (t.seed !== '' && !s.seed) s.seed = String(t.seed);
              if (t.model && !s.model) s.model = t.model;
            });
          } },
          { label: 'Preview', icon: 'eye', onClick: () => window.open(t.url, '_blank') },
        ]),
      }, t.kind === 'video' ? h('video', { src: `${t.url}#t=0.1`, muted: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => e.target.pause() }) : h('img', { src: t.url }),
      h('span', null, `v${String(t.version).padStart(3, '0')}`))))) : null;

    return [
      h('div.insp-head', null,
        h('span.insp-code', null, f.code), numIn, h('div.grow'), statusSel,
        iconBtn('dots', 'Shot actions', (e) => { const r = e.currentTarget.getBoundingClientRect(); shotMenu(r.left - 150, r.bottom + 4); }, 'small')),
      frameBox, frameActions,
      h('div.insp-section', null,
        field('Action / description', text('action', { placeholder: 'What we see. e.g. Maya steps out of the taxi into the rain, looks up at the neon sign.', rows: 3 })),
        field('Dialogue / VO', text('dialogue', { placeholder: 'Lines, voice-over, or on-screen text', rows: 1 })),
        h('div.cols-3', null, field('Size', sel3(SIZES, 'size')), field('Angle', sel3(ANGLES, 'angle')), field('Movement', sel3(MOVES, 'move'))),
        h('div.cols-3', null, field('Lens', lensIn), field('Length (s)', durIn, frames), field('Transition in', select(TRANSITIONS, shot.transition, (v) => set('transition', v))))),
      h('div.insp-section', null,
        h('div.sec-head', null, h('h4', null, 'AI generation'), h('div.row', { style: { gap: '4px' } }, buildBtn, copyBtn)),
        promptIn, preview,
        field('Negative prompt', text('negative', { placeholder: store.settings.negative || 'Optional', rows: 1 })),
        h('div.cols-3', null,
          field('Seed', h('input.input.mono', { value: shot.seed || '', placeholder: 'random', dataset: { field: 'seed' }, oninput: (e) => set('seed', e.target.value.replace(/[^\d]/g, '')) })),
          field('Takes', h('input.input.mono', { type: 'number', min: 1, max: 20, value: shot.takes || '', placeholder: String(store.settings.takes || 1), dataset: { field: 'takes' }, oninput: (e) => set('takes', e.target.value) })),
          field('Made with', h('input.input', { value: shot.model || '', placeholder: 'Higgsfield…', list: 'sb-models', dataset: { field: 'model' }, oninput: (e) => set('model', e.target.value) })))),
      versionsBox(f),
      h('div.insp-section', null, h('div.sec-head', null, h('h4', null, 'References'), h('small.faint', null, 'Character, style, start frame…')), refsBox),
      takesBox,
      h('div.insp-section', null, field('Notes', text('notes', { placeholder: 'Anything else: VFX, sound, props, edit ideas…', rows: 2 }))),
    ];
  }

  // The shot's evolution tree in brief, with a way into it and into mark-up.
  function versionsBox(f) {
    const vs = versionsOf(store.p, f.shot.id);
    const notes = vs.reduce((n, v) => n + openMarks(v).length, 0);
    const markUp = () => {
      const v = store.update((p) => trackFrame(p, store.find(f.shot.id).shot), { source: 'inspector' });
      if (v) openReview(store, v.id);
    };
    return h('div.insp-section', null,
      h('div.sec-head', null, h('h4', null, 'Versions'),
        h('small.faint', null, vs.length ? `${vs.length} version${vs.length > 1 ? 's' : ''}${notes ? ` · ${notes} open note${notes > 1 ? 's' : ''}` : ''}` : 'none yet')),
      h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
        btn('Open tree', () => app.go('versions', { shot: f.shot.id }), { icon: 'tree', cls: 'small' }),
        f.shot.frame?.kind === 'image' && btn('Mark up frame', markUp, { icon: 'marker', cls: 'small', title: 'Circle what should change and leave notes for Claude' })));
  }

  function multiInspector() {
    const list = store.shots().filter((x) => sel().has(x.shot.id));
    const total = list.reduce((t, x) => t + (Number(x.shot.duration) || 0), 0);
    const durIn = h('input.input.mono', { type: 'number', min: 0.1, step: 0.5, placeholder: 'seconds' });
    return [
      h('div.insp-head', null, h('span.insp-code', null, `${list.length} shots`), h('span.faint', null, fmtDuration(total))),
      h('div.insp-section', null,
        field('Set status', select([['', 'Choose…'], ...STATUSES.map((s) => [s.id, s.label])], '', (v) => v && store.update(() => list.forEach((x) => { x.shot.status = v; })))),
        field('Set length', h('div.row', null, durIn, btn('Apply', () => { const v = parseFloat(durIn.value); if (v > 0) store.update(() => list.forEach((x) => { x.shot.duration = v; })); }, { cls: 'small' }))),
        field('Move to scene', select([['', 'Choose…'], ...store.p.scenes.map((s) => [s.id, `SC${String(s.number).padStart(2, '0')} ${s.title}`])], '', (v) => v && moveShots(new Set(sel()), v, store.scene(v).shots.length))),
        h('div.row', null, btn('Copy prompts', copyPrompts, { icon: 'copy', cls: 'small' }), btn('Duplicate', () => duplicateShots(), { icon: 'copy', cls: 'small' }), btn('Delete', () => deleteShots(), { icon: 'trash', cls: 'small danger' }))),
    ];
  }

  function overview() {
    const all = store.shots();
    const total = store.totalSeconds();
    const counts = STATUSES.map((s) => [s, all.filter((x) => x.shot.status === s.id).length]);
    const framed = all.filter((x) => x.shot.frame).length;
    const k = (keys, what) => [h('span', null, keys.split(' ').map((x) => h('kbd', null, x))), h('span', null, what)];
    return h('div.overview', null,
      h('h3', null, 'Overview'),
      h('div.big-stats', null,
        h('div.big-stat', null, h('b', null, all.length), h('span', null, 'shots')),
        h('div.big-stat', null, h('b', null, fmtDuration(total)), h('span', null, 'runtime')),
        h('div.big-stat', null, h('b', null, `${all.length ? Math.round((framed / all.length) * 100) : 0}%`), h('span', null, 'have frames'))),
      h('div.legend', null, counts.map(([s, n]) => h('div', null, h('i', { style: { background: s.color } }), s.label, h('b', null, n)))),
      h('div', null, h('h4.muted', { style: { margin: '0 0 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Quick start'),
        h('div.shortcuts', null,
          k('Drop', 'Stills or clips onto a scene → one shot each'),
          k(`${modKey}V`, 'Paste a screenshot into the selected shot'),
          k('N', 'New shot'), k('⇧N', 'New scene'),
          k(`${modKey}C`, 'Copy selected shot’s prompt'),
          k('Space', 'Quick look'), k('?', 'All shortcuts'))));
  }

  // --- takes ------------------------------------------------------------------------------

  async function loadTakes(force) {
    try {
      const r = await api.takes(pid);
      takes = r.takes || {};
      if (force) toast(`${Object.values(takes).flat().length} take(s) found in ${r.folder}`);
      for (const c of cards.values()) c.sig = null;
      renderMain();
      if (single()) renderInspector();
    } catch { /* takes are optional */ }
  }

  // --- keys & paste ----------------------------------------------------------------------

  function onKey(e) {
    if (isTyping(e)) {
      if (e.key === 'Escape') { e.target.blur(); return true; }
      return false;
    }
    const k = e.key;
    if (mod(e) && k.toLowerCase() === 'a') { e.preventDefault(); app.select(store.shots().map((x) => x.shot.id)); return true; }
    if (mod(e) && k.toLowerCase() === 'd') { e.preventDefault(); duplicateShots(); return true; }
    if (mod(e) && k.toLowerCase() === 'c' && sel().size && !window.getSelection()?.toString()) { e.preventDefault(); copyPrompts(); return true; }
    if (mod(e) || e.altKey) return false;
    if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); stepSelection(1); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); stepSelection(-1); return true; }
    if (k === 'n') { e.preventDefault(); addShot(); return true; }
    if (k === 'N') { e.preventDefault(); addScene(single()?.scene.id); return true; }
    if ((k === 'Delete' || k === 'Backspace') && sel().size) { e.preventDefault(); deleteShots(); return true; }
    if (k === ' ' && single()) { e.preventDefault(); quickLook(); return true; }
    if (k === 'Enter' && single()) { e.preventDefault(); focusField('action'); return true; }
    if (k === 'Escape' && sel().size) { app.select([]); return true; }
    return false;
  }

  const onPaste = (e) => {
    if (isTyping(e) || document.querySelector('.modal-back')) return;
    const m = droppedMedia(e.clipboardData);
    const inputs = m.files || (m.url ? [m.url] : []);
    if (!inputs.length) return;
    e.preventDefault();
    const f = single();
    if (f) setFrameFrom(f.shot.id, inputs);
    else if (store.p.scenes.length) { const sc = store.p.scenes.at(-1); addShotsFrom(sc.id, sc.shots.length, inputs); }
  };
  document.addEventListener('paste', onPaste);

  const offChange = store.on('change', ({ source }) => {
    renderSide();
    renderMain();
    if (source === 'remote') renderInspector({ remote: true });
    else if (source !== 'inspector') renderInspector();
    else if (single()) {
      insp.querySelector('.insp-code').textContent = single().code;
      insp.dataset.sig = inspectorSig() || '';
    }
  });

  // shared list for the lens + model inputs
  const lists = h('div', { style: { display: 'none' } },
    h('datalist', { id: 'sb-lenses' }, LENSES.map((l) => h('option', { value: l }))),
    h('datalist', { id: 'sb-models' }, ['Higgsfield · Kling 2.5', 'Higgsfield · Seedance', 'Higgsfield · Veo 3.1', 'Higgsfield · Soul', 'Higgsfield · Nano Banana', 'Kling', 'Runway', 'Midjourney', 'LTX local', 'Photoshop / drawn'].map((m) => h('option', { value: m }))));
  root.append(lists);

  layout();
  renderSide();
  renderInspector();
  loadTakes(false);
  if (app.current) requestAnimationFrame(() => revealShot(app.current));

  return {
    onKey,
    onSelect,
    refresh: () => { for (const c of cards.values()) c.sig = null; layout(); renderSide(); renderInspector(); },
    unmount: () => { offChange(); document.removeEventListener('paste', onPaste); root.remove(); },
  };
}
