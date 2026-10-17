// Print view for the "Storyboard PDF" export: paginated frames + notes,
// then the browser's own Print › Save as PDF.

import { api, mediaUrl } from './api.js';
import { normalize, shotCode } from './store.js';
import { aspectRatio, cameraLine, fullPrompt, statusOf } from './vocab.js';
import { fmtDuration, h } from './ui.js';

const q = new URLSearchParams(location.search);
const LAYOUTS = {
  3: { cols: 1, rows: 3, landscape: false, cls: 'list' },
  4: { cols: 2, rows: 2, landscape: true },
  6: { cols: 3, rows: 2, landscape: true },
  9: { cols: 3, rows: 3, landscape: false },
  12: { cols: 4, rows: 3, landscape: true, cls: 'thumbs' },
};
const PAPER = { A4: [210, 297], Letter: [215.9, 279.4] };
const layout = LAYOUTS[q.get('layout')] || LAYOUTS[6];
const fields = new Set((q.get('f') || 'action,dialogue,camera').split(',').filter(Boolean));
const paperSel = document.getElementById('paper');
paperSel.value = /^en-US|en-CA/.test(navigator.language) ? 'Letter' : 'A4';

// First frame of a clip as a still, so videos print.
function videoStill(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = `${url}#t=0.1`;
    const done = (src) => { clearTimeout(timer); resolve(src); };
    const timer = setTimeout(() => done(''), 8000);
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        done(c.toDataURL('image/jpeg', 0.88));
      } catch { done(''); }
    }, { once: true });
    v.addEventListener('loadeddata', () => { v.currentTime = 0.1; }, { once: true });
    v.addEventListener('error', () => done(''), { once: true });
  });
}

function sizePages() {
  const [w, hgt] = PAPER[paperSel.value];
  const [pw, ph] = layout.landscape ? [hgt, w] : [w, hgt];
  document.documentElement.style.setProperty('--pw', `${pw}mm`);
  document.documentElement.style.setProperty('--ph', `${ph}mm`);
  document.documentElement.style.setProperty('--ph-print', `${ph - 0.5}mm`);
  document.getElementById('page-size').textContent = `@page { size: ${paperSel.value} ${layout.landscape ? 'landscape' : 'portrait'}; margin: 0; }`;
}

async function main() {
  const p = normalize(await api.get(q.get('p')));
  document.title = `${p.name} — storyboard`;
  document.getElementById('title').textContent = p.name;
  document.documentElement.style.setProperty('--ar', String(aspectRatio(p.settings.aspect)));
  document.documentElement.style.setProperty('--cols', layout.cols);
  document.documentElement.style.setProperty('--rows', layout.rows);
  sizePages();

  const shots = p.scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot, code: shotCode(scene, shot) })));
  const total = shots.reduce((t, x) => t + (Number(x.shot.duration) || 0), 0);
  const stills = await Promise.all(shots.map((x) => (x.shot.frame?.kind === 'video' ? videoStill(mediaUrl(p.id, x.shot.frame.src)) : Promise.resolve(x.shot.frame ? mediaUrl(p.id, x.shot.frame.src) : ''))));
  const per = layout.cols * layout.rows;
  const pageCount = Math.max(1, Math.ceil(shots.length / per));
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  const cell = (x, i) => {
    const s = x.shot;
    const prevScene = i > 0 ? shots[i - 1].scene : null;
    const camera = [cameraLine(s), s.transition && s.transition !== 'Cut' ? s.transition : ''].filter(Boolean).join(' · ');
    const info = [
      h('div.head-row', null, h('span', null, x.code.replace('_', ' · ')), h('span', null, fmtDuration(Number(s.duration) || 0))),
      fields.has('camera') && camera && h('p.f.camera', null, camera),
      fields.has('action') && s.action && h('p.f', null, s.action),
      fields.has('dialogue') && s.dialogue && h('p.f.dialogue', null, `“${s.dialogue}”`),
      fields.has('prompt') && h('p.f.prompt', null, h('b', null, 'Prompt'), fullPrompt(s, p.settings)),
      fields.has('notes') && s.notes && h('p.f.notes', null, h('b', null, 'Notes'), s.notes),
      fields.has('status') && h('p.f.camera', null, h('b', null, 'Status'), statusOf(s.status).label),
    ];
    const frame = h('div.frame', null, stills[i] ? h('img', { src: stills[i], alt: x.code }) : h('div.empty', null, 'No frame'));
    const tag = h('div.scene-tag', null, x.scene !== prevScene || i % per === 0 ? `SC${String(x.scene.number).padStart(2, '0')} ${x.scene.title || ''}` : '');
    return layout.cls === 'list'
      ? h('div.cell', null, h('div', null, tag, frame), h('div', null, h('div.scene-tag', null, ' '), ...info))
      : h('div.cell', null, tag, frame, ...info);
  };

  const pages = [];
  for (let pg = 0; pg < pageCount; pg++) {
    pages.push(h('section.page', null,
      h('header.page-head', null, h('h1', null, p.name), h('span.meta', null, `${shots.length} shots · ${fmtDuration(total)} · ${p.settings.aspect} · ${date}`), h('span.num', null, `${pg + 1} / ${pageCount}`)),
      h(`div.grid${layout.cls ? `.${layout.cls}` : ''}`, null, shots.slice(pg * per, pg * per + per).map((x, k) => cell(x, pg * per + k)))));
  }
  document.getElementById('pages').replaceChildren(...pages);
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  if (q.get('auto') !== '0') setTimeout(() => window.print(), 300);
}

paperSel.addEventListener('change', sizePages);
document.getElementById('print').addEventListener('click', () => window.print());
main().catch((e) => { document.getElementById('pages').replaceChildren(h('div.loading', null, `Couldn’t load the project: ${e.message}`)); });
