const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTION = 'rooms'
const SIGNAL_COLLECTION = 'roomSignals'

// 去掉易混淆字符（0/O、1/I/L、J），便于口头传达和手动输入
const CODE_CHARS = '23456789ABCDEFGHKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6
const CODE_PATTERN = new RegExp('^[' + CODE_CHARS + ']{' + CODE_LENGTH + '}$')
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RETENTION_HOURS = [1, 24, 168, 720]
const CATEGORIES = ['food', 'cinema', 'coffee', 'fun']
const CLAIM_CODE_PATTERN = /^[A-F0-9]{16}$/

function claimableMemberIds(doc) {
  const bound = (doc.memberBindings || []).map((item) => item.memberId)
  return doc.room.members.filter((member) => bound.indexOf(member.id) < 0).map((member) => member.id)
}

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

function generateMemberId() {
  return 'member-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function normalizeAvailability(value) {
  if (!Array.isArray(value) || value.length > 5) throw new Error('可用时间最多填写 5 段')
  return value.map((range) => {
    const start = String(range && range.start || '')
    const end = String(range && range.end || '')
    const valid = (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    if (!valid(start) || !valid(end) || start >= end) throw new Error('可用时间格式不正确')
    return { start, end }
  })
}

function normalizeVenues(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('地点数据不合法')
  const seen = new Set()
  return value.map((venue) => {
    if (!venue || typeof venue !== 'object' || Array.isArray(venue)) throw new Error('地点数据不合法')
    const id = String(venue.id || '')
    const name = String(venue.name || '').trim()
    if (!id || id.length > 160 || ['__proto__', 'constructor', 'prototype'].includes(id) ||
      seen.has(id) || !name || name.length > 80 || CATEGORIES.indexOf(venue.category) < 0 ||
      !Number.isFinite(venue.latitude) || venue.latitude < -90 || venue.latitude > 90 ||
      !Number.isFinite(venue.longitude) || venue.longitude < -180 || venue.longitude > 180) {
      throw new Error('地点数据不合法')
    }
    seen.add(id)
    const optionalNumber = (number, max) => {
      if (number === null || number === undefined || number === '') return null
      if (!Number.isFinite(number) || number < 0 || number > max) throw new Error('地点数据不合法')
      return number
    }
    const text = (value, max) => String(value || '').slice(0, max)
    return {
      id, name, category: venue.category,
      providerId: text(venue.providerId, 100), cityCode: text(venue.cityCode, 20),
      address: text(venue.address, 160), latitude: venue.latitude, longitude: venue.longitude,
      rating: optionalNumber(venue.rating, 5), price: optionalNumber(venue.price, 100000),
      openingStatus: text(venue.openingStatus, 20), openingText: text(venue.openingText, 80),
      tags: text(venue.tags, 200), parkingType: text(venue.parkingType, 80),
      highlight: text(venue.highlight, 200), distanceMeters: optionalNumber(venue.distanceMeters, 1000000),
      source: text(venue.source, 20)
    }
  })
}

function normalizeRouteMatrix(value, venues, members) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('路线数据不合法')
  const venueIds = new Set(venues.map((venue) => venue.id))
  const memberIds = new Set(members.map((member) => member.id))
  const matrix = {}
  for (const venueId of Object.keys(value)) {
    if (!venueIds.has(venueId)) throw new Error('路线数据不合法')
    const routes = value[venueId]
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('路线数据不合法')
    matrix[venueId] = {}
    for (const memberId of Object.keys(routes)) {
      const route = routes[memberId]
      if (!memberIds.has(memberId) || !route || typeof route !== 'object' || Array.isArray(route) ||
        !Number.isFinite(route.minutes) || route.minutes < 1 || route.minutes > 1440 ||
        (route.distance !== null && route.distance !== undefined &&
          (!Number.isFinite(route.distance) || route.distance < 0 || route.distance > 10000))) {
        throw new Error('路线数据不合法')
      }
      matrix[venueId][memberId] = { minutes: route.minutes,
        distance: route.distance === undefined ? null : route.distance, source: 'amap-route' }
    }
  }
  return matrix
}

function normalizeVenueSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { live: value.live === true, provider: ['amap', 'tencent'].includes(value.provider) ? value.provider : '',
    label: String(value.label || '').slice(0, 120) }
}

function normalizeMember(member, id) {
  if (!member || typeof member !== 'object') throw new Error('成员数据不合法')
  if (typeof id !== 'string' || !id || id.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('成员标识不合法')
  const name = String(member.name || '').trim().slice(0, 8)
  const latitude = Number(member.latitude)
  const longitude = Number(member.longitude)
  const transports = ['transit', 'driving', 'walking', 'bicycle']
  const approximate = member.approximate === true
  if (!name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('成员数据不合法')
  }
  return {
    id,
    name,
    shortName: name.slice(0, 1),
    color: /^#[0-9a-f]{6}$/i.test(String(member.color || '')) ? String(member.color) : '#3675ff',
    latitude: approximate ? Math.round(latitude * 100) / 100 : latitude,
    longitude: approximate ? Math.round(longitude * 100) / 100 : longitude,
    locationName: approximate ? '大致位置（约 1 公里精度）' : String(member.locationName || '').slice(0, 120),
    approximate,
    transport: transports.indexOf(member.transport) >= 0 ? member.transport : 'transit',
    budget: Math.max(0, Math.min(255, Number(member.budget) || 0)),
    availability: normalizeAvailability(member.availability || [])
  }
}

async function findRoom(code) {
  const result = await db.collection(COLLECTION).where({ code }).limit(1).get()
  return (result.data && result.data[0]) || null
}

function getViewerMemberId(doc, openid) {
  const binding = (doc.memberBindings || []).find((item) => item.openid === openid)
  if (binding) return binding.memberId
  // 兼容部署本版本前创建的房间：旧数据只有 owner，没有 memberBindings。
  if (doc.owner === openid && doc.room && doc.room.members && doc.room.members[0]) {
    return doc.room.members[0].id
  }
  return ''
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在时忽略；下面 add 若仍失败会返回真实错误
  }
}

async function publishSignals(signals) {
  const version = crypto.randomBytes(8).toString('hex')
  await Promise.all(Object.keys(signals || {}).map(async (openid) => {
    try {
      await db.collection(SIGNAL_COLLECTION).doc(signals[openid]).set({ data: { openid, version } })
    } catch (error) {
      console.warn('[roomService] 实时通知失败:', error.message)
    }
  }))
}

async function ensureViewerSignal(doc, openid) {
  if (!getViewerMemberId(doc, openid)) return ''
  if (doc.signals && doc.signals[openid]) return doc.signals[openid]
  await ensureCollection(SIGNAL_COLLECTION)
  const signalId = await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
    if (!current || !getViewerMemberId(current, openid)) return ''
    if (current.signals && current.signals[openid]) return current.signals[openid]
    const id = crypto.randomBytes(16).toString('hex')
    const signals = Object.assign({}, current.signals || {}, { [openid]: id })
    await transaction.collection(COLLECTION).doc(doc._id).update({ data: { signals } })
    return id
  })
  if (signalId) await publishSignals({ [openid]: signalId })
  return signalId
}

async function createRoom(room, openid) {
  await ensureCollection(COLLECTION)
  await ensureCollection(SIGNAL_COLLECTION)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const existing = await db.collection(COLLECTION).where({ code }).count()
    if (existing.total > 0) continue
    const ownerMemberId = room.members[0].id || generateMemberId()
    const signalId = crypto.randomBytes(16).toString('hex')
    const retentionHours = RETENTION_HOURS.indexOf(Number(room.retentionHours)) >= 0 ? Number(room.retentionHours) : 720
    const expiresAt = Date.now() + retentionHours * 3600000
    const members = room.members.map((member, index) => normalizeMember(member, index === 0 ? ownerMemberId : (member.id || generateMemberId())))
    const venues = normalizeVenues(room.venues)
    const savedRoom = {
      id: String(room.id).slice(0, 80),
      title: String(room.title).trim().slice(0, 18),
      category: room.category,
      preferenceText: String(room.preferenceText || '').trim().slice(0, 60),
      transport: 'mixed',
      dateText: String(room.dateText || '').slice(0, 40),
      meetingDate: String(room.meetingDate || '').slice(0, 10),
      meetingTime: String(room.meetingTime || '').slice(0, 5),
      meetingSearchTime: String(room.meetingTime || '').slice(0, 5),
      retentionHours,
      expiresAt,
      cloudId: code,
      members,
      venues,
      venueSource: normalizeVenueSource(room.venueSource),
      routeMatrix: normalizeRouteMatrix(room.routeMatrix, venues, members),
      memberRevision: 0,
      venueMemberRevision: 0,
      votes: {},
      createdAt: Number(room.createdAt) || Date.now()
    }
    await db.collection(COLLECTION).add({
      data: {
        code,
        clientRoomId: openid + ':' + String(room.id).slice(0, 80),
        room: savedRoom,
        owner: openid,
        memberBindings: [{ memberId: ownerMemberId, openid }],
        signals: { [openid]: signalId },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt
      }
    })
    await publishSignals({ [openid]: signalId })
    return { code, room: savedRoom, viewerMemberId: ownerMemberId, signalId,
      claimableMemberIds: savedRoom.members.slice(1).map((member) => member.id) }
  }
  throw new Error('聚会码生成失败，请稍后重试')
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action

  try {
    if (action === 'create') {
      const room = event.room
      if (!room || !room.id || !String(room.title || '').trim() || CATEGORIES.indexOf(room.category) < 0 ||
        !Array.isArray(room.members) || !room.members.length || !Array.isArray(room.venues) || room.venues.length > 100) {
        return { ok: false, message: '聚会数据不合法' }
      }
      if (room.members.length > 8) return { ok: false, message: '成员最多 8 人' }
      await ensureCollection(COLLECTION)
      const clientRoomId = OPENID + ':' + String(room.id).slice(0, 80)
      const existing = (await db.collection(COLLECTION).where({ clientRoomId }).limit(1).get()).data[0]
      if (existing && existing.expiresAt > Date.now()) {
        const viewerMemberId = getViewerMemberId(existing, OPENID)
        return { ok: true, isOwner: true, code: existing.code, room: existing.room,
          viewerMemberId, signalId: (existing.signals || {})[OPENID] || '',
          claimableMemberIds: claimableMemberIds(existing) }
      }
      const created = await createRoom(room, OPENID)
      return Object.assign({ ok: true, isOwner: true }, created)
    }

    if (action === 'get') {
      const code = String(event.code || '').toUpperCase()
      if (!CODE_PATTERN.test(code)) {
        return { ok: false, code: 'INVALID_CODE', message: '聚会码格式不正确' }
      }
      const doc = await findRoom(code)
      if (!doc) {
        return { ok: false, code: 'ROOM_NOT_FOUND', message: '聚会码不存在' }
      }
      const expiresAt = doc.expiresAt || ((doc.createdAt || Date.now()) + ROOM_TTL_MS)
      if (expiresAt < Date.now()) {
        await Promise.all(Object.values(doc.signals || {}).map((id) => db.collection(SIGNAL_COLLECTION).doc(id).remove()))
        await db.collection(COLLECTION).doc(doc._id).remove()
        return { ok: false, code: 'ROOM_EXPIRED', message: '聚会已过期' }
      }
      const viewerMemberId = getViewerMemberId(doc, OPENID)
      if (!viewerMemberId) {
        const { id, title, category, dateText } = doc.room
        return { ok: true, code: doc.code, room: {
          id, title, category, dateText, transport: 'mixed', cloudId: doc.code, expiresAt,
          memberCount: doc.room.members.length, members: [], venues: [], preview: true
        }, viewerMemberId: '', isOwner: false, claimableMemberIds: [], signalId: '' }
      }
      const room = Object.assign({}, doc.room, { cloudId: doc.code, expiresAt })
      const signalId = await ensureViewerSignal(doc, OPENID)
      return { ok: true, code: doc.code, room, viewerMemberId, isOwner: doc.owner === OPENID,
        claimableMemberIds: doc.owner === OPENID ? claimableMemberIds(doc) : [], signalId }
    }

    if (action === 'issueClaimCode') {
      const code = String(event.code || '').toUpperCase()
      const memberId = String(event.memberId || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以生成认领码' }
      const claimCode = crypto.randomBytes(8).toString('hex').toUpperCase()
      await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.owner !== OPENID || claimableMemberIds(current).indexOf(memberId) < 0) {
          throw new Error('该成员已被认领或不存在')
        }
        if (current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const claimCodes = Object.assign({}, current.claimCodes || {}, {
          [memberId]: crypto.createHash('sha256').update(claimCode).digest('hex')
        })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { claimCodes, updatedAt: Date.now() } })
      })
      return { ok: true, claimCode }
    }

    if (action === 'join') {
      const code = String(event.code || '').toUpperCase()
      if (!CODE_PATTERN.test(code)) return { ok: false, message: '聚会码格式不正确' }
      const doc = await findRoom(code)
      if (!doc) return { ok: false, message: '聚会码不存在' }
      const claimCode = String(event.claimCode || '').trim().toUpperCase()
      const joined = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current) throw new Error('聚会不存在')
        if (current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const existingMemberId = getViewerMemberId(current, OPENID)
        if (existingMemberId) return { room: current.room, memberId: existingMemberId, doc: current }
        let claimableMember = null
        if (claimCode) {
          if (!CLAIM_CODE_PATTERN.test(claimCode)) throw new Error('认领码格式不正确')
          const hash = crypto.createHash('sha256').update(claimCode).digest('hex')
          const memberId = Object.keys(current.claimCodes || {}).find((id) => current.claimCodes[id] === hash)
          if (!memberId || claimableMemberIds(current).indexOf(memberId) < 0) throw new Error('认领码无效或已使用')
          claimableMember = current.room.members.find((member) => member.id === memberId)
        }
        if (!claimableMember && current.room.members.length >= 8) throw new Error('聚会人数已满')
        const memberId = claimableMember ? claimableMember.id : generateMemberId()
        const member = normalizeMember(event.member, memberId)
        const room = Object.assign({}, current.room, {
          cloudId: code,
          memberRevision: (current.room.memberRevision || 0) + 1,
          routeMatrix: claimableMember ? {} : current.room.routeMatrix,
          members: claimableMember
            ? current.room.members.map((item) => item.id === memberId ? member : item)
            : current.room.members.concat(member)
        })
        const memberBindings = (current.memberBindings || []).concat({ memberId, openid: OPENID })
        const claimCodes = Object.assign({}, current.claimCodes || {})
        const signalId = crypto.randomBytes(16).toString('hex')
        const signals = Object.assign({}, current.signals || {}, { [OPENID]: signalId })
        if (claimableMember) delete claimCodes[memberId]
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, memberBindings, claimCodes, signals, updatedAt: Date.now() } })
        return { room, memberId, doc: Object.assign({}, current, { room, memberBindings, signals }) }
      })
      const signalId = await ensureViewerSignal(joined.doc, OPENID)
      await publishSignals(joined.doc.signals)
      return { ok: true, code, room: joined.room, viewerMemberId: joined.memberId, isOwner: doc.owner === OPENID,
        claimableMemberIds: doc.owner === OPENID ? claimableMemberIds(joined.doc) : [], signalId }
    }

    if (action === 'updateMember') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const memberId = getViewerMemberId(current, OPENID)
        if (!memberId) throw new Error('请先加入聚会')
        const previous = current.room.members.find((item) => item.id === memberId)
        if (!previous) throw new Error('成员不存在')
        const member = normalizeMember(Object.assign({}, event.member, {
          color: previous.color, availability: previous.availability || []
        }), memberId)
        const room = Object.assign({}, current.room, {
          memberRevision: (current.room.memberRevision || 0) + 1,
          members: current.room.members.map((item) => item.id === memberId ? member : item),
          routeMatrix: {}
        })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, memberId, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: result.memberId, isOwner: result.doc.owner === OPENID,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'updateAvailability') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      const availability = normalizeAvailability(event.availability)
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const memberId = getViewerMemberId(current, OPENID)
        if (!memberId) throw new Error('请先加入聚会')
        const room = Object.assign({}, current.room, {
          members: current.room.members.map((item) => item.id === memberId
            ? Object.assign({}, item, { availability }) : item)
        })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, memberId, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: result.memberId, isOwner: result.doc.owner === OPENID,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'setMeetingTime') {
      const code = String(event.code || '').toUpperCase()
      const time = String(event.time || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以确定时间' }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, message: '聚会时间不合法' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.expiresAt < Date.now()) throw new Error('聚会已过期')
        if (current.owner !== OPENID) throw new Error('只有创建者可以确定时间')
        const room = Object.assign({}, current.room, {
          meetingTime: time, dateText: current.room.meetingDate + ' ' + time,
          meetingSearchTime: current.room.meetingSearchTime || current.room.meetingTime || '',
          finalTimeAt: Date.now(), routeMatrix: {}
        })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: getViewerMemberId(result.doc, OPENID), isOwner: true,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'toggleVote') {
      const code = String(event.code || '').toUpperCase()
      const venueId = String(event.venueId || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current) throw new Error('聚会不存在')
        if (current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const memberId = getViewerMemberId(current, OPENID)
        if (!memberId) throw new Error('请先加入聚会')
        if (!(current.room.venues || []).some((venue) => venue.id === venueId)) throw new Error('地点不存在')
        const votes = Object.assign({}, current.room.votes || {})
        const currentVotes = votes[venueId] || []
        votes[venueId] = currentVotes.indexOf(memberId) >= 0
          ? currentVotes.filter((id) => id !== memberId)
          : currentVotes.concat(memberId)
        const room = Object.assign({}, current.room, { cloudId: code, votes })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, memberId, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: result.memberId, isOwner: result.doc.owner === OPENID,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'setVenues') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以更新地点' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current) throw new Error('聚会不存在')
        if (current.expiresAt < Date.now()) throw new Error('聚会已过期')
        if (current.owner !== OPENID) throw new Error('只有创建者可以更新地点')
        const memberId = getViewerMemberId(current, OPENID)
        if (event.memberRevision !== (current.room.memberRevision || 0)) throw new Error('成员已变化，请重新搜索地点')
        if (current.room.meetingTime && event.meetingTime !== current.room.meetingTime) throw new Error('聚会时间已变化，请重新搜索地点')
        const venues = normalizeVenues(event.venues)
        const room = Object.assign({}, current.room, {
          cloudId: code,
          venues,
          venueSource: normalizeVenueSource(event.venueSource),
          routeMatrix: normalizeRouteMatrix(event.routeMatrix, venues, current.room.members),
          venueMemberRevision: current.room.memberRevision || 0,
          meetingSearchTime: current.room.meetingTime || '',
          venueSearchAt: Date.now()
        })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, memberId, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: result.memberId, isOwner: result.doc.owner === OPENID,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'setFinalVenue') {
      const code = String(event.code || '').toUpperCase()
      const venueId = String(event.venueId || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以确定地点' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.expiresAt < Date.now()) throw new Error('聚会已过期')
        if (current.owner !== OPENID) throw new Error('只有创建者可以确定地点')
        const venue = (current.room.venues || []).find((item) => item.id === venueId)
        if (!venue || !Number.isFinite(Number(venue.latitude)) || !Number.isFinite(Number(venue.longitude))) throw new Error('地点不存在')
        const finalVenue = {
          id: venue.id, name: String(venue.name || '聚会地点').slice(0, 80),
          address: String(venue.address || '').slice(0, 160),
          latitude: Number(venue.latitude), longitude: Number(venue.longitude)
        }
        const room = Object.assign({}, current.room, { finalVenue, finalVenueAt: Date.now() })
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
        return { room, doc: current }
      }, 3)
      await publishSignals(result.doc.signals)
      return { ok: true, code, room: result.room, viewerMemberId: getViewerMemberId(result.doc, OPENID), isOwner: true,
        signalId: (result.doc.signals || {})[OPENID] || '' }
    }

    if (action === 'leave') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner === OPENID) return { ok: false, message: '创建者请删除整个聚会' }
      const result = await db.runTransaction(async (transaction) => {
        const current = (await transaction.collection(COLLECTION).doc(doc._id).get()).data
        if (!current || current.expiresAt < Date.now()) throw new Error('聚会已过期')
        const memberId = getViewerMemberId(current, OPENID)
        if (!memberId) throw new Error('你尚未加入聚会')
        const votes = {}
        Object.keys(current.room.votes || {}).forEach((venueId) => {
          votes[venueId] = current.room.votes[venueId].filter((id) => id !== memberId)
        })
        const routeMatrix = {}
        Object.keys(current.room.routeMatrix || {}).forEach((venueId) => {
          const routes = Object.assign({}, current.room.routeMatrix[venueId])
          delete routes[memberId]
          routeMatrix[venueId] = routes
        })
        const room = Object.assign({}, current.room, {
          memberRevision: (current.room.memberRevision || 0) + 1,
          members: current.room.members.filter((member) => member.id !== memberId), votes, routeMatrix
        })
        const memberBindings = (current.memberBindings || []).filter((item) => item.openid !== OPENID)
        const signals = Object.assign({}, current.signals || {})
        const removedSignalId = signals[OPENID]
        delete signals[OPENID]
        await transaction.collection(COLLECTION).doc(doc._id).update({ data: { room, memberBindings, signals, updatedAt: Date.now() } })
        return { signals, removedSignalId }
      })
      if (result.removedSignalId) await db.collection(SIGNAL_COLLECTION).doc(result.removedSignalId).remove().catch(() => {})
      await publishSignals(result.signals)
      return { ok: true }
    }

    if (action === 'delete') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以删除聚会' }
      await db.collection(COLLECTION).doc(doc._id).remove()
      await Promise.all(Object.values(doc.signals || {}).map((id) => db.collection(SIGNAL_COLLECTION).doc(id).remove().catch(() => {})))
      return { ok: true }
    }

    return { ok: false, message: '未知操作' }
  } catch (e) {
    console.error('[roomService] 失败:', e)
    return { ok: false, message: e.message || '云函数执行失败' }
  }
}
