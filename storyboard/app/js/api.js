// Talks to server.py. Every write carries X-Storyboard so other websites
// open in the browser can't drive the local server.

const H = { 'X-Storyboard': '1' };

async function call(method, url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...H, ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Can’t reach the Storyboard server. Is it still running?'), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

export const api = {
  ping: () => call('GET', '/api/ping'),
  shutdown: () => call('POST', '/api/shutdown', {}),
  projects: () => call('GET', '/api/projects'),
  create: (name, project) => call('POST', '/api/projects', { name, project }),
  get: (id) => call('GET', `/api/projects/${id}`),
  save: (id, data, rev, { keepalive = false, client = '' } = {}) => keepalive
    ? fetch(`/api/projects/${id}/save`, { method: 'POST', keepalive: true, headers: { ...H, 'Content-Type': 'application/json', 'X-Base-Rev': String(rev), 'X-Client': client }, body: JSON.stringify(data) })
    : call('PUT', `/api/projects/${id}`, data, { 'X-Base-Rev': String(rev), 'X-Client': client }),
  presence: (id, info) => call('POST', `/api/projects/${id}/presence`, info),
  claudeStatus: () => call('GET', '/api/claude/status'),
  claudeInstall: () => call('POST', '/api/claude/install', {}),
  remove: (id) => call('DELETE', `/api/projects/${id}`),
  duplicate: (id) => call('POST', `/api/projects/${id}/duplicate`, {}),
  history: (id) => call('GET', `/api/projects/${id}/history`),
  restore: (id, name) => call('POST', `/api/projects/${id}/restore`, { name }),
  reveal: (id, path) => call('POST', `/api/projects/${id}/reveal`, { path }),
  fetchUrl: (id, url) => call('POST', `/api/projects/${id}/fetch`, { url }),
  takes: (id) => call('GET', `/api/projects/${id}/takes`),
  importTake: (id, name) => call('POST', `/api/projects/${id}/import-take`, { name }),
  export: (id, kind, payload = {}) => call('POST', `/api/projects/${id}/export/${kind}`, payload),
  upload: (id, file) => call('POST', `/api/projects/${id}/media`, file, {
    'X-Filename': encodeURIComponent(file.name || 'pasted.png'),
    'Content-Type': file.type || 'application/octet-stream',
  }),
};

export const mediaUrl = (id, src) => (src ? `/p/${id}/${src.split('/').map(encodeURIComponent).join('/')}` : '');

// Width/height/duration so exports and layouts know the media's shape.
export function probe(url, kind) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => resolve({}), 8000);
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    } else {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = () => done({ w: el.videoWidth || undefined, h: el.videoHeight || undefined, duration: Number.isFinite(el.duration) ? el.duration : undefined });
      el.onerror = () => done({});
      el.src = url;
    }
  });
}

// Upload a File (or fetch a URL) into the project and return a media ref:
// { src, kind, name, w, h, duration }
export async function addMedia(id, fileOrUrl) {
  const r = typeof fileOrUrl === 'string' ? await api.fetchUrl(id, fileOrUrl) : await api.upload(id, fileOrUrl);
  const meta = await probe(mediaUrl(id, r.src), r.kind);
  return { src: r.src, kind: r.kind, name: r.name, ...meta };
}
