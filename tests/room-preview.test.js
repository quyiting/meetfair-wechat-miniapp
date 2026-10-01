const assert = require('assert')

let stored = [{
  id: 'room-preview', title: '周末聚会', category: 'food', dateText: '2026-10-01 18:30',
  cloudId: 'ABC234', preview: true, memberCount: 2, members: [], venues: []
}]
global.wx = {
  getStorageSync: () => stored,
  setStorageSync: (key, value) => { stored = value }
}
global.Page = (definition) => { global.roomPage = definition }
require('../miniprogram/pages/room/room')

async function run() {
  const page = Object.assign({}, global.roomPage, {
    data: Object.assign({}, global.roomPage.data),
    roomId: 'room-preview',
    setData(values) { Object.assign(this.data, values) },
    refreshNearby() { throw new Error('未加入者不应触发地点搜索') }
  })
  await page.loadRoom(true)
  assert.strictEqual(page.data.room.preview, true)
  assert.strictEqual(page.data.room.memberCount, 2)
  assert.strictEqual(page.data.point, null)
  assert.deepStrictEqual(page.data.recommendations, [])
  assert.deepStrictEqual(page.data.markers, [])
  assert.strictEqual(page.data.isMember, false)

  require('../miniprogram/pages/index/index')
  const indexPage = Object.assign({}, global.roomPage, {
    data: {}, setData(values) { Object.assign(this.data, values) }
  })
  indexPage.onShow()
  assert.strictEqual(indexPage.data.rooms[0].memberCount, 2, '首页应显示摘要中的真实人数')

  const joinedRoom = {
    id: 'room-preview', cloudId: 'ABC234', title: '周末聚会', category: 'food',
    members: [
      { id: 'owner', name: '你', latitude: 31, longitude: 121 },
      { id: 'new', name: '小李', latitude: 31.1, longitude: 121.1 }
    ],
    venues: [{ id: 'venue-1', name: '餐厅', category: 'food', latitude: 31.05, longitude: 121.05 }],
    votes: {}, routeMatrix: {}
  }
  wx.cloud = {
    callFunction({ data, success }) {
      assert.strictEqual(data.action, 'join')
      success({ result: { ok: true, code: 'ABC234', room: joinedRoom, viewerMemberId: 'new', signalId: 'signal-1' } })
    }
  }
  const { addMemberToRoom, cloudCreateRoom } = require('../miniprogram/utils/store')
  await addMemberToRoom('room-preview', joinedRoom.members[1], '')
  await page.loadRoom(true)
  assert.strictEqual(page.data.isMember, true)
  assert.strictEqual(page.data.room.preview, undefined)
  assert.strictEqual(page.data.recommendations.length, 1)
  assert.strictEqual(page.data.markers.length, 3)

  stored = [{
    id: 'cached-full', cloudId: 'ABC234', title: '周末聚会', category: 'food',
    members: [{ id: 'private', name: '小李', latitude: 31, longitude: 121 }],
    venues: [{ id: 'venue-1', name: '餐厅', latitude: 31, longitude: 121 }]
  }]
  wx.cloud = { callFunction({ fail }) { fail({ errMsg: 'network unavailable' }) } }
  wx.showToast = () => {}
  const cachedPage = Object.assign({}, page, {
    data: Object.assign({}, page.data, { room: stored[0] }),
    roomId: 'cached-full'
  })
  await cachedPage.loadRoom()
  assert.strictEqual(cachedPage.data.room, null, '云端校验失败时不能展示缓存的成员位置')
  assert.match(cachedPage.data.loadError, /网络或云服务暂时不可用/)
  assert.deepStrictEqual(cachedPage.data.markers, [])
  const localRoom = { id: 'local-room', currentUserIsOwner: true, members: [{ id: 'owner' }] }
  stored = [localRoom]
  assert.strictEqual(await cloudCreateRoom(localRoom), null)
  assert.match(stored[0].syncError, /网络或云服务暂时不可用/)
  console.log('room preview tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
