const assert = require('assert')
const { recommendMeetingTimes } = require('../miniprogram/utils/meeting-time')

const members = [
  { availability: [{ start: '18:00', end: '21:00' }] },
  { availability: [{ start: '19:00', end: '22:00' }] },
  { availability: [{ start: '18:30', end: '20:30' }] }
]
const suggestions = recommendMeetingTimes(members, '2026-10-03', '19:00', 0, new Date('2026-10-01T10:00:00+08:00'))
assert.strictEqual(suggestions[0].start, '19:00')
assert.strictEqual(suggestions[0].count, 3)
assert.strictEqual(suggestions[0].end, '20:00')

const partial = recommendMeetingTimes([
  { availability: [{ start: '09:00', end: '11:00' }] },
  { availability: [{ start: '18:00', end: '20:00' }] }
], '2026-10-03', '18:00', 0, new Date('2026-10-01T10:00:00+08:00'))
assert.strictEqual(partial[0].count, 1)
assert.strictEqual(partial[0].start, '18:00')

const tooLate = recommendMeetingTimes(members, '2026-10-01', '19:00', 40, new Date('2026-10-01T18:30:00+08:00'))
assert(tooLate.every((item) => item.start >= '19:30'), '今天的时间需预留路程与缓冲')

console.log('time suggestions tests: ok')
