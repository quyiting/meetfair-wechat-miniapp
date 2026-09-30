const assert = require('assert')
const { openingStatus, transitDeparture } = require('../cloudfunctions/venueService')

assert.strictEqual(openingStatus('09:00-22:00', '', '2026-09-30', '18:30', '2026-09-30'), 'open')
assert.strictEqual(openingStatus('09:00-22:00', '', '2026-09-30', '23:00', '2026-09-30'), 'closed')
assert.strictEqual(openingStatus('', '周一至周五:09:00-22:00', '2026-10-03', '18:30', '2026-09-30'), 'closed')
assert.strictEqual(openingStatus('', '周一至周五:09:00-22:00', '2026-10-02', '18:30', '2026-09-30'), 'open')
assert.strictEqual(openingStatus('', '节假日另行通知', '2026-10-02', '18:30', '2026-09-30'), 'unknown')
assert.deepStrictEqual(transitDeparture('2026-10-02', '00:20', 40), { date: '2026-10-01', time: '23-40' })

console.log('meeting time tests: ok')
