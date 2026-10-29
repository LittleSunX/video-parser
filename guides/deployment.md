# 部署指南

[返回 README](../README.md)

**首次部署建议使用方式一：Vercel 托管前端，Cloudflare Worker 运行 API，无需购买或维护 VPS。** 从下面的准备工作开始，按顺序完成即可。

本文按以下顺序组织，每次选择一套方案：

1. [无需维护服务器：Vercel + Cloudflare Worker（推荐）](#方式一无需维护服务器推荐)
2. [前端和 API 全部部署到 VPS：Nginx + Node](#方式二前端和-api-全部部署到-vps)
3. [Cloudflare Worker 后端 + VPS 前端](#方式三cloudflare-worker-后端与-vps-前端)
4. [其他部署组合](#其他部署组合)

环境变量速查、常见问题和 Cloudflare 代理说明放在文末，操作时按需要查阅。示例中的域名、`YOUR_GITHUB_NAME` 等占位内容需替换成自己的值。

**所有方案均优先由浏览器直连抖音媒体 CDN 下载。** 解析请求使用 API，媒体直连成功时不消耗本项目 API 的文件转发流量。直连异常按资源类型回退到 API；已知超过 64 MiB 的普通视频及手动选择的“备用下载”直接走 API 代理。部署位置不改变这些规则，详见 [下载策略](implementation.md#下载策略)。

<a id="vercel-worker"></a>

## 方式一：无需维护服务器（推荐）

**组合：Vercel 前端 + Cloudflare Worker API。** 整套服务运行在托管平台上。可以先使用平台提供的域名，自定义域名留到部署成功后再绑定。

开始前准备：

- GitHub、Cloudflare 和 Vercel 账号。
- 本地安装 Git、npm 和符合 [项目要求](../package.json) 的 Node.js。

下面的终端命令均在本地执行；克隆后进入**仓库根目录**，后续命令都在这个目录运行。顺序是：**准备代码 → 部署 Worker → 部署 Vercel → 验证**。

### 第一步：准备代码

1. 将 [本仓库](https://github.com/LittleSunX/video-parser) Fork 到自己的 GitHub 账号。
2. 克隆自己的仓库并安装依赖：

```bash
git clone https://github.com/YOUR_GITHUB_NAME/video-parser.git
cd video-parser
npm ci
npm run check
```

**完成标志：** `npm run check` 成功结束。后续 Worker 和 Vercel 应部署这个仓库的同一个提交。

<a id="cloudflare-worker"></a>

### 第二步：先部署 Worker API

[worker/wrangler.jsonc](../worker/wrangler.jsonc) 已配置 API 入口、版本信息和限流绑定，默认 Worker 名称为 `video-parser-api`。如果账号中已有同名服务，请先确认是否要更新它；部署独立实例时使用不同名称和限流 namespace，并提交配置修改。

在本地终端执行：

```bash
npx --no-install wrangler login
npm run deploy:worker
```

第一条命令会引导完成 Cloudflare 登录授权；第二条使用当前提交发布 API。若提示工作区未提交，先用 `git status --short` 确认并提交自己需要发布的修改，再执行发布。

成功后，复制终端输出的 Worker 地址，例如：

```text
https://video-parser-api.your-subdomain.workers.dev
```

这就是接下来要填写的 **API 地址**。在浏览器打开它的 `/api/health`：

```text
https://video-parser-api.your-subdomain.workers.dev/api/health
```

**完成标志：** 返回 JSON，包含 `success: true`、`status: "ok"` 和 `runtime: "cloudflare-worker"`。如果该地址不可访问，先解决 API 的发布或网络问题，再部署前端。

Wrangler 的登录与发布流程见 [Cloudflare 官方指南](https://developers.cloudflare.com/workers/get-started/guide/)。本项目的发布命令还会写入 Git 提交版本；`npm run release:worker` 只预览，不能代替 `npm run deploy:worker`。

<a id="vercel"></a>

### 第三步：在 Vercel 部署前端

在 Vercel 新建项目，导入第一步 Fork 的仓库。在首次部署前，将构建设置改为下表内容：

| Vercel 配置项    | 填写内容                              |
| ---------------- | ------------------------------------- |
| Framework Preset | `Vite`                                |
| Root Directory   | 仓库根目录，保持默认，不选 `frontend` |
| Install Command  | `npm ci`                              |
| Build Command    | `npm run build --workspace frontend`  |
| Output Directory | `frontend/dist`                       |
| Node.js Version  | `22.x` 或 `24.x`                      |

在 **Environment Variables** 中新增一条变量，名称和值分开填写：

| Name                | Value                            |
| ------------------- | -------------------------------- |
| `VITE_API_BASE_URL` | 第二步实际发布得到的 Worker 地址 |

例如 Value 为 `https://video-parser-api.your-subdomain.workers.dev`，**不要加 `/api` 或 `/api/health`**。确保变量用于 Production；如果也要测试预览部署，再为 Preview 配置相应 API。

如果在本地修改过代码或配置，先将需要发布的提交推送到自己的 GitHub 仓库，再点击 **Deploy**。Vercel 的生产分支应包含第二步发布的提交；若两个部署的提交不同，后续版本检查会提示不一致。该项目共用根目录锁文件和 `shared/`，因此目录、构建命令和产物路径要使用上面这一整套配置。

**完成标志：** Vercel 构建成功，打开分配的 `*.vercel.app` 地址能看到解析页面。Vercel 此时只托管前端；API 已在第二步单独部署。

如果已经部署过，去项目 Settings 修改构建设置或环境变量，并重新部署。**环境变量变更不会更新已有的静态页面。** 官方操作说明见 [导入 Git 仓库](https://vercel.com/docs/git)、[构建设置](https://vercel.com/docs/builds/configure-a-build) 和 [环境变量](https://vercel.com/docs/environment-variables)。

### 第四步：确认网站能用

1. 打开前端的 `/version.json`，应返回含 `commit` 和 `builtAt` 的 JSON。
2. 在页面粘贴一条可公开访问的抖音作品链接，确认能解析，并实际保存一个文件。
3. 在本地仓库执行版本检查，把下方两处地址换成实际地址：

```bash
npm run release:check -- --frontend https://YOUR_PROJECT.vercel.app --api https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
```

不传 `--commit` 时，对照的是本地当前提交（HEAD）。**完成标志：** 输出 `passed: true`，且浏览器能够完成解析和保存。健康检查与版本检查本身不会验证抖音上游，完整验收见 [样本与手机保存验收](implementation.md#版本与验收)。

### 后续更新

代码检查通过并提交后，先发布 Worker，再让 Vercel 部署同一提交，最后重复第四步。连接 Git 的 Vercel 项目可以自动部署前端；本仓库的 GitHub Actions 负责检查，**不会自动发布 Worker**。

仅改前端且确认 API 兼容时，可以保留原 Worker，使用 [分别指定前后端版本](../RELEASE_CHECK.md#前后端分别发布时) 的方式检查。

<details>
<summary>可选：自定义域名与前端缓存</summary>

前端域名在 Vercel 项目中绑定，API 域名在 Worker 中绑定。例如前端 `video.example.com`，API `api.example.com`。更换 API 域名后，将 Vercel 中的 `VITE_API_BASE_URL` 改成新基址并重新部署。

首页与 `/version.json` 应能及时更新，带内容哈希的 `/assets/` 文件可以长期缓存。需要显式设置入口缓存时，在仓库根目录添加 `vercel.json`，提交并重新部署（仓库未预置此文件）：

```json
{
  "headers": [
    { "source": "/", "headers": [{ "key": "Cache-Control", "value": "no-store" }] },
    { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-store" }] },
    { "source": "/version.json", "headers": [{ "key": "Cache-Control", "value": "no-store" }] }
  ]
}
```

公开站点的版本与 API 接口不应被部署登录页或 HTML 挑战页替代。

</details>

<a id="vps-full-stack"></a>

## 方式二：前端和 API 全部部署到 VPS

这条路线需要一台使用 systemd 的 Debian/Ubuntu VPS、一个指向它的域名，以及配置 Nginx 和 HTTPS 的权限。运行 Node API 无需 Cloudflare 账号。

```text
用户浏览器
├─ 打开网页 → https://example.com → Nginx → 前端静态文件
├─ 解析作品 → https://example.com/api/parse → Nginx → Node API → 抖音解析来源
├─ 媒体下载（优先）→ 抖音媒体 CDN
└─ 代理下载 → https://example.com/api/download → Nginx → Node API → 抖音媒体 CDN
```

Node API 监听 `127.0.0.1:8787`。直连成功的媒体下载不经过 Nginx 或 Node；触发代理下载时，媒体才经 VPS 转发。

按 **[VPS_DEPLOY.md](../VPS_DEPLOY.md)** 的第 1–7 节依次执行。它包含完整的安装、构建、证书、服务启动和检查命令；首次部署不用执行更新、回滚章节。

需要记住的配置只有以下几个入口：

| 配置                 | 位置                                  | 这条路线的值                                |
| -------------------- | ------------------------------------- | ------------------------------------------- |
| 前端 API 基址        | 构建前端时的 `VITE_API_BASE_URL`      | 空字符串，使用同域 `/api`                   |
| Node 监听地址        | `/etc/video-parser/server.env`        | `HOST=127.0.0.1`、`PORT=8787`               |
| 可信反代             | 同一环境文件                          | `TRUST_PROXY=loopback`，与模板的 Nginx 配套 |
| 域名、证书、静态目录 | `/etc/nginx/conf.d/video-parser.conf` | 换成自己的域名和实际路径                    |

**完成标志：** `https://example.com` 能打开页面，`https://example.com/api/health` 返回 `runtime: "node"`，版本检查通过且能实际保存文件。公网只需访问 Nginx；8787 保持本机监听。

<a id="vps-static-frontend"></a>

## 方式三：Cloudflare Worker 后端与 VPS 前端

希望后端使用 Cloudflare、前端放在自己 VPS 上时，选择这套组合。浏览器从 VPS 获取网页，媒体优先直连抖音 CDN，解析和代理下载请求访问 Worker。这既是一套首次部署方案，也支持只迁移已有站点的前端。

| 部分               | 部署位置          | 访问地址示例                                                    |
| ------------------ | ----------------- | --------------------------------------------------------------- |
| 前端网页           | VPS 的 Nginx      | `https://video.example.com`，DNS A 记录指向 VPS                 |
| 解析与备用下载 API | Cloudflare Worker | `https://api.example.com` 或可用的 `*.workers.dev`，绑定 Worker |

首次部署依次完成：**发布 Worker → 确认 API 可用 → 本地构建前端 → 上传 VPS → 配置 Nginx / HTTPS → 验证**。已有可用 Worker 时，沿用原地址和版本，跳过 Worker 发布步骤。

**[完整教程：Cloudflare Worker 后端 + VPS 前端](frontend-only.md)**。该页包含这套组合的全部操作、Windows / Linux 本地命令、[纯静态 Nginx 模板](../deploy/frontend-nginx.conf)、证书续期、更新与回滚。

前端构建时将 `VITE_API_BASE_URL` 填为 Worker 的完整 HTTPS 基址；前端域名和 API 域名分别指向 VPS 与 Worker。VPS 不运行 Node 后端，不使用方式二的 `/api` 反代配置。

<a id="other-deployments"></a>

## 其他部署组合

以下用于替换前端托管平台，或让前端与 API 分开托管。已选定前面三种方式的用户可直接按对应教程完成部署。

<a id="cloudflare-pages"></a>

### Cloudflare Pages 前端 + 已有 API

先完成 API 部署，再创建 **Pages 静态项目**并连接自己的完整 Git 仓库。选择需要部署的生产分支，填写：

| 配置项                 | 值                                                       |
| ---------------------- | -------------------------------------------------------- |
| Root directory         | 仓库根目录，留空                                         |
| Framework preset       | `None`，手动填写下列构建项                               |
| Build command          | `npm ci && npm run build --workspace frontend`           |
| Build output directory | `frontend/dist`                                          |
| Environment Variable   | 名称 `VITE_API_BASE_URL`，值为实际 API 的 HTTPS 基址     |
| Node 版本              | 使用仓库 `.nvmrc`；如设置 `NODE_VERSION`，须符合项目要求 |

生产与预览环境的变量分别设置。Pages 只发布前端静态文件，**不会自动部署 `worker/`，也不会运行 Node API**；Worker 按 [第二步](#第二步先部署-worker-api) 发布，Node 按 [VPS 教程](../VPS_DEPLOY.md) 启动。

可在 `frontend/public/_headers` 添加以下内容，让 Vite 将它复制到 `frontend/dist/_headers`（配置示例，仓库当前未预置）：

```text
/
  Cache-Control: no-store
/index.html
  Cache-Control: no-store
/version.json
  Cache-Control: no-store
```

Pages 会解析 `_headers`，它不是给 Vercel 或 Nginx 使用的通用配置。绑定自定义前端域名时，从 Pages 项目里的 Custom domains 流程操作；不要把 Pages 项目误当成 VPS 源站配置。参考官方 [构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)、[构建环境](https://developers.cloudflare.com/pages/configuration/build-image/) 和 [响应头配置](https://developers.cloudflare.com/pages/configuration/headers/)。

**完成标志：** 打开 Pages 分配的地址可以解析并保存作品；将 [第四步](#第四步确认网站能用) 的前端地址换为该地址，完成版本检查。

<a id="vps-separated"></a>

### Vercel / Pages 前端 + VPS API

先阅读 [VPS 的前后端分开部署说明](../VPS_DEPLOY.md#9-可选前端与-api-分开部署)，让 Node API 通过独立的 `https://api.example.com` 提供服务。API 可用后，按 [Vercel 设置](#第三步在-vercel-部署前端) 或 [Pages 设置](#cloudflare-pages-前端--已有-api) 部署前端，把 `VITE_API_BASE_URL` 填成这个 VPS API 地址。

这一组合只需要 Node API。前端可以换托管平台，Worker 和 Node 之间没有自动切换。

<a id="static-hosting"></a>

### 其他静态托管平台 + 已有 API

只要支持 HTTPS 静态文件托管，就可以使用同一份前端；后端仍须选择独立 Worker 或 Node。构建方式：在仓库根目录设置 `VITE_API_BASE_URL`，执行 `npm run build --workspace frontend`，上传 **`frontend/dist/` 的内容**。

按平台规则设置首页、资源 MIME 和缓存，保证 `/version.json` 返回真实 JSON 而不是 SPA fallback；不要用全站“缓存所有内容”覆盖首页/版本文件的策略。子目录部署、平台登录保护或额外代理规则需要单独验证。无需启动 `vite dev` 或把 `vite preview` 作为生产服务器。

<a id="deployment-common"></a>

## 环境变量应该填在哪里

| 你在做什么            | 填写位置                                    | 示例                                                        |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Vercel 构建前端       | 项目的 Environment Variables                | Name：`VITE_API_BASE_URL`；Value：`https://api.example.com` |
| Pages 构建前端        | 项目的环境变量设置                          | 同上                                                        |
| 在本机或 VPS 构建前端 | `frontend/.env.local`，或构建命令的环境变量 | `VITE_API_BASE_URL=https://api.example.com`                 |
| systemd 运行 Node     | `/etc/video-parser/server.env`              | `HOST`、`PORT`、`TRUST_PROXY` 等                            |

`VITE_API_BASE_URL` 是前端构建变量，填 API 的 HTTPS 基址。全 VPS 同域方案显式设为空；前后端跨域时填完整 API 地址。把它添加到运行中的 Node 环境文件，不会改变已经构建的页面。

这个变量决定解析和代理下载的 API 地址，不会把解析得到的媒体直链改写成代理地址。Worker 与 Node 之间没有自动故障切换；“备用下载”是直连失败后的媒体代理路径，不是另一个后端。

本地 Vite 的 `/api` 代理仅用于开发。静态托管平台不会自动获得该代理配置；`VITE_*` 的值会进入前端产物，不应放访问凭据。

## 常见部署问题

| 现象                                  | 优先检查                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| 页面正常，解析请求却返回 404 或 HTML  | 前端的 `VITE_API_BASE_URL` 是否设置并重新构建；同域部署是否配置了 `/api/` 反代              |
| Vercel 找不到 `shared/`、锁文件或产物 | 是否导入完整仓库；Root Directory、Build Command、Output Directory 是否与教程一致            |
| Worker 发布提示工作区未提交           | 运行 `git status --short`，确认并提交需要发布的修改                                         |
| VPS 的 `/api/health` 返回 502         | 按 [服务启动与检查](../VPS_DEPLOY.md#6-systemd-启动与本机验证) 查看 Node 服务状态和监听端口 |
| 更新后前后端版本不一致                | Worker 是否重新发布，Vercel 是否构建了预期提交，首页和版本文件是否仍被缓存                  |

<a id="cloudflare-proxy"></a>

## 可选：在 VPS 前面增加 Cloudflare DNS / CDN

**Cloudflare DNS、橙云代理、Pages 托管、Worker 执行是不同功能。** 域名交给 CF 管理不等于网站已经部署到 CF；网站文件仍可放 VPS。

下表描述访问自己站点域名时的路径。下载时对抖音媒体 CDN 的直连请求不经过自己站点的橙云代理。

| DNS 模式         | 访问路径               | 含义                                               |
| ---------------- | ---------------------- | -------------------------------------------------- |
| DNS only（灰云） | 浏览器 → VPS           | CF 只解析域名，不代理该 HTTP 流量                  |
| Proxied（橙云）  | 浏览器 → CF 边缘 → VPS | VPS 是源站，CF 提供反向代理及按规则缓存的 CDN 能力 |

### 仅前端套 CF，API 仍是 Worker

1. 将 `video.example.com` 的 A 记录指向 VPS；只有 IPv6 已配置可用时才加 AAAA，再开启橙云。
2. VPS 在 443 提供匹配域名、未过期的证书；CF 的 SSL/TLS 模式选 **Full (strict)**，不要用 Flexible。证书可使用公共 CA 或 Cloudflare Origin CA；后者不被普通浏览器直接信任，切回灰云前需换成公共可信证书。
3. `api.example.com` 继续绑定 Worker，不要把它指向 VPS。前端的 `VITE_API_BASE_URL` 仍填写这个 Worker 地址，VPS 不启动 Node，也不需要给静态前端添加 Node 的代理配置。
4. CF 缓存规则保留首页和 `/version.json` 的不缓存策略；不要套用全站 Cache Everything。带哈希的静态资源可缓存，更新时检查边缘与浏览器没有继续提供旧首页/版本。

### Node API 也套 CF

先按直连 VPS 教程完成验证，再增加这层代理，并检查：

- **真实客户端 IP**：未经配置的 Nginx 会看到 CF 边缘 IP，多名用户会共用限流额度。使用 Nginx realip 模块，仅对 [Cloudflare 官方 IP 网段](https://www.cloudflare.com/ips/) 配置 `set_real_ip_from`，再使用 `real_ip_header CF-Connecting-IP`。持续维护 IPv4/IPv6 网段，不能信任 `0.0.0.0/0`、`::/0` 或任意客户端提交的该头。
- **传给 Node 的仍是校验后的身份**：Nginx 继续用 `proxy_set_header X-Real-IP $remote_addr` 覆盖报头，Node 保持 `TRUST_PROXY=loopback`。不要改为让 Node 无条件相信 `CF-Connecting-IP` / `X-Forwarded-For`，也不要把客户端传入的头直接透传。
- **源站边界**：限制公网 HTTP/HTTPS 只接受可信 CF 入口，防止绕过边缘防护；同时安排证书续期、独立管理入口，避免误封 SSH。Node 的 8787 仍只监听 loopback，VPS 出站限制也必须保留。
- **API 不缓存**：对 `/api/*` 设置缓存绕过并保留应用 `Cache-Control`；不要缓存解析结果、健康版本或带签名 URL 的媒体代理响应。API 使用域名单独托管时，也要给该域名设置规则。
- **流式与访问策略**：保留模板的禁缓冲、取消传递、Range 和错误响应；不要让 API 被返回 HTML 的交互式挑战或部署登录保护拦截。额外 CF 层仍有自己的限制，必须重新验收 NDJSON 首段、长下载、206/416、取消、限流和失败处理，不能用“页面能打开”替代。
- **日志隐私**：CF 的日志导出、分析工具和 APM 同样不得持久化完整媒体 query、签名或 `errorToken`；仅修改应用日志不覆盖整条链路。

可信代理配置参考 [CF 原始访客 IP 文档](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)，TLS 要求参考 [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。这层扩展不会自动修改仓库里的直连 Nginx 模板，需管理员按实际入口配置和验收。
