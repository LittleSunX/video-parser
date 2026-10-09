import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export function isCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
}

export function isUuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
}

export function isTimestamp(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  // Cloudflare 版本时间可带微秒；Date 只保留毫秒，用相同精度检查日期与时钟范围。
  return (
    new Date(value).toISOString() ===
    match[1] + '.' + (match[2] ?? '').slice(0, 3).padEnd(3, '0') + 'Z'
  )
}

export function requireCommit(value) {
  if (!isCommit(value)) throw new Error('提交版本必须是完整的 40 位 Git SHA')
  return value.toLowerCase()
}

export function gitState() {
  try {
    return {
      commit: requireCommit(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ),
      dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    }
  } catch {
    throw new Error('无法读取当前 Git 提交或工作区状态')
  }
}

export function endpoint(base, path) {
  let url
  try {
    url = new URL(base)
  } catch {
    throw new Error('服务地址必须是有效的 HTTP 或 HTTPS 地址')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('服务地址不能包含凭据、查询参数或片段')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL(path, url).href
}

export function timeoutValue(value, fallback = 45000) {
  const timeout = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000)
    throw new Error('超时必须是 100 至 120000 之间的毫秒数')
  return timeout
}

export function options(args, schema) {
  const values = {}
  for (let index = 0; index < args.length; index++) {
    const [flag, ...parts] = args[index].split('=')
    const name = flag.slice(2)
    if (!flag.startsWith('--') || !Object.hasOwn(schema, name)) throw new Error('存在未知命令参数')
    if (Object.hasOwn(values, name)) throw new Error('同一命令参数不能重复指定')
    if (schema[name] === 'boolean') {
      if (parts.length) throw new Error('开关参数不能带值')
      values[name] = true
    } else {
      const value = parts.length ? parts.join('=') : args[++index]
      if (!value || value.startsWith('--')) throw new Error('命令参数缺少值')
      values[name] = value
    }
  }
  return values
}

export function isMain(url) {
  if (!process.argv[1]) return false
  const current = resolve(process.argv[1])
  const target = fileURLToPath(url)
  return process.platform === 'win32'
    ? current.toLowerCase() === target.toLowerCase()
    : current === target
}

export function withSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => {})
    throw signal.reason
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function readJson(response, { signal, maxBytes = 1024 * 1024 } = {}) {
  let reader
  try {
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? ''))
      throw new Error('JSON 响应类型无效')
    const length = response.headers.get('Content-Length')
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes)
      throw new Error('JSON 响应超过字节上限')
    if (!response.body) throw new Error('JSON 响应为空')
    reader = response.body.getReader()
    const decoder = new globalThis.TextDecoder('utf-8', { fatal: true })
    let body = ''
    let bytes = 0
    while (true) {
      const chunk = await withSignal(reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('JSON 响应超过字节上限')
      body += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } catch (error) {
    if (error instanceof Error && /^JSON 响应/.test(error.message)) throw error
    throw new Error('JSON 响应读取失败、无效或超时', { cause: error })
  } finally {
    // 不等待远端清理；停滞的 cancel 不能突破请求期限。
    if (reader) void reader.cancel().catch(() => {})
    else if (response.body) void response.body.cancel().catch(() => {})
  }
}

export function report(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

export async function cli(action) {
  try {
    await action()
  } catch (error) {
    process.stderr.write('失败：' + (error instanceof Error ? error.message : '运行异常') + '\n')
    process.exitCode = 1
  }
}
