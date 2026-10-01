const assert = require('assert')
const Module = require('module')

let openid = 'owner'
const docs = []
const signals = {}
let failSignalRemoval = ''
const signalCollection = {
  doc(id) {
    return {
      async set({ data }) { signals[id] = data },
      async remove() {
        if (id === failSignalRemoval) throw new Error('signal removal failed')
        delete signals[id]
      }
    }
  }
}
const collection = {
  where(query) {
    return {
      limit() { return this },
      async get() { return { data: docs.filter((doc) => Object.keys(query).every((key) => doc[key] === query[key])) } },
      async count() { return { total: docs.filter((doc) => Object.keys(query).every((key) => doc[key] === query[key])).length } }
    }
  },
  async add({ data }) { docs.push(Object.assign({ _id: 'doc-' + (docs.length + 1) }, data)) },
  doc(id) {
    return {
      async get() { return { data: docs.find((doc) => doc._id === id) } },
      async update({ data }) { Object.assign(docs.find((doc) => doc._id === id), data) },
      async remove() {
        const index = docs.findIndex((doc) => doc._id === id)
        if (index >= 0) docs.splice(index, 1)
      }
    }
  }
}
const db = {
  collection(name) { return name === 'roomSignals' ? signalCollection : collection },
  async createCollection() {},
  async runTransaction(callback) { return callback({ collection: () => collection }) }
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

const member = (id, name) => ({ id, name, latitude: 31, longitude: 121, transport: 'transit' })
const room = { id: 'room-1', title: '聚会', category: 'food', members: [member('owner-seat', '你'), member('guest-seat', '小李')], venues: [{ id: 'venue-1' }] }

async function run() {
  const created = await roomService.main({ action: 'create', room })
  assert.strictEqual(created.ok, true)
  const code = created.code
  assert.strictEqual((await roomService.main({ action: 'get', code: 'BAD' })).code, 'INVALID_CODE')
  const retried = await roomService.main({ action: 'create', room })
  assert.strictEqual(retried.code, code, '创建响应丢失后的重试不应生成第二个云端房间')
  assert.strictEqual(docs.length, 1)
  assert.strictEqual(created.room.memberRevision, 0)
  assert.strictEqual(created.room.venueMemberRevision, 0)
  assert(created.room.expiresAt > Date.now() + 29 * 24 * 3600000)
  assert.strictEqual(signals[created.signalId].openid, 'owner')

  openid = 'stranger'
  const preview = await roomService.main({ action: 'get', code })
  assert.strictEqual(preview.ok, true)
  assert.strictEqual(preview.room.preview, true)
  assert.strictEqual(preview.room.title, '聚会')
  assert.strictEqual(preview.room.memberCount, 2)
  assert.strictEqual(preview.viewerMemberId, '')
  assert.strictEqual(preview.signalId, '')
  assert(!JSON.stringify(preview).includes('latitude'), '未加入者不能读取成员坐标')
  assert(!JSON.stringify(preview).includes('guest-seat'), '未加入者不能读取成员标识')
  assert(!JSON.stringify(preview).includes('venue-1'), '未加入者不能读取推荐地点')

  const denied = await roomService.main({ action: 'issueClaimCode', code, memberId: 'guest-seat' })
  assert.strictEqual(denied.ok, false)
  const deniedEdit = await roomService.main({ action: 'updateMember', code, member: member('owner-seat', '冒名修改') })
  assert.strictEqual(deniedEdit.ok, false)

  openid = 'owner'
  const ownerView = await roomService.main({ action: 'get', code })
  assert.strictEqual(ownerView.room.members[0].latitude, 31)
  assert.strictEqual(ownerView.room.preview, undefined)
  const issued = await roomService.main({ action: 'issueClaimCode', code, memberId: 'guest-seat' })
  assert.match(issued.claimCode, /^[A-F0-9]{16}$/)
  assert(!JSON.stringify(docs).includes(issued.claimCode), '云端不能保存明文认领码')

  openid = 'other'
  const wrong = await roomService.main({ action: 'join', code, claimCode: '0000000000000000', member: member('', '小李') })
  assert.strictEqual(wrong.ok, false)
  const sameName = await roomService.main({ action: 'join', code, member: member('', '小李') })
  assert.strictEqual(sameName.ok, true)
  assert.strictEqual(sameName.room.memberRevision, 1)
  assert.notStrictEqual(sameName.viewerMemberId, 'guest-seat')

  openid = 'invitee'
  const joined = await roomService.main({ action: 'join', code, claimCode: issued.claimCode, member: member('', '小李') })
  assert.strictEqual(joined.ok, true)
  assert.strictEqual(joined.room.memberRevision, 2)
  assert.strictEqual(joined.viewerMemberId, 'guest-seat')
  assert.strictEqual(signals[joined.signalId].openid, 'invitee')
  const joinedView = await roomService.main({ action: 'get', code })
  assert.strictEqual(joinedView.room.members[0].longitude, 121)
  docs[0].room.routeMatrix = { 'venue-1': { 'guest-seat': { minutes: 20 } } }
  const edited = await roomService.main({ action: 'updateMember', code, member: Object.assign(member('owner-seat', '新名字'), {
    latitude: 32, longitude: 122, transport: 'walking', budget: 50
  }) })
  assert.strictEqual(edited.ok, true)
  assert.strictEqual(edited.room.memberRevision, 3)
  assert.strictEqual(edited.room.members.find((item) => item.id === 'guest-seat').name, '新名字')
  assert.strictEqual(edited.room.members.find((item) => item.id === 'guest-seat').latitude, 32)
  assert.strictEqual(edited.room.members[0].name, '你', '成员不能用客户端传入的 ID 修改别人')
  assert.deepStrictEqual(edited.room.routeMatrix, {}, '修改出发信息后旧路线必须失效')
  const previousVersion = signals[created.signalId].version
  const voted = await roomService.main({ action: 'toggleVote', code, venueId: 'venue-1' })
  assert.strictEqual(voted.ok, true)
  assert.notStrictEqual(signals[created.signalId].version, previousVersion)
  const left = await roomService.main({ action: 'leave', code })
  assert.strictEqual(left.ok, true)
  assert.strictEqual(docs[0].room.memberRevision, 4)
  assert(!docs[0].room.members.some((item) => item.id === 'guest-seat'))
  assert.deepStrictEqual(docs[0].room.votes['venue-1'], [])
  assert.strictEqual(signals[joined.signalId], undefined)
  const afterLeave = await roomService.main({ action: 'get', code })
  assert.strictEqual(afterLeave.room.preview, true)
  assert(!JSON.stringify(afterLeave).includes('latitude'))

  openid = 'another'
  const replay = await roomService.main({ action: 'join', code, claimCode: issued.claimCode, member: member('', '小李') })
  assert.strictEqual(replay.ok, false)
  openid = 'next-owner'
  const shortRoom = Object.assign({}, room, {
    id: 'room-2', retentionHours: 1,
    members: [Object.assign({}, member('next-owner-seat', '你'), { latitude: 31.230412, longitude: 121.473701, locationName: '详细地址', approximate: true })]
  })
  const shortLived = await roomService.main({ action: 'create', room: shortRoom })
  assert(shortLived.room.expiresAt > Date.now() + 3500000 && shortLived.room.expiresAt < Date.now() + 3700000)
  assert.strictEqual(shortLived.room.members[0].latitude, 31.23)
  assert.strictEqual(shortLived.room.members[0].locationName, '大致位置（约 1 公里精度）')
  const expiringDoc = docs.find((doc) => doc.code === shortLived.code)
  expiringDoc.expiresAt = Date.now() - 1
  failSignalRemoval = shortLived.signalId
  await roomService.main({ action: 'get', code: shortLived.code })
  assert(docs.includes(expiringDoc), '通知删除失败时读取清理也应保留房间，供下次重试')
  failSignalRemoval = ''
  const expired = await roomService.main({ action: 'get', code: shortLived.code })
  assert.strictEqual(expired.message, '聚会已过期')
  assert.strictEqual(expired.code, 'ROOM_EXPIRED')
  assert(!docs.includes(expiringDoc))
  assert.strictEqual(signals[shortLived.signalId], undefined)
  console.log('claim tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
