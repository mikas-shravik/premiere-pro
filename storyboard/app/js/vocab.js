// Film vocabulary used by the shot fields, and the prompt builder that turns
// those fields into a text-to-video prompt (Higgsfield, Kling, Seedance...).

// [code, menu label, prompt phrase]
export const SIZES = [
  ['', '—', ''],
  ['EWS', 'EWS · Extreme wide', 'extreme wide shot'],
  ['WS', 'WS · Wide', 'wide shot'],
  ['FS', 'FS · Full shot', 'full body shot'],
  ['MWS', 'MWS · Medium wide', 'medium wide shot'],
  ['MS', 'MS · Medium', 'medium shot'],
  ['MCU', 'MCU · Medium close-up', 'medium close-up'],
  ['CU', 'CU · Close-up', 'close-up'],
  ['ECU', 'ECU · Extreme close-up', 'extreme close-up'],
  ['INS', 'INS · Insert / detail', 'insert detail shot'],
  ['OTS', 'OTS · Over the shoulder', 'over-the-shoulder shot'],
  ['POV', 'POV · Point of view', 'first-person point-of-view shot'],
  ['2S', '2S · Two shot', 'two shot'],
  ['EST', 'EST · Establishing', 'establishing shot'],
];

export const ANGLES = [
  ['', '—', ''],
  ['Eye level', 'Eye level', 'eye-level angle'],
  ['Low', 'Low angle', 'low angle looking up'],
  ['High', 'High angle', 'high angle looking down'],
  ['Overhead', 'Overhead / bird’s-eye', 'overhead top-down bird’s-eye view'],
  ['Worm', 'Worm’s-eye', 'worm’s-eye view from ground level'],
  ['Dutch', 'Dutch tilt', 'dutch angle, tilted horizon'],
  ['Profile', 'Profile', 'side profile angle'],
  ['Aerial', 'Aerial', 'high aerial view'],
];

// [code, label, prompt phrase, animatic move {s: scale, x, y as fractions}]
export const MOVES = [
  ['', '—', '', null],
  ['Static', 'Static', 'static locked-off camera', null],
  ['Push in', 'Push in', 'slow dolly-in push toward the subject', { s: [1, 1.14] }],
  ['Pull out', 'Pull out', 'slow dolly-out pull back revealing the scene', { s: [1.14, 1] }],
  ['Pan left', 'Pan left', 'camera pans left', { s: [1.12, 1.12], x: [0.05, -0.05] }],
  ['Pan right', 'Pan right', 'camera pans right', { s: [1.12, 1.12], x: [-0.05, 0.05] }],
  ['Tilt up', 'Tilt up', 'camera tilts up', { s: [1.12, 1.12], y: [-0.05, 0.05] }],
  ['Tilt down', 'Tilt down', 'camera tilts down', { s: [1.12, 1.12], y: [0.05, -0.05] }],
  ['Truck left', 'Truck left', 'camera trucks left alongside the subject', { s: [1.1, 1.1], x: [0.04, -0.04] }],
  ['Truck right', 'Truck right', 'camera trucks right alongside the subject', { s: [1.1, 1.1], x: [-0.04, 0.04] }],
  ['Tracking', 'Tracking', 'tracking shot following the subject', { s: [1.06, 1.1] }],
  ['Orbit', 'Orbit', 'camera orbits around the subject', { s: [1.1, 1.1], x: [-0.04, 0.04] }],
  ['Crane up', 'Crane up', 'crane shot rising upward', { s: [1.12, 1.12], y: [0.05, -0.05] }],
  ['Crane down', 'Crane down', 'crane shot descending', { s: [1.12, 1.12], y: [-0.05, 0.05] }],
  ['Handheld', 'Handheld', 'handheld camera with natural shake', { s: [1.05, 1.05], shake: true }],
  ['Zoom in', 'Zoom in', 'slow optical zoom in', { s: [1, 1.2] }],
  ['Zoom out', 'Zoom out', 'slow optical zoom out', { s: [1.2, 1] }],
  ['Crash zoom', 'Crash zoom', 'fast crash zoom in', { s: [1, 1.35], ease: 'fast' }],
  ['Drone', 'Drone', 'smooth aerial drone flyover', { s: [1.04, 1.14], y: [0.02, -0.02] }],
  ['FPV', 'FPV drone', 'fast FPV drone flythrough', { s: [1, 1.3] }],
  ['Whip pan', 'Whip pan', 'whip pan with motion blur', { s: [1.1, 1.1], x: [-0.06, 0.06], ease: 'fast' }],
  ['Rack focus', 'Rack focus', 'rack focus shifting between foreground and background', null],
  ['Dolly zoom', 'Dolly zoom', 'dolly zoom vertigo effect', { s: [1, 1.16] }],
];

export const LENSES = ['14mm', '18mm', '24mm', '28mm', '35mm', '50mm', '85mm', '100mm macro', '135mm', '200mm', 'Anamorphic', 'Fisheye'];

export const TRANSITIONS = ['Cut', 'Dissolve', 'Fade in', 'Fade out', 'Match cut', 'Smash cut', 'Whip pan', 'J-cut', 'L-cut', 'Wipe'];

export const STATUSES = [
  { id: 'idea', label: 'Idea', color: '#8d8d96' },
  { id: 'prompt', label: 'Prompt ready', color: '#5b9cff' },
  { id: 'generated', label: 'Generated', color: '#b07cff' },
  { id: 'approved', label: 'Approved', color: '#35c27e' },
  { id: 'edit', label: 'In edit', color: '#f3b13e' },
];
export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];

// Status of one version in a shot's evolution tree.
export const VSTATUS = [
  { id: 'new', label: 'Exploring', color: '#8d8d96', hint: 'Not judged yet' },
  { id: 'rework', label: 'Rework', color: '#f3b13e', hint: 'Close, needs changes in the next variation' },
  { id: 'option', label: 'Option', color: '#5b9cff', hint: 'A backup I might use later' },
  { id: 'picked', label: 'Picked', color: '#35c27e', hint: 'The final choice, used as the shot’s frame' },
];
export const vstatusOf = (id) => VSTATUS.find((s) => s.id === id) || VSTATUS[0];

export const ASPECTS = [
  ['16:9', '16:9 · HD / YouTube', 1920, 1080],
  ['2.39:1', '2.39:1 · Scope', 1920, 804],
  ['1.85:1', '1.85:1 · Flat', 1920, 1038],
  ['9:16', '9:16 · Reels / Shorts / TikTok', 1080, 1920],
  ['4:5', '4:5 · Instagram feed', 1080, 1350],
  ['1:1', '1:1 · Square', 1080, 1080],
  ['4:3', '4:3 · Classic', 1440, 1080],
  ['21:9', '21:9 · Ultrawide', 2560, 1080],
];
export const aspectRatio = (a) => {
  const [w, h] = String(a || '16:9').split(':').map(Number);
  return w / (h || 1) || 16 / 9;
};
// The closest ratio most video models accept, for shots.csv.
export const genAspect = (a) => ({ '2.39:1': '21:9', '1.85:1': '16:9' }[a] || a);

export const FPS = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'];

export const NOTE_COLORS = [
  ['yellow', '#f6d76b'], ['orange', '#f7a960'], ['pink', '#f39ac0'], ['purple', '#bfa2f7'],
  ['blue', '#8fbcf7'], ['green', '#97dca6'], ['gray', '#c9c9cf'], ['dark', '#2c2c31'],
];
export const noteColor = (c) => (NOTE_COLORS.find(([k]) => k === c) || NOTE_COLORS[0])[1];

const phrase = (list, code) => (list.find((x) => x[0] === code) || [])[2] || '';
export const moveOf = (code) => (MOVES.find((m) => m[0] === code) || [])[3] || null;
const sentence = (s) => (s ? s.trim().replace(/\s+/g, ' ').replace(/([^.!?"”])$/, '$1.') : '');

// Camera description from the shot fields, e.g. "Low angle MCU, 35mm, push in".
export function cameraLine(shot) {
  return [shot.size, shot.angle && shot.angle !== 'Eye level' ? `${shot.angle} angle` : '', shot.lens, shot.move && shot.move !== 'Static' ? shot.move.toLowerCase() : '']
    .filter(Boolean).join(' · ');
}

// Shot fields -> prompt: framing first, then the action, then camera motion.
export function buildPrompt(shot) {
  const frame = [phrase(SIZES, shot.size), phrase(ANGLES, shot.angle), shot.lens && `${shot.lens} lens`].filter(Boolean).join(', ');
  const parts = [frame && sentence(frame[0].toUpperCase() + frame.slice(1)), sentence(shot.action)];
  const move = phrase(MOVES, shot.move);
  if (move) parts.push(sentence(move[0].toUpperCase() + move.slice(1)));
  if (shot.dialogue) parts.push(`Dialogue: "${shot.dialogue.trim()}"`);
  return parts.filter(Boolean).join(' ');
}

// What gets copied / exported: project look + the shot's prompt (or a
// prompt built from its fields when the prompt box is empty).
export function fullPrompt(shot, settings = {}) {
  const body = (shot.prompt || '').trim() || buildPrompt(shot);
  const look = (settings.look || '').trim();
  return [look && sentence(look), body].filter(Boolean).join(' ');
}
