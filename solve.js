// makefun-diff, faster: my own implementation of the makefun-diff/1 patch rule.
//
// The rule (from the competition spec): cut each text into lines after every
// "\n" (a trailing line without one is a line too), keep the common prefix of
// lines, then the common suffix of what is left, and between them run Myers's
// greedy search that keeps, on each diagonal, the path furthest into the old
// text, taking the deletion when a deletion and an insertion reach the same
// point, never stepping past either text's end, and following every run of
// equal lines as far as it goes. The patch is then printed with 3 lines of
// context around each change run, runs at most 6 kept lines apart sharing a
// hunk.
//
// Speed comes from three choices, all of which keep the answer identical:
//   1. every distinct line is interned once to a small integer id, so the
//      search compares integers in typed arrays instead of strings;
//   2. the search keeps its furthest-reached table in one Int32Array per
//      edit distance, with no objects allocated per step;
//   3. the patch is built from the run list with plain string appends.
//
// Coordinates are counts: x old lines and y new lines consumed, diagonal
// k = x - y. A stored value of -1 means "that diagonal was not reached".

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

/** Intern a line string to its integer id, sharing ids across both texts. */
function intern(map, s) {
  let id = map.get(s);
  if (id === undefined) {
    id = map.size;
    map.set(s, id);
  }
  return id;
}

/**
 * A text's lines, each with its "\n" (the last one without, when the text
 * does not end in one), as the line strings and as integer ids.
 */
function tokenize(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(count);
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const s = parts[i] + '\n';
    lines[i] = s;
    ids[i] = intern(map, s);
  }
  if (parts[last] !== '') {
    const s = parts[last];
    lines[last] = s;
    ids[last] = intern(map, s);
  }
  return { lines, ids };
}

/**
 * The edit-script runs of a[0..n) into b[0..m): [{ kind, count }] in order.
 * The forward greedy search stores one furthest-reached row per edit
 * distance; the script is then read back from the end using the same
 * deletion-on-tie rule the forward search used, so the script it returns is
 * the one the forward search itself found.
 *
 * Each row is indexed by j = k + d (k the diagonal), so the deletion
 * candidate for j reads row d - 1 at j - 2 and the insertion candidate reads
 * it at j. A row stores x + 1 (x the old lines consumed), so 0 means "that
 * diagonal was not reached" and no fill pass is needed.
 */
function editRuns(a, b, n, m) {
  if (n === 0 && m === 0) return [];

  // d = 0: the run of equal lines from the start.
  const rows = [];
  const row0 = new Int32Array(1);
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  row0[0] = x + 1;
  rows.push(row0);
  if (x === n && y === m) return [];

  const maxD = n + m;
  let D = -1;
  for (let d = 1; d <= maxD; d++) {
    const prev = rows[d - 1];
    const row = new Int32Array(2 * d + 1);
    const last = 2 * d;
    let done = false;
    for (let j = 0; j <= last; j += 2) {
      const k = j - d;
      // A deletion steps from diagonal k - 1: one old line further, and
      // only when that old line exists. An insertion steps from diagonal
      // k + 1, keeping x, and only when that new line exists.
      const sDel = j >= 2 ? prev[j - 2] : 0;
      const delOk = sDel !== 0 && sDel <= n;
      const sIns = j < last ? prev[j] : 0;
      const insOk = sIns !== 0 && sIns - k - 2 < m;
      if (!delOk && !insOk) continue;
      // Furthest into the old text wins; a tie goes to the deletion.
      // xDel is the stored sDel itself (x + 1 after the deletion step),
      // xIns is sIns - 1 (x unchanged by the insertion step).
      let xx = delOk && (!insOk || sDel >= sIns - 1) ? sDel : sIns - 1;
      let yy = xx - k;
      while (xx < n && yy < m && a[xx] === b[yy]) {
        xx++;
        yy++;
      }
      row[j] = xx + 1;
      if (xx === n && yy === m) {
        D = d;
        done = true;
        break;
      }
    }
    rows.push(row);
    if (done) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Read the script back from (n, m), one edit step at a time.
  const runs = [];
  let k = n - m;
  let xx = rows[D][k + D] - 1;
  for (let d = D; d >= 1; d--) {
    const prev = rows[d - 1];
    const j = k + d;
    const sDel = j >= 2 ? prev[j - 2] : 0;
    const delOk = sDel !== 0 && sDel <= n;
    const sIns = j <= 2 * d - 2 ? prev[j] : 0;
    const insOk = sIns !== 0 && sIns - k - 2 < m;
    const isDel = delOk && (!insOk || sDel >= sIns - 1);
    const xLand = isDel ? sDel : sIns - 1;
    const snake = xx - xLand;
    if (snake > 0) runs.push({ kind: KEEP, count: snake });
    runs.push({ kind: isDel ? DELETE : INSERT, count: 1 });
    xx = isDel ? sDel - 1 : sIns - 1;
    k = isDel ? k - 1 : k + 1;
  }
  if (xx > 0) runs.push({ kind: KEEP, count: xx });
  runs.reverse();

  // Merge neighbouring runs of one kind.
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else merged.push({ kind: r.kind, count: r.count });
  }
  return merged;
}

/** A line as the patch writes it: op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const a = tokenize(input.old, map);
  const b = tokenize(input.new, map);
  const n = a.ids.length;
  const m = b.ids.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of editRuns(a.ids.subarray(prefix, n - suffix), b.ids.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix)) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  if (suffix > 0) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === KEEP) last.count += suffix;
    else runs.push({ kind: KEEP, count: suffix });
  }

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.lines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.lines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.lines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.lines[at]));
  }
  return out.join('');
}
