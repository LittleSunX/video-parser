// 利用用户粘贴文案前的时间建立 API 连接；不提前提交解析请求。
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL
if (apiBaseUrl) {
  try {
    const apiOrigin = new URL(apiBaseUrl, window.location.href)
    if (apiOrigin.protocol === 'https:' && apiOrigin.origin !== window.location.origin) {
      const connection = document.createElement('link')
      connection.rel = 'preconnect'
      connection.href = apiOrigin.origin
      connection.crossOrigin = 'anonymous'
      document.head.appendChild(connection)
    }
  } catch {
    // 无效配置仍由实际 API 调用报告，连接提示不能阻止页面打开。
  }
}

// 入口不静态导入应用样式，让资源未到时仍能显示 HTML 中的启动反馈。
void import('./application')
  .then(({ mountApplication }) => {
    mountApplication()
    window.dispatchEvent(new CustomEvent('video-parser:startup', { detail: 'ready' }))
  })
  .catch((error: unknown) => {
    console.error('应用启动失败', error)
    window.dispatchEvent(new CustomEvent('video-parser:startup', { detail: 'failed' }))
  })
