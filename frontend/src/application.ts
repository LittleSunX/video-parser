import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

/** 挂载期间的组件错误也必须结束启动等待，挂载后恢复 Vue 原有错误处理。 */
export function mountApplication() {
  const app = createApp(App)
  const originalHandler = app.config.errorHandler
  let failed = false
  app.config.errorHandler = (...args) => {
    failed = true
    originalHandler?.(...args)
  }
  try {
    app.mount('#app')
    if (failed) throw new Error('应用启动失败')
  } catch (error) {
    try {
      app.unmount()
    } catch {
      // 清理失败不能掩盖启动错误，静态反馈仍需保留。
    }
    document.getElementById('app')?.replaceChildren()
    throw error
  } finally {
    app.config.errorHandler = originalHandler
  }
}
