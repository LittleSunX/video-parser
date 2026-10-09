import process from 'node:process'
import {
  cli,
  endpoint,
  gitState,
  isMain,
  isCommit,
  isTimestamp,
  isUuid,
  options,
  report,
  requireCommit,
  readJson,
  timeoutValue,
} from './release-utils.mjs'

export function compareVersions(frontend, health, expected) {
  const commit = requireCommit(expected)
  const failures = []
  if (!isCommit(frontend?.commit) || frontend.commit.toLowerCase() !== commit)
    failures.push('前端提交与预期版本不一致')
  if (!isTimestamp(frontend?.builtAt)) failures.push('前端构建时间无效')
  const worker = health?.success === true ? health.data : undefined
  if (worker?.service !== 'video-parser-api' || worker?.status !== 'ok')
    failures.push('Worker 健康接口异常')
  if (!isUuid(worker?.version)) failures.push('Worker 缺少有效版本 ID')
  if (!isCommit(worker?.versionTag)) failures.push('Worker 未标记完整提交版本')
  else if (worker.versionTag.toLowerCase() !== commit) failures.push('Worker 提交与预期版本不一致')
  if (!isTimestamp(worker?.versionCreatedAt)) failures.push('Worker 版本创建时间无效')
  return {
    passed: failures.length === 0,
    expectedCommit: commit,
    frontendCommit: isCommit(frontend?.commit) ? frontend.commit : null,
    workerVersion: isUuid(worker?.version) ? worker.version : null,
    workerCommit: isCommit(worker?.versionTag) ? worker.versionTag : null,
    failures,
  }
}

export async function checkRelease(
  { frontend, worker, commit, timeout = 15000, dryRun = false },
  fetchFn = globalThis.fetch,
) {
  const urls = [endpoint(frontend, 'version.json'), endpoint(worker, 'api/health')]
  const expectedCommit = requireCommit(commit)
  if (dryRun) return { mode: '仅预览请求，未联网', expectedCommit, requests: urls }
  let bodies
  const controller = new globalThis.AbortController()
  const signal = globalThis.AbortSignal.any([
    controller.signal,
    globalThis.AbortSignal.timeout(timeout),
  ])
  try {
    bodies = await Promise.all(
      urls.map(async (url) => {
        const response = await fetchFn(url, {
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          signal,
          redirect: 'error',
          cache: 'no-store',
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new Error()
        }
        return readJson(response, { signal, maxBytes: 16 * 1024 })
      }),
    )
  } catch {
    throw new Error('版本接口请求失败，请检查服务地址、部署保护或网络')
  } finally {
    controller.abort()
  }
  return compareVersions(bodies[0], bodies[1], expectedCommit)
}

export async function main(args = process.argv.slice(2)) {
  const flags = options(args, {
    help: 'boolean',
    frontend: 'string',
    worker: 'string',
    commit: 'string',
    timeout: 'string',
    'dry-run': 'boolean',
  })
  if (flags.help) {
    process.stdout.write(
      '用法：npm run release:check -- --frontend <前端地址> --worker <Worker地址> [--commit <完整SHA>] [--timeout <毫秒>] [--dry-run]\n默认对照当前 Git 提交；未打版本 tag 或错配时返回失败。\n',
    )
    return
  }
  if (!flags.frontend || !flags.worker) throw new Error('请显式指定前端和 Worker 服务地址')
  const result = await checkRelease({
    ...flags,
    timeout: timeoutValue(flags.timeout, 15000),
    commit: flags.commit ?? gitState().commit,
    dryRun: flags['dry-run'],
  })
  report(result)
  if (result.passed === false) process.exitCode = 1
}

if (isMain(import.meta.url)) await cli(() => main())
