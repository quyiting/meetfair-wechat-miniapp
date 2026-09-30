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

function normalizeMember(member, id) {
  if (!member || typeof member !== 'object') throw new Error('成员数据不合法')
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
    budget: Math.max(0, Math.min(255, Number(member.budget) || 0))
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
    const savedRoom = {
      id: String(room.id).slice(0, 80),
      title: String(room.title).trim().slice(0, 18),
      category: room.category,
      transport: 'mixed',
      dateText: String(room.dateText || '').slice(0, 40),
      meetingDate: String(room.meetingDate || '').slice(0, 10),
      meetingTime: String(room.meetingTime || '').slice(0, 5),
      retentionHours,
      expiresAt,
      cloudId: code,
      members: room.members.map((member, index) => normalizeMember(member, index === 0 ? ownerMemberId : (member.id || generateMemberId()))),
      venues: room.venues,
      venueSource: room.venueSource || null,
      routeMatrix: room.routeMatrix && typeof room.routeMatrix === 'object' ? room.routeMatrix : {},
      votes: {},
      createdAt: Number(room.createdAt) || Date.now()
    }
    await db.collection(COLLECTION).add({
      data: {
        code,
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
      const created = await createRoom(room, OPENID)
      return Object.assign({ ok: true, isOwner: true }, created)
    }

    if (action === 'get') {
      const code = String(event.code || '').toUpperCase()
      if (!CODE_PATTERN.test(code)) {
        return { ok: false, message: '聚会码格式不正确' }
      }
      const doc = await findRoom(code)
      if (!doc) {
        return { ok: false, message: '聚会码不存在' }
      }
      const expiresAt = doc.expiresAt || ((doc.createdAt || Date.now()) + ROOM_TTL_MS)
      if (expiresAt < Date.now()) {
        await db.collection(COLLECTION).doc(doc._id).remove()
        await Promise.all(Object.values(doc.signals || {}).map((id) => db.collection(SIGNAL_COLLECTION).doc(id).remove().catch(() => {})))
        return { ok: false, message: '聚会已过期' }
      }
      const room = Object.assign({}, doc.room, { cloudId: doc.code, expiresAt })
      const signalId = await ensureViewerSignal(doc, OPENID)
      return { ok: true, code: doc.code, room, viewerMemberId: getViewerMemberId(doc, OPENID), isOwner: doc.owner === OPENID,
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

    if (action === 'toggleVote') {
      const code = String(event.code || '').toUpperCase()
      const venueId = String(event.venueId || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.expiresAt < Date.now()) return { ok: false, message: '聚会已过期' }
      const memberId = getViewerMemberId(doc, OPENID)
      if (!memberId) return { ok: false, message: '请先加入聚会' }
      if (!(doc.room.venues || []).some((venue) => venue.id === venueId)) return { ok: false, message: '地点不存在' }
      const votes = Object.assign({}, doc.room.votes || {})
      const currentVotes = votes[venueId] || []
      votes[venueId] = currentVotes.indexOf(memberId) >= 0
        ? currentVotes.filter((id) => id !== memberId)
        : currentVotes.concat(memberId)
      const room = Object.assign({}, doc.room, { cloudId: code, votes })
      await db.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
      await publishSignals(doc.signals)
      return { ok: true, code, room, viewerMemberId: memberId, isOwner: doc.owner === OPENID, signalId: (doc.signals || {})[OPENID] || '' }
    }

    if (action === 'setVenues') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.expiresAt < Date.now()) return { ok: false, message: '聚会已过期' }
      if (!getViewerMemberId(doc, OPENID)) return { ok: false, message: '请先加入聚会' }
      if (!Array.isArray(event.venues) || event.venues.length > 100) return { ok: false, message: '地点数据不合法' }
      const room = Object.assign({}, doc.room, {
        cloudId: code,
        venues: event.venues,
        venueSource: event.venueSource || null,
        routeMatrix: event.routeMatrix && typeof event.routeMatrix === 'object' ? event.routeMatrix : {},
        venueSearchAt: Date.now()
      })
      await db.collection(COLLECTION).doc(doc._id).update({ data: { room, updatedAt: Date.now() } })
      await publishSignals(doc.signals)
      return { ok: true, code, room, viewerMemberId: getViewerMemberId(doc, OPENID), isOwner: doc.owner === OPENID, signalId: (doc.signals || {})[OPENID] || '' }
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
