const assert = require('assert')
const { distanceKm, estimateMinutes, midpoint, recommendVenues } = require('../miniprogram/utils/recommend')

const members = [
  { id: 'a', name: '甲', shortName: '甲', latitude: 31.2304, longitude: 121.4737, transport: 'transit', budget: 100 },
  { id: 'b', name: '乙', shortName: '乙', latitude: 31.2, longitude: 121.4, transport: 'driving', budget: 50 }
]
const venues = [
  { id: 'near', name: '近处', category: 'food', latitude: 31.2152, longitude: 121.4368, rating: 4.5, price: 80 },
  { id: 'far', name: '远处', category: 'food', latitude: 31.1, longitude: 121.3, rating: 5, price: 200 }
]

assert(distanceKm(members[0], members[1]) > 0)
assert(estimateMinutes(5, 'walking') > estimateMinutes(5, 'driving'))
assert(Math.abs(midpoint(members).latitude - 31.2152) < 0.00001)

const estimated = recommendVenues({ category: 'food', transport: 'mixed', members, venues }, 'all')
assert.strictEqual(estimated[0].id, 'near')
assert.strictEqual(estimated[0].routeStatus, '含估算路线')
assert.strictEqual(estimated[0].budgetStatus, '1 人预算可能不足')

const routed = recommendVenues({
  category: 'food', transport: 'mixed', members, venues: [venues[0]],
  routeMatrix: {
    near: {
      a: { minutes: 16, distance: 5.2 },
      b: { minutes: 12, distance: 6.1 }
    }
  }
}, 'all')
assert.strictEqual(routed[0].maxMinutes, 16)
assert.strictEqual(routed[0].averageMinutes, 14)
assert.strictEqual(routed[0].routeStatus, '真实路线')

console.log('recommend tests: ok')
