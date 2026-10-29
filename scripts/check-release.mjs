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

export function compareVersions(frontend, health, expected, expectedWorker = expected) {
  const commit = requireCommit(expected)
  const workerCommit = requireCommit(expectedWorker)
  const failures = []
  if (!isCommit(frontend?.commit) || frontend.commit.toLowerCase() !== commit)
    failures.push('前端提交与预期版本不一致')
  if (!isTimestamp(frontend?.builtAt)) failures.push('前端构建时间无效')
  const worker = health?.success === true ? health.data : undefined
  const service = worker?.runtime === 'node' ? 'Node' : 'Worker'
  if (worker?.runtime !== undefined && !['cloudflare-worker', 'node'].includes(worker.runtime))
    failures.push('API 运行时无效')
  if (worker?.service !== 'video-parser-api' || worker?.status !== 'ok')
    failures.push(`${service} 健康接口异常`)
  if (!isUuid(worker?.version)) failures.push(`${service} 缺少有效版本 ID`)
  if (!isCommit(worker?.versionTag)) failures.push(`${service} 未标记完整提交版本`)
  else if (worker.versionTag.toLowerCase() !== workerCommit)
    failures.push(`${service} 提交与预期版本不一致`)
  if (!isTimestamp(worker?.versionCreatedAt)) failures.push(`${service} 版本创建时间无效`)
  return {
    passed: failures.length === 0,
    expectedCommit: commit,
    expectedFrontendCommit: commit,
    expectedWorkerCommit: workerCommit,
    expectedApiCommit: workerCommit,
    frontendCommit: isCommit(frontend?.commit) ? frontend.commit : null,
    workerVersion: isUuid(worker?.version) ? worker.version : null,
    workerCommit: isCommit(worker?.versionTag) ? worker.versionTag : null,
    apiVersion: isUuid(worker?.version) ? worker.version : null,
    apiCommit: isCommit(worker?.versionTag) ? worker.versionTag : null,
    apiRuntime: worker?.runtime === undefined ? 'cloudflare-worker' : worker.runtime,
    failures,
  }
}

function aliasedOption(value, legacy, name, legacyName) {
  if (value !== undefined && legacy !== undefined && value !== legacy)
    throw new Error(`--${name} 与 --${legacyName} 参数值冲突`)
  return value === undefined ? legacy : value
}

export async function checkRelease(
  {
    frontend,
    worker,
    api,
    commit,
    frontendCommit = commit,
    workerCommit,
    apiCommit,
    timeout = 15000,
    dryRun = false,
  },
  fetchFn = globalThis.fetch,
) {
  const apiBase = aliasedOption(api, worker, 'api', 'worker')
  const apiExpected = aliasedOption(apiCommit, workerCommit, 'api-commit', 'worker-commit')
  const urls = [endpoint(frontend, 'version.json'), endpoint(apiBase, 'api/health')]
  const expectedCommit = requireCommit(frontendCommit)
  const expectedWorkerCommit = requireCommit(apiExpected === undefined ? commit : apiExpected)
  if (dryRun)
    return {
      mode: '仅预览请求，未联网',
      expectedCommit,
      expectedFrontendCommit: expectedCommit,
      expectedWorkerCommit,
      expectedApiCommit: expectedWorkerCommit,
      requests: urls,
    }
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
  return compareVersions(bodies[0], bodies[1], expectedCommit, expectedWorkerCommit)
}

export async function main(args = process.argv.slice(2)) {
  const flags = options(args, {
    help: 'boolean',
    frontend: 'string',
    worker: 'string',
    api: 'string',
    commit: 'string',
    'frontend-commit': 'string',
    'worker-commit': 'string',
    'api-commit': 'string',
    timeout: 'string',
    'dry-run': 'boolean',
  })
  if (flags.help) {
    process.stdout.write(
      '用法：npm run release:check -- --frontend <前端地址> --api <API地址> [--commit <完整SHA> | --frontend-commit <完整SHA> --api-commit <完整SHA>] [--timeout <毫秒>] [--dry-run]\n支持 Cloudflare Worker 和 Node；--worker、--worker-commit 分别作为 --api、--api-commit 的兼容别名，同值可共用，冲突值报错。\n默认两个服务均对照当前 Git 提交；分别指定时必须同时提供两个预期版本，未打版本 tag 或错配仍返回失败。\n',
    )
    return
  }
  const api = aliasedOption(flags.api, flags.worker, 'api', 'worker')
  const apiCommit = aliasedOption(
    flags['api-commit'],
    flags['worker-commit'],
    'api-commit',
    'worker-commit',
  )
  if (!flags.frontend || !api) throw new Error('请显式指定前端和 API 服务地址（--api 或 --worker）')
  const separate = flags['frontend-commit'] !== undefined || apiCommit !== undefined
  if (separate && (flags.commit || !flags['frontend-commit'] || !apiCommit))
    throw new Error(
      '分别校验时请同时指定 frontend-commit 和 api-commit（或 worker-commit），且不能混用 commit',
    )
  const result = await checkRelease({
    ...flags,
    timeout: timeoutValue(flags.timeout, 15000),
    commit: separate ? undefined : (flags.commit ?? gitState().commit),
    frontendCommit: flags['frontend-commit'],
    workerCommit: flags['worker-commit'],
    apiCommit: flags['api-commit'],
    dryRun: flags['dry-run'],
  })
  report(result)
  if (result.passed === false) process.exitCode = 1
}

if (isMain(import.meta.url)) await cli(() => main())
