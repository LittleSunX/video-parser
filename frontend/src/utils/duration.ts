/** API 时长统一使用毫秒。 */
export function formatDuration(duration?: number): string {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return ''
  const totalSeconds = Math.round(duration / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
}
