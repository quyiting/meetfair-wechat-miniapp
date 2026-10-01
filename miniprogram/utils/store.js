const { normalizeTransport, CATEGORY_LABELS } = require('./constants')

const STORAGE_KEY = 'meetfair_rooms_v1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function getRooms() {
  const stored = wx.getStorageSync(STORAGE_KEY) || []
  const active = stored.filter((room) => !room.expiresAt || room.expiresAt > Date.now())
  if (active.length !== stored.length) saveRooms(active)
  return active
}

function saveRooms(rooms) {
  wx.setStorageSync(STORAGE_KEY, rooms)
}

function getRoom(id) {
  return getRooms().find((room) => room.id === id) || null
}

function createRoom(room) {
  const rooms = getRooms()
  rooms.unshift(room)
  saveRooms(rooms)
  return room
}

function updateRoom(updatedRoom) {
  const rooms = getRooms()
  const idx = rooms.findIndex((room) => room.id === updatedRoom.id)
  if (idx >= 0) {
    rooms[idx] = updatedRoom
  } else {
    rooms.unshift(updatedRoom)
  }
  saveRooms(rooms)
  return updatedRoom
}

function deleteRoom(id) {
  saveRooms(getRooms().filter((room) => room.id !== id))
}

// 聚会数据存云数据库，聚会码只是 6 位短码的“取件凭证”，便于口头传达和手动输入。
// 读写统一走 roomService 云函数：客户端无权建集合，也不该把整个集合开放给所有人读。
function callRoomService(action, payload) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.callFunction) {
      reject(new Error('云开发不可用'))
      return
    }
    wx.cloud.callFunction({
      name: 'roomService',
      data: Object.assign({ action }, payload),
      success: (res) => {
        const result = res.result || {}
        if (!result.ok) {
          reject(new Error(result.message || '云服务返回异常'))
          return
        }
        resolve(result)
      },
      fail: (err) => {
        reject(new Error((err && err.errMsg) || '云函数调用失败'))
      }
    })
  })
}

function cloudCreateRoom(room) {
  return callRoomService('create', { room }).then((result) => {
    room = Object.assign({}, result.room || room, {
      cloudId: result.code,
      currentMemberId: result.viewerMemberId || room.members[0].id,
      currentUserIsOwner: result.isOwner !== false,
      claimableMemberIds: result.claimableMemberIds || [],
      signalId: result.signalId || ''
    })
    updateRoom(room)
    console.log('[cloudCreateRoom] 成功，短码:', result.code)
    return room
  }).catch((err) => {
    console.warn('[cloudCreateRoom] 失败，回退本地长码:', err.message)
    return null
  })
}

function cloudGetRoom(code) {
  return callRoomService('get', { code }).then((result) => {
    console.log('[cloudGetRoom] 成功，短码:', result.code)
    return Object.assign({}, result.room, {
      cloudId: result.code,
      currentMemberId: result.viewerMemberId || '',
      currentUserIsOwner: Boolean(result.isOwner),
      claimableMemberIds: result.claimableMemberIds || [],
      signalId: result.signalId || ''
    })
  }).catch((err) => {
    console.warn('[cloudGetRoom] 失败:', err.message)
    return null
  })
}

function addMemberToRoom(roomId, member, claimCode) {
  const room = getRoom(roomId)
  if (!room) {
    return Promise.reject(new Error('聚会不存在'))
  }
  if (room.cloudId) {
    return callRoomService('join', { code: room.cloudId, member, claimCode }).then((result) => {
      const syncedRoom = Object.assign({}, result.room, {
        cloudId: result.code,
        currentMemberId: result.viewerMemberId || '',
        currentUserIsOwner: Boolean(result.isOwner),
        claimableMemberIds: result.claimableMemberIds || [],
        signalId: result.signalId || ''
      })
      updateRoom(syncedRoom)
      return syncedRoom
    })
  }
  const existingMember = room.currentMemberId && room.members.find((m) => m.id === room.currentMemberId)
  if (existingMember) {
    return Promise.reject(new Error('你已经加入了这个聚会'))
  }
  member.id = member.id || `local-member-${Date.now()}`
  room.members.push(member)
  room.memberRevision = (room.memberRevision || 0) + 1
  room.currentMemberId = member.id
  updateRoom(room)
  return Promise.resolve(room)
}

function cloudIssueClaimCode(room, memberId) {
  return callRoomService('issueClaimCode', { code: room.cloudId, memberId })
}

function cloudToggleVote(room, venueId) {
  if (!room.cloudId) return Promise.resolve(null)
  return callRoomService('toggleVote', { code: room.cloudId, venueId }).then((result) => {
    const syncedRoom = Object.assign({}, result.room, {
      cloudId: result.code,
      currentMemberId: result.viewerMemberId || '',
      currentUserIsOwner: Boolean(result.isOwner),
      claimableMemberIds: room.claimableMemberIds || [],
      signalId: result.signalId || room.signalId || ''
    })
    updateRoom(syncedRoom)
    return syncedRoom
  })
}

function cloudSetVenues(room, venues, venueSource, routeMatrix) {
  if (!room.cloudId) return Promise.resolve(null)
  return callRoomService('setVenues', { code: room.cloudId, memberRevision: room.memberRevision || 0, venues, venueSource, routeMatrix }).then((result) => {
    const syncedRoom = Object.assign({}, result.room, {
      cloudId: result.code,
      currentMemberId: result.viewerMemberId || room.currentMemberId || '',
      currentUserIsOwner: Boolean(result.isOwner),
      claimableMemberIds: room.claimableMemberIds || [],
      signalId: result.signalId || room.signalId || ''
    })
    updateRoom(syncedRoom)
    return syncedRoom
  })
}

function cloudDeleteRoom(room) {
  if (!room.cloudId) {
    deleteRoom(room.id)
    return Promise.resolve()
  }
  return callRoomService('delete', { code: room.cloudId }).then(() => deleteRoom(room.id))
}

function cloudLeaveRoom(room) {
  if (!room.cloudId) {
    deleteRoom(room.id)
    return Promise.resolve()
  }
  return callRoomService('leave', { code: room.cloudId }).then(() => deleteRoom(room.id))
}

// 紧凑编码：用数组代替对象，坐标转整数，base-36 编码
const MEMBER_COLORS = ['#3675ff', '#fa6e52', '#8d6bff', '#20b891', '#e19a35', '#e85b98', '#4895d8', '#74829d']
const TRANSPORT_MAP = { transit: 0, driving: 1, walking: 2, bicycle: 3 }
const TRANSPORT_REV = ['transit', 'driving', 'walking', 'bicycle']

function bytesToBase36(bytes) {
  // 将整个字节数组作为大整数，一次性转 base36，比逐字节编码短约 40%
  let bigInt = BigInt(0)
  for (let i = 0; i < bytes.length; i++) {
    bigInt = (bigInt << BigInt(8)) | BigInt(bytes[i])
  }
  return bigInt.toString(36)
}

function base36ToBytes(str) {
  let bigInt = BigInt(0)
  for (let i = 0; i < str.length; i++) {
    bigInt = bigInt * BigInt(36) + BigInt(parseInt(str[i], 36))
  }
  // 转回字节数组
  const bytes = []
  while (bigInt > BigInt(0)) {
    bytes.unshift(Number(bigInt & BigInt(255)))
    bigInt = bigInt >> BigInt(8)
  }
  return bytes
}

function stringToBytes(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

function bytesToString(bytes) {
  let str = ''
  let i = 0
  while (i < bytes.length) {
    const b1 = bytes[i++]
    if (b1 < 0x80) {
      str += String.fromCharCode(b1)
    } else if ((b1 & 0xe0) === 0xc0) {
      const b2 = bytes[i++]
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f))
    } else if ((b1 & 0xf0) === 0xe0) {
      const b2 = bytes[i++], b3 = bytes[i++]
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f))
    } else {
      const b2 = bytes[i++], b3 = bytes[i++], b4 = bytes[i++]
      str += String.fromCharCode(((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f))
    }
  }
  return str
}

function encodeRoom(room) {
  // 紧凑二进制编码，比 JSON 数组短很多
  const parts = []

  // 写字符串：1 字节长度 + UTF-8 内容
  function writeStr(s) {
    // 长度前缀只有 1 字节，超过 255 字节必须按字符截断，否则整串编码都会损坏
    let text = s == null ? '' : String(s)
    let bytes = stringToBytes(text)
    while (bytes.length > 255) {
      text = text.slice(0, -1)
      bytes = stringToBytes(text)
    }
    parts.push(bytes.length)
    parts.push(...bytes)
  }

  // 写 4 字节大端整数（坐标）
  function writeInt32(n) {
    parts.push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255)
  }

  writeStr(room.id)
  writeStr(room.title)
  writeStr(room.category)
  writeStr(room.dateText || '')
  parts.push(room.members.length)

  room.members.forEach(m => {
    writeStr(m.name)
    const colorIdx = MEMBER_COLORS.indexOf(m.color)
    parts.push(colorIdx >= 0 ? colorIdx : 0)
    writeInt32(Math.round(m.latitude * 1e5))
    writeInt32(Math.round(m.longitude * 1e5))
    // 去除默认位置名
    const locName = (m.locationName || '').replace(/^当前位置 · \d+\.\d+, \d+\.\d+$/, '')
    writeStr(locName)
    const transportIndex = TRANSPORT_MAP[normalizeTransport(m.transport)]
    parts.push(transportIndex === undefined ? 0 : transportIndex)
    parts.push(m.budget || 0)
  })

  writeStr(room.preferenceText || '')

  return bytesToBase36(parts)
}

function decodeRoom(code) {
  try {
    if (typeof code !== 'string' || !code) return null
    const bytes = base36ToBytes(code)
    let pos = 0

    function ensure(count) {
      if (pos + count > bytes.length) throw new Error('聚会码不完整')
    }

    function readStr() {
      ensure(1)
      const len = bytes[pos++]
      ensure(len)
      const str = bytesToString(bytes.slice(pos, pos + len))
      pos += len
      return str
    }

    function readInt32() {
      ensure(4)
      const n = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
      pos += 4
      return n
    }

    function readByte() {
      ensure(1)
      return bytes[pos++]
    }

    const roomId = readStr()
    const title = readStr()
    const category = readStr()
    const dateText = readStr()
    const memberCount = readByte()

    // 结构校验：截断或损坏的码在这里被拒绝，而不是解析成乱码
    if (!roomId || !title || !CATEGORY_LABELS[category] || memberCount < 1 || memberCount > 8) {
      throw new Error('聚会码内容不合法')
    }

    const members = []
    for (let i = 0; i < memberCount; i++) {
      const name = readStr()
      const colorIdx = readByte()
      const lat = readInt32() / 1e5
      const lng = readInt32() / 1e5
      const locationName = readStr()
      const transport = TRANSPORT_REV[readByte()] || 'transit'
      const budget = readByte()

      members.push({
        id: `local-member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || `朋友 ${i + 1}`,
        shortName: (name || '友').slice(0, 1),
        color: MEMBER_COLORS[colorIdx] || MEMBER_COLORS[0],
        latitude: lat,
        longitude: lng,
        locationName: locationName || '',
        transport,
        budget
      })
    }

    // 旧版长码在成员列表后结束；新版附加可选的地点偏好。
    const preferenceText = pos < bytes.length ? readStr() : ''
    // 必须恰好读完所有字节，多一个或少一个都视为无效
    if (pos !== bytes.length) throw new Error('聚会码校验失败')

    return {
      id: roomId,
      title,
      category,
      dateText: dateText || '',
      preferenceText,
      members,
      votes: {},
      venues: [],
      venueSource: null,
      venueSearchAt: 0
    }
  } catch (e) {
    return null
  }
}

module.exports = {
  getRooms,
  getRoom,
  createRoom,
  updateRoom,
  deleteRoom,
  clone,
  encodeRoom,
  decodeRoom,
  cloudCreateRoom,
  cloudGetRoom,
  addMemberToRoom,
  cloudIssueClaimCode,
  cloudToggleVote,
  cloudSetVenues,
  cloudLeaveRoom,
  cloudDeleteRoom
}
