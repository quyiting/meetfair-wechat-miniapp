const { getRoom, updateRoom, cloudToggleVote } = require('../../utils/store')
const { recommendVenues } = require('../../utils/recommend')

Page({
  data: {
    room: null,
    venue: null,
    markers: []
  },
  onLoad(options) {
    this.roomId = options.roomId
    this.venueId = options.venueId
  },
  onShow() {
    if (this.roomId) this.loadData()
  },
  loadData() {
    const room = getRoom(this.roomId)
    if (!room) return
    const venue = recommendVenues(room, 'all').find((item) => item.id === this.venueId)
    if (!venue) return
    const votes = (room.votes && room.votes[venue.id]) || []
    const hasVoted = votes.indexOf(room.currentMemberId) >= 0
    const hydratedVenue = Object.assign({}, venue, {
      voteCount: votes.length,
      hasVoted,
      voteButtonText: hasVoted ? '♥ 已投票' : '♥ 投票',
      voteSuffix: votes.length ? `(${votes.length})` : ''
    })
    const memberMarkers = room.members.map((member, index) => ({ id: index + 1, latitude: member.latitude, longitude: member.longitude, width: 24, height: 30, iconPath: '/images/marker-member.svg' }))
    const markers = memberMarkers.concat([{ id: 100, latitude: venue.latitude, longitude: venue.longitude, width: 36, height: 45, iconPath: '/images/marker-place.svg', callout: { content: venue.name, display: 'ALWAYS', padding: 7, borderRadius: 10, bgColor: '#1f5eff', color: '#ffffff', fontSize: 11 } }])
    this.setData({ room, venue: hydratedVenue, markers })
    wx.setNavigationBarTitle({ title: venue.name })
  },
  toggleVote() {
    const room = getRoom(this.roomId)
    const voterId = room.currentMemberId
    if (!voterId) {
      wx.showToast({ title: '请先加入聚会', icon: 'none' })
      return
    }
    const currentVotes = (room.votes && room.votes[this.venueId]) || []
    const hasVoted = currentVotes.indexOf(voterId) >= 0
    if (room.cloudId) {
      wx.showLoading({ title: '正在同步投票' })
      cloudToggleVote(room, this.venueId).then(() => {
        wx.hideLoading()
        this.loadData()
        wx.showToast({ title: hasVoted ? '已取消投票' : '已投给这个地点', icon: 'none' })
      }).catch((error) => {
        wx.hideLoading()
        wx.showToast({ title: error.message || '投票失败', icon: 'none' })
      })
      return
    }
    room.votes = room.votes || {}
    room.votes[this.venueId] = hasVoted ? currentVotes.filter((id) => id !== voterId) : currentVotes.concat(voterId)
    updateRoom(room)
    this.loadData()
    wx.showToast({ title: hasVoted ? '已取消投票' : '已投给这个地点', icon: 'none' })
  },
  openNavigation() {
    const venue = this.data.venue
    wx.openLocation({ latitude: venue.latitude, longitude: venue.longitude, name: venue.name, address: venue.address, scale: 17 })
  }
})
