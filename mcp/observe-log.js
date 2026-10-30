/**
 * Incremental observations: `rev` and `since`.
 *
 * Within one prep phase most of an observation does not change between calls: the field, the coming wave,
 * the last battle's report, the static catalog. An agent that observes after every action would otherwise
 * carry each of them into its context again and again.
 *
 * Every rendered observation gets a `rev`. Passing a previous `rev` back as `since` returns only what
 * differs from that response:
 *
 *   - scalars (phase, round, seconds_left, …) are always sent;
 *   - an object or array section whose content equals the one in `since` is left out and named in `unchanged`;
 *   - a key present in `since` and absent now (a closed modal, the end of the draft) is named in `removed`;
 *   - `catalog` carries only the entries `since` did not have.
 *
 * Recovery is built in: a `since` this log no longer holds (too old, from before a restart, or taken with
 * other options) answers with the whole observation and `resync: true`. A caller that lost track of its
 * context just omits `since`.
 */

/** Scalars that change on every call without anything happening; they do not make a new revision. */
const VOLATILE = new Set(['frames_age_ms', 'seconds_left']);

const isSection = (value) => value !== null && typeof value === 'object';

function sectionsOf(obs) {
  const out = new Map();
  for (const [key, value] of Object.entries(obs)) {
    if (key === 'catalog' || VOLATILE.has(key)) continue;
    out.set(key, JSON.stringify(value));
  }
  return out;
}

function sameSections(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, json] of a) if (b.get(key) !== json) return false;
  return true;
}

/**
 * @param {{ limit?: number }} [options] how many revisions to keep (each is one rendered observation)
 * @returns {(obs: object, options?: { signature?: string, since?: number|null }) => object}
 */
export function createObservationLog({ limit = 16 } = {}) {
  /** @type {{ rev: number, signature: string, obs: object, sections: Map<string, string> }[]} */
  const history = [];
  let nextRev = 1;

  return function render(obs, { signature = '', since = null } = {}) {
    const sections = sectionsOf(obs);
    const latest = history.at(-1);
    let entry;
    if (latest && latest.signature === signature && sameSections(latest.sections, sections)
      && JSON.stringify(latest.obs.catalog ?? null) === JSON.stringify(obs.catalog ?? null)) {
      entry = latest;
    } else {
      entry = { rev: nextRev++, signature, obs, sections };
      history.push(entry);
      if (history.length > limit) history.shift();
    }

    if (since == null) return { rev: entry.rev, ...obs };
    const base = history.find((h) => h.rev === since && h.signature === signature);
    if (!base) return { rev: entry.rev, resync: true, ...obs };

    const out = { rev: entry.rev, since };
    const unchanged = [];
    for (const [key, value] of Object.entries(obs)) {
      if (key === 'catalog') continue;
      if (isSection(value) && base.sections.get(key) === sections.get(key)) unchanged.push(key);
      else out[key] = value;
    }
    if (obs.catalog) {
      const known = base.obs.catalog || {};
      const added = Object.fromEntries(Object.entries(obs.catalog).filter(([key, value]) => JSON.stringify(known[key]) !== JSON.stringify(value)));
      if (Object.keys(added).length) out.catalog = added;
    }
    const removed = Object.keys(base.obs).filter((key) => !(key in obs));
    out.unchanged = unchanged;
    if (removed.length) out.removed = removed;
    return out;
  };
}
