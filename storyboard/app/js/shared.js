// Media helpers used by several views: thumbnails, uploads with a progress
// pill, a lightbox, and a picker for moodboard images.

import { addMedia, mediaUrl } from './api.js';
import { h, icon, modal, toast } from './ui.js';

// <img> or <video> for a media ref. Videos show their first frame and can
// play on hover, which makes boards of generated clips easy to scan.
export function mediaEl(pid, ref, { hoverPlay = false, controls = false, autoplay = false, loop = true, muted = true, draggable = false } = {}) {
  if (!ref?.src) return null;
  const url = mediaUrl(pid, ref.src);
  if (ref.kind === 'video') {
    const v = h('video', { src: autoplay || controls ? url : `${url}#t=0.1`, preload: autoplay ? 'auto' : 'metadata', playsInline: true, controls, loop, autoplay, draggable });
    v.muted = muted;
    if (hoverPlay) {
      v.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
      v.addEventListener('mouseleave', () => { v.pause(); try { v.currentTime = 0.1; } catch { /* not loaded */ } });
    }
    return v;
  }
  if (ref.kind === 'audio') return h('audio', { src: url, controls: true, preload: 'metadata' });
  return h('img', { src: url, alt: ref.name || '', decoding: 'async', draggable });
}

let pill, pending = 0;
function busy(delta, label) {
  pending += delta;
  if (pending > 0) {
    pill ??= document.body.appendChild(h('div.uploading', null, h('i.spinner'), h('span')));
    pill.lastChild.textContent = label || `Adding ${pending} file${pending > 1 ? 's' : ''}…`;
  } else {
    pill?.remove();
    pill = null;
  }
}

// Files or URLs -> media refs, in order. Failures are reported and skipped.
export async function addAll(pid, inputs) {
  const list = [...inputs];
  if (!list.length) return [];
  busy(list.length);
  const out = await Promise.all(list.map(async (f) => {
    try {
      return await addMedia(pid, f);
    } catch (e) {
      toast(`${typeof f === 'string' ? 'Link' : f.name}: ${e.message}`, { type: 'error', timeout: 6000 });
      return null;
    } finally {
      busy(-1);
    }
  }));
  return out.filter(Boolean);
}

export function lightbox(pid, ref, caption) {
  const media = mediaEl(pid, ref, { controls: ref.kind === 'video', autoplay: ref.kind === 'video', muted: false });
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if ([' ', 'Escape', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); close(); } };
  const el = h('div.lightbox', { onclick: (e) => { if (e.target.tagName !== 'VIDEO') close(); } }, media,
    caption && h('div.cap', null, caption));
  document.body.append(el);
  document.addEventListener('keydown', onKey, true);
  return close;
}

// Every image/video on the project's moodboards, newest board first.
export function boardMedia(store) {
  const seen = new Set();
  const out = [];
  for (const b of store.p.boards) {
    for (const it of b.items) {
      if ((it.type === 'image' || it.type === 'video') && it.src && !seen.has(it.src)) {
        seen.add(it.src);
        out.push({ src: it.src, kind: it.type, w: it.mw, h: it.mh, duration: it.duration, board: b.name });
      }
    }
  }
  return out;
}

export async function pickFromBoards(store, { multiple = true, title = 'Pick from moodboards' } = {}) {
  const items = boardMedia(store);
  if (!items.length) {
    toast('Your moodboards have no images or clips yet.');
    return [];
  }
  const chosen = new Set();
  const grid = h('div.pick-grid', null, items.map((it, i) => {
    const b = h('button.pick', {
      type: 'button', title: it.board,
      onclick: () => {
        if (!multiple) chosen.clear();
        chosen.has(i) ? chosen.delete(i) : chosen.add(i);
        grid.querySelectorAll('.pick').forEach((el, k) => el.classList.toggle('on', chosen.has(k)));
      },
      ondblclick: () => { chosen.add(i); done?.(true); },
    }, mediaEl(store.id, it, { hoverPlay: true }));
    return b;
  }));
  let done;
  const ok = await modal({
    title, wide: true,
    body: (close) => { done = close; return grid; },
    actions: [{ label: 'Cancel', value: false }, { label: multiple ? 'Add selected' : 'Use', value: true, primary: true }],
  });
  return ok ? [...chosen].map((i) => items[i]) : [];
}

export function emptyFrame(text = 'Drop image or clip') {
  return h('div.frame-empty', null, icon('image', 22), h('span', null, text));
}
