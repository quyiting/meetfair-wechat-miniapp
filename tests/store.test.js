const assert = require('assert')
const { encodeRoom, decodeRoom } = require('../miniprogram/utils/store')

const room = {
  id: 'room-test', title: '周末见面', category: 'food', dateText: '2026-09-28 18:30',
  members: [
    { id: 'a', name: '小明', color: '#3675ff', latitude: 31.2304, longitude: 121.4737, locationName: '人民广场', transport: 'transit', budget: 100 },
    { id: 'b', name: '小红', color: '#fa6e52', latitude: 31.2, longitude: 121.4, locationName: '徐家汇', transport: 'driving', budget: 200 }
  ]
}

const code = encodeRoom(room)
const decoded = decodeRoom(code)
assert(decoded)
assert.strictEqual(decoded.title, room.title)
assert.strictEqual(decoded.members.length, 2)
assert.strictEqual(decoded.members[1].transport, 'driving')
assert.strictEqual(decoded.members[1].budget, 200)
assert.strictEqual(decodeRoom(code.slice(0, -3)), null)
assert.strictEqual(decodeRoom('not-a-valid-code'), null)

console.log('store tests: ok')
