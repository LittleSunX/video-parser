import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  cli,
  gitState,
  isMain,
  options,
  report,
  repositoryRoot,
  requireCommit,
} from './release-utils.mjs'

// --tag 与 --dry-run：https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
export function releasePlan(state, { deploy = false, dryRun = false } = {}) {
  const commit = requireCommit(state.commit)
  if (typeof state.dirty !== 'boolean') throw new Error('无法确认 Git 工作区是否已提交')
  if (deploy && dryRun) throw new Error('不能同时指定发布和本地打包')
  if (deploy && state.dirty) throw new Error('发布前请提交工作区改动，避免提交版本与发布内容不一致')
  return {
    mode: deploy ? '发布' : dryRun ? '本地打包' : '仅预览命令',
    commit,
    dirty: state.dirty,
    args: ['deploy', '--tag', commit, ...(dryRun ? ['--dry-run', '--outdir', 'dist'] : [])],
  }
}

export async function main(args = process.argv.slice(2)) {
  const flags = options(args, { help: 'boolean', deploy: 'boolean', 'dry-run': 'boolean' })
  if (flags.help) {
    process.stdout.write(
      '用法：npm run release:worker -- [--dry-run | --deploy]\n' +
        '默认只预览命令；--dry-run 本地打包；--deploy 用当前 Wrangler 登录或环境凭据发布。\n' +
        '发布使用完整当前提交作为版本 tag，且要求工作区已提交。\n',
    )
    return
  }
  const plan = releasePlan(gitState(), { deploy: flags.deploy, dryRun: flags['dry-run'] })
  report({ ...plan, command: 'wrangler ' + plan.args.join(' ') })
  if (!flags.deploy && !flags['dry-run']) return
  const require = createRequire(import.meta.url)
  let binary
  try {
    binary = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
  } catch {
    throw new Error('未找到项目安装的 Wrangler，请先运行 npm ci')
  }
  // 直接调用项目依赖，禁止自动下载 CLI 或创建新账户；身份由 Wrangler 继承。
  const child = spawnSync(process.execPath, [binary, ...plan.args], {
    cwd: join(repositoryRoot, 'worker'),
    stdio: 'inherit',
    env: {
      ...process.env,
      // 日志留在已忽略的工作区目录，兼容受限 Windows 环境。
      WRANGLER_LOG_PATH: join(repositoryRoot, 'worker', '.wrangler', 'release-logs'),
      WRANGLER_LOG_SANITIZE: 'true',
      ...(flags['dry-run'] ? { WRANGLER_SEND_METRICS: 'false' } : {}),
    },
  })
  if (child.error || child.status !== 0) throw new Error('Wrangler 执行失败，请检查其诊断输出')
}

if (isMain(import.meta.url)) await cli(() => main())
