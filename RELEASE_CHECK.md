# 检查线上部署版本

[返回 README](README.md)

用于确认线上前端和 Worker 是否已部署到预期提交。请在项目根目录执行，首次使用先运行 `npm ci` 安装依赖。

## 检查是否与主干最新提交一致

以下 PowerShell 命令先获取 GitHub 主干最新提交，再核对当前在线网站和 Worker：

```powershell
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw '获取主干失败，请检查网络后重试' }

$expectedCommit = git rev-parse --verify FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw '读取主干提交失败' }

npm run release:check -- --frontend https://wind-video.ccwu.cc --worker https://api.wind-video.ccwu.cc --commit $expectedCommit
```

部署在其他域名时，替换 `--frontend` 和 `--worker` 后的地址。主干仍在更新时，检查结果以本次 `git fetch` 获取的提交为准。

## 怎样看结果

| 输出字段                                          | 含义                              |
| ------------------------------------------------- | --------------------------------- |
| `passed`                                          | `true` 表示版本与健康检查全部通过 |
| `expectedFrontendCommit` / `expectedWorkerCommit` | 本次检查预期的前端 / Worker 提交  |
| `frontendCommit` / `workerCommit`                 | 两个线上服务实际返回的提交        |
| `workerVersion`                                   | Cloudflare 部署版本 ID            |
| `failures`                                        | 失败原因列表，通过时为 `[]`       |

两端均匹配主干最新提交、`passed: true` 且 `failures: []`，表示已同步发布。版本不匹配时，按失败原因核对对应服务的部署记录；缺少提交 tag、Worker 健康异常、版本 ID 或时间无效、版本接口不可读，也会导致检查失败。

此检查确认部署版本和服务健康；视频、图片及音乐能否在手机上实际保存，仍需单独验证。

## 检查指定提交

如果要核对某次合并或发布，将下方占位内容替换为该提交的完整 40 位 SHA：

```powershell
npm run release:check -- --frontend https://wind-video.ccwu.cc --worker https://api.wind-video.ccwu.cc --commit '填写完整Git-SHA'
```

不传 `--commit` 时，默认对照本地当前提交（HEAD），不会自动获取 GitHub 主干最新版本。在开发分支或本地尚未更新时，建议使用上面的主干检查步骤。

## 前后端分别发布时

仅修改前端或文档、接口保持兼容时，可以有意保留原 Worker 版本。此时分别指定两个预期提交：

```powershell
npm run release:check -- --frontend https://wind-video.ccwu.cc --worker https://api.wind-video.ccwu.cc --frontend-commit '填写前端完整Git-SHA' --worker-commit '填写Worker完整Git-SHA'
```

两个版本参数必须一起提供，不能与 `--commit` 混用。分别指定版本仍会检查 Worker 健康、完整提交 tag、部署版本 ID 和时间；通过只表示两端符合各自预期，不表示它们都与主干最新提交相同。输出中的 `expectedCommit` 保留为前端预期提交，以兼容原有使用方式。

## 只预览检查目标

在上述检查命令末尾加上 `--dry-run`，可以查看预期提交和请求地址，不请求线上版本接口。此模式不能用于确认部署成功。
