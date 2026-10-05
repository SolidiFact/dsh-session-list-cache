import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply, createCache, headerKey, recordOf, report, UNREADABLE, wrapList, wrapSummarizeCold,
} from './index.mjs'

// --- A stand-in for dsh: a summarizeCold that counts how often it really runs. ---

function fakeDsh (records) {
  const calls = []
  const original = function (header) {
    calls.push(header.id)
    const record = records.get(header.id)
    return { sessionId: header.id, title: record?.rows?.title ?? null, cwd: header.cwd }
  }
  const lookup = (_controller, header) => records.get(header.id)
  return { calls, original, lookup }
}

const header = (id, extra = {}) => ({ id, createdAt: 1, version: 3, cwd: '/w', ...extra })

// --- The cache rule. ---

test('an unchanged session is built once and then served from the cache', () => {
  const records = new Map([['a', { rows: { title: 'A' } }]])
  const { calls, original, lookup } = fakeDsh(records)
  const cache = createCache()
  const wrapped = wrapSummarizeCold(original, cache, lookup)
  const first = wrapped.call({}, header('a'))
  const second = wrapped.call({}, header('a'))
  assert.deepEqual(second, first)
  assert.deepEqual(calls, ['a'])
  assert.equal(cache.hits, 1)
})

test('a row older than maxAgeMs is rebuilt even when nothing stored changed', () => {
  // Rows carry some live state (e.g. which plugin provides each tool), so age bounds staleness.
  const records = new Map([['a', { rows: { title: 'A' } }]])
  const { calls, original, lookup } = fakeDsh(records)
  let clock = 0
  const wrapped = wrapSummarizeCold(original, createCache({ maxAgeMs: 60_000, now: () => clock }), lookup)
  wrapped.call({}, header('a'))
  clock = 59_999
  wrapped.call({}, header('a'))
  assert.equal(calls.length, 1)
  clock = 60_000
  wrapped.call({}, header('a'))
  assert.equal(calls.length, 2)
  clock = 60_001
  wrapped.call({}, header('a'))
  assert.equal(calls.length, 2)
})

test('a table that returns a fresh outer object on every read still hits', () => {
  // @michengai/dsh-archive-manager wraps the table: get() returns
  // { identity, rows } anew each time, around the same stored objects.
  const stored = { identity: { createdAt: 1 }, rows: { title: 'A' } }
  const { calls, original } = fakeDsh(new Map([['a', stored]]))
  const cache = createCache()
  const lookup = () => ({ identity: stored.identity, rows: stored.rows })
  const wrapped = wrapSummarizeCold(original, cache, lookup)
  wrapped.call({}, header('a'))
  wrapped.call({}, header('a'))
  assert.equal(cache.hits, 1)
  assert.equal(calls.length, 1)
})

test('a new record object for the session rebuilds the row', () => {
  // dsh stores a fresh object on every write, so a changed session has a new record.
  const records = new Map([['a', { rows: { title: 'old' } }]])
  const { calls, original, lookup } = fakeDsh(records)
  const wrapped = wrapSummarizeCold(original, createCache(), lookup)
  wrapped.call({}, header('a'))
  records.set('a', { rows: { title: 'new' } })
  assert.equal(wrapped.call({}, header('a')).title, 'new')
  assert.deepEqual(calls, ['a', 'a'])
})

test('a changed header rebuilds the row even when the record is the same', () => {
  const records = new Map([['a', { rows: { title: 'A' } }]])
  const { calls, original, lookup } = fakeDsh(records)
  const wrapped = wrapSummarizeCold(original, createCache(), lookup)
  wrapped.call({}, header('a', { cwd: '/one' }))
  assert.equal(wrapped.call({}, header('a', { cwd: '/two' })).cwd, '/two')
  assert.deepEqual(calls, ['a', 'a'])
})

test('a session with no record is cached until a record appears', () => {
  const records = new Map()
  const { calls, original, lookup } = fakeDsh(records)
  const wrapped = wrapSummarizeCold(original, createCache(), lookup)
  wrapped.call({}, header('a'))
  wrapped.call({}, header('a'))
  records.set('a', { rows: { title: 'now titled' } })
  assert.equal(wrapped.call({}, header('a')).title, 'now titled')
  assert.deepEqual(calls, ['a', 'a'])
})

test('an unreadable record is never cached', () => {
  const { calls, original } = fakeDsh(new Map())
  const cache = createCache()
  const wrapped = wrapSummarizeCold(original, cache, () => UNREADABLE)
  wrapped.call({}, header('a'))
  wrapped.call({}, header('a'))
  assert.deepEqual(calls, ['a', 'a'])
  assert.equal(cache.rows.size, 0)
})

test('a caller changing a returned row cannot change the cached one', () => {
  const records = new Map([['a', { rows: { title: 'A' } }]])
  const { original, lookup } = fakeDsh(records)
  const wrapped = wrapSummarizeCold(original, createCache(), lookup)
  wrapped.call({}, header('a')).title = 'scribbled'
  assert.equal(wrapped.call({}, header('a')).title, 'A')
})

test('the spot-check catches a row that changed without a new record, and serves the fresh one', () => {
  // Simulates the assumption breaking: dsh edits a record in place.
  const record = { rows: { title: 'before' } }
  const records = new Map([['a', record]])
  const { original, lookup } = fakeDsh(records)
  const cache = createCache({ checkEvery: 1 })
  const wrapped = wrapSummarizeCold(original, cache, lookup)
  const warn = console.warn
  console.warn = () => {}
  try {
    wrapped.call({}, header('a'))
    record.rows.title = 'after'
    assert.equal(wrapped.call({}, header('a')).title, 'after')
  } finally {
    console.warn = warn
  }
  assert.equal(cache.mismatches, 1)
})

test('the spot-check stays quiet when the cached row is right', () => {
  const records = new Map([['a', { rows: { title: 'A' } }]])
  const { calls, original, lookup } = fakeDsh(records)
  const cache = createCache({ checkEvery: 2 })
  const wrapped = wrapSummarizeCold(original, cache, lookup)
  for (let i = 0; i < 5; i++) wrapped.call({}, header('a'))
  assert.equal(cache.checked, 2)
  assert.equal(cache.mismatches, 0)
  assert.equal(calls.length, 3)
})

test('headerKey changes when any header field changes', () => {
  assert.notEqual(headerKey(header('a')), headerKey(header('a', { origin: 'acp' })))
  assert.equal(headerKey(header('a')), headerKey(header('a')))
})

// --- Dropping rows for sessions that are gone. ---

test('rows for sessions no longer listed are dropped after a request', async () => {
  const records = new Map([['a', { rows: {} }], ['b', { rows: {} }]])
  const { original, lookup } = fakeDsh(records)
  const cache = createCache()
  const summarize = wrapSummarizeCold(original, cache, lookup)
  let visible = ['a', 'b']
  const list = wrapList(async function () { return visible.map((id) => summarize.call({}, header(id))) }, cache)
  await list.call({})
  visible = ['a']
  await list.call({})
  await list.call({})
  assert.deepEqual([...cache.rows.keys()], ['a'])
})

test('wrapList passes the request through and returns its result unchanged', async () => {
  const cache = createCache()
  const list = wrapList(async function (signal) { return { got: signal } }, cache)
  assert.deepEqual(await list.call({}, 'sig'), { got: 'sig' })
})

// --- Attaching to dsh. ---

test('recordOf reads the projection cache table', () => {
  const table = new Map([['a', { rows: {} }]])
  const controller = { ctx: { get: (n) => n === 'sessionProjectionCache' ? { requireTable: () => table } : undefined } }
  assert.equal(recordOf(controller, header('a')), table.get('a'))
  assert.equal(recordOf(controller, header('b')), undefined)
})

test('recordOf reports UNREADABLE when the cache throws', () => {
  const controller = { ctx: { get: () => ({ requireTable: () => { throw new Error('not initialized') } }) } }
  assert.equal(recordOf(controller, header('a')), UNREADABLE)
})

test('apply leaves dsh untouched when the internals it needs are missing', () => {
  const warnings = []
  apply({ sessionController: { listState: {} }, logger: { warn: (m) => warnings.push(m) }, on () {} })
  assert.equal(warnings.length, 1)
})

test('apply attaches once, and dispose restores dsh exactly', () => {
  class ApiSessionList { summarizeCold () { return 'orig' } async list () { return [] } }
  const before = { summarizeCold: ApiSessionList.prototype.summarizeCold, list: ApiSessionList.prototype.list }
  const listeners = []
  const ctx = { sessionController: { listState: new ApiSessionList() }, logger: { info () {}, warn () {} }, on: (_e, fn) => listeners.push(fn) }
  apply(ctx)
  assert.notEqual(ApiSessionList.prototype.summarizeCold, before.summarizeCold)
  apply(ctx)
  assert.equal(listeners.length, 1)
  listeners[0]()
  assert.equal(ApiSessionList.prototype.summarizeCold, before.summarizeCold)
  assert.equal(ApiSessionList.prototype.list, before.list)
})

test('report says how much was reused and whether any check differed', () => {
  const cache = { ...createCache(), generation: 3, hits: 9, misses: 1, checked: 2, mismatches: 0 }
  assert.equal(report(cache), '3 list requests, 10 rows: 90% reused, 1 built; 2 spot-checked, 0 differed; 0 rows kept')
})
