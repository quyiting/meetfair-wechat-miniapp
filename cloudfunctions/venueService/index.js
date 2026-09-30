const crypto = require('crypto')
const https = require('https')

const CATEGORY_QUERIES = { food: '餐厅', cinema: '电影院', coffee: '咖啡', fun: 'KTV' }
const AMAP_CATEGORY_TYPES = { food: '050000', cinema: '080601', coffee: '050500', fun: '080300' }
const CATEGORY_KEYS = Object.keys(CATEGORY_QUERIES)
const PAGE_SIZE = 20
const SEARCH_RADIUS = 8000

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex')
}

function sortedQuery(params) {
  return Object.keys(params).sort().map((key) => key + '=' + params[key]).join('&')
}

function requestJson(hostname, path, params) {
  const query = Object.keys(params).map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&')
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname, path: path + '?' + query, timeout: 10000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, data: JSON.parse(body) })
        } catch (error) {
          reject(new Error('地图服务返回了无法解析的数据'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('地图服务请求超时')))
    request.on('error', reject)
  })
}

function toTencentVenue(result, category) {
  const location = result.location || {}
  return {
    id: 'qq-' + (result.id || location.lat + '-' + location.lng + '-' + result.title),
    providerId: result.id || '', name: result.title || '未命名地点', category,
    address: result.address || (result.ad_info && result.ad_info.district) || '地址信息暂缺',
    latitude: Number(location.lat), longitude: Number(location.lng), rating: null, price: null, open: true,
    highlight: result.tel ? '电话 ' + result.tel : (result.category || '腾讯位置服务地点数据'),
    distanceMeters: Number(result._distance || 0), source: 'tencent'
  }
}

async function searchTencent(origin, category) {
  const key = process.env.QQ_MAP_KEY
  const sk = process.env.QQ_MAP_SK || ''
  if (!key) throw new Error('云函数未配置 QQ_MAP_KEY')
  const path = '/ws/place/v1/search'
  const params = {
    boundary: 'nearby(' + origin.latitude + ',' + origin.longitude + ',' + SEARCH_RADIUS + ')',
    keyword: CATEGORY_QUERIES[category], page_size: PAGE_SIZE, page_index: 1, orderby: '_distance', key
  }
  if (sk) params.sig = md5(path + '?' + sortedQuery(params) + sk)
  const response = await requestJson('apis.map.qq.com', path, params)
  const payload = response.data || {}
  if (response.statusCode !== 200 || payload.status !== 0) throw new Error(payload.message || '腾讯地图请求失败')
  return (payload.data || []).map((result) => toTencentVenue(result, category))
}

function toAmapVenue(poi, category) {
  const coords = String(poi.location || '').split(',')
  const biz = poi.biz_ext || {}
  const rating = Number(biz.rating)
  const price = Number(biz.cost)
  return {
    id: 'amap-' + (poi.id || coords.join('-') + '-' + poi.name), providerId: poi.id || '', cityCode: String(poi.citycode || ''),
    name: poi.name || '未命名地点', category,
    address: (typeof poi.address === 'string' && poi.address) || (typeof poi.adname === 'string' && poi.adname) || '地址信息暂缺',
    latitude: Number(coords[1]), longitude: Number(coords[0]),
    rating: rating > 0 ? rating : null, price: price > 0 ? Math.round(price) : null, open: true,
    highlight: (typeof poi.tel === 'string' && poi.tel ? '电话 ' + poi.tel : '') || (typeof poi.type === 'string' && poi.type) || '高德地图地点数据',
    distanceMeters: Number(poi.distance || 0), source: 'amap'
  }
}

async function searchAmap(origin, category) {
  const key = process.env.AMAP_KEY
  const sk = process.env.AMAP_SK || ''
  if (!key) throw new Error('云函数未配置 AMAP_KEY')
  const path = '/v3/place/around'
  const params = {
    key, location: origin.longitude + ',' + origin.latitude, types: AMAP_CATEGORY_TYPES[category],
    radius: SEARCH_RADIUS, offset: PAGE_SIZE, page: 1, extensions: 'all', sortrule: 'distance'
  }
  if (sk) params.sig = md5(sortedQuery(params) + sk)
  const response = await requestJson('restapi.amap.com', path, params)
  const payload = response.data || {}
  if (response.statusCode !== 200 || payload.status !== '1') throw new Error(payload.info || '高德地图请求失败')
  return (payload.pois || []).map((poi) => toAmapVenue(poi, category))
}

async function getAmapRoute(member, venue) {
  const key = process.env.AMAP_KEY
  const sk = process.env.AMAP_SK || ''
  const routeType = { driving: 'driving', walking: 'walking', bicycle: 'bicycling', transit: 'transit/integrated' }[member.transport] || 'transit/integrated'
  const path = '/v5/direction/' + routeType
  const params = {
    key,
    origin: member.longitude + ',' + member.latitude,
    destination: venue.longitude + ',' + venue.latitude,
    show_fields: 'cost'
  }
  if (member.transport === 'transit') {
    // 候选地点位于同一搜索区域，默认按候选地点城市进行市内公交规划。
    if (!venue.cityCode) return null
    params.city1 = venue.cityCode
    params.city2 = venue.cityCode
    params.AlternativeRoute = 1
  }
  if (sk) params.sig = md5(sortedQuery(params) + sk)
  try {
    const response = await requestJson('restapi.amap.com', path, params)
    const payload = response.data || {}
    if (response.statusCode !== 200 || payload.status !== '1') return null
    const options = member.transport === 'transit'
      ? (payload.route && payload.route.transits)
      : (payload.route && payload.route.paths)
    const route = options && options[0]
    const duration = Number(route && route.cost && route.cost.duration)
    const distance = Number(route && route.distance)
    if (!Number.isFinite(duration) || duration <= 0) return null
    return {
      minutes: Math.max(1, Math.round(duration / 60)),
      distance: Number.isFinite(distance) ? Number((distance / 1000).toFixed(1)) : null,
      source: 'amap-route'
    }
  } catch (error) {
    console.warn('[venueService] 路线规划失败:', error.message)
    return null
  }
}

async function getRouteMatrix(event) {
  if (!process.env.AMAP_KEY) return { ok: true, available: false, routeMatrix: {} }
  const members = Array.isArray(event.members) ? event.members.slice(0, 8) : []
  const venues = Array.isArray(event.venues) ? event.venues.slice(0, 3) : []
  if (!members.length || !venues.length) return { ok: false, message: '路线规划参数不完整' }
  const pairs = []
  venues.forEach((venue) => members.forEach((member) => pairs.push({ member, venue })))
  const results = []
  // 限制并发，避免瞬间打满地图服务 QPS。
  for (let index = 0; index < pairs.length; index += 5) {
    const batch = pairs.slice(index, index + 5)
    const batchResults = await Promise.all(batch.map((pair) => getAmapRoute(pair.member, pair.venue)))
    results.push.apply(results, batchResults)
  }
  const routeMatrix = {}
  pairs.forEach((pair, index) => {
    if (!results[index]) return
    routeMatrix[pair.venue.id] = routeMatrix[pair.venue.id] || {}
    routeMatrix[pair.venue.id][pair.member.id] = results[index]
  })
  return { ok: true, available: true, routeMatrix }
}

exports.main = async (event) => {
  try {
    if (event.action === 'routes') return await getRouteMatrix(event)
    const origin = event.origin || {}
    const latitude = Number(origin.latitude)
    const longitude = Number(origin.longitude)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { ok: false, message: '搜索中心坐标不合法' }
    }
    const categories = event.category === 'all' ? CATEGORY_KEYS : [event.category]
    if (categories.some((category) => CATEGORY_KEYS.indexOf(category) < 0)) return { ok: false, message: '地点类别不合法' }
    const provider = process.env.AMAP_KEY ? 'amap' : 'tencent'
    const search = provider === 'amap' ? searchAmap : searchTencent
    const groups = await Promise.all(categories.map((category) => search({ latitude, longitude }, category)))
    const venues = [].concat.apply([], groups).filter((venue) => Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude))
    return {
      ok: true, venues,
      source: {
        live: true, provider,
        label: provider === 'amap' ? '高德地图 · 附近搜索，含人均价格与评分' : '腾讯位置服务 · 附近搜索，当前数据源不含价格'
      }
    }
  } catch (error) {
    console.error('[venueService] 失败:', error)
    return { ok: false, message: error.message || '地点搜索失败' }
  }
}
