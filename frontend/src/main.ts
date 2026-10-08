import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

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

createApp(App).mount('#app')
