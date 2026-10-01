function toMinutes(time) {
  if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return null
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(3))
  return hour < 24 && minute < 60 ? hour * 60 + minute : null
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function recommendMeetingTimes(members, date, preferredTime, travelMinutes = 0, now = new Date()) {
  const chinaNow = new Date(now.getTime() + 8 * 3600000)
  const today = chinaNow.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || date < today) return []
  const preferred = toMinutes(preferredTime)
  const earliest = date === today
    ? chinaNow.getUTCHours() * 60 + chinaNow.getUTCMinutes() + Math.max(0, travelMinutes) + 10
    : 0
  const respondents = members.filter((member) => Array.isArray(member.availability) && member.availability.length)
  if (!respondents.length) return []
  const slots = []
  for (let start = 8 * 60; start <= 22 * 60; start += 30) {
    if (start < earliest) continue
    const end = start + 60
    const count = respondents.filter((member) => member.availability.some((range) => {
      const from = toMinutes(range.start)
      const to = toMinutes(range.end)
      return from !== null && to !== null && from <= start && to >= end
    })).length
    if (count) slots.push({ start: toTime(start), end: toTime(end), count,
      responded: respondents.length, total: members.length,
      distanceFromPreferred: preferred === null ? 0 : Math.abs(start - preferred) })
  }
  slots.sort((a, b) => b.count - a.count || a.distanceFromPreferred - b.distanceFromPreferred || a.start.localeCompare(b.start))
  const chosen = []
  slots.forEach((slot) => {
    if (chosen.length < 3 && chosen.every((item) => Math.abs(toMinutes(item.start) - toMinutes(slot.start)) >= 60)) {
      chosen.push(slot)
    }
  })
  return chosen
}

module.exports = { recommendMeetingTimes, toMinutes }
