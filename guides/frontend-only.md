# 部署方式三：Cloudflare Worker 后端 + VPS 前端

[返回部署指南](deployment.md) · [返回 README](../README.md) · [版本检查](../RELEASE_CHECK.md)

本文从零部署这套组合：**Cloudflare Worker 运行解析和备用下载 API，VPS 上的 Nginx 提供网页。** 已经有可用 Worker、仅迁移前端的用户，跳过第 1 步中的 Worker 发布命令即可。

```text
用户浏览器
├─ 打开网页 → https://video.example.com → VPS 的 Nginx → 静态文件
├─ 解析作品 → https://api.example.com/api/parse → Worker → 抖音解析来源
├─ 媒体下载（优先）→ 抖音媒体 CDN
└─ 代理下载 → https://api.example.com/api/download → Worker → 抖音媒体 CDN
```

**这套部署仍然优先直连。** 直连成功时媒体文件不经过 Worker 或 VPS；直连异常按资源类型回退到 Worker，已知超过 128 MiB 的普通视频和手动选择的“备用下载”直接使用 Worker 代理。普通视频与单个实况 MP4 的页面缓冲门槛为 128 MiB，不是视频下载大小上限；图片、封面和音乐仍为 64 MiB，ZIP 每包媒体内容仍为 32 MiB。完整条件见 [下载策略](implementation.md#下载策略)。

浏览器的解析和代理下载请求直接访问 Worker。VPS 只负责提供网页，安装 Nginx 和证书工具，使用 [纯前端 Nginx 模板](../deploy/frontend-nginx.conf)；无需运行本项目的 Node 后端，也无需配置 `/api` 反向代理。

**主流程：本地 Windows PowerShell 构建、上传，远端 Debian/Ubuntu VPS 用 Bash 配置站点。** 每一步标明执行位置；本地使用 Linux / macOS 的替代命令放在文末。

本文提供可逐步执行的手动流程。把这些命令封装为本地辅助脚本时，上传目录、Worker 配置路径和 SSH 用户需要写入部署记录；辅助脚本应保留本节列出的检查结果，不能仅凭“脚本执行结束”判断部署完成。

首次部署按第 1–7 步依次执行：**发布 Worker → 构建前端 → 上传 → 安装文件 → DNS 与证书 → HTTPS → 验证**。第 8 节用于后续更新和回滚。

## 开始前：准备工具和两个地址

需要 Cloudflare 账号、能用 sudo 登录的 Debian/Ubuntu VPS，以及前端域名。本地安装 Git、符合 [项目要求](../package.json) 的 Node.js / npm、`tar`、`ssh` 和 `scp`。云安全组和 VPS 防火墙允许 80、443，并保留 SSH 入口。

**先确认 VPS 地域和域名备案状态。** 使用中国内地 VPS 提供网站时，应先完成 ICP 备案及服务器接入商要求的接入手续；只托管静态前端、API 使用 Cloudflare Worker，也需要核对这项要求。以阿里云为例，未备案或尚未接入阿里云的域名可能被平台阻断访问，见 [阿里云 ICP 备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/what-is-an-icp-filing)。备案资格、域名注册商和服务器要求以接入商当前审核规则为准。

公网返回 `403`、`Non-compliance ICP Filing` 等备案拦截页时，先处理备案或接入状态，再继续验收。Nginx 配置检查、短暂的 HTTP 200 或首次签发证书成功，都不能代替后续的公网访问和证书续期验证。

| 项目            | 本文示例                  | 填写说明                          |
| --------------- | ------------------------- | --------------------------------- |
| Worker API 地址 | `https://api.example.com` | Worker 的 HTTPS 基址，不加 `/api` |
| 前端域名        | `video.example.com`       | 指向新 VPS 的域名                 |
| VPS 公网 IP     | `203.0.113.10`            | 替换为真实 IP                     |
| SSH 账号        | `deploy@203.0.113.10`     | 使用有 sudo 权限的普通账号        |
| 证书邮箱        | `admin@example.com`       | 替换为自己的邮箱                  |

下文用有 sudo 权限的 `deploy` 用户举例，该用户需已在服务器上配置好。若云服务器当前使用 `root` 登录，将 SSH 目标改成 `root@你的IP`；VPS 上的命令可以去掉 `sudo`。`$HOME` 指登录用户的家目录，root 对应 `/root`。密码登录时直接在 SSH / SCP 提示中输入，多个连接可能分别要求输入密码。

Worker 也可以使用发布后得到的 `https://video-parser-api.你的子域.workers.dev`，前提是用户浏览器所在网络能正常访问。下文所有 `https://api.example.com` 都替换成你实际使用的 Worker 地址。

| 地址                                       | 在哪里配置                      | 最终指向                             |
| ------------------------------------------ | ------------------------------- | ------------------------------------ |
| `video.example.com`                        | 第 5 步在 DNS 管理中配置 A 记录 | VPS 公网 IP                          |
| `api.example.com`（选用自定义 API 域名时） | Worker 的 Custom Domain         | Worker，Cloudflare 管理其 DNS 和证书 |
| `*.workers.dev`（使用默认 API 地址时）     | Worker 发布后获得               | Worker，无需添加 VPS 的 DNS 记录     |

**不要把 API 域名也解析到 VPS。** 使用 Cloudflare DNS 时，首次配置仅将**前端 A 记录**设为 DNS only（灰云），Worker 的域名绑定保持原样。模板仅监听 IPv4；前端有 AAAA 记录时，需配置 IPv6 监听与网络，或移除不再适用的 AAAA。

**如果是迁移旧站点：** 记录原前端 DNS、前端提交和 Worker 提交，保留原托管项目。网页和 API 若原本共用一个域名，先给 API 准备独立地址，否则切换前端 DNS 会一起切断 API。仅迁移前端可保留原 Worker 版本；同时升级前端时需确认接口兼容。

沿用旧前端域名时，第 5 步切换 DNS 到签发证书之间可能短暂影响 HTTPS。可安排维护窗口或先用新子域名验证；已有匹配域名的有效证书时，可先配置 HTTPS 再切换 DNS。

## 1. 准备源码并部署 Worker 后端

**执行位置：本地电脑。** 已有仓库时进入仓库根目录。没有源码时，在本地工作目录执行（使用自己的 Fork 时替换地址）：

```powershell
git clone https://github.com/LittleSunX/video-parser.git
if ($LASTEXITCODE -ne 0) { throw '克隆失败' }
Set-Location video-parser
```

在仓库根目录安装依赖，后续本地命令也都在这里执行：

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
```

**已有本项目的可用 API：** `/api/health` 已返回本节末尾要求的 JSON 时，可以跳过发布命令，保留原服务和版本。仅在控制台创建了 Worker、响应仍是 `Hello World!` 时，还需要发布本项目的代码和绑定。

**首次部署 Worker：** 核对 [worker/wrangler.jsonc](../worker/wrangler.jsonc)，默认名称是 `video-parser-api`。账号下有同名服务时先确认是否要使用它；新建独立实例时更换名称和限流 namespace，保留配置中的 API 入口、版本与限流绑定。提交需要发布的修改，确保工作区干净，然后执行：

```powershell
npx --no-install wrangler login
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare 登录失败' }
npm run deploy:worker
if ($LASTEXITCODE -ne 0) { throw 'Worker 发布失败' }
```

登录自己的 Cloudflare 账号。发布命令会把当前 Git 提交写入 Worker 版本信息，成功后记录终端输出的 API 地址，可以是 `workers.dev` 地址或已配置的自定义域名。`npm run release:worker` 只预览发布计划，不能代替上面的发布命令。

<details>
<summary>账号已有旧 Worker：使用独立实例和专用配置</summary>

`npm run deploy:worker` 默认读取 `worker/wrangler.jsonc`。需要保留同账号旧实例时，可以修改该文件并提交；也可以创建一份本地专用配置，在发布命令中显式指定。不要只修改 API 域名，却仍用指向旧实例的默认发布命令。

例如，先在仓库根目录复制配置（已有同名专用配置时保留它）：

```powershell
$workerConfig = 'worker/.wrangler/wrangler.deploy.jsonc'
if (-not (Test-Path -LiteralPath $workerConfig)) {
  New-Item -ItemType Directory -Path worker/.wrangler -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath worker/wrangler.jsonc -Destination $workerConfig -ErrorAction Stop
}
```

该目录被 Git 忽略，配置需要自行备份，并在部署记录中保存配置路径和实际目标。编辑这份专用配置，核对：

- `name`：新实例的真实名称，与控制台已有的目标 Worker 一致。
- `main`：由于配置移入 `.wrangler/`，改为 `../src/index.ts`，相对于该配置文件解析。
- 如保留 `$schema`，将路径调整为 `../../node_modules/wrangler/config-schema.json`，供编辑器读取。
- 两个 `namespace_id`：使用与同账号其他实例不同的值，避免共用限流计数；保留版本元数据绑定和限流阈值。
- 自定义域名：可在控制台绑定，也可在专用配置的 `routes` 中指定 `pattern` 和 `custom_domain: true`。

专用配置对应的发布命令在**本地仓库根目录**执行，替代上面的默认发布命令：

```powershell
$workerConfig = 'worker/.wrangler/wrangler.deploy.jsonc'
$workerCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $workerCommit -notmatch '^[a-fA-F0-9]{40}$') { throw '无法读取提交版本' }
$pendingChanges = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $pendingChanges) { throw '请先提交需要发布的源码修改' }
if (-not (Test-Path -LiteralPath $workerConfig)) { throw '请先准备并核对专用 Worker 配置' }
npx --no-install wrangler deploy --config $workerConfig --tag $workerCommit
if ($LASTEXITCODE -ne 0) { throw 'Worker 发布失败' }
```

发布后必须核对自定义域名的 `/api/health` 和提交号。后续更新同一实例时，继续使用这份专用配置；默认发布脚本不会自动发现它。

</details>

若使用自定义 API 域名，在 Cloudflare 控制台进入 **Workers & Pages → 选择该 Worker → Settings → Domains & Routes → Add → Custom Domain**，添加属于自己、已在 Cloudflare 激活的 `api.example.com`。Cloudflare 会创建对应的 DNS 和证书，不要把这条记录改成 VPS 的 A 记录。已有同名 CNAME 时先核对并处理冲突；已有可用绑定则直接沿用。[Cloudflare 自定义域名说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

**完成标志：** 从自己电脑的浏览器打开 `https://api.example.com/api/health`，返回 JSON，包含 `success: true`、`data.status: "ok"`、`data.service: "video-parser-api"` 和完整提交号 `data.versionTag`。新版本 Worker 还会返回 `data.runtime: "cloudflare-worker"`。确认 API 可用后再部署前端。

## 2. 构建并打包前端

**执行位置：本地 PowerShell，仓库根目录。** 首次部署使用第 1 步发布 Worker 的同一提交构建前端；仅迁移时可使用原前端提交，并确认与保留的 Worker 兼容。若在第 1 步之后切换过提交，先重新执行 `npm ci` 安装该版本的依赖。

若使用的旧提交没有 `deploy/frontend-nginx.conf`，先将本指南链接的 [纯前端模板](../deploy/frontend-nginx.conf) 保存到该路径，再执行上传。模板与前端构建独立，无需为获取模板而升级原 API。

替换最前面的 API 地址和 SSH 账号后执行：

```powershell
$apiBase = 'https://api.example.com'
$sshTarget = 'deploy@203.0.113.10'
$apiBase = $apiBase.TrimEnd('/')

$health = Invoke-RestMethod "$apiBase/api/health" -ErrorAction Stop
$apiCommit = $health.data.versionTag
if (-not $health.success -or $health.data.status -ne 'ok' -or $health.data.service -ne 'video-parser-api' -or $apiCommit -notmatch '^[a-fA-F0-9]{40}$') {
  throw 'API 健康或版本信息无效，请先确认 Worker 状态'
}

$previousApiBase = $env:VITE_API_BASE_URL
try {
  $env:VITE_API_BASE_URL = $apiBase
  npm run build --workspace frontend
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
} finally {
  $env:VITE_API_BASE_URL = $previousApiBase
}

$frontVersion = Get-Content frontend/dist/version.json -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$frontendCommit = $frontVersion.commit
$currentCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $frontendCommit -ne $currentCommit) {
  throw '构建版本与当前提交不一致，请检查 VERCEL_GIT_COMMIT_SHA 等构建环境'
}
$releaseName = 'web-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + $frontendCommit.Substring(0, 12)
$archivePath = Join-Path $env:TEMP "$releaseName.tar.gz"
tar -czf $archivePath -C frontend/dist .
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
$archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
Write-Output "发布目录名：$releaseName"
Write-Output "前端提交：$frontendCommit"
Write-Output "API 提交：$apiCommit"
Write-Output "压缩包 SHA256：$archiveSha256"
```

**完成标志：** `frontend/dist/` 中有 `index.html`、`assets/` 和 `version.json`，终端输出发布目录名、两个提交号和压缩包校验值。将这些输出保存到部署记录中，第 4、7 步会用到；保留当前终端供第 3 步上传使用。

`VITE_API_BASE_URL` 会在构建时写进静态文件。这里始终填写**Worker 的完整 HTTPS 基址**；即使网页迁到 VPS，也不要留空或改成 `http://127.0.0.1:8787`。这与全 VPS 同域部署的配置不同，参见 [Vite 环境变量说明](https://vite.dev/guide/env-and-mode.html)。

## 3. 上传产物

**执行位置：本地 PowerShell，仍在仓库根目录。** 沿用第 2 步的终端变量：

```powershell
ssh $sshTarget 'mkdir -p ~/video-parser-upload'
if ($LASTEXITCODE -ne 0) { throw '创建上传目录失败' }
scp $archivePath deploy/frontend-nginx.conf "${sshTarget}:video-parser-upload/"
if ($LASTEXITCODE -ne 0) { throw '上传失败' }
```

上传的是前端产物压缩包和纯静态 Nginx 模板。API 源码、`.env`、`node_modules` 都不需要上传。Linux / macOS 使用文末的本地替代命令。

上传目录用于暂存文件，正式网页目录由下一步解压创建。本文约定如下：

| 路径                                                  | 用途                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| 本地 `frontend/dist/`                                 | 构建产物，打包的是该目录里面的内容                                            |
| VPS `$HOME/video-parser-upload/`                      | 压缩包和 Nginx 模板的上传暂存目录；root 登录时是 `/root/video-parser-upload/` |
| VPS `/var/www/video-parser/releases/web-时间-提交号/` | 解压后的正式版本，直接包含 `index.html`、`assets/`、`version.json`            |
| VPS `/var/www/video-parser/current`                   | 指向正在使用版本的软链接，Nginx 以此为静态根目录                              |
| VPS `/etc/nginx/conf.d/video-parser-frontend.conf`    | 当前站点的 Nginx 配置                                                         |

也可以把文件直接上传到 `/root/` 等管理员选定的目录，但必须在第 4、6 步使用相同路径。上传到哪里与 Nginx 从哪里提供网页是两个配置项；不需要在服务器保留 `frontend/dist/` 这层目录名。

## 4. 在 VPS 安装 Nginx 和前端文件

**执行位置：VPS 的 Bash。** 在本地另开终端，用 `ssh deploy@203.0.113.10` 登录 VPS（替换账号与 IP），保留本地构建终端。以下服务器命令在同一个 Bash 会话中执行。

首次部署先安装系统工具；以后更新前端可跳过这一块：

```bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y nginx certbot curl
```

将 `RELEASE_NAME`、`ARCHIVE_SHA256` 替换为第 2 步的实际输出，再安装并选择本次版本。`UPLOAD_DIR` 应与第 3 步的上传位置一致；若直接上传到 root 家目录，这里改为 `/root`。

```bash
set -euo pipefail
RELEASE_NAME='web-20261028120000-0123456789ab'
[[ "$RELEASE_NAME" =~ ^web-[0-9]{14}-[a-f0-9]{12}$ ]] || exit 1
ARCHIVE_SHA256='填写第2步输出的64位SHA256'
[[ "$ARCHIVE_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || exit 1
UPLOAD_DIR="$HOME/video-parser-upload"
RELEASE_DIR="/var/www/video-parser/releases/$RELEASE_NAME"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$UPLOAD_DIR/$RELEASE_NAME.tar.gz" | sha256sum -c -

sudo install -d -m 0755 /var/www/video-parser/releases /var/www/letsencrypt
sudo test ! -e "$RELEASE_DIR"
sudo test ! -L "$RELEASE_DIR"
sudo install -d -m 0755 "$RELEASE_DIR"
sudo tar -xzf "$UPLOAD_DIR/$RELEASE_NAME.tar.gz" \
  --no-same-owner --no-same-permissions -C "$RELEASE_DIR"
sudo chown -R root:root "$RELEASE_DIR"
sudo chmod -R u=rwX,go=rX "$RELEASE_DIR"
sudo test -s "$RELEASE_DIR/index.html"
sudo test -s "$RELEASE_DIR/version.json"

PREVIOUS_RELEASE=''
if [ -L /var/www/video-parser/current ]; then
  PREVIOUS_RELEASE=$(readlink -e /var/www/video-parser/current)
elif [ -e /var/www/video-parser/current ]; then
  printf 'current 已存在且不是软链接，请先核对目录\n'
  exit 1
fi
printf 'previous=%s\nnext=%s\n' "$PREVIOUS_RELEASE" "$RELEASE_DIR"
sudo test ! -e /var/www/video-parser/current.next
sudo test ! -L /var/www/video-parser/current.next
sudo ln -s "$RELEASE_DIR" /var/www/video-parser/current.next
sudo mv -Tf /var/www/video-parser/current.next /var/www/video-parser/current
```

`/var/www/video-parser` 应专用于这个前端。记录旧版本路径；第一次安装没有旧版本可供文件回滚。以后更新也发布到新目录，通过 `current` 选择当前版本。

## 5. 配置 HTTP、切换前端 DNS 并申请证书

**执行位置：VPS 的 Bash；DNS 记录在域名管理后台修改。** 先使用 HTTP 配置，让 Nginx 能提供文件和证书验证目录。以下以 `video.example.com` 为例，**先替换域名**。若已有同名站点配置，先备份并整合，避免保留两个相同 `server_name`。

在 VPS 创建 `/etc/nginx/conf.d/video-parser-frontend.conf`：

```bash
sudo tee /etc/nginx/conf.d/video-parser-frontend.conf > /dev/null <<'NGINX'
server {
    listen 80;
    server_name video.example.com;
    root /var/www/video-parser/current;
    index index.html;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    error_log /dev/null crit;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        try_files $uri =404;
    }
    location = /api { return 404; }
    location ^~ /api/ { return 404; }
    location = /version.json {
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }
    location / {
        add_header Cache-Control "no-store" always;
        try_files $uri $uri/ /index.html;
    }
}
NGINX
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

发行版主配置应在 `http {}` 中 include `conf.d/*.conf`。检查其他默认站点或全局日志配置，避免继承记录完整 query 的访问、错误日志。从**本地终端**直接指定 VPS 地址检查，不用先改 DNS（Windows 使用 `curl.exe`）：

```bash
curl --noproxy '*' --fail --silent --show-error \
  --retry 10 --retry-delay 1 --retry-all-errors --retry-max-time 30 \
  --connect-timeout 3 --max-time 5 \
  --resolve video.example.com:80:203.0.113.10 http://video.example.com/version.json
```

Nginx 重载后新配置可能需要短暂生效，上面的检查会重试。始终失败时，应核对实际加载的 `server_name`、`current` 指向和文件读取权限；不要直接把一次重载后的 404 判定为前端构建失败。`--noproxy '*'` 用于直接检查指定的源站，避免本机代理改变探测路径。

**完成标志：** 返回第 2 步构建的版本 JSON。随后在 DNS 管理后台，将**前端域名**的 A 记录指向 VPS 公网 IP；保留原 API 域名的记录和 Worker 绑定。若前端原来是 CNAME，先记录旧值，再改为新的 A 记录。

等待 `http://video.example.com/version.json` 在外部网络返回新版本，再在 VPS 申请证书；替换域名和邮箱：

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name video.example.com -d video.example.com \
  --email admin@example.com --agree-tos
sudo test -s /etc/letsencrypt/live/video.example.com/fullchain.pem
sudo test -s /etc/letsencrypt/live/video.example.com/privkey.pem
```

这里使用 webroot 验证，Nginx 保持运行。已有匹配域名的有效证书时可跳过签发，并在下一步填写其真实路径。签发失败时先检查 A/AAAA、80 端口和验证目录；如果正在迁移原域名且影响访问，可恢复原 DNS 记录后排查。[Certbot webroot 说明](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)

## 6. 启用 HTTPS 与证书续期

**执行位置：VPS 的 Bash。** 第 3 步已经上传 [纯前端 HTTPS 模板](../deploy/frontend-nginx.conf)。在 VPS 安装它，再替换文件中的所有 `video.example.com`，核对证书路径：

```bash
sudo cp /etc/nginx/conf.d/video-parser-frontend.conf \
  /etc/nginx/video-parser-frontend.http.backup
sudo install -m 0644 "$UPLOAD_DIR/frontend-nginx.conf" \
  /etc/nginx/conf.d/video-parser-frontend.conf
sudoedit /etc/nginx/conf.d/video-parser-frontend.conf
sudo nginx -t
sudo systemctl reload nginx
```

**完成标志：** 打开 `https://video.example.com` 能看到页面，证书有效；HTTP 会跳转到 HTTPS，`/version.json` 返回 JSON 且带 `Cache-Control: no-store`。配置变更需要测试并重载才能生效，见 [Nginx 指南](https://nginx.org/en/docs/beginners_guide.html)。

使用上述 apt 安装的 Certbot 时，安排自动续期，并在证书更新后重载 Nginx：

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/video-parser-reload-nginx.sh > /dev/null
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/video-parser-reload-nginx.sh
sudo systemctl enable --now certbot.timer
if sudo certbot renew --cert-name video.example.com --dry-run --no-random-sleep-on-renew; then
  printf '证书续期演练通过\n'
else
  printf '续期演练未通过：保留已验证的 HTTPS 配置，按 Certbot 输出排查验证路径\n' >&2
fi
```

保留模板中 80 端口的 `/.well-known/acme-challenge/` 路由，它用于后续续期。已有其他证书管理方式时，沿用对应续期机制。

**HTTPS 配置生效与续期演练通过需要分别记录。** HTTP-01 续期依赖公网 80 端口和验证目录；HTTPS 页面能打开，不证明续期一定成功。演练失败时保留已经验证可用的 HTTPS 配置，排查验证响应、DNS、权限和服务商拦截，不应自动恢复成仅 HTTP。只有域名访问、前后端版本、实际保存和续期演练都通过，才算完成本指南的全部验收。

## 7. 验证前端和 Worker

在**本地仓库根目录**检查，使用与本指南配套、支持 `--api` / `--api-commit` 的版本检查工具。若为了构建旧前端检出了旧提交，旧脚本可能不支持这些参数；此时在另一份包含本指南版本的仓库中运行 `npm ci`，再执行下面的检查，不必升级已经部署的前端或 API。

以下命令不依赖之前终端中的变量。将两个地址及两个完整提交号都替换为部署记录中的值；检查工具所在仓库的 HEAD 可以与待检查版本不同。

Windows PowerShell：

```powershell
$frontendBase = 'https://video.example.com'
$apiBase = 'https://api.example.com'
$frontendCommit = '填写第2步记录的前端完整40位SHA'
$apiCommit = '填写第2步记录的API完整40位SHA'
npm run release:check -- --frontend $frontendBase --api $apiBase --frontend-commit $frontendCommit --api-commit $apiCommit
if ($LASTEXITCODE -ne 0) { throw '版本检查未通过' }
```

Linux / macOS 对应命令为：

```bash
FRONTEND_BASE='https://video.example.com'
API_BASE='https://api.example.com'
FRONTEND_COMMIT='填写第2步记录的前端完整40位SHA'
API_COMMIT='填写第2步记录的API完整40位SHA'
npm run release:check -- --frontend "$FRONTEND_BASE" --api "$API_BASE" \
  --frontend-commit "$FRONTEND_COMMIT" --api-commit "$API_COMMIT"
```

先确认两处版本接口：`https://video.example.com/version.json` 返回前端版本，`https://api.example.com/api/health` 返回 Worker 健康信息。然后在浏览器检查：

1. 新前端能解析公开作品，普通视频、图片和 Worker 支持的实况资源可保存。
2. “备用下载”可用，批量 ZIP、取消和再次保存正常。
3. 按 [下载链路核对](implementation.md#如何核对实际下载链路) 查看开发者工具：解析请求指向 **Worker API 域名**；直连成功的下载请求指向**抖音媒体 CDN**；发生代理回退、下载已知超过 128 MiB 的普通视频或手动点击“备用下载”时，才会请求 Worker 的 `/api/download`。新前端域名的 `/api/health` 返回 404 是本方案的预期行为。
4. 刷新页面后显示新前端版本；`release:check` 输出 `passed: true`。

结合第 6 步续期演练的结果记录验收状态；版本检查通过不代表续期或完整文件保存已经通过。若是迁移，确认解析与保存通过后再停用旧前端；有意保留旧 Worker 时，分别核对两个版本，不必为了提交号相同而重发 Worker。[分别检查前后端版本](../RELEASE_CHECK.md#前后端分别发布时)

## 8. 更新与回滚

**只更新前端：** 在本地获取需要发布的提交，确认与现有 Worker 接口兼容，执行 `npm ci` 后重复第 2–4 步，使用新的发布目录名；第 4 步保存的 `PREVIOUS_RELEASE` 就是切换前的旧版本。域名和证书不变时，无需重复第 5–6 步，也不需要重载 Nginx；切换后重复第 7 步。

**同时更新后端：** 先检查并提交源码，使用第 1 步中与当前实例对应的默认命令或专用配置发布 Worker，再构建上传相同提交的前端，最后执行第 7 步。接口有不兼容变化时需协调两端切换。下方软链接只回滚前端，不会回滚 Cloudflare 上的 Worker。

**回滚到旧前端：** 在 VPS 的 Bash 中，将路径替换为发布记录中的旧目录，先检查路径仍位于本站的 releases 内：

```bash
set -euo pipefail
PREVIOUS_RELEASE='/var/www/video-parser/releases/填写旧发布目录名'
ROLLBACK_DIR=$(realpath -e "$PREVIOUS_RELEASE")
case "$ROLLBACK_DIR" in
  /var/www/video-parser/releases/web-*) ;;
  *) printf '旧版本路径不属于本站 releases\n'; exit 1 ;;
esac
sudo test -s "$ROLLBACK_DIR/index.html"
sudo test -s "$ROLLBACK_DIR/version.json"
sudo test ! -e /var/www/video-parser/current.next
sudo test ! -L /var/www/video-parser/current.next
sudo ln -s "$ROLLBACK_DIR" /var/www/video-parser/current.next
sudo mv -Tf /var/www/video-parser/current.next /var/www/video-parser/current
```

刷新页面，并用旧目录 `version.json` 中的前端提交重新检查。Worker 继续使用其当前版本；旧前端必须与它兼容。

**回到迁移前的托管平台：** 恢复开始前记录的前端 DNS / 自定义域名设置，保持旧站点可用；等待 DNS 生效后验证旧站点。第一次迁移时 VPS 没有旧文件版本，需要使用这种回退方式。首次从零部署则没有旧站点可回退，应排查失败步骤后重新验证。站点验证成功后再考虑启用 [Cloudflare 前端代理](deployment.md#可选在-vps-前面增加-cloudflare-dns--cdn)，并保留首页、版本文件的不缓存策略。

## 常见问题

| 现象或疑问                              | 应如何处理                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| VPS 要安装 Node 或运行 `npm start` 吗？ | 本文在本地构建；VPS 只运行 Nginx，不启动 Node API，也不用 `vite preview`。                                                          |
| 前端域名的 `/api/health` 返回 404       | 本方案的正常结果；健康检查应访问 Worker 域名。                                                                                      |
| 页面打开了，解析请求却访问前端域名      | 构建时没有正确设置 `VITE_API_BASE_URL`；填 Worker 基址后重新构建、打包上传。修改 VPS 环境变量不会改变已构建网页。                   |
| 浏览器提示跨域或返回登录页              | 当前 API 已提供 CORS；检查 Worker 前面的访问控制、代理和允许的前端域名，不要重复添加冲突的 CORS 头。                                |
| 上传后只看到 Nginx 默认页               | 检查 `server_name`、域名指向和加载的配置；静态根目录应是 `/var/www/video-parser/current`，其中直接包含 `index.html`。               |
| 使用 root 登录，但找不到网页文件        | 先检查 `/var/www/video-parser/current` 指向的 releases 目录。`/root/` 或其上传子目录通常只保存压缩包和辅助文件，并非 Nginx 根目录。 |
| HTTPS 能打开，但续期演练返回 403        | 区分服务商备案拦截页与 Nginx 的目录权限错误；保留可用 HTTPS，处理 80 端口验证路径，单独记录续期失败。                               |
| 能否给前端开 Cloudflare 橙云？          | 先完成灰云验证，再启用代理和 Full (strict)；这不会迁移 Worker。保留首页与版本文件的不缓存策略，详见部署指南的 Cloudflare 代理说明。 |

## 本地使用 Linux 或 macOS

本节替代第 1–3 步的本地 PowerShell 命令。上传后继续第 4 步，VPS 上的步骤保持一致。

没有源码时先执行（已有仓库时直接进入其根目录，跳过克隆）：

```bash
set -euo pipefail
git clone https://github.com/LittleSunX/video-parser.git
cd video-parser
```

在仓库根目录安装依赖：

```bash
set -euo pipefail
npm ci
```

首次部署 Worker 时执行以下命令；已有本项目的可用 API、且 `/api/health` 格式正确时可跳过：

```bash
npx --no-install wrangler login
npm run deploy:worker
```

同账号保留旧 Worker、使用专用配置时，同样需显式传入该配置。先按第 1 步准备 `worker/.wrangler/wrangler.deploy.jsonc`，确认源码已提交，再以 `npx --no-install wrangler deploy --config worker/.wrangler/wrangler.deploy.jsonc --tag "$(git rev-parse HEAD)"` 替代默认发布命令。

取得 API 地址后，在同一个本地 Bash 终端构建、打包：

```bash
set -euo pipefail
API_BASE='https://api.example.com'
SSH_TARGET='deploy@203.0.113.10'
API_BASE=${API_BASE%/}
API_COMMIT=$(curl --fail --silent --show-error "$API_BASE/api/health" | node --input-type=module -e '
let s=""; for await (const c of process.stdin) s+=c;
const h=JSON.parse(s), commit=h.data?.versionTag;
if(!h.success || h.data?.status!=="ok" || h.data?.service!=="video-parser-api" || typeof commit!=="string" || !/^[a-f0-9]{40}$/i.test(commit)) process.exit(1);
console.log(commit);')
VITE_API_BASE_URL="$API_BASE" npm run build --workspace frontend
FRONTEND_COMMIT=$(node -p 'JSON.parse(require("fs").readFileSync("frontend/dist/version.json","utf8")).commit')
test "$FRONTEND_COMMIT" = "$(git rev-parse HEAD)"
RELEASE_NAME="web-$(date +%Y%m%d%H%M%S)-${FRONTEND_COMMIT:0:12}"
ARTIFACT_DIR=$(mktemp -d)
tar -czf "$ARTIFACT_DIR/$RELEASE_NAME.tar.gz" -C frontend/dist .
if command -v sha256sum >/dev/null; then
  ARCHIVE_SHA256=$(sha256sum "$ARTIFACT_DIR/$RELEASE_NAME.tar.gz" | awk '{print $1}')
else
  ARCHIVE_SHA256=$(shasum -a 256 "$ARTIFACT_DIR/$RELEASE_NAME.tar.gz" | awk '{print $1}')
fi
printf 'release=%s\nfrontend=%s\napi=%s\n' "$RELEASE_NAME" "$FRONTEND_COMMIT" "$API_COMMIT"
printf 'archive_sha256=%s\n' "$ARCHIVE_SHA256"
```

下一步上传时使用：

```bash
ssh "$SSH_TARGET" 'mkdir -p ~/video-parser-upload'
scp "$ARTIFACT_DIR/$RELEASE_NAME.tar.gz" deploy/frontend-nginx.conf "$SSH_TARGET:video-parser-upload/"
```
