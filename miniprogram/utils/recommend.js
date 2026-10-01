const { CATEGORY_LABELS, TRANSPORT_LABELS, normalizeTransport } = require('./constants')

const EARTH_RADIUS_KM = 6371

function toRadians(value) {
  return value * Math.PI / 180
}

function distanceKm(from, to) {
  const latDiff = toRadians(to.latitude - from.latitude)
  const lonDiff = toRadians(to.longitude - from.longitude)
  const a = Math.sin(latDiff / 2) ** 2 + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(lonDiff / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function midpoint(members) {
  const total = members.length || 1
  return members.reduce((point, member) => ({
    latitude: point.latitude + member.latitude / total,
    longitude: point.longitude + member.longitude / total
  }), { latitude: 0, longitude: 0 })
}

function candidateOrigins(members) {
  const center = midpoint(members)
  if (members.length < 2) return [center]
  let pair = [members[0], members[1]]
  let spread = 0
  members.forEach((first) => members.forEach((second) => {
    const distance = distanceKm(first, second)
    if (distance > spread) { spread = distance; pair = [first, second] }
  }))
  if (spread < 5) return [center]
  return [center].concat(pair.map((member) => ({
    latitude: (center.latitude + member.latitude) / 2,
    longitude: (center.longitude + member.longitude) / 2
  })))
}

const SPEEDS = { transit: 19, driving: 25, walking: 4.5, bicycle: 12 }
const FIXED_MINUTES = { transit: 10, driving: 5, walking: 0, bicycle: 0 }

function estimateMinutes(distance, transport) {
  const mode = normalizeTransport(transport)
  return Math.max(4, Math.round(distance / SPEEDS[mode] * 60 + FIXED_MINUTES[mode]))
}

function getFairnessLabel(maxMinutes) {
  if (maxMinutes <= 20) return '很公平'
  if (maxMinutes <= 30) return '比较公平'
  return '可接受'
}

// 评分以「公平度」为核心：优先压低最远成员的时间，其次看平均时间。
// 注意：腾讯位置服务不返回人均价格与用户评分，因此二者当前不参与打分，
// 只有数据源真的提供价格/评分时才会重新生效。
const MAX_WEIGHT = 1.8
const AVG_WEIGHT = 0.7
const CATEGORY_BONUS = 12
const PREFERENCES = [
  { label: '安静', wanted: /安静|清静|不吵/, evidence: /安静|清静|静谧/ },
  { label: '包间', wanted: /包间|包厢/, evidence: /包间|包厢/ },
  { label: '停车', wanted: /停车|车位/, evidence: /停车场|停车位|可停车|车位/ }
]

function preferenceMatches(venue, text) {
  const evidence = [venue.name, venue.tags, venue.highlight, venue.parkingType].filter(Boolean).join(' ')
  return PREFERENCES.filter((item) => item.wanted.test(text) &&
    !new RegExp('(不要|无需|不需要)' + item.label).test(text) &&
    item.evidence.test(evidence) && !new RegExp('(无|没有)' + item.label).test(evidence))
    .map((item) => item.label)
}

function clampScore(value) {
  return Math.max(0, Math.min(100, value))
}

function recommendVenues(room, category, goal = 'max') {
  const venues = category === 'all' ? room.venues : room.venues.filter((venue) => venue.category === category)
  return venues.map((venue) => {
    const travel = room.members.map((member) => {
      const distance = distanceKm(member, venue)
      const transport = normalizeTransport(member.transport || (room.transport === 'mixed' ? 'transit' : room.transport))
      const route = room.routeMatrix && room.routeMatrix[venue.id] && room.routeMatrix[venue.id][member.id]
      return {
        memberId: member.id,
        name: member.name,
        shortName: member.shortName,
        minutes: route ? route.minutes : estimateMinutes(distance, transport),
        distance: route && Number.isFinite(route.distance) ? route.distance : Number(distance.toFixed(1)),
        transport,
        transportLabel: TRANSPORT_LABELS[transport],
        isEstimated: !route
      }
    })
    const maxMinutes = Math.max.apply(null, travel.map((item) => item.minutes))
    const totalMinutes = travel.reduce((sum, item) => sum + item.minutes, 0)
    const spreadMinutes = maxMinutes - Math.min.apply(null, travel.map((item) => item.minutes))
    const averageMinutes = Math.round(totalMinutes / travel.length)
    const categoryBonus = venue.category === room.category ? CATEGORY_BONUS : 0
    const rating = Number(venue.rating) || 0
    const price = Number(venue.price) || 0
    const ratingBonus = rating > 0 ? rating * 4 : 0
    const membersWithBudget = price > 0 ? room.members.filter((member) => Number(member.budget) > 0) : []
    const overBudgetMembers = membersWithBudget.filter((member) => price > Number(member.budget))
    const budgetPenalty = overBudgetMembers.length * 12
    const matchedPreferences = preferenceMatches(venue, String(room.preferenceText || ''))
    // rawScore 用于排序，保留负值以保证远近地点之间的次序不被打平；
    // score 仅作为 0~100 的展示用分值。
    const rawScore = 100 - maxMinutes * MAX_WEIGHT - averageMinutes * AVG_WEIGHT + ratingBonus + categoryBonus - budgetPenalty + matchedPreferences.length * 5
    const score = clampScore(Math.round(rawScore))
    // 缺失的价格/评分不编造文案，界面据空字符串隐藏对应字段
    const metaText = [CATEGORY_LABELS[venue.category]]
      .concat(rating > 0 ? [`★ ${rating}`] : [])
      .concat(price > 0 ? [`人均 ¥${price}`] : [])
      .concat(venue.openingText ? [venue.openingText] : [])
      .join(' · ')
    const budgetStatus = price > 0
      ? (membersWithBudget.length
        ? (overBudgetMembers.length ? `${overBudgetMembers.length} 人预算可能不足` : '符合所有人的预算')
        : '未设置预算')
      : ''
    return Object.assign({}, venue, {
      travel,
      maxMinutes,
      totalMinutes,
      spreadMinutes,
      averageMinutes,
      rawScore,
      score,
      fairness: getFairnessLabel(maxMinutes),
      categoryLabel: CATEGORY_LABELS[venue.category],
      metaText,
      budgetStatus,
      preferenceMatchText: matchedPreferences.length ? `公开资料匹配：${matchedPreferences.join('、')}` : '',
      routeCoverage: travel.filter((item) => !item.isEstimated).length,
      routeStatus: travel.every((item) => !item.isEstimated) ? '真实路线' : '含估算路线'
    })
  }).sort((a, b) => {
    const metric = goal === 'total' ? 'totalMinutes' : goal === 'equal' ? 'spreadMinutes' : 'maxMinutes'
    return a[metric] - b[metric] || b.rawScore - a.rawScore
  })
}

function explainTopRecommendation(recommendations, goal = 'max') {
  if (!recommendations.length) return ''
  if (recommendations.length === 1) return '当前筛选条件下只有一个候选地点。'
  const metric = goal === 'total' ? 'totalMinutes' : goal === 'equal' ? 'spreadMinutes' : 'maxMinutes'
  const label = goal === 'total' ? '全员总通勤' : goal === 'equal' ? '通勤时间差距' : '最远成员通勤'
  const difference = recommendations[1][metric] - recommendations[0][metric]
  const reason = difference > 0
    ? `按${label}排序，首选比第二名少 ${difference} 分钟。`
    : recommendations[0].rawScore > recommendations[1].rawScore
      ? `${label}与第二名持平，首选的预算、类别、评分或偏好综合匹配更高。`
      : `${label}与第二名持平，可结合预算和地点偏好选择。`
  return recommendations[0].routeCoverage < recommendations[0].travel.length
    ? reason + ' 含估算通勤，请以实际导航核实。' : reason
}

function routeCandidates(room) {
  const ranked = recommendVenues(room, 'all')
  const chosen = []
  const categories = ['food', 'cinema', 'coffee', 'fun']
  categories.forEach((category) => {
    const first = ranked.find((venue) => venue.category === category)
    if (first) chosen.push(first)
  })
  ranked.forEach((venue) => {
    if (chosen.length < 6 && !chosen.some((item) => item.id === venue.id)) chosen.push(venue)
  })
  return chosen
}

module.exports = { distanceKm, midpoint, candidateOrigins, estimateMinutes, recommendVenues, routeCandidates, explainTopRecommendation }
