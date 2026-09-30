const { getRooms, getRoom, createRoom, decodeRoom, cloudGetRoom } = require('../../utils/store')
const { CATEGORY_LABELS, TRANSPORT_LABELS } = require('../../utils/constants')

// 6 位短码（云端聚会码）；更短的才可能是本地长码，用长度即可区分
const SHORT_CODE_PATTERN = /^[23456789ABCDEFGHKMNPQRSTUVWXYZ]{6}$/

Page({
  data: {
    rooms: [],
    showJoinCodeModal: false,
    joinCode: '',
    joining: false
  },
  onShow() {
    const rooms = getRooms().map((room) => Object.assign({}, room, {
      categoryLabel: CATEGORY_LABELS[room.category],
      transportLabel: TRANSPORT_LABELS[room.transport],
      memberCount: room.preview ? room.memberCount : room.members.length
    }))
    this.setData({ rooms })
  },
  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' })
  },
  openRoom(event) {
    wx.navigateTo({ url: `/pages/room/room?id=${event.currentTarget.dataset.id}` })
  },
  openJoinCodeModal() {
    this.setData({ showJoinCodeModal: true, joinCode: '', joining: false })
  },
  closeJoinCodeModal() {
    this.setData({ showJoinCodeModal: false, joinCode: '', joining: false })
  },
  noop() {},
  setJoinCode(event) {
    this.setData({ joinCode: event.detail.value })
  },
  pasteJoinCode() {
    wx.getClipboardData({
      success: (result) => {
        const text = (result.data || '').trim()
        if (!text) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
          return
        }
        this.setData({ joinCode: text })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },
  async submitJoinCode() {
    if (this.data.joining) return
    const raw = this.data.joinCode.trim()
    if (!raw) {
      wx.showToast({ title: '请输入聚会码', icon: 'none' })
      return
    }
    this.setData({ joining: true })
    let room = null
    if (SHORT_CODE_PATTERN.test(raw.toUpperCase())) {
      wx.showLoading({ title: '正在查找聚会' })
      room = await cloudGetRoom(raw)
      wx.hideLoading()
      if (!room) {
        this.setData({ joining: false })
        wx.showToast({ title: '聚会码不存在，请检查后重试', icon: 'none' })
        return
      }
    } else {
      // 兼容早期分享出去的本地长码
      room = decodeRoom(raw.toLowerCase())
      if (!room) {
        this.setData({ joining: false })
        wx.showToast({ title: '聚会码无效，请确认已完整复制', icon: 'none' })
        return
      }
    }
    if (getRoom(room.id)) {
      const { updateRoom } = require('../../utils/store')
      updateRoom(room)
    } else {
      createRoom(room)
    }
    this.setData({ joining: false })
    this.closeJoinCodeModal()
    wx.showToast({ title: '已找到聚会', icon: 'success' })
    wx.navigateTo({ url: `/pages/room/room?id=${room.id}` })
  },
  onShareAppMessage() {
    return {
      title: '聚点：一起找个大家都顺路的地方吧',
      path: '/pages/index/index'
    }
  }
})
