# 检查线上部署版本

[返回 README](README.md) · [VPS 部署与回滚](VPS_DEPLOY.md)

用于确认线上前端和 API（Cloudflare Worker 或 Node）是否已部署到预期提交。请在项目根目录执行，首次使用先运行 `npm ci` 安装依赖。检查只读取版本/健康接口，不发布、不切换后端。

## 检查是否与主干最新提交一致

以下 PowerShell 命令先获取 GitHub 主干最新提交，再核对现有 Demo 的前端和 API；示例地址不代表本文已验证过它们的当前状态：

```powershell
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw '获取主干失败，请检查网络后重试' }

$expectedCommit = git rev-parse --verify FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw '读取主干提交失败' }

npm run release:check -- --frontend https://wind-video.ccwu.cc --api https://api.wind-video.ccwu.cc --commit $expectedCommit
```

部署在其他域名时，替换 `--frontend` 和 `--api` 后的地址。填写站点/API **基址**，不要追加 `/version.json` 或 `/api`；脚本分别请求 `/version.json` 和 `/api/health`。主干仍在更新时，检查结果以本次 `git fetch` 获取的提交为准。

同域部署可以给两个参数传同一个地址。Linux Bash 示例：

```bash
set -euo pipefail
git fetch origin main
EXPECTED_COMMIT=$(git rev-parse --verify FETCH_HEAD)
npm run release:check -- --frontend https://example.com --api https://example.com --commit "$EXPECTED_COMMIT"
```

Node 与 Worker 是二选一运行入口，不是主备。该脚本不会因某个入口失败而自动检查或切换到另一个入口。

## 怎样看结果

| 输出字段                                       | 含义                                   |
| ---------------------------------------------- | -------------------------------------- |
| `passed`                                       | `true` 表示版本与健康检查全部通过      |
| `expectedFrontendCommit` / `expectedApiCommit` | 本次检查预期的前端 / API 提交          |
| `frontendCommit` / `apiCommit`                 | 两个线上服务实际返回的提交             |
| `apiVersion`                                   | Worker 部署版本 UUID 或 Node 构建 UUID |
| `apiRuntime`                                   | `cloudflare-worker` 或 `node`          |
| `failures`                                     | 失败原因列表，通过时为 `[]`            |

两端均匹配预期提交、`passed: true` 且 `failures: []`，表示本次版本检查通过。版本不匹配时，按失败原因核对部署记录；缺少完整提交 tag、健康异常、版本 ID 或时间无效、版本接口不可读也会失败。未识别的 `runtime` 不会通过；兼容旧 Worker 健康接口没有 `runtime` 字段的情况，届时按 `cloudflare-worker` 解释。

兼容输出 `expectedWorkerCommit`、`workerCommit`、`workerVersion` 仍保留，与相应 API 字段同值；`expectedCommit` 保留为前端预期提交。在 Node 上出现这些旧字段/头名称，不代表调用了 Cloudflare。

- 前端 `/version.json` 提供 `commit` 和 `builtAt`；不能被缓存成旧版本、被 SPA fallback 替换，或要求部署登录。
- API `/api/health` 提供 `service: video-parser-api`、`status: ok`、`runtime`、`version`、`versionTag`、`versionCreatedAt`。
- API 响应新增 `X-API-Version`、`X-API-Runtime`，保留 `X-Worker-Version` 兼容头，并提供 `X-Request-ID`。版本脚本核对 JSON 元数据，不代替逐项响应头检查。
- Node 的 UUID、SHA 和 ISO 时间来自 `server/dist/version.json`，**重启不变，重新 build 产生新 UUID**。运行时缺少/非法元数据会启动失败；不能通过现场生成或手改元数据掩盖错配。

此检查不请求上游作品，不验证媒体内容、接口兼容性或手机实际保存。还需执行 [VPS 真实验收步骤](VPS_DEPLOY.md#7-公网健康版本及真实媒体验收) / [样本与真机验收](guides/implementation.md#版本与验收)；不能仅因 `passed: true` 就宣称完成全链路上线。

## 检查指定提交

发布固定版本时，用该版本而不是不断移动的主干。将下方占位内容替换为完整 40 位 SHA：

```powershell
npm run release:check -- --frontend https://example.com --api https://example.com --commit '填写完整Git-SHA'
```

前端和 Node API 分开托管，例如：

```bash
npm run release:check -- --frontend https://www.example.com --api https://api.example.com --commit '填写完整Git-SHA'
```

不传 `--commit` 时，默认对照本地当前提交（HEAD），不会自动获取 GitHub 主干最新版本。在开发分支或本地尚未更新时，明确使用发布记录的提交或上面的主干检查步骤。

## 前后端分别发布时

仅修改前端或文档、接口保持兼容时，可以有意保留原 API 版本。此时分别指定两个预期提交：

```powershell
npm run release:check -- --frontend https://www.example.com --api https://api.example.com --frontend-commit '填写前端完整Git-SHA' --api-commit '填写API完整Git-SHA'
```

两个版本参数必须一起提供，不能与 `--commit` 混用。分别指定版本仍会检查 API 健康、完整提交 tag、版本 UUID 和时间；通过只表示两端符合各自预期，不表示都与主干相同，也不证明两个接口版本兼容。同机部署通常应直接发布/回滚配对的整套 release，而不是有意混用前后端版本。

## 旧参数兼容

`release:check` 的 `--worker`、`--worker-commit` 分别是 `--api`、`--api-commit` 的兼容别名，仍支持原有 Worker 命令；同一别名对可以同时给相同值，值冲突会报错。新文档推荐中立的 API 参数名。

注意：**`release:acceptance` 尚未提供 `--api` 别名**，对 Node 验收仍用 `--worker https://api.example.com`。不要把两个脚本的参数混为一谈。

## 只预览检查目标

在上述检查命令末尾加上 `--dry-run`，可以查看预期提交和请求地址，不请求线上版本接口。此模式不能用于确认部署成功。默认请求期限为 15000 毫秒，可用 `--timeout <毫秒>` 调整（100 至 120000）；网络/部署保护失败时应排查具体阻断，不能用 dry-run 结果代替线上结果。
