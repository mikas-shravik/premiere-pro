// Small DOM + UI helpers shared by every view. No framework: h() builds
// elements, and modal/menu/toast cover the app's dialogs.

export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = name === 'svg' || props?.svg ? document.createElementNS('http://www.w3.org/2000/svg', name)
    : document.createElement(name || 'div');
  if (classes.length) el.setAttribute('class', classes.join(' '));
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', [el.getAttribute('class'), v].filter(Boolean).join(' '));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && !(el instanceof SVGElement) && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const pad = (n, w) => String(n).padStart(w, '0');

export function fmtDuration(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const ss = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return m ? `${m}:${ss.padStart(Number.isInteger(s) ? 2 : 4, '0')}` : `${ss}s`;
}

export function fmtTimecode(sec, fps) {
  const f = Math.round(Number(fps) || 24);
  const total = Math.round(Math.max(0, sec) * (Number(fps) || 24));
  const fr = total % f, s = Math.floor(total / f);
  return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}:${pad(fr, 2)}`;
}

export function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export function isTyping(e) {
  const t = e?.target || document.activeElement;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
export const modKey = isMac ? '⌘' : 'Ctrl+';

// --- icons (inline SVG, stroke-based, 24px grid) ---------------------------

const ICONS = {
  board: 'M3 5h7v6H3zM14 5h7v6h-7zM3 15h7v4H3zM14 15h7v4h-7z',
  mood: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  prev: 'M6 5v14M19 5L9 12l10 7z',
  next: 'M18 5v14M5 5l10 7-10 7z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01',
  video: 'M4 6h11v12H4zM15 10l5-3v10l-5-3z',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  swatch: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11h.01M10 7h.01M15 7.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7-2.5 0-4-1.5-5.5-3.5L3 13.5a1.5 1.5 0 0 1 2.5-1.7L8 14',
  cursor: 'M5 3l14 8-6 1.5L10 19z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  folder: 'M3 6h6l2 2h10v11H3z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  wand: 'M15 4V2M15 10V8M11 6H9M21 6h-2M18 3l-1.5 1.5M18 9l-1.5-1.5M12 3l1.5 1.5M3 21l10-10',
  palette: 'M4 4h4v16H4zM10 4h4v16h-4zM16 4h4v16h-4z',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 6l6 6-6 6',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  check: 'M5 12l5 5 9-10',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01',
  printer: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  captions: 'M3 5h18v14H3zM7 12h3M7 15h6M14 15h3M13 12h4',
  camera: 'M3 7h4l2-3h6l2 3h4v12H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  minus: 'M5 12h14',
  volume: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9h6v6H9z',
};

export function icon(name, size = 16) {
  const svg = h('svg', { svg: true, viewBox: '0 0 24 24', width: size, height: size, class: 'ico', 'aria-hidden': 'true' });
  const d = ICONS[name] || ICONS.dots;
  svg.append(h('path', { svg: true, d }));
  return svg;
}

export function btn(label, onClick, { icon: ic, cls = '', title, kbd } = {}) {
  return h(`button.btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', onclick: onClick, title: title || (kbd ? `${label} (${kbd})` : undefined) },
    ic && icon(ic), label && h('span', null, label));
}

export function iconBtn(ic, title, onClick, cls = '') {
  return h(`button.icon-btn${cls ? '.' + cls : ''}`, { type: 'button', title, 'aria-label': title, onclick: onClick }, icon(ic));
}

// --- toast -----------------------------------------------------------------

let toastHost;
export function toast(message, { action, onAction, type = '', timeout = 3500 } = {}) {
  toastHost ??= document.body.appendChild(h('div.toasts'));
  const t = h(`div.toast${type ? '.' + type : ''}`, null, h('span', null, message),
    action && h('button', { type: 'button', onclick: () => { onAction?.(); close(); } }, action));
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const close = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 200); };
  if (timeout) setTimeout(close, timeout);
  return close;
}

// --- modal -----------------------------------------------------------------

export function modal({ title, body, actions = [], wide = false, onClose, className = '' }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      back.classList.remove('in');
      setTimeout(() => back.remove(), 150);
      onClose?.(v);
      prev?.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const primary = actions.find((a) => a.primary);
        if (primary && document.activeElement?.tagName !== 'BUTTON') {
          e.preventDefault(); e.stopPropagation();
          close(primary.value !== undefined ? primary.value : (primary.onClick?.() ?? true));
        }
      }
      e.stopPropagation();
    };
    const box = h(`div.modal${wide ? '.wide' : ''}${className ? '.' + className : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, h('h2', null, title), iconBtn('close', 'Close', () => close(null))),
      h('div.modal-body', null, typeof body === 'function' ? body(close) : body),
      actions.length ? h('footer', null, actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
        type: 'button',
        onclick: () => {
          const v = a.onClick ? a.onClick() : a.value;
          if (v !== false) close(a.value !== undefined ? a.value : v ?? true);
        },
      }, a.label))) : null);
    const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(null); } }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      back.classList.add('in');
      (box.querySelector('[autofocus]') || box.querySelector('input,textarea,select') || box.querySelector('footer .primary'))?.focus();
    });
  });
}

export function confirmDialog(message, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
  return modal({ title, body: h('p.muted', null, message), actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true, danger }] });
}

export async function promptDialog(title, value = '', { label, placeholder, ok = 'OK' } = {}) {
  const input = h('input.input', { value, placeholder, autofocus: true });
  const res = await modal({
    title, body: h('label.field', null, label && h('span', null, label), input),
    actions: [{ label: 'Cancel', value: null }, { label: ok, primary: true, onClick: () => input.value }],
  });
  return res == null ? null : String(res).trim();
}

// --- context menu ----------------------------------------------------------

let openMenu;
export function menu(x, y, items) {
  openMenu?.();
  const el = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('div.menu-sep')); continue; }
    if (it.heading) { el.append(h('div.menu-heading', null, it.heading)); continue; }
    el.append(h(`button.menu-item${it.danger ? '.danger' : ''}${it.checked ? '.checked' : ''}`, {
      type: 'button', disabled: it.disabled, role: 'menuitem',
      onclick: () => { close(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 14) : it.swatch ? h('i.menu-swatch', { style: { background: it.swatch } }) : h('i.menu-gap'),
    h('span', null, it.label), it.kbd && h('kbd', null, it.kbd)));
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${clamp(x, 6, innerWidth - r.width - 6)}px`;
  el.style.top = `${y + r.height > innerHeight - 6 ? Math.max(6, y - r.height) : y}px`;
  const onDown = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (openMenu === close) openMenu = null;
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
  });
  openMenu = close;
  return close;
}

export function menuFrom(button, items) {
  const r = button.getBoundingClientRect();
  return menu(r.left, r.bottom + 4, items);
}

// --- form fields -----------------------------------------------------------

export function field(label, control, hint) {
  return h('label.field', null, h('span', null, label), control, hint && h('small.muted', null, hint));
}

export function select(options, value, onChange, props = {}) {
  const el = h('select.input', { ...props, onchange: (e) => onChange(e.target.value) },
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, l);
    }));
  return el;
}

export function autosize(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return ta;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: 0 } });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function pickFiles({ accept = 'image/*,video/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// Files, URLs or nothing, from a drop or paste event.
export function droppedMedia(dt) {
  const files = [...(dt?.files || [])].filter((f) => /^(image|video|audio)\//.test(f.type) || /\.(jpe?g|png|gif|webp|avif|svg|mp4|mov|m4v|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  if (files.length) return { files };
  const uri = dt?.getData?.('text/uri-list')?.split('\n').find((l) => l && !l.startsWith('#'));
  const html = dt?.getData?.('text/html');
  const img = html && /<img[^>]+src="([^"]+)"/i.exec(html)?.[1];
  const url = (img && /^https?:/.test(img) ? img : null) || uri?.trim();
  if (url && /^https?:\/\//.test(url)) return { url };
  return {};
}
