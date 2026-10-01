const assert = require('assert')
const Module = require('module')

const clone = (value) => JSON.parse(JSON.stringify(value))
const roomDoc = {
  _id: 'room-1', code: 'ABC234', owner: 'owner', expiresAt: Date.now() + 3600000,
  memberBindings: [{ memberId: 'member-1', openid: 'owner' }], signals: {},
  room: {
    id: 'room-1', cloudId: 'ABC234', members: [{ id: 'member-1' }],
    venues: [{ id: 'venue-1' }], votes: {}, routeMatrix: {}, memberRevision: 1, venueMemberRevision: 1
  }
}
const collection = {
  where({ code }) {
    return {
      limit() { return this },
      async get() { return { data: roomDoc.code === code ? [clone(roomDoc)] : [] } }
    }
  },
  doc(id) {
    assert.strictEqual(id, roomDoc._id)
    return {
      async get() { return { data: clone(roomDoc) } },
      async update({ data }) { Object.assign(roomDoc, clone(data)) }
    }
  }
}
let transactionQueue = Promise.resolve()
const db = {
  collection() { return collection },
  async runTransaction(callback) {
    const previous = transactionQueue
    let release
    transactionQueue = new Promise((resolve) => { release = resolve })
    await previous
    try { return await callback({ collection: () => collection }) } finally { release() }
  }
}
const cloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
  getWXContext: () => ({ OPENID: 'owner' })
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloud
  return originalLoad.call(this, request, parent, isMain)
}
const roomService = require('../cloudfunctions/roomService')
Module._load = originalLoad

async function run() {
  const [vote, refresh] = await Promise.all([
    roomService.main({ action: 'toggleVote', code: 'ABC234', venueId: 'venue-1' }),
    roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 1, venues: [{ id: 'venue-1' }, { id: 'venue-2' }] })
  ])
  assert.strictEqual(vote.ok, true)
  assert.strictEqual(refresh.ok, true)
  assert.deepStrictEqual(roomDoc.room.votes['venue-1'], ['member-1'], '刷新地点不能覆盖刚提交的投票')
  assert.deepStrictEqual(roomDoc.room.venues.map((item) => item.id), ['venue-1', 'venue-2'])
  roomDoc.room.memberRevision = 2
  const stale = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 1, venues: [{ id: 'stale' }] })
  assert.strictEqual(stale.ok, false, '成员变更前的搜索结果不能覆盖新房间')
  assert.deepStrictEqual(roomDoc.room.venues.map((item) => item.id), ['venue-1', 'venue-2'])
  const current = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, venues: [{ id: 'venue-3' }] })
  assert.strictEqual(current.ok, true)
  assert.strictEqual(roomDoc.room.venueMemberRevision, 2)
  console.log('room concurrency tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
