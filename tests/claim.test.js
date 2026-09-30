const assert = require('assert')
const Module = require('module')

let openid = 'owner'
const docs = []
const collection = {
  where(query) {
    return {
      limit() { return this },
      async get() { return { data: docs.filter((doc) => doc.code === query.code) } },
      async count() { return { total: docs.filter((doc) => doc.code === query.code).length } }
    }
  },
  async add({ data }) { docs.push(Object.assign({ _id: 'doc-1' }, data)) },
  doc(id) {
    return {
      async get() { return { data: docs.find((doc) => doc._id === id) } },
      async update({ data }) { Object.assign(docs.find((doc) => doc._id === id), data) }
    }
  }
}
const db = {
  collection() { return collection },
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
const room = { id: 'room-1', title: '聚会', category: 'food', members: [member('owner-seat', '你'), member('guest-seat', '小李')], venues: [] }

async function run() {
  const created = await roomService.main({ action: 'create', room })
  assert.strictEqual(created.ok, true)
  const code = created.code

  openid = 'stranger'
  const denied = await roomService.main({ action: 'issueClaimCode', code, memberId: 'guest-seat' })
  assert.strictEqual(denied.ok, false)

  openid = 'owner'
  const issued = await roomService.main({ action: 'issueClaimCode', code, memberId: 'guest-seat' })
  assert.match(issued.claimCode, /^[A-F0-9]{16}$/)
  assert(!JSON.stringify(docs).includes(issued.claimCode), '云端不能保存明文认领码')

  openid = 'other'
  const wrong = await roomService.main({ action: 'join', code, claimCode: '0000000000000000', member: member('', '小李') })
  assert.strictEqual(wrong.ok, false)
  const sameName = await roomService.main({ action: 'join', code, member: member('', '小李') })
  assert.strictEqual(sameName.ok, true)
  assert.notStrictEqual(sameName.viewerMemberId, 'guest-seat')

  openid = 'invitee'
  const joined = await roomService.main({ action: 'join', code, claimCode: issued.claimCode, member: member('', '小李') })
  assert.strictEqual(joined.ok, true)
  assert.strictEqual(joined.viewerMemberId, 'guest-seat')

  openid = 'another'
  const replay = await roomService.main({ action: 'join', code, claimCode: issued.claimCode, member: member('', '小李') })
  assert.strictEqual(replay.ok, false)
  console.log('claim tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
