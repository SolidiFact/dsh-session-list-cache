/**
 * session-list-cache: stop dsh web from rebuilding every stored session's
 * summary each time a page refreshes the session list.
 *
 * THE PROBLEM
 * While a dsh web page is open it asks for the session list every few
 * seconds. For every session that is not attached (a "cold" session), dsh
 * builds the row again from its projection-cache record, and that re-runs
 * schema validation over every stored value. With hundreds of sessions this
 * costs a steady 10-15% of a CPU core on an otherwise idle machine, and it
 * grows with every session you keep. Measured on one install: 12 list
 * requests a minute, each summarizing 738 cold sessions.
 *
 * THE RULE
 * A cold session's row depends on two things: its header and its record in
 * the projection cache. dsh never edits a stored record in place; every write
 * stores new `rows` and `identity` objects. So if the header is unchanged and
 * the record's `rows` and `identity` are the very same objects as last time,
 * the row is unchanged too, and the one built last time is served again. The
 * comparison is on those two inner objects, not the record itself, because a
 * plugin may wrap the table and return a fresh outer object on every read
 * (@michengai/dsh-archive-manager does).
 *
 * A ROW ALSO CARRIES SOME LIVE STATE, SO NO ROW IS KEPT LONGER THAN A MINUTE
 * Part of a row is computed from the running dsh, not the stored record: image
 * limits, and which plugin provides each tool. Measured: the plugin set settles
 * a few seconds after startup, and 641 of 763 rows built in that window named a
 * tool's plugin differently from a later build. dsh already documents a cold
 * row as possibly stale, so a row is reused for at most `maxAgeMs` (60 s by
 * default) and then rebuilt. At one list request every 5 s that still skips 11
 * of every 12 rebuilds, and live-state staleness can never last longer. Anything else rebuilds the row exactly as dsh
 * would. Attached (live) sessions are never cached.
 *
 * CHECKING ITSELF
 * One cached row in every `checkEvery` (100 by default) is rebuilt anyway and
 * compared with the cached copy. A difference is counted, the fresh row
 * replaces the cached one, and the first few are logged, so a wrong assumption
 * above shows up in the log instead of silently in the sidebar. Live state
 * changing inside the minute also counts here, so a small number is expected;
 * a large and growing one is not. It costs about 1% of the work saved.
 *
 * FAILING SAFE
 * This patches an internal, unexported dsh class, so a dsh upgrade can move
 * what it depends on. When anything it needs is missing it logs one warning
 * and leaves dsh untouched, and a record it cannot read is never cached.
 */

export const name = 'session-list-cache'
export const inject = ['sessionController']

const PATCHED = Symbol.for('solidifact.session-list-cache.patched')

// --- The cache: rows kept between list requests, and what decides a hit. ---

/**
 * Make an empty cache. `generation` counts list requests so rows for sessions
 * that have disappeared (deleted or archived) can be dropped.
 * @returns the cache state.
 */
export function createCache ({ checkEvery = 100, reportEvery = 100, maxAgeMs = 60_000, now = Date.now } = {}) {
  return { rows: new Map(), generation: 0, hits: 0, misses: 0, checked: 0, mismatches: 0, checkEvery, reportEvery, maxAgeMs, now }
}

/**
 * One line for the log: how much work the cache is saving, and whether the
 * spot-check has ever disagreed with it.
 * @param cache - state from createCache().
 * @returns the summary line.
 */
export function report (cache) {
  const served = cache.hits + cache.misses
  const rate = served === 0 ? 0 : Math.round((100 * cache.hits) / served)
  return `${cache.generation} list requests, ${served} rows: ${rate}% reused, ${cache.misses} built; ` +
    `${cache.checked} spot-checked, ${cache.mismatches} differed; ${cache.rows.size} rows kept`
}

/**
 * The header fields a row depends on, as one comparable string. The whole
 * header is used, not a chosen subset, so a field a future dsh adds to the
 * row cannot be missed.
 * @param header - the stored session header.
 * @returns a string that changes whenever the header changes.
 */
export function headerKey (header) {
  return JSON.stringify(header)
}

/** Marks a record that could not be read, so the row is never cached. */
export const UNREADABLE = Symbol('unreadable')

/**
 * What identifies a stored record's contents: its `rows` and `identity`
 * objects, which every write replaces.
 * @param record - a projection-cache record, or undefined.
 * @returns the pair to compare, or undefined when there is no record.
 */
export function contentsOf (record) {
  return record === undefined ? undefined : { rows: record.rows, identity: record.identity }
}

/**
 * True when two contentsOf() results are the same stored objects.
 */
export function sameContents (a, b) {
  if (a === undefined || b === undefined) return a === b
  return a.rows === b.rows && a.identity === b.identity
}

/**
 * Find the projection-cache record a cold row is built from.
 * @param controller - the ApiSessionList instance (`this` inside summarizeCold).
 * @param header - the stored session header.
 * @returns the record object, `undefined` when the session has none, or
 *   UNREADABLE when the cache cannot be reached.
 */
export function recordOf (controller, header) {
  try {
    const service = controller.ctx.get('sessionProjectionCache')
    if (service === undefined) return undefined
    return service.requireTable().get(header.id)
  } catch {
    return UNREADABLE
  }
}

// --- The wrappers: what replaces dsh's own methods. ---

/**
 * Wrap ApiSessionList.summarizeCold so an unchanged session reuses its row.
 * @param original - dsh's summarizeCold.
 * @param cache - state from createCache().
 * @param lookup - how to find the record (recordOf; replaceable in tests).
 * @returns the wrapped method.
 */
export function wrapSummarizeCold (original, cache, lookup = recordOf) {
  return function summarizeCold (header) {
    const record = lookup(this, header)
    if (record === UNREADABLE) return original.call(this, header)
    const contents = contentsOf(record)
    const key = headerKey(header)
    const kept = cache.rows.get(header.id)
    const now = cache.now()
    if (kept !== undefined && sameContents(kept.contents, contents) && kept.key === key && now - kept.builtAt < cache.maxAgeMs) {
      kept.seen = cache.generation
      cache.hits++
      if (cache.checkEvery > 0 && cache.hits % cache.checkEvery === 0) {
        const fresh = original.call(this, header)
        cache.checked++
        if (JSON.stringify(fresh) !== JSON.stringify(kept.row)) {
          cache.mismatches++
          if (cache.mismatches <= 3) console.warn(`[session-list-cache] cached row for session ${header.id} differed from a fresh build; serving the fresh one (${cache.mismatches} so far; later ones are only counted)`)
          kept.row = fresh
          kept.builtAt = now
        }
      }
      return { ...kept.row }
    }
    const row = original.call(this, header)
    cache.rows.set(header.id, { contents, key, row, seen: cache.generation, builtAt: now })
    cache.misses++
    return { ...row }
  }
}

/**
 * Wrap ApiSessionList.list so each request starts a new generation, and rows
 * no request has asked for since the previous one are dropped afterwards.
 * @param original - dsh's list.
 * @param cache - state from createCache().
 * @returns the wrapped method.
 */
export function wrapList (original, cache) {
  return async function list (...args) {
    const generation = ++cache.generation
    const items = await original.apply(this, args)
    for (const [id, kept] of cache.rows) {
      if (kept.seen < generation - 1) cache.rows.delete(id)
    }
    if (generation % cache.reportEvery === 0) console.log(`[session-list-cache] ${report(cache)}`)
    return items
  }
}

// --- Plugin entry: attach to the running dsh, and detach on dispose. ---

export function apply (ctx) {
  const list = ctx.sessionController?.listState
  const proto = list == null ? undefined : Object.getPrototypeOf(list)
  if (proto == null || typeof proto.summarizeCold !== 'function' || typeof proto.list !== 'function') {
    ctx.logger?.warn('session-list-cache: this dsh has no ApiSessionList.summarizeCold/list to attach to; the session list is unchanged')
    return
  }
  if (proto[PATCHED]) {
    ctx.logger?.info('session-list-cache: already attached')
    return
  }
  const cache = createCache()
  const originals = { summarizeCold: proto.summarizeCold, list: proto.list }
  proto.summarizeCold = wrapSummarizeCold(originals.summarizeCold, cache)
  proto.list = wrapList(originals.list, cache)
  proto[PATCHED] = cache
  console.log('[session-list-cache] unchanged cold sessions reuse their session-list row')
  ctx.on('dispose', () => {
    proto.summarizeCold = originals.summarizeCold
    proto.list = originals.list
    delete proto[PATCHED]
  })
}
