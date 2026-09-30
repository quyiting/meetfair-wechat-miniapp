const assert = require('assert')
const { prepareMemberLocation } = require('../miniprogram/utils/privacy')

const precise = { latitude: 31.230412, longitude: 121.473701, locationName: '某小区 3 号楼', approximate: true }
const shared = prepareMemberLocation(precise)
assert.deepStrictEqual([shared.latitude, shared.longitude], [31.23, 121.47])
assert.strictEqual(shared.locationName, '大致位置（约 1 公里精度）')
assert.strictEqual(precise.locationName, '某小区 3 号楼')
assert.strictEqual(prepareMemberLocation(Object.assign({}, precise, { approximate: false })).latitude, precise.latitude)
assert.strictEqual(prepareMemberLocation(Object.assign({}, precise, { latitude: null })).latitude, null)

console.log('privacy tests: ok')
