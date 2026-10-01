const { createRoom, cloudCreateRoom } = require('../../utils/store')
const { getNearbyVenues, getRouteMatrix, getSearchSource } = require('../../utils/venue-service')
const { candidateOrigins, routeCandidates } = require('../../utils/recommend')
const { prepareMemberLocation } = require('../../utils/privacy')

const categories = [
  { id: 'food', icon: '🍜', label: '吃饭' },
  { id: 'cinema', icon: '🎬', label: '看电影' },
  { id: 'coffee', icon: '☕', label: '喝咖啡' },
  { id: 'fun', icon: '🎲', label: '玩一玩' }
]

const memberColors = ['#3675ff', '#fa6e52', '#8d6bff', '#20b891', '#e19a35', '#e85b98', '#4895d8', '#74829d']
const budgets = [
  { value: 0, label: '不限' },
  { value: 50, label: '¥50' },
  { value: 100, label: '¥100' },
  { value: 150, label: '¥150' },
  { value: 200, label: '¥200+' }
]

function todayText() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function makeMember(index, name) {
  return {
    id: `local-member-${Date.now()}-${index}`,
    name: name || `朋友 ${index + 1}`,
    shortName: name ? name.slice(0, 1) : '友',
    color: memberColors[index % memberColors.length],
    latitude: null,
    longitude: null,
    locationName: '',
    transport: 'transit',
    budget: 100,
    approximate: false
  }
}

Page({
  data: {
    title: '周末一起见个面',
    categories,
    budgets,
    activeCategory: 'food',
    preferenceText: '',
    meetingDate: todayText(),
    meetingTime: '18:30',
    minDate: todayText(),
    retentionOptions: [
      { hours: 1, label: '1 小时' },
      { hours: 24, label: '1 天' },
      { hours: 168, label: '7 天' },
      { hours: 720, label: '30 天' }
    ],
    retentionIndex: 3,
    searchSource: getSearchSource(),
    members: [makeMember(0, '你')],
    creating: false
  },
  setTitle(event) {
    this.setData({ title: event.detail.value })
  },
  selectCategory(event) {
    this.setData({ activeCategory: event.currentTarget.dataset.id })
  },
  setPreferenceText(event) {
    this.setData({ preferenceText: event.detail.value.slice(0, 60) })
  },
  selectMeetingDate(event) {
    this.setData({ meetingDate: event.detail.value })
  },
  selectMeetingTime(event) {
    this.setData({ meetingTime: event.detail.value })
  },
  selectRetention(event) {
    this.setData({ retentionIndex: Number(event.detail.value) })
  },
  updateMember(index, changes) {
    const members = this.data.members.map((member, memberIndex) => memberIndex === index ? Object.assign({}, member, changes) : member)
    this.setData({ members })
  },
  updateMemberName(event) {
    const index = Number(event.currentTarget.dataset.index)
    const name = event.detail.value.slice(0, 8)
    this.updateMember(index, { name, shortName: name ? name.slice(0, 1) : '友' })
  },
  selectMemberTransport(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateMember(index, { transport: event.currentTarget.dataset.transport })
  },
  selectMemberBudget(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateMember(index, { budget: Number(event.currentTarget.dataset.budget) })
  },
  toggleMemberApproximate(event) {
    this.updateMember(Number(event.currentTarget.dataset.index), { approximate: event.detail.value })
  },
  chooseMemberLocation(event) {
    const index = Number(event.currentTarget.dataset.index)
    wx.chooseLocation({
      success: (result) => {
        this.updateMember(index, {
          latitude: result.latitude,
          longitude: result.longitude,
          locationName: result.name || result.address || '已选择位置'
        })
      },
      fail: () => wx.showToast({ title: '未选择位置', icon: 'none' })
    })
  },
  locateMe() {
    wx.showLoading({ title: '正在获取位置' })
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      success: (result) => {
        wx.hideLoading()
        this.updateMember(0, {
          latitude: result.latitude,
          longitude: result.longitude,
          locationName: `当前位置 · ${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`
        })
        wx.showToast({ title: '已更新我的位置', icon: 'success' })
      },
      fail: () => {
        wx.hideLoading()
        wx.showModal({ title: '无法获取位置', content: '请允许位置权限，或手动在地图选点。', showCancel: false })
      }
    })
  },
  addMember() {
    const members = this.data.members
    if (members.length >= 8) {
      wx.showToast({ title: '最多添加 8 人', icon: 'none' })
      return
    }
    this.setData({ members: members.concat(makeMember(members.length)) })
  },
  removeMember(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (index === 0) return
    this.setData({ members: this.data.members.filter((member, memberIndex) => memberIndex !== index) })
  },
  createRoom() {
    if (this.data.creating) return
    const title = this.data.title.trim()
    const members = this.data.members.map((member, index) => prepareMemberLocation(Object.assign({}, member, {
      id: member.id || `local-member-${Date.now()}-${index}`,
      name: member.name.trim() || (index === 0 ? '你' : `朋友 ${index + 1}`),
      shortName: (member.name.trim() || (index === 0 ? '你' : '友')).slice(0, 1)
    })))
    if (!title) {
      wx.showToast({ title: '给这次聚会起个名字吧', icon: 'none' })
      return
    }
    if (members.length < 2) {
      wx.showToast({ title: '至少添加 1 位朋友', icon: 'none' })
      return
    }
    const memberWithoutLocation = members.find((member) => !Number.isFinite(member.latitude) || !Number.isFinite(member.longitude))
    if (memberWithoutLocation) {
      wx.showToast({ title: `请先设置「${memberWithoutLocation.name}」的位置`, icon: 'none' })
      return
    }
    const searchOrigins = candidateOrigins(members)
    this.setData({ creating: true })
    wx.showLoading({ title: '正在搜索附近地点' })
    getNearbyVenues(searchOrigins, this.data.activeCategory, this.data.meetingDate, this.data.meetingTime).then((searchResult) => {
      const room = {
        id: `room-${Date.now()}`,
        title,
        category: this.data.activeCategory,
        preferenceText: this.data.preferenceText.trim(),
        transport: 'mixed',
        dateText: `${this.data.meetingDate} ${this.data.meetingTime}`,
        meetingDate: this.data.meetingDate,
        meetingTime: this.data.meetingTime,
        retentionHours: this.data.retentionOptions[this.data.retentionIndex].hours,
        expiresAt: Date.now() + this.data.retentionOptions[this.data.retentionIndex].hours * 3600000,
        members,
        currentMemberId: members[0].id,
        currentUserIsOwner: true,
        venues: searchResult.venues,
        venueSource: searchResult.source,
        votes: {},
        memberRevision: 0,
        venueMemberRevision: 0,
        createdAt: Date.now()
      }
      return getRouteMatrix(members, routeCandidates(room), room.meetingDate, room.meetingTime).then((routeResult) => {
        room.routeMatrix = routeResult.routeMatrix || {}
        createRoom(room)
        return cloudCreateRoom(room)
      }).then((savedRoom) => {
        wx.hideLoading()
        if (savedRoom && savedRoom.cloudId) {
          console.log('房间已同步到云，短码:', savedRoom.cloudId)
        } else {
          console.warn('云同步失败，使用本地模式')
        }
        wx.redirectTo({ url: `/pages/room/room?id=${room.id}` })
      }).catch((err) => {
        console.error('云同步异常:', err)
        wx.hideLoading()
        wx.redirectTo({ url: `/pages/room/room?id=${room.id}` })
      })
    }).catch((error) => {
      wx.hideLoading()
      this.setData({ creating: false })
      wx.showToast({ title: error.message || '地点搜索失败，请重试', icon: 'none', duration: 3000 })
    })
  }
})
