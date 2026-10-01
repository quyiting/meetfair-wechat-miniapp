const assert = require('assert')
const Module = require('module')

const clone = (value) => JSON.parse(JSON.stringify(value))
const venue = (id) => ({ id, name: id, category: 'food', latitude: 31, longitude: 121, address: '测试地址' })
let openid = 'owner'
const roomDoc = {
  _id: 'room-1', code: 'ABC234', owner: 'owner', expiresAt: Date.now() + 3600000,
  memberBindings: [{ memberId: 'member-1', openid: 'owner' }, { memberId: 'member-2', openid: 'guest' }], signals: {},
  room: {
    id: 'room-1', cloudId: 'ABC234', members: [{ id: 'member-1' }],
    venues: [venue('venue-1')], votes: {}, routeMatrix: {}, memberRevision: 1, venueMemberRevision: 1,
    meetingTime: '18:30', meetingSearchTime: '18:30'
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
  getWXContext: () => ({ OPENID: openid })
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
    roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 1, meetingTime: '18:30', venues: [venue('venue-1'), venue('venue-2')] })
  ])
  assert.strictEqual(vote.ok, true)
  assert.strictEqual(refresh.ok, true)
  assert.deepStrictEqual(roomDoc.room.votes['venue-1'], ['member-1'], '刷新地点不能覆盖刚提交的投票')
  assert.deepStrictEqual(roomDoc.room.venues.map((item) => item.id), ['venue-1', 'venue-2'])
  roomDoc.room.memberRevision = 2
  const stale = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 1, meetingTime: '18:30', venues: [venue('stale')] })
  assert.strictEqual(stale.ok, false, '成员变更前的搜索结果不能覆盖新房间')
  assert.deepStrictEqual(roomDoc.room.venues.map((item) => item.id), ['venue-1', 'venue-2'])
  const current = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, meetingTime: '18:30', venues: [venue('venue-3')],
    routeMatrix: { 'venue-3': { 'member-1': { minutes: 24, distance: 4.2, source: 'amap-route' } } } })
  assert.strictEqual(current.ok, true)
  assert.strictEqual(roomDoc.room.venueMemberRevision, 2)
  assert.strictEqual(roomDoc.room.routeMatrix['venue-3']['member-1'].minutes, 24)
  roomDoc.room.meetingTime = '19:00'
  const oldTime = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, meetingTime: '18:30', venues: [venue('old-time')] })
  assert.strictEqual(oldTime.ok, false, '改时间前的搜索结果不能覆盖新结果')
  openid = 'guest'
  const guestRefresh = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, meetingTime: '19:00', venues: [venue('guest-venue')] })
  assert.strictEqual(guestRefresh.ok, false, '普通成员不能改写全员推荐')
  openid = 'owner'
  const invalidVenue = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, meetingTime: '19:00', venues: [Object.assign(venue('bad'), { latitude: 999 })] })
  assert.strictEqual(invalidVenue.ok, false)
  const invalidRoute = await roomService.main({ action: 'setVenues', code: 'ABC234', memberRevision: 2, meetingTime: '19:00', venues: [venue('venue-3')], routeMatrix: { 'venue-3': { 'member-1': { minutes: -20 } } } })
  assert.strictEqual(invalidRoute.ok, false)
  console.log('room concurrency tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
