const assert = require('assert')
const { cachedSearch, main } = require('../cloudfunctions/venueService')

async function run() {
  const origin = { latitude: 31.2304, longitude: 121.4737 }
  const meeting = { date: '2026-10-03', time: '18:30' }
  let requests = 0
  const search = async () => { requests++; return [{ id: 'venue-1' }] }
  const first = await cachedSearch('amap', origin, 'food', meeting, 20, search)
  const second = await cachedSearch('amap', origin, 'food', meeting, 20, search)
  assert.strictEqual(first.cacheHit, false)
  assert.strictEqual(second.cacheHit, true)
  assert.strictEqual(requests, 1)
  await cachedSearch('amap', origin, 'food', { date: meeting.date, time: '19:00' }, 20, search)
  assert.strictEqual(requests, 2, '不同聚会时间不能复用营业状态')
  await cachedSearch('amap', origin, 'food', meeting, 8, search)
  assert.strictEqual(requests, 3, '不同搜索页大小不能复用结果')
  const badRoutes = await main({ action: 'routes', members: [{ id: 'a', latitude: 999, longitude: 121 }],
    venues: [{ id: 'v', latitude: 31, longitude: 121 }] })
  assert.strictEqual(badRoutes.ok, false)
  const missingVenueId = await main({ action: 'routes', members: [{ id: 'a', latitude: 31, longitude: 121 }],
    venues: [{ id: '', latitude: 31, longitude: 121 }] })
  assert.strictEqual(missingVenueId.ok, false)
  const badMeeting = await main({ origins: [origin], category: 'food', meetingDate: 'invalid', meetingTime: '18:30' })
  assert.strictEqual(badMeeting.ok, false)
  console.log('venue cache tests: ok')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
