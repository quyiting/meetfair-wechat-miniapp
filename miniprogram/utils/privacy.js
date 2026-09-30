function prepareMemberLocation(member) {
  if (!member.approximate || !Number.isFinite(member.latitude) || !Number.isFinite(member.longitude)) return Object.assign({}, member)
  return Object.assign({}, member, {
    latitude: Math.round(member.latitude * 100) / 100,
    longitude: Math.round(member.longitude * 100) / 100,
    locationName: '大致位置（约 1 公里精度）'
  })
}

module.exports = { prepareMemberLocation }
