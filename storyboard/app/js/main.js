// App shell: home screen (project list), project top bar, view switching,
// settings, history and global shortcuts.

import { api, mediaUrl } from './api.js';
import { openExport } from './exports.js';
import { renumberScene, projectFromTemplate, Store, TEMPLATES } from './store.js';
import { ASPECTS, aspectRatio, FPS } from './vocab.js';
import {
  $, btn, confirmDialog, field, fmtDuration, h, icon, iconBtn, isTyping, menu, menuFrom, mod, modal,
  modKey, promptDialog, select, timeAgo, toast,
} from './ui.js';
import * as storyboard from './storyboard.js';
import * as moodboard from './moodboard.js';
import * as animatic from './animatic.js';
import * as versions from './versions.js';

const VIEWS = { board: storyboard, mood: moodboard, versions, animatic };
const VIEW_TABS = [['board', 'Storyboard', 'board', '1'], ['mood', 'Moodboard', 'mood', '2'], ['versions', 'Versions', 'tree', '3'], ['animatic', 'Animatic', 'film', '4']];
const root = $('#app');

const app = {
  store: null,
  view: null,
  viewName: null,
  selection: new Set(),   // selected shot ids, shared by storyboard + animatic
  current: null,          // focused shot id
  go(view, opts) { location.hash = `#/p/${app.store.id}/${view}`; app.pendingOpts = opts; },
  select(ids, current = ids[ids.length - 1] ?? null) {
    app.selection = new Set(ids);
    app.current = current;
    app.view?.onSelect?.();
    app.store?.setPresence({ view: app.viewName, shot: current, version: null, selection: [...app.selection] });
  },
};

// --- routing -------------------------------------------------------------------

async function route() {
  const [, kind, id, view = 'board'] = location.hash.split('/');
  if (kind === 'p' && id) {
    if (app.store?.id !== id) {
      try {
        await openProject(id);
      } catch (e) {
        toast(e.message, { type: 'error' });
        location.hash = '#/';
        return;
      }
    }
    showView(VIEWS[view] ? view : 'board');
  } else {
    closeProject();
    renderHome();
  }
}

async function openProject(id) {
  closeProject();
  const data = await api.get(id);
  const store = new Store(data);
  app.store = store;
  app.selection = new Set();
  app.current = null;
  document.title = `${store.p.name} · Storyboard`;
  renderShell();
}

function closeProject(discard = false) {
  if (!app.store) return;
  app.view?.unmount?.();
  app.view = null;
  app.viewName = null;
  if (discard) app.store.dirty = false;
  app.store.saveSoon.cancel();
  app.store.flush();
  app.store.close();
  app.store = null;
  document.title = 'Storyboard';
}

// Reload the project from disk, dropping this window's unsaved edits.
async function reopen() {
  const id = app.store.id;
  closeProject(true);
  await openProject(id);
  route();
}

function showView(name) {
  if (app.viewName === name) return;
  app.view?.unmount?.();
  const host = $('.view', root);
  host.replaceChildren();
  app.viewName = name;
  root.querySelectorAll('.seg [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  app.view = VIEWS[name].mount(host, { store: app.store, app, opts: app.pendingOpts });
  app.pendingOpts = null;
  if (name !== 'versions') app.store.setPresence({ view: name, version: null, shot: app.current });
}

// Changes saved by Claude or another window: say what happened, offer undo,
// and briefly highlight what changed.
function announceRemote({ actor, summary, touched = [] }) {
  const who = { claude: 'Claude', history: 'Version history' }[actor] || 'Another window';
  toast(`${who}: ${summary || 'updated the board'}`, { action: 'Undo', onAction: () => app.store?.undo(), timeout: 6000 });
  requestAnimationFrame(() => {
    for (const id of touched) {
      for (const el of document.querySelectorAll(`[data-shot="${id}"],[data-node="${id}"],[data-scene="${id}"],[data-id="${id}"]`)) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 2700);
      }
    }
  });
}

// --- top bar --------------------------------------------------------------------

function renderShell() {
  const store = app.store;
  root.className = '';
  const name = h('input.project-name', {
    value: store.p.name, spellcheck: false, title: 'Rename project',
    oninput: (e) => store.update((p) => { p.name = e.target.value; }, { key: 'name', source: 'name' }),
    onblur: (e) => { if (!e.target.value.trim()) store.update((p) => { p.name = 'Untitled project'; }); e.target.value = store.p.name; document.title = `${store.p.name} · Storyboard`; },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
  });
  name.style.width = `${Math.min(320, Math.max(80, store.p.name.length * 8.5 + 24))}px`;
  name.addEventListener('input', () => { name.style.width = `${Math.min(320, Math.max(80, name.value.length * 8.5 + 24))}px`; });

  const saveState = h('span.save-state', { title: '' }, h('i'), h('span', null, 'Saved'));
  const undoBtn = iconBtn('undo', `Undo (${modKey}Z)`, () => store.undo());
  const redoBtn = iconBtn('redo', `Redo (${modKey}⇧Z)`, () => store.redo());
  const syncUndo = () => { undoBtn.disabled = !store.past.length; redoBtn.disabled = !store.future.length; };
  syncUndo();
  store.on('change', (ev) => {
    syncUndo();
    if ((ev.source === 'undo' || ev.source === 'redo' || ev.source === 'remote') && document.activeElement !== name) {
      name.value = store.p.name;
      name.style.width = `${Math.min(320, Math.max(80, name.value.length * 8.5 + 24))}px`;
      document.title = `${store.p.name} · Storyboard`;
    }
    if (ev.source === 'remote') announceRemote(ev);
  });
  store.on('status', ({ status, message }) => {
    saveState.className = `save-state ${status}`;
    saveState.lastChild.textContent = { saved: 'Saved', pending: 'Edited', saving: 'Saving…', error: 'Not saved', conflict: 'Conflict' }[status];
    saveState.title = message || (status === 'saved' ? `Saved to ${store.path}` : '');
  });

  const syncAspect = () => document.documentElement.style.setProperty('--ar', String(aspectRatio(store.settings.aspect)));
  syncAspect();
  store.on('change', syncAspect);

  root.replaceChildren(
    h('header.topbar', null,
      h('div.left', null,
        iconBtn('grid', 'All projects', () => { location.hash = '#/'; }),
        name),
      h('nav.seg', { role: 'tablist' }, VIEW_TABS.map(([v, label, ic, key]) => h('button', {
        type: 'button', dataset: { view: v }, title: `${label} (${key})`, role: 'tab',
        onclick: () => app.go(v),
      }, icon(ic), h('span', null, label)))),
      h('div.right', null,
        saveState, undoBtn, redoBtn,
        btn('Export', () => openExport(app), { icon: 'download', cls: 'small' }),
        iconBtn('dots', 'Project menu', (e) => menuFrom(e.currentTarget, [
          { label: 'Project settings…', icon: 'settings', onClick: openSettings },
          { label: 'Version history…', icon: 'history', onClick: openHistory },
          { label: 'Show project folder', icon: 'folder', onClick: () => api.reveal(store.id, '.') },
          { label: 'Connect Claude…', icon: 'sparkle', onClick: openClaude },
          '-',
          { label: 'Keyboard shortcuts', icon: 'help', kbd: '?', onClick: openHelp },
        ])))),
    h('main.view'));
}

// --- Claude desktop app ----------------------------------------------------------

async function openClaude() {
  let status;
  try { status = await api.claudeStatus(); } catch (e) { return toast(e.message, { type: 'error' }); }
  const statusLine = h('p.muted');
  const showStatus = (st) => {
    statusLine.replaceChildren(st.installed
      ? h('span', null, h('b', { style: { color: 'var(--ok)' } }, 'Connected. '), 'If Claude was open while you connected, quit it completely (⌘Q) and open it again.')
      : st.appFound ? 'Not connected yet.' : h('span', null, 'The Claude desktop app wasn’t found. Install it from ', h('a', { href: 'https://claude.ai/download', target: '_blank', rel: 'noopener' }, 'claude.ai/download'), ' and sign in with your Pro account, then come back here.'));
  };
  showStatus(status);
  const examples = [
    'What’s on my storyboard so far? Summarize it scene by scene.',
    'Look at my notes on the shot I have selected and write the next variation.',
    'Pitch three alternative openings and add them as new shots in scene 1.',
    'Rewrite the prompts in scene 2 so they all match the project look.',
    'Look at the frames in scene 1. Anything breaking continuity?',
    'Add the images in ~/Downloads/renders to the selected shot as variations of v1.',
    'Start a new 9:16 project from this script, one scene per beat, and open it.',
  ];
  modal({
    title: 'Connect Claude', wide: true,
    body: h('div', { style: { display: 'grid', gap: '16px' } },
      h('p', null, 'Lets Claude in the Claude desktop app read this storyboard, your versions and mark-up notes, and make changes. Changes appear here live, and you can undo them. It runs on your Claude plan, with no extra cost.'),
      h('ol.claude-steps', null,
        h('li', null, h('div', null, h('b', null, 'Click Connect below. '), 'Storyboard adds itself to the Claude app’s connectors.')),
        h('li', null, h('div', null, h('b', null, 'Quit Claude completely (⌘Q) and open it again. '), 'If macOS asks whether Claude may access a folder, click Allow.')),
        h('li', null, h('div', null, h('b', null, 'Keep Storyboard running while you chat. '), 'Claude works on the project you have open here.'))),
      statusLine,
      h('div', null, h('h4.muted', { style: { margin: '0 0 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Then try asking Claude'),
        h('div.try-list', null, examples.map((t) => h('div', null, `“${t}”`))))),
    actions: [
      { label: 'Close', value: false },
      { label: status.installed ? 'Reconnect' : 'Connect', primary: true, onClick: () => {
        api.claudeInstall().then((st) => { showStatus(st); toast('Storyboard was added to Claude. Restart Claude to use it.'); })
          .catch((e) => toast(e.message, { type: 'error', timeout: 8000 }));
        return false;
      } },
    ],
  });
}

// --- settings / history / help ----------------------------------------------------

function openSettings() {
  const store = app.store;
  const s = { ...store.settings };
  const nameIn = h('input.input', { value: store.p.name });
  const wIn = h('input.input.mono', { type: 'number', value: s.width, min: 16 });
  const hIn = h('input.input.mono', { type: 'number', value: s.height, min: 16 });
  const aspectSel = select(ASPECTS.map((a) => [a[0], a[1]]), s.aspect, (v) => {
    const a = ASPECTS.find((x) => x[0] === v);
    s.aspect = v;
    if (a) { wIn.value = a[2]; hIn.value = a[3]; }
  });
  const fpsSel = select(FPS.map((f) => [f, `${f} fps`]), s.fps, (v) => { s.fps = v; });
  const durIn = h('input.input.mono', { type: 'number', value: s.duration, min: 0.5, step: 0.5 });
  const takesIn = h('input.input.mono', { type: 'number', value: s.takes || 1, min: 1, max: 20 });
  const lookIn = h('textarea.input', { rows: 3, value: s.look || '', placeholder: 'e.g. Cinematic 35mm film, anamorphic, teal-and-orange grade, soft haze, shallow depth of field' });
  const negIn = h('textarea.input', { rows: 2, value: s.negative || '', placeholder: 'e.g. blurry, warped hands, text, watermark' });

  modal({
    title: 'Project settings', wide: true,
    body: h('div', { style: { display: 'grid', gap: '14px' } },
      field('Project name', nameIn),
      h('div.cols-3', null, field('Aspect ratio', aspectSel), field('Frame rate', fpsSel),
        field('Resolution', h('div.row', null, wIn, h('span.faint', null, '×'), hIn), 'Used for the Premiere sequence and slates')),
      h('div.cols-2', null, field('Default shot length (s)', durIn), field('Default takes per shot', takesIn, 'Used by gen_clip.py batch')),
      field('Look / style prefix', lookIn, 'Added to the front of every prompt you copy or export, so all shots share one look.'),
      field('Default negative prompt', negIn),
      h('div.row', null, btn('Renumber all scenes & shots', async () => {
        if (!(await confirmDialog('Scenes become SC01, SC02… in board order and shots SH010, SH020… Clips already generated keep their old names.', { title: 'Renumber everything?', ok: 'Renumber' }))) return;
        store.update((p) => { p.scenes.forEach((sc, i) => { sc.number = i + 1; renumberScene(sc); }); });
        toast('Renumbered');
      }, { icon: 'list', cls: 'small' }), h('span.faint', { style: { fontSize: '12px' } }, `Saved in ${store.path}`))),
    actions: [{ label: 'Cancel', value: false }, {
      label: 'Save', primary: true, onClick: () => {
        store.update((p) => {
          p.name = nameIn.value.trim() || p.name;
          Object.assign(p.settings, {
            aspect: s.aspect, fps: s.fps, width: Math.max(16, Number(wIn.value) || 1920), height: Math.max(16, Number(hIn.value) || 1080),
            duration: Math.max(0.1, Number(durIn.value) || 3), takes: Math.max(1, Number(takesIn.value) || 1),
            look: lookIn.value.trim(), negative: negIn.value.trim(),
          });
        });
        $('.project-name').value = store.p.name;
        app.view?.refresh?.();
      },
    }],
  });
}

async function openHistory() {
  const store = app.store;
  await store.save();
  const { snapshots } = await api.history(store.id);
  modal({
    title: 'Version history', wide: true,
    body: (close) => h('div', { style: { display: 'grid', gap: '12px' } },
      h('p.muted', null, 'A snapshot of the project is kept every 10 minutes while you work (the last 60). Restoring one keeps a snapshot of the current state too, so nothing is lost.'),
      snapshots.length ? h('div.hist-list', null, snapshots.map((s) => h('div.hist-item', null,
        icon('history'),
        h('div.grow', null, h('div', null, new Date(s.time).toLocaleString()), h('small.muted', null, `${s.shots} shots · ${s.items} board items · ${timeAgo(s.time)}`)),
        btn('Restore', async () => {
          if (!(await confirmDialog(`Go back to the version from ${new Date(s.time).toLocaleString()}?`, { title: 'Restore version', ok: 'Restore' }))) return;
          await api.restore(store.id, s.name);
          close();
          await reopen();
          toast('Version restored');
        }, { cls: 'small' })))) : h('p.faint', null, 'No snapshots yet. The first one is taken on the next save.')),
  });
}

export function openHelp() {
  const k = (keys, what) => [h('span', null, keys.split(' ').map((x) => h('kbd', null, x))), h('span', null, what)];
  modal({
    title: 'Keyboard shortcuts', wide: true,
    body: h('div.cols-2', { style: { gap: '24px' } },
      h('div', null, h('h4.muted', null, 'Everywhere'), h('div.shortcuts', null,
        k('1 2 3 4', 'Storyboard · Moodboard · Versions · Animatic'), k(`${modKey}Z`, 'Undo'), k(`${modKey}⇧Z`, 'Redo'), k(`${modKey}S`, 'Save now'), k('?', 'This list')),
      h('h4.muted', { style: { marginTop: '18px' } }, 'Storyboard'), h('div.shortcuts', null,
        k('N', 'New shot after selection'), k('⇧N', 'New scene'), k('← →', 'Previous / next shot'), k('Space', 'Quick look'),
        k(`${modKey}D`, 'Duplicate shot'), k('⌫', 'Delete shot'), k(`${modKey}V`, 'Paste image into selected shot'), k('Enter', 'Edit action text'),
        k(`${modKey}C`, 'Copy shot’s full prompt'))),
      h('div', null, h('h4.muted', null, 'Versions'), h('div.shortcuts', null,
        k('Drop', 'On a shot: references · on a version: variations'), k('Dbl-click', 'Mark up for Claude'), k('P', 'Pick as final'),
        k('↑ ↓ ← →', 'Move around the tree'), k('⌫', 'Delete version'), k('F', 'Fit')),
      h('h4.muted', { style: { marginTop: '18px' } }, 'Mark-up'), h('div.shortcuts', null,
        k('O R A P', 'Circle · box · arrow · draw'), k('V', 'Move marks'), k('⌫', 'Delete mark'), k('Esc', 'Done')),
      h('h4.muted', { style: { marginTop: '18px' } }, 'Moodboard'), h('div.shortcuts', null,
        k('V', 'Select tool'), k('H', 'Hand / pan (or hold Space)'), k('N', 'Sticky note'), k('T', 'Text'), k('S', 'Section'), k('C', 'Color swatch'),
        k('Scroll', 'Pan'), k(`${modKey} Scroll`, 'Zoom (or pinch)'), k('⇧1', 'Zoom to fit'), k('Dbl-click', 'New note / edit'), k(`${modKey}D`, 'Duplicate'), k('⌫', 'Delete')),
      h('h4.muted', { style: { marginTop: '18px' } }, 'Animatic'), h('div.shortcuts', null,
        k('Space', 'Play / pause'), k('J K L', 'Back 1 s · pause · play'), k('← →', 'Step one frame (⇧ = 1 s)'), k('↑ ↓', 'Previous / next shot'), k('Home End', 'Start / end'), k('C', 'Captions'), k('F', 'Full screen'),
        k('Drag', 'Trim a shot’s right edge in the timeline')))),
  });
}

// --- home ---------------------------------------------------------------------------

async function renderHome() {
  root.className = 'home';
  document.title = 'Storyboard';
  let data;
  try {
    data = await api.projects();
  } catch (e) {
    root.replaceChildren(h('div.empty-home', null, h('h2', null, 'Storyboard isn’t running'), h('p', null, 'Start it again the way you started it before (the python3 command in Terminal), then reload this page.')));
    return;
  }
  const cards = data.projects.map((p) => {
    const cover = p.cover ? (p.cover.kind === 'video'
      ? h('video', { src: `${mediaUrl(p.id, p.cover.src)}#t=0.1`, muted: true, preload: 'metadata' })
      : null) : icon('film', 28);
    const open = () => { location.hash = `#/p/${p.id}/board`; };
    const card = h('div.proj-card', {
      role: 'button', tabIndex: 0, onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter') open(); },
      oncontextmenu: (e) => { e.preventDefault(); projectMenu(e.clientX, e.clientY, p); },
    },
      h('div.proj-cover', { style: p.cover && p.cover.kind !== 'video' ? { backgroundImage: `url("${mediaUrl(p.id, p.cover.src)}")` } : {} }, cover),
      h('div.proj-meta', null,
        h('div.grow', { style: { minWidth: 0 } }, h('h3', null, p.name),
          h('p', null, `${p.shots} shot${p.shots === 1 ? '' : 's'} · ${fmtDuration(p.seconds)} · ${p.aspect} · ${timeAgo(p.updated)}`)),
        iconBtn('dots', 'Project actions', (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); projectMenu(r.left, r.bottom + 4, p); })));
    return card;
  });
  root.replaceChildren(h('div.home-wrap', null, h('div.home-inner', null,
    h('div.home-head', null,
      h('div.brand', null, h('div.brand-mark', null, icon('film', 22)),
        h('div', null, h('h1', null, 'Storyboard'), h('p', null, 'Boards, moodboards and animatics, saved on this computer.'))),
      h('div.grow'), btn('New project', newProject, { icon: 'plus', cls: 'primary' })),
    h('div.projects', null,
      h('button.proj-card.proj-new', { type: 'button', onclick: newProject }, h('div.plus', null, icon('plus', 20)), h('span', null, 'New project')),
      cards),
    h('div.data-path', null, icon('folder', 14), h('span', null, `Projects are saved in ${data.data}`),
      btn('Connect Claude…', openClaude, { icon: 'sparkle', cls: 'small ghost' }),
      btn('Quit Storyboard', quitServer, { cls: 'small ghost', title: 'Stop the local Storyboard server' })))));
}

async function quitServer() {
  if (!(await confirmDialog('This stops the Storyboard server on this computer. Your projects are already saved. To start it again, run the same python3 command in Terminal.', { title: 'Quit Storyboard?', ok: 'Quit' }))) return;
  await api.shutdown().catch(() => {});
  root.replaceChildren(h('div.stopped', null, h('div', null, h('div.brand-mark', { style: { margin: '0 auto' } }, icon('film', 22)),
    h('h2', null, 'Storyboard has stopped'), h('p', null, 'You can close this tab.'))));
}

function projectMenu(x, y, p) {
  menu(x, y, [
    { label: 'Open', icon: 'arrow', onClick: () => { location.hash = `#/p/${p.id}/board`; } },
    { label: 'Rename…', icon: 'text', onClick: async () => {
      const name = await promptDialog('Rename project', p.name, { ok: 'Rename' });
      if (!name) return;
      const full = await api.get(p.id);
      delete full.path;
      full.name = name;
      await api.save(p.id, full, full.rev);
      renderHome();
    } },
    { label: 'Duplicate', icon: 'copy', onClick: async () => { await api.duplicate(p.id); renderHome(); } },
    { label: 'Show in Finder', icon: 'folder', onClick: () => api.reveal(p.id, '.') },
    '-',
    { label: 'Move to trash', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog(`“${p.name}” moves to the .trash folder inside your Storyboards folder. You can recover it from there.`, { title: 'Delete project?', ok: 'Delete', danger: true }))) return;
      await api.remove(p.id);
      renderHome();
    } },
  ]);
}

async function newProject() {
  let tpl = 'blank';
  let aspect = '16:9';
  let fps = '24';
  const nameIn = h('input.input', { placeholder: 'e.g. Neon Nights music video', autofocus: true });
  const tplGrid = h('div.tpl-grid', null, TEMPLATES.map((t) => h(`button.tpl${t.id === tpl ? '.on' : ''}`, {
    type: 'button', onclick: (e) => { tpl = t.id; tplGrid.querySelectorAll('.tpl').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
  }, h('b', null, t.label), h('span', null, t.desc))));
  const ok = await modal({
    title: 'New project', wide: true,
    body: h('div', { style: { display: 'grid', gap: '14px' } },
      field('Name', nameIn),
      h('div.cols-2', null,
        field('Aspect ratio', select(ASPECTS.map((a) => [a[0], a[1]]), aspect, (v) => { aspect = v; })),
        field('Frame rate', select(FPS.map((f) => [f, `${f} fps`]), fps, (v) => { fps = v; }))),
      field('Start from', tplGrid)),
    actions: [{ label: 'Cancel', value: false }, { label: 'Create project', primary: true, value: true }],
  });
  if (!ok) return;
  const a = ASPECTS.find((x) => x[0] === aspect);
  const project = projectFromTemplate(tpl, { aspect, fps, width: a[2], height: a[3], duration: 3 });
  const created = await api.create(nameIn.value.trim() || 'Untitled project', project);
  location.hash = `#/p/${created.id}/board`;
}

// --- global keys & lifecycle -----------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (!app.store) return;
  if (mod(e) && e.key.toLowerCase() === 'z' && !isTyping(e)) {
    e.preventDefault();
    e.shiftKey ? app.store.redo() : app.store.undo();
    return;
  }
  if (mod(e) && e.key.toLowerCase() === 'y' && !isTyping(e)) { e.preventDefault(); app.store.redo(); return; }
  if (mod(e) && e.key.toLowerCase() === 's') { e.preventDefault(); app.store.saveSoon.flush(); return; }
  if (document.querySelector('.modal-back')) return;
  if (app.view?.onKey?.(e)) return;
  if (isTyping(e) || mod(e) || e.altKey) return;
  const tab = VIEW_TABS.find((t) => t[3] === e.key);
  if (tab) { e.preventDefault(); app.go(tab[0]); return; }
  if (e.key === '?') { e.preventDefault(); openHelp(); }
});

addEventListener('hashchange', route);
addEventListener('pagehide', () => app.store?.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.store?.saveSoon.flush(); });
addEventListener('beforeunload', (e) => {
  if (app.store?.dirty || app.store?.saving) { app.store.flush(); }
  if (app.store?.status === 'error') { e.preventDefault(); e.returnValue = ''; }
});
// Dropping a file outside a drop zone shouldn't navigate away from the app.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

route();

// Project-list events: the home screen updates when Claude (or another
// window) creates, renames or deletes a project, and Claude can bring a
// project up in this window.
if (typeof EventSource !== 'undefined') {
  let homeTimer = 0;
  new EventSource('/api/events').onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.open && app.store?.id !== ev.open) location.hash = `#/p/${ev.open}/board`;
    if (ev.projects && !app.store) { clearTimeout(homeTimer); homeTimer = setTimeout(() => { if (!app.store) renderHome(); }, 300); }
  };
}

// The offline page (served by sw.js when the server is down, e.g. from the
// installed Chrome app) shows this command so Storyboard is easy to restart.
api.ping().then((r) => { try { if (r.command) localStorage.setItem('storyboard.command', r.command); } catch { /* private mode */ } }, () => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
