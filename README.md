<div align="center">

# Video Parser

粘贴抖音分享链接，在浏览器中保存视频、图集、实况动态与背景音乐。

[在线体验](https://wind-video.ccwu.cc/) · [快速开始](#本地运行) · [部署指南](#部署) · [问题反馈](https://github.com/LittleSunX/video-parser/issues)

[![Quality checks](https://github.com/LittleSunX/video-parser/actions/workflows/check.yml/badge.svg)](https://github.com/LittleSunX/video-parser/actions/workflows/check.yml)
![Vue 3](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

</div>

## 简介

Video Parser 是一个支持自行部署的网页下载工具。前端使用 Vue 3，后端可选择 Cloudflare Workers 或独立 Node 服务，两者共用解析和下载逻辑。

**目前支持抖音公开作品。** 可粘贴单独链接或完整分享文案；页面提供静态预览，方便确认内容后保存。

| 内容       | 支持能力                                               |
| ---------- | ------------------------------------------------------ |
| 视频       | 选择较高画质的视频流，保存视频与封面                   |
| 图文       | 大图、缩略图和总览查看，单张保存或 ZIP 批量下载        |
| Live Photo | 分别保存静态图片和 MP4 动态轨，批量下载可选动态优先    |
| 背景音乐   | 上游提供资源时，可单独保存                             |
| 下载操作   | 进度、取消、失败重试与再次保存，保留直链和备用下载入口 |

图片是否无水印、音乐与实况是否可用，取决于上游实际返回的资源。Live Photo 保存为图片或 MP4，不会自动组合成手机相册中的实况照片。

**下载默认优先直连抖音媒体 CDN**，直连成功时文件不经过本项目的 API。直连异常按资源类型回退到备用下载；已知超过 128 MiB 的普通视频会直接使用 API 流式代理，手动选择“备用下载”也会经过 API。普通视频与单个实况 MP4 的页面缓冲上限为 128 MiB，图片、封面和音乐仍为 64 MiB；这些是浏览器缓冲门槛，不是 API 流式下载的视频大小上限。具体规则见 [下载策略](guides/implementation.md#下载策略)。

## 使用

1. 在抖音中复制作品分享链接或分享文案。
2. 打开 [在线体验](https://wind-video.ccwu.cc/)，粘贴后开始解析。
3. 确认预览内容，选择视频、图片、动态轨或音乐进行保存。

批量下载会生成 ZIP，每包媒体内容最多 32 MiB；较大的作品按页面提示逐包保存。浏览器接管下载后，请到下载列表确认结果。

<a id="quick-start"></a>

## 本地运行

需要 Git、npm，以及 **Node.js 22.13.0 及以上的 22.x，或 24 及以上版本**，具体范围见 [package.json](package.json)。仓库的 [.nvmrc](.nvmrc) 使用 Node 22。

### 1. 安装依赖

```bash
git clone https://github.com/LittleSunX/video-parser.git
cd video-parser
npm ci
```

### 2. 启动 API

本地可直接使用 Node，无需配置 Cloudflare 账号：

```bash
npm run dev:server
```

API 默认监听 `http://127.0.0.1:8787`，可通过 [/api/health](http://127.0.0.1:8787/api/health) 检查。该命令先构建再启动，修改后端代码后需要重启。

<details>
<summary>使用 Cloudflare Worker 开发入口</summary>

如果需要调试 Worker 环境，改用：

```bash
npm run dev:worker
```

两个后端入口默认都使用 8787 端口，选择一个启动即可。

</details>

### 3. 启动前端

另开终端，进入同一仓库目录：

```bash
npm run dev:frontend
```

打开终端显示的地址，默认是 [http://localhost:5173](http://localhost:5173)。Vite 会将 `/api` 请求转发到本地 8787 端口，默认无需配置环境变量。

<a id="deployment"></a>

## 部署

首次部署推荐从方式一开始：前端和 API 都由平台托管，无需购买或维护 VPS。其他两种方式按需选择，分别有完整教程。

三种方案均保留上述优先直连策略。API 部署在 Worker 还是 Node，决定解析和代理下载由谁处理；前端托管位置不会让所有媒体下载都经过该服务器。

### 方式一：无需维护服务器（推荐）

**Vercel 托管前端，Cloudflare Worker 运行 API。** 准备好 GitHub、Vercel 和 Cloudflare 账号后，按“准备代码 → 发布 API → 发布前端 → 验证”的顺序操作，可以先使用平台提供的域名。

**[开始部署：Vercel + Cloudflare Worker →](guides/deployment.md#方式一无需维护服务器推荐)**

### 方式二：前端和 API 全部部署到 VPS

适合已有 VPS、希望自行管理服务的用户。Nginx 提供网页和 HTTPS，Node 运行 API，需要自行维护服务器、证书和服务进程。

**[开始部署：Nginx + Node →](VPS_DEPLOY.md)**

### 方式三：Cloudflare Worker 后端与 VPS 前端

解析和备用下载运行在 Cloudflare Worker，网页由 VPS 上的 Nginx 提供。教程从首次部署 Worker 开始；已有可用 Worker、仅迁移前端时可跳过后端发布。

**[开始部署：CF 后端 + VPS 前端 →](guides/frontend-only.md)**

Cloudflare Pages、前后端分开托管等选择放在 [其他部署组合](guides/deployment.md#其他部署组合)，环境变量、排错和 Cloudflare 代理说明放在部署指南末尾。

## 文档

| 文档                                          | 内容                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| [部署指南](guides/deployment.md)              | Worker、Vercel、Pages、静态 VPS、Cloudflare 代理及环境变量         |
| [VPS 部署](VPS_DEPLOY.md)                     | Node、Nginx、HTTPS、systemd、更新与回滚                            |
| [CF 后端 + VPS 前端](guides/frontend-only.md) | 首次部署 Worker、构建上传前端、Nginx / HTTPS；兼顾仅迁移前端与回滚 |
| [API 说明](guides/api.md)                     | 解析、渐进结果、下载、健康检查与限流                               |
| [实现与开发说明](guides/implementation.md)    | 解析策略、资源合并、下载与 ZIP 分包、诊断和验收                    |
| [部署版本检查](RELEASE_CHECK.md)              | 检查线上版本、分别指定前后端提交                                   |

## 开发

在仓库根目录执行完整检查：

```bash
npm run check
```

该命令包含格式检查、ESLint、测试、类型检查和构建。常用命令：

| 命令                   | 用途                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm test`             | 运行测试                                                                  |
| `npm run format`       | 格式化代码和文档                                                          |
| `npm run build`        | 构建前端、检查共用核心和 Worker 类型、构建 Node 服务                      |
| `npm run check:worker` | 检查 Worker 打包边界并执行 Wrangler dry-run                               |
| `npm run check:nginx`  | 在 Linux 上验证真实 Nginx 与 Node 部署链路，需先构建并安装 Nginx、OpenSSL |

```text
video-parser/
├── frontend/   # Vue 页面、解析状态与下载交互
├── backend/    # 共用解析器、HTTP 业务与媒体代理
├── worker/     # Cloudflare Workers 入口
├── server/     # Node HTTP 入口与独立构建
├── shared/     # 前后端共用类型与工具
├── deploy/     # Nginx、systemd 与环境变量模板
├── scripts/    # 构建、发布与验收工具
├── tests/      # 回归测试与离线样本
└── guides/     # 部署、API 与实现文档
```

欢迎通过 [Issues](https://github.com/LittleSunX/video-parser/issues) 反馈问题或提交 Pull Request。反馈时请附上浏览器、部署方式、复现步骤和页面中的“问题信息”；请勿公开含签名的媒体下载地址或访问凭据。提交代码前请运行 `npm run check`。

## 常见问题

<details>
<summary>为什么有些图片没有标记“无水印”？</summary>

只有明确来自可信无水印字段的资源才会标记。普通图片地址不会自动视为无水印，也不会对图片进行去水印处理。

</details>

<details>
<summary>点击保存后没有找到文件怎么办？</summary>

先检查浏览器下载列表和下载权限。页面出现“再次保存”时可点击重试；也可使用“打开直链”或“备用下载”。资源地址过期时，需要重新解析作品。

</details>

<details>
<summary>自己部署后，页面能打开但解析失败怎么办？</summary>

先确认 API 的 `/api/health` 可访问，再核对前端构建时的 `VITE_API_BASE_URL`。仅发布前端不会自动部署 API。配置正常但个别作品失败时，可能与上游接口变化、资源权限或出口网络有关。

</details>

## 使用与版权

本工具仅处理可公开访问的作品，不绕过登录、付费或其他访问控制。解析内容版权归原作者或相关权利人所有，请遵守相关法律法规及平台规则，勿用于侵权传播或未经授权的商业用途。

本项目版权归作者所有，未经授权不得擅自用于商业用途。
