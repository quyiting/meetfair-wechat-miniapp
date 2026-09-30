App({
  globalData: {
    brandName: '聚点',
    cloudReady: false
  },
  onLaunch() {
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#1f5eff'
    })
    if (wx.cloud) {
      try {
        wx.cloud.init({
          env: 'cloud1-d9ge1xz9814ebfbdb'
        })
        this.globalData.cloudReady = true
      } catch (err) {
        // 云开发不可用时不影响本地功能，聚会码会自动回退为本地长码
        console.warn('云开发初始化失败:', err)
      }
    }
  }
})
