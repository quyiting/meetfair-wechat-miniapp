const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 100

exports.main = async () => {
  const now = Date.now()
  let deleted = 0
  const queries = [
    { expiresAt: db.command.lt(now) },
    { createdAt: db.command.lt(now - ROOM_TTL_MS) }
  ]

  for (const query of queries) {
    const result = await db.collection('rooms').where(query).limit(BATCH_SIZE).get()
    for (const doc of result.data || []) {
      const expiresAt = doc.expiresAt || ((doc.createdAt || now) + ROOM_TTL_MS)
      if (expiresAt >= now) continue
      for (const id of Object.values(doc.signals || {})) {
        await db.collection('roomSignals').doc(id).remove()
      }
      await db.collection('rooms').doc(doc._id).remove()
      deleted++
    }
  }

  console.log('[cleanupExpiredRooms] 已删除过期聚会:', deleted)
  return { deleted }
}
