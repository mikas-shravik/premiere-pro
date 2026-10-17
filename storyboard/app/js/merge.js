// Three-way merge of project documents. When Claude (or another window)
// saves while this window has unsaved edits, both sets of changes are kept:
// objects merge key by key, lists of objects with an `id` merge item by
// item, anything else is one value. When both sides changed the same value,
// `mine` (this window, i.e. what the person is doing right now) wins.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

const isIdList = (...lists) => lists.every((l) => l === undefined || Array.isArray(l))
  && lists.some((l) => l?.length)
  && lists.every((l) => !l || l.every((o) => isObj(o) && 'id' in o));

export function merge3(base, mine, theirs) {
  if (deepEqual(mine, theirs)) return mine;
  if (deepEqual(base, mine)) return theirs;
  if (deepEqual(base, theirs)) return mine;
  if (Array.isArray(mine) && Array.isArray(theirs) && isIdList(base, mine, theirs)) {
    return mergeList(Array.isArray(base) ? base : [], mine, theirs);
  }
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const inM = k in mine, inT = k in theirs, inB = k in b;
      if (inM && inT) out[k] = merge3(b[k], mine[k], theirs[k]);
      else if (inM) { if (!inB || !deepEqual(b[k], mine[k])) out[k] = mine[k]; }
      else if (!inB || !deepEqual(b[k], theirs[k])) out[k] = theirs[k];
    }
    return out;
  }
  return mine;
}

// Did the relative order of the items both lists share change?
function reordered(from, to) {
  const inTo = new Set(to), inFrom = new Set(from);
  const a = from.filter((id) => inTo.has(id)), b = to.filter((id) => inFrom.has(id));
  return a.some((id, i) => id !== b[i]);
}

function mergeList(base, mine, theirs) {
  const map = (l) => new Map(l.map((o) => [o.id, o]));
  const B = map(base), M = map(mine), T = map(theirs);
  // An item deleted on one side stays deleted, unless this window changed it.
  const value = (id) => {
    const inB = B.has(id), inM = M.has(id), inT = T.has(id);
    if (inM && inT) return merge3(B.get(id), M.get(id), T.get(id));
    if (inM) return !inB || !deepEqual(B.get(id), M.get(id)) ? M.get(id) : undefined;
    if (inT) return inB ? undefined : T.get(id);
    return undefined;
  };
  const bo = base.map((o) => o.id), mo = mine.map((o) => o.id), to = theirs.map((o) => o.id);
  // Follow this window's order unless only the other side rearranged things.
  const useTheirs = reordered(bo, to) && !reordered(bo, mo);
  const primary = useTheirs ? to : mo, secondary = useTheirs ? mo : to;
  const out = primary.filter((id) => value(id) !== undefined);
  let prev = null;
  for (const id of secondary) {
    if (out.includes(id)) { prev = id; continue; }
    if (value(id) === undefined) continue;
    out.splice(prev == null ? 0 : out.indexOf(prev) + 1, 0, id);
    prev = id;
  }
  return out.map(value);
}
