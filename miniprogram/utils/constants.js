const CATEGORY_LABELS = {
  food: '吃饭',
  cinema: '看电影',
  coffee: '喝咖啡',
  fun: '玩一玩'
}

// 统一出行方式枚举：transit / driving / walking / bicycle（mixed 仅用于聚会整体）
const TRANSPORT_LABELS = {
  transit: '公共交通',
  driving: '驾车',
  walking: '步行',
  bicycle: '骑行',
  mixed: '混合出行'
}

const TRANSPORT_VALUES = ['transit', 'driving', 'walking', 'bicycle']

// 兼容早期数据：旧版本曾使用 drive / walk
const TRANSPORT_ALIASES = { drive: 'driving', walk: 'walking' }

function normalizeTransport(value) {
  if (TRANSPORT_VALUES.indexOf(value) >= 0) return value
  return TRANSPORT_ALIASES[value] || 'transit'
}

module.exports = { CATEGORY_LABELS, TRANSPORT_LABELS, TRANSPORT_VALUES, normalizeTransport }
