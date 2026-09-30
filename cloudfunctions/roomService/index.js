const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTION = 'rooms'

// 去掉易混淆字符（0/O、1/I/L、J），便于口头传达和手动输入
const CODE_CHARS = '23456789ABCDEFGHKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6
const CODE_PATTERN = new RegExp('^[' + CODE_CHARS + ']{' + CODE_LENGTH + '}$')
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CATEGORIES = ['food', 'cinema', 'coffee', 'fun']

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
  if (!name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('成员数据不合法')
  }
  return {
    id,
    name,
    shortName: name.slice(0, 1),
    color: /^#[0-9a-f]{6}$/i.test(String(member.color || '')) ? String(member.color) : '#3675ff',
    latitude,
    longitude,
    locationName: String(member.locationName || '').slice(0, 120),
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

async function ensureCollection() {
  try {
    await db.createCollection(COLLECTION)
  } catch (e) {
    // 已存在时忽略；下面 add 若仍失败会返回真实错误
  }
}

async function createRoom(room, openid) {
  await ensureCollection()
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const existing = await db.collection(COLLECTION).where({ code }).count()
    if (existing.total > 0) continue
    const ownerMemberId = room.members[0].id || generateMemberId()
    const savedRoom = {
      id: String(room.id).slice(0, 80),
      title: String(room.title).trim().slice(0, 18),
      category: room.category,
      transport: 'mixed',
      dateText: String(room.dateText || '').slice(0, 40),
      meetingDate: String(room.meetingDate || '').slice(0, 10),
      meetingTime: String(room.meetingTime || '').slice(0, 5),
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + ROOM_TTL_MS
      }
    })
    return { code, room: savedRoom, viewerMemberId: ownerMemberId }
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
        return { ok: false, message: '聚会已过期' }
      }
      const room = Object.assign({}, doc.room, { cloudId: doc.code })
      return { ok: true, code: doc.code, room, viewerMemberId: getViewerMemberId(doc, OPENID), isOwner: doc.owner === OPENID }
    }

    if (action === 'join') {
      const code = String(event.code || '').toUpperCase()
      if (!CODE_PATTERN.test(code)) return { ok: false, message: '聚会码格式不正确' }
      const doc = await findRoom(code)
      if (!doc) return { ok: false, message: '聚会码不存在' }
      const existingMemberId = getViewerMemberId(doc, OPENID)
      if (existingMemberId) {
        return { ok: true, code, room: Object.assign({}, doc.room, { cloudId: code }), viewerMemberId: existingMemberId, isOwner: doc.owner === OPENID }
      }
      const requestedName = String(event.member && event.member.name || '').trim().slice(0, 8)
      const boundIds = (doc.memberBindings || []).map((item) => item.memberId)
      const claimableMember = doc.room.members.find((member) => member.name === requestedName && boundIds.indexOf(member.id) < 0)
      if (!claimableMember && doc.room.members.length >= 8) return { ok: false, message: '聚会人数已满' }
      const memberId = claimableMember ? claimableMember.id : generateMemberId()
      const member = normalizeMember(event.member, memberId)
      const room = Object.assign({}, doc.room, {
        cloudId: code,
        members: claimableMember
          ? doc.room.members.map((item) => item.id === memberId ? member : item)
          : doc.room.members.concat(member)
      })
      const memberBindings = (doc.memberBindings || []).concat({ memberId, openid: OPENID })
      await db.collection(COLLECTION).doc(doc._id).update({ data: { room, memberBindings, updatedAt: Date.now() } })
      return { ok: true, code, room, viewerMemberId: memberId, isOwner: doc.owner === OPENID }
    }

    if (action === 'toggleVote') {
      const code = String(event.code || '').toUpperCase()
      const venueId = String(event.venueId || '')
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
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
      return { ok: true, code, room, viewerMemberId: memberId, isOwner: doc.owner === OPENID }
    }

    if (action === 'setVenues') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
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
      return { ok: true, code, room, viewerMemberId: getViewerMemberId(doc, OPENID), isOwner: doc.owner === OPENID }
    }

    if (action === 'delete') {
      const code = String(event.code || '').toUpperCase()
      const doc = CODE_PATTERN.test(code) ? await findRoom(code) : null
      if (!doc) return { ok: false, message: '聚会不存在' }
      if (doc.owner !== OPENID) return { ok: false, message: '只有创建者可以删除聚会' }
      await db.collection(COLLECTION).doc(doc._id).remove()
      return { ok: true }
    }

    return { ok: false, message: '未知操作' }
  } catch (e) {
    console.error('[roomService] 失败:', e)
    return { ok: false, message: e.message || '云函数执行失败' }
  }
}
