const assert = require('assert')
const Module = require('module')

const now = Date.now()
const day = 24 * 60 * 60 * 1000
const rooms = [
  { _id: 'expired', expiresAt: now - 1000, createdAt: now - day, signals: { a: 'signal-expired' } },
  { _id: 'legacy-expired', createdAt: now - 31 * day, signals: { b: 'signal-legacy' } },
  { _id: 'active', expiresAt: now + day, createdAt: now - day, signals: { c: 'signal-active' } },
  { _id: 'legacy-active', createdAt: now - day, signals: { d: 'signal-legacy-active' } }
]
const signals = new Set(['signal-expired', 'signal-legacy', 'signal-active', 'signal-legacy-active'])
let failSignal = ''
const db = {
  command: { lt(value) { return { op: 'lt', value } } },
  collection(name) {
    if (name === 'roomSignals') {
      return { doc(id) { return { async remove() {
        if (id === failSignal) throw new Error('signal removal failed')
        signals.delete(id)
      } } } }
    }
    assert.strictEqual(name, 'rooms')
    return {
      where(query) {
        return {
          limit(size) { this.size = size; return this },
          async get() {
            const field = Object.keys(query)[0]
            return { data: rooms.filter((room) => room[field] < query[field].value).slice(0, this.size) }
          }
        }
      },
      doc(id) { return { async remove() {
        const index = rooms.findIndex((room) => room._id === id)
        if (index >= 0) rooms.splice(index, 1)
      } } }
    }
  }
}
const cloud = { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db }
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloud
  return originalLoad.call(this, request, parent, isMain)
}
const cleanupRooms = require('../cloudfunctions/cleanupExpiredRooms')
Module._load = originalLoad

async function run() {
  const result = await cleanupRooms.main({ Type: 'Timer' })
  assert.strictEqual(result.deleted, 2)
  assert.deepStrictEqual(rooms.map((room) => room._id), ['active', 'legacy-active'])
  assert.deepStrictEqual([...signals].sort(), ['signal-active', 'signal-legacy-active'])

  rooms.push({ _id: 'retryable', expiresAt: now - 1000, createdAt: now - day, signals: { e: 'signal-retry' } })
  signals.add('signal-retry')
  failSignal = 'signal-retry'
  await assert.rejects(() => cleanupRooms.main({ Type: 'Timer' }), /signal removal failed/)
  assert(rooms.some((room) => room._id === 'retryable'), '通知删除失败时须保留房间，供下次重试')
  failSignal = ''
  await cleanupRooms.main({ Type: 'Timer' })
  assert(!rooms.some((room) => room._id === 'retryable'))
  assert(!signals.has('signal-retry'))
  console.log('cleanup rooms tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
