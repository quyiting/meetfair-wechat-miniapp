function getSearchSource() {
  return {
    ready: true,
    provider: 'cloud',
    title: '真实搜索已开启',
    detail: '地点搜索通过云函数完成，地图密钥不会进入小程序包。'
  }
}

function getNearbyVenues(origin, category, meetingDate, meetingTime) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.callFunction) {
      reject(new Error('云开发不可用，无法搜索附近地点'))
      return
    }
    wx.cloud.callFunction({
      name: 'venueService',
      data: { origin, category: category || 'all', meetingDate, meetingTime },
      success: (response) => {
        const result = response.result || {}
        if (!result.ok) {
          reject(new Error(result.message || '地点搜索失败'))
          return
        }
        resolve({ venues: result.venues || [], source: result.source || null })
      },
      fail: (error) => reject(new Error((error && error.errMsg) || '地点搜索云函数调用失败'))
    })
  })
}

function getRouteMatrix(members, venues, meetingDate, meetingTime) {
  return new Promise((resolve) => {
    if (!wx.cloud || !wx.cloud.callFunction || !venues.length) {
      resolve({ available: false, routeMatrix: {} })
      return
    }
    wx.cloud.callFunction({
      name: 'venueService',
      data: { action: 'routes', members, venues, meetingDate, meetingTime },
      success: (response) => {
        const result = response.result || {}
        resolve(result.ok ? result : { available: false, routeMatrix: {} })
      },
      fail: () => resolve({ available: false, routeMatrix: {} })
    })
  })
}

module.exports = { getNearbyVenues, getRouteMatrix, getSearchSource }
