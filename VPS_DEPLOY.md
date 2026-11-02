# 部署方式二：前端和 API 全部部署到 VPS

[返回部署指南](guides/deployment.md) · [返回 README](README.md) · [版本检查](RELEASE_CHECK.md)

本文使用 **Nginx + Node**，把网页和 API 部署在同一台 VPS，需要自行维护服务器。若希望使用无需维护服务器的方案，请从 [方式一：Vercel + Cloudflare Worker](guides/deployment.md#方式一无需维护服务器推荐) 开始。

部署完成后，用户通过一个 HTTPS 域名访问页面，Nginx 将 `/api/` 请求转发给本机 Node 服务。

```text
用户浏览器
├─ 打开网页 → https://example.com → Nginx → 前端静态文件
├─ 解析作品 → https://example.com/api/parse → Nginx → Node → 抖音解析来源
├─ 媒体下载（优先）→ 抖音媒体 CDN
└─ 代理下载 → https://example.com/api/download → Nginx → Node → 抖音媒体 CDN
```

Node 监听 `127.0.0.1:8787`。**部署到 VPS 后仍优先直连媒体 CDN**，直连成功时媒体文件不消耗 VPS 的转发流量。直连异常按资源类型回退到 Node 代理；已知超过 128 MiB 的普通视频及手动选择的“备用下载”直接经过 VPS 代理。普通视频与单个实况 MP4 的页面缓冲阈值为 128 MiB，不是视频大小上限；图片、音乐和 ZIP 的限额见 [下载策略](guides/implementation.md#下载策略)。

**首次部署按第 1–7 节依次执行。** 第 8 节用于已有站点的更新与回滚；如果前端要放在 Vercel 或 Pages，先阅读 [分开部署的区别](#9-可选前端与-api-分开部署)，再执行对应步骤。

所有命令默认在 **VPS 的 Bash 终端**中执行，使用有 `sudo` 权限的普通账号，并在同一终端保留后续步骤需要的变量。提前准备：

| 内容         | 文中的示例          | 需要做什么                                         |
| ------------ | ------------------- | -------------------------------------------------- |
| 站点域名     | `example.com`       | 替换为自己的域名，并解析到 VPS                     |
| 证书联系邮箱 | `admin@example.com` | 替换为自己的邮箱                                   |
| 代码版本     | `COMMIT`            | 默认固定到刚克隆仓库的当前提交，可换为指定完整 SHA |
| 安装目录     | `/opt/video-parser` | 可按示例使用，修改时要同步 Nginx 和 systemd 配置   |

本方案运行时不需要 Cloudflare 账号、数据库或 Redis。仓库安装 Worker 开发依赖用于检查，但无需执行 `deploy:worker`。如果希望后端使用 Cloudflare、只把静态前端放到 VPS，请阅读 [CF 后端 + VPS 前端](guides/frontend-only.md)，其中也包含首次部署和仅迁移前端的流程。

> 以下为部署模板，尚未据此完成真实 VPS 上线验收。请在自己的环境完成第 7 节的版本、解析与保存验证。

## 1. 准备与安全边界

适用基线：使用 systemd 的独立 Debian/Ubuntu VPS，单 Node 进程，同机 Nginx 直接接收公网访问；不包含 Docker、PM2 cluster、CDN 或多层代理。使用有 `sudo` 权限的普通运维账号构建和发布，API 使用单独的无登录用户运行。

购买或使用中国内地 VPS 前，先核对域名备案资格，并完成 ICP 备案及接入商要求的接入手续。阿里云会阻断未备案或尚未接入阿里云的域名；仅托管静态网页也应核对备案要求，见 [官方说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/what-is-an-icp-filing)。若公网返回 `Non-compliance ICP Filing` 等拦截页，应先处理备案状态；放行端口、安装证书和修改 Nginx 不能替代这一步。

上线前必须完成：

1. 自有域名（示例 `example.com`）的 A 记录指向 VPS 公网 IPv4。只有已配置 IPv6 路由、防火墙和 Nginx 监听时才添加 AAAA；错误 AAAA 会影响访问和签发证书。
2. 云安全组及主机入站防火墙只开放必要端口：80、443，以及限制来源的 SSH；**不要开放 8787**。Node 只绑定 `127.0.0.1`，不能改为 `0.0.0.0` 或公网 IP。
3. 为 API 的运行用户/进程配置出站防火墙或等价网络隔离：允许实际需要的公网 HTTPS 和受控 DNS，拒绝访问本机其他服务、私网、链路本地、云 metadata、管理网段及 IPv6 对应范围。至少覆盖 IPv4 loopback、RFC1918、链路本地（包括 `169.254.169.254`）、运营商共享地址及 IPv6 loopback、ULA、链路本地；同时封锁云厂商额外 metadata 地址。允许已建立连接的回包，避免误伤 Nginx 到 Node 的 loopback 入站和本机 DNS 解析器。具体规则依云厂商、DNS 路径及防火墙而异，必须验证拒绝访问的效果，不能仅照抄一条 OUTPUT 规则就视作完成。
4. 代码做 HTTPS、端口、凭据和域名 allowlist 检查，**不提供 DNS 解析后 IP 校验/连接地址固定的保证**。域名白名单不是完整 SSRF 防护，不能代替上述出站策略。不要将服务与敏感内网管理系统放在可互通的网络中。
5. 审计主机上所有 Nginx include、默认站点、负载均衡和日志代理。不能有额外的原始 URL/query 日志，也不能继承不可信的 `real_ip_header` / `set_real_ip_from` 配置。模板依赖 `$remote_addr` 是真实 TCP 对端，而不是由客户端报头改写的值。

上游可能因 VPS 出口 IP、地区或频率拒绝请求；独立 VPS 不保证提高成功率，也不绕过登录、付费或其他访问控制。

## 2. 安装受支持的 Node 与系统工具

构建机和运行机均要求根 `package.json` 的 `engines`：`^22.13.0 || >=24.0.0`，即 22.x 至少 22.13.0，或 24 及以上；不是任意 22+（不包含 23）。应选仍受维护、已打安全补丁的 LTS 版本。服务通过 **`/usr/bin/node` 直接启动**，不依赖交互式 shell 的 nvm/PATH，也不以 `npm start` 包裹进程。

先安装系统工具：

```bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils nginx certbot
```

已有符合要求的 `/usr/bin/node` 和 `/usr/bin/npm` 时，跳过下面的 Node 安装示例，直接核对版本。使用 nvm 的环境需要另外保证 systemd 能通过 `/usr/bin/node` 启动。

<details>
<summary>尚未安装 Node：使用官方二进制包安装</summary>

以下示例适用于 x64 / ARM64。先从 [Node 下载页](https://nodejs.org/en/download) 选择具体版本，替换 `NODE_VERSION`，再执行。命令会检查目标路径是否已存在，不覆盖已有安装。

```bash
set -euo pipefail

# 从 https://nodejs.org/en/download 选择已发布、受支持的精确版本并替换占位值。
NODE_VERSION='v24.填写次版本.填写补丁版本'
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) printf '此示例未覆盖当前 CPU 架构\n'; exit 1 ;;
esac

NODE_TMP=$(mktemp -d)
(
  set -e
  cd "$NODE_TMP"
  curl --fail --show-error --silent --location \
    "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o SHASUMS256.txt
  curl --fail --show-error --silent --location \
    "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    -o "node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  sha256sum --check --ignore-missing SHASUMS256.txt
  test ! -e /usr/bin/node
  test ! -e /usr/bin/npm
  sudo install -d -m 0755 "/opt/node/$NODE_VERSION"
  sudo tar -xJf "node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    --strip-components=1 -C "/opt/node/$NODE_VERSION"
  sudo ln -s "/opt/node/$NODE_VERSION/bin/node" /usr/bin/node
  sudo ln -s "/opt/node/$NODE_VERSION/bin/npm" /usr/bin/npm
)
# 仅删除本步骤创建的临时下载目录。
rm -rf -- "$NODE_TMP"
```

下载步骤失败应停止，不继续部署。SHA256 检查验证下载文件与官方 HTTPS 校验单一致；如组织要求签名校验，应另按 Node 官方发布密钥流程验证校验单签名。还需持续安排系统和 Node 安全更新。

</details>

继续前确认两个命令都能输出版本，并且 Node 满足本节要求：

```bash
/usr/bin/node --version
/usr/bin/npm --version
```

## 3. 下载代码并构建前后端

默认部署刚克隆仓库的当前提交，并固定其完整 SHA。需要部署指定版本时，将 `COMMIT` 改为已确认的完整 40 位提交号。后续变量在同一个 Bash 终端中复用。

```bash
set -euo pipefail
git clone https://github.com/LittleSunX/video-parser.git
cd video-parser
COMMIT=$(git rev-parse HEAD)
[[ "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || exit 1
git fetch origin "$COMMIT"
git checkout --detach "$COMMIT"
test "$(git rev-parse HEAD)" = "${COMMIT,,}"
test -z "$(git status --porcelain)"

node -e 'const {engines}=require("./package.json"); console.log("required:",engines.node,"actual:",process.version)'
npm ci
# check 包含格式、lint、测试、前端、共用核心/Worker 类型及 Node 构建。
# 空字符串强制同源 API；移除 Vercel 的构建 SHA 覆盖，版本来自本次 HEAD。
env -u VERCEL_GIT_COMMIT_SHA VITE_API_BASE_URL= npm run check

# 只检查生成的版本文件，不读取任何真实 .env。
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
const sha=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const front=JSON.parse(readFileSync("frontend/dist/version.json","utf8"));
const api=JSON.parse(readFileSync("server/dist/version.json","utf8"));
if(front.commit!==sha || api.tag!==sha || api.runtime!=="node") process.exit(1);
console.log({commit:sha,releaseId:api.id,builtAt:api.timestamp});'
RELEASE_ID=$(node -p 'JSON.parse(require("fs").readFileSync("server/dist/version.json","utf8")).id')
[[ "$RELEASE_ID" =~ ^[0-9a-f-]{36}$ ]] || exit 1
```

`VITE_API_BASE_URL` 是前端**构建时**变量。同机部署时设为空，前端调用当前域名的 `/api`；修改运行服务的环境文件不会改变已构建的前端。不要在 API 基址后再加 `/api`。

仅需构建时可运行 `VITE_API_BASE_URL= npm run build`；`npm run build:server` 只构建 Node；`npm run start:server` 启动现有构建；`npm run dev:server` 是先构建再启动，**没有 watch**。生产构建来自干净、固定提交；Node 构建脚本本身不会替你拒绝未提交修改。

产物含义：

- `frontend/dist/`：静态前端与它自己的 `version.json`（`commit`、`builtAt`）。
- `server/dist/index.mjs` 与 `server/dist/version.json`：独立可运行的 Node 包，运行时只需受支持的系统 Node，不需要源码、Git、npm 或 `node_modules`。
- Node 元数据包含 `runtime: node`、UUID `id`、完整 SHA `tag`、ISO 时间 `timestamp`。重启不会改变 ID，重新 build 会产生新 ID。缺少/非法元数据时启动失败，不会现场编造版本；必须把两个 Node 文件作为一对发布，不能手改版本“修复”检查。

## 4. 安装版本化目录与环境文件

```bash
# 首次创建；若已有同名用户，先人工确认用途和组，不重复创建。
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin video-parser
sudo install -d -o root -g root -m 0755 /opt/video-parser/releases
sudo install -d -o root -g video-parser -m 0750 /etc/video-parser
sudo install -o root -g video-parser -m 0640 \
  deploy/server.env.example /etc/video-parser/server.env

RELEASE_DIR="/opt/video-parser/releases/$RELEASE_ID"
sudo test ! -e "$RELEASE_DIR"
sudo install -d -o root -g root -m 0755 "$RELEASE_DIR/frontend" "$RELEASE_DIR/server"
sudo cp -a frontend/dist/. "$RELEASE_DIR/frontend/"
sudo install -o root -g root -m 0644 server/dist/index.mjs server/dist/version.json "$RELEASE_DIR/server/"
sudo chown -R root:root "$RELEASE_DIR"
sudo chmod -R u=rwX,go=rX "$RELEASE_DIR"
# 首次发布，不覆盖已经存在的 current。
sudo test ! -e /opt/video-parser/current
sudo ln -s "$RELEASE_DIR" /opt/video-parser/current
```

目录布局：

```text
/opt/video-parser/
├── releases/<Node构建UUID>/
│   ├── frontend/          # frontend/dist 的内容
│   └── server/
│       ├── index.mjs
│       └── version.json
└── current -> releases/<Node构建UUID>
/etc/video-parser/server.env
```

release 由 root 持有、服务用户只读；Nginx 用户可读静态目录。不在 release 中安装依赖或写日志。上传产物时可由另一台受信构建机完成第 3 节，再传输上述目录；仍要保留同一提交和对应元数据，不能混装两次构建。

### Node 环境变量

Node 不自动读取 `.env`；服务单元用 `EnvironmentFile=/etc/video-parser/server.env` 注入。不要把环境文件放进公开静态目录，不需要填 Cloudflare 凭据。

| 变量                       | 应用默认值  | 本模板/约束                                            |
| -------------------------- | ----------- | ------------------------------------------------------ |
| `HOST`                     | `127.0.0.1` | 保持 loopback；模板使用 IPv4，与 Nginx upstream 一致   |
| `PORT`                     | `8787`      | 正整数，最大 65535；更改时同步 Nginx                   |
| `TRUST_PROXY`              | `none`      | 同机 Nginx 模板设为 `loopback`；只有这两个值           |
| `MAX_CONCURRENT_PARSES`    | `8`         | 正整数，最大 1000000                                   |
| `MAX_CONCURRENT_DOWNLOADS` | `16`        | 正整数，最大 1000000                                   |
| `MAX_DOWNLOADS_PER_IP`     | `4`         | 正整数，最大 1000000                                   |
| `SHUTDOWN_TIMEOUT_MS`      | `15000`     | 正整数毫秒，最大 2147483647；必须小于 systemd 停机期限 |

数字不能是空字符串、0、负数、小数或带单位。并发额度包括尚未结束的响应流，满额返回 `503 SERVER_BUSY`，不是无限排队。按 IP 的下载上限不会取代全局上限。

`TRUST_PROXY=none` 使用 socket 对端 IP；经 Nginx 时所有人会共用 loopback 的额度。`loopback` 仅在 socket 对端属于 loopback 时接受合法的单个 `X-Real-IP`，不采用 `Forwarded`、`X-Forwarded-For` 或 `CF-Connecting-IP`。Nginx 必须用 `$remote_addr` **覆盖**该头，其他转发链清空，不能使用 `$proxy_add_x_forwarded_for`。同主机的其他进程也能连接 loopback，因此主机本身必须可信。不要直接套用到远端负载均衡、容器网桥或 CDN 后方。

Node 为单进程内存固定窗口：每个客户端解析 10 次/60 秒、下载 120 次/60 秒；窗口从该客户端该操作的首个请求起算。超限为 429，健康和 OPTIONS 不占业务额度。限流表最多 10000 个操作/IP key，每 30 秒清理到期项，容量耗尽时失败关闭而不是放行；这些常量不是环境变量。重启会重置限流，多进程间不共享。Cloudflare 原生限流具有本地/最终一致语义，与 Node 的单进程窗口并不完全等价；本文只部署一个实例，不承诺全局精确限流。

## 5. DNS、HTTPS 证书与 Nginx

模板安装目标为 `/etc/nginx/conf.d/video-parser.conf`，内容包含 **http 级** `map`、`log_format` 和两个 `server` 块。确认主 `/etc/nginx/nginx.conf` 在 `http {}` 内包含 `conf.d/*.conf`；不要把模板再套进 `server`，也不要直接覆盖整个主配置。

**先获得证书，再安装/验证 HTTPS 配置。** 模板引用尚不存在的证书时，`nginx -t` 和启动/reload 必然失败。示例 `example.com` 与 `/etc/letsencrypt/live/example.com/` 都必须换成自己的域名和真实证书路径。

已持有有效证书时直接使用；首次申请可使用下面的 standalone 路径。在域名已解析、80 端口可达的专用 VPS 上，短暂停掉 Nginx，由 Certbot 临时占用 80 端口。此操作会中断其他站点，因此共享主机应改用已审查的 DNS 验证或独立 webroot 流程，不能照抄停机命令。

```bash
# 在安装含证书引用的新模板之前执行；替换域名与联系邮箱。
sudo systemctl stop nginx
if ! sudo certbot certonly --standalone --preferred-challenges http \
  --cert-name example.com -d example.com --email admin@example.com --agree-tos; then
  sudo systemctl start nginx
  printf '证书申请失败，已尝试恢复原 Nginx；请排查后重试\n' >&2
  exit 1
fi
sudo test -s /etc/letsencrypt/live/example.com/fullchain.pem
sudo test -s /etc/letsencrypt/live/example.com/privkey.pem

sudo install -o root -g root -m 0644 deploy/nginx.conf /etc/nginx/conf.d/video-parser.conf
sudoedit /etc/nginx/conf.d/video-parser.conf
# 专用 VPS：确认发行版默认站点可移除；先备份，再禁用默认软链接。
if [ -e /etc/nginx/sites-enabled/default ]; then
  sudo cp -L /etc/nginx/sites-enabled/default /etc/nginx/default-site.backup
  sudo rm /etc/nginx/sites-enabled/default
fi
sudo nginx -t
```

保留模板的如下约定：

- HTTP 只 308 到 HTTPS；两个 server 块均使用脱敏日志，并作为专用主机的默认站点。若已有其他默认站点，需人工整合，不能保留重复 `default_server`。
- `/api/` 反代到 `http://127.0.0.1:8787`，不去掉 `/api` 前缀；`/api` 自身直接 404。SPA fallback 不接管 API；`/assets/` 文件不存在返回 404，`/version.json` 不缓存且不存在不回退 HTML；首页也 `no-store`，避免更新后引用旧入口。
- `proxy_buffering off`、`proxy_request_buffering off`，使 NDJSON/媒体不被整包缓冲；`proxy_ignore_client_abort off` 保留断开取消；`proxy_intercept_errors off` 保留应用错误；`proxy_cache off`、`gzip off`，不用缓存或压缩改写媒体。
- 上游 HTTP/1.1，连接超时 5 秒，代理读/写超时各 45 秒，客户端请求体超时 15 秒，客户端发送超时 45 秒。它们是相关阶段/停滞超时，不是整个文件传输总时长。
- Node 接收请求头和请求体另有 10 秒总期限，每秒检查一次；持续发送零碎数据也不能延长期限。超时由 Node HTTP 层返回 408 并关闭连接、释放并发名额，不保证应用 JSON/CORS/诊断头。请求接收完成后，解析和下载响应不受该期限影响。
- 应用解析总预算约 30 秒，渐进解析先发候选、最终结果到达才可下载。媒体等待上游头最多 15 秒（含重定向），读取停滞最多 30 秒；持续传输不设总时长。反代的 45 秒给应用错误响应/流结束留余量。
- Nginx `client_max_body_size 64k`，应用解析体最大 32 KiB。超过反代限制时可能由 Nginx 直接返回 413，**不保证应用 JSON、请求编号或版本头**。
- 下载向上游请求 `Accept-Encoding: identity`。即使如此上游仍返回压缩媒体时，应用返回 502，而不是剥离编码后猜测字节数或篡改 `Content-Range`。保留 Range、206、416 及相关长度信息；媒体流开始后的失败只能终止连接，不能在视频末尾插入 JSON。

### 日志隐私是部署前置条件

专用 access log 仅写方法、`$uri`（没有 query）、状态、时间/耗时、字节数及请求编号；上游有 `X-Request-ID` 时使用它，否则使用 Nginx 自己的编号。不得在日志格式中加入 `$request`、`$request_uri`、`$args`，也不记录 Referer、请求体、报头全集或客户端完整 URL。下载 query 中可能同时含带签名的媒体 URL 和 `errorToken`。

**error log 同样可能包含原始请求和 query。** 因此模板的 HTTP/HTTPS server 都设置 `error_log /dev/null crit`，不写持久错误日志；这不是“设为 warn 就脱敏”。不要临时打开原始 error/debug 日志、curl verbose/trace、网络抓包或会导出完整请求的 APM 来排错。排错仅使用应用白名单结构化日志、固定错误码、版本和请求编号；反代自身产生的错误用脱敏 access log 的时间、状态关联，可能没有应用日志。证书/语法错误可在尚无真实流量时直接检查配置，不收集用户请求。

默认 server 之外的其他 vhost、http/main 级日志、代理商访问日志、日志收集器也必须审计，模板不能替你修改这些配置。对于包含完整请求行的早期协议错误或 TLS 层错误，要在全局配置中同样禁用会落盘的原始请求诊断；不能以“应用已脱敏”推断整条链路安全。专用日志还应设置权限、轮转与保留期。

### 证书续期

使用 standalone 证书需要续期时仍能占用 80 端口。**完成第 6 节、确认 Nginx 已运行后**，在维护窗口安装持久化 pre/post hook，续期前停掉 Nginx，续期尝试结束后重新启动。以下适用于本文使用 apt 安装 Certbot 的专用 VPS；如果这台服务器还有其他证书或站点，应先整合现有续期配置，不要叠加这套全局停启 hook。

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
printf '#!/bin/sh\n/bin/systemctl stop nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/pre/video-parser-nginx > /dev/null
printf '#!/bin/sh\n/bin/systemctl start nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/post/video-parser-nginx > /dev/null
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/pre/video-parser-nginx \
  /etc/letsencrypt/renewal-hooks/post/video-parser-nginx
sudo systemctl enable --now certbot.timer
sudo certbot renew --cert-name example.com --dry-run
sudo systemctl is-active nginx
sudo systemctl list-timers --all certbot.timer
```

替换演练命令中的证书名，确认续期演练成功、Nginx 恢复运行且定时器显示下次执行时间，并配置到期告警。hook 文件会被后续定时续期读取，行为见 [Certbot 自动续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html#automated-renewals)。若不能接受定期短暂停机，应改用 DNS 或独立 webroot 验证并审计其日志，不让 Certbot 自动替换这里的安全反代/日志配置。改用 webroot 后应移除这两个 standalone 专用 hook，避免继续停机。

## 6. systemd 启动与本机验证

```bash
sudo install -o root -g root -m 0644 deploy/video-parser.service /etc/systemd/system/video-parser.service
sudo systemd-analyze verify /etc/systemd/system/video-parser.service
sudo systemctl daemon-reload
sudo systemctl enable --now video-parser
sudo systemctl status video-parser --no-pager
curl --fail --silent --show-error http://127.0.0.1:8787/api/health
sudo ss -lntp 'sport = :8787'
sudo nginx -t
sudo systemctl enable --now nginx
```

确认监听只在 `127.0.0.1:8787`，没有公网绑定；从外部网络连接 VPS 的 8787 应失败。健康响应应为 `success: true`，`service: video-parser-api`、`status: ok`、`runtime: node`；`version` 与 release UUID 一致，`versionTag` 为目标完整提交，`versionCreatedAt` 为构建时间。

服务单元使用 `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp` 等限制；这些不取代出站防火墙。服务不写 release，标准输出/错误只送入应用脱敏日志。`SIGTERM`/`SIGINT` 停止接收新任务，已有任务最多等待 `SHUTDOWN_TIMEOUT_MS=15000`，到期取消上游并关闭连接。`TimeoutStopSec=25s` 必须大于应用期限；若提高应用期限，需要一起调整服务单元并 `daemon-reload`。长下载可能在维护时被截断，不能宣称无损/零停机更新。

启动失败可查看：

```bash
sudo journalctl -u video-parser --since '10 minutes ago' --no-pager
```

`startup_failed` 不包含原始异常或配置值。分别核对 Node 版本、路径权限、端口占用、环境变量格式以及产物配对，不要为了打印原始异常而放宽日志策略。

## 7. 公网健康、版本及真实媒体验收

在构建仓库根目录执行；`example.com` 替换为真实域名：

```bash
curl --fail --silent --show-error https://example.com/api/health
curl --fail --silent --show-error --head https://example.com/version.json
npm run release:check -- --frontend https://example.com --api https://example.com --commit "$COMMIT"
```

`/version.json` 应有 `Cache-Control: no-store`；API 响应具有 `X-Request-ID`、`X-API-Version`、`X-API-Runtime: node`。保留兼容头 `X-Worker-Version`，其值也是 Node 版本 ID，并不表示请求经过了 Worker。版本检查同时验证前端提交、API 运行时/健康/UUID/tag/时间；必须返回 `passed: true`，不能用 `--dry-run` 代替。还要确认未知 `/api/...` 返回 API 404，而不是 `index.html`。

健康通过不代表上游可用。准备 3 至 6 个有权访问的真实公开样本，必须覆盖普通视频、普通图文和实况图文，并填写预期数量、作品 ID/元信息及无水印数量下限。把样本存放在本地权限受限、未纳入版本控制的文件中：

```bash
install -d -m 0700 "$HOME/video-parser-private"
install -m 0600 scripts/acceptance-samples.example.json "$HOME/video-parser-private/samples.json"
# 用本机编辑器填写真实样本，不在工单/日志中粘贴分享文案或签名媒体地址。
# 该工具目前保留参数名 --worker，值可以是 Node API，尚无 --api 别名。
npm run release:acceptance -- --worker https://example.com \
  --samples "$HOME/video-parser-private/samples.json" --dry-run
npm run release:acceptance -- --worker https://example.com \
  --samples "$HOME/video-parser-private/samples.json"
```

脚本顺序执行真实 parse，检查资源/元信息，通过代理读取代表媒体 1 KiB 前缀后取消；上游忽略 Range 时会报告实际接收块的大小。默认单请求 45 秒、整体 120 秒，遇到限流停止。`--parse-only` 跳过媒体，不是完整验收；`--dry-run` 不联网。没有真实样本时应明确记录“尚未完成上游验收”，不可用假数据宣称通过。

最后在浏览器完成实际页面验收：确认 NDJSON 渐进结果不被 Nginx 缓冲、最终结果前下载禁用；测试直链及 API 备用下载、普通视频/图片/实况/音乐/封面、ZIP 分包、取消、失败重试和再次保存。iPhone Safari、Android 与应用内浏览器分别确认文件实际保存；前缀读取成功、页面“已发起下载”和 HTTP 200 均不证明整文件已落盘。取消代理下载后应用应释放额度，不应继续占用上游。

## 8. 更新、原子切换与回滚

在已有构建仓库的根目录获取要发布的版本，不重新克隆。下面选择远端 `main` 的最新提交；需要指定版本时，将 `COMMIT` 改为该版本的完整 SHA：

```bash
set -euo pipefail
git fetch origin main
COMMIT=$(git rev-parse --verify FETCH_HEAD)
```

保持这个 `COMMIT`，从第 3 节的 `git fetch origin "$COMMIT"` 开始继续执行，完成固定提交检出、`npm ci`、检查、构建和 `RELEASE_ID` 读取。把新 `frontend/dist` 和配对的 `server/dist` 安装到**新的** `/opt/video-parser/releases/<id>`（第 4 节的产物复制步骤）。不要重建或覆盖正在使用的 release，不重复创建用户或覆盖已维护的环境文件。

记录旧 release、Git SHA、配置版本和验收结论。配置变更另行审查/备份；环境文件与服务单元不在 release 内，因此软链接回滚不会自动还原它们。仅改代码时不要覆盖这些配置。

以下 `RELEASE_ID`/`RELEASE_DIR` 来自新构建，在维护窗口切换：

```bash
set -euo pipefail
PREVIOUS_RELEASE=$(readlink -f /opt/video-parser/current)
RELEASE_DIR="/opt/video-parser/releases/$RELEASE_ID"
sudo test -s "$RELEASE_DIR/frontend/version.json"
sudo test -s "$RELEASE_DIR/server/index.mjs"
sudo test -s "$RELEASE_DIR/server/version.json"
# 把 PREVIOUS_RELEASE 记入自己的发布记录，回滚时仍需它。
printf 'previous=%s\nnext=%s\n' "$PREVIOUS_RELEASE" "$RELEASE_DIR"

# 排空/中止旧实例，避免 current 已切换而旧 API 仍接收新业务。
sudo systemctl stop video-parser
# 同一目录/文件系统内 rename 原子替换 current；该临时路径须未被占用。
sudo test ! -e /opt/video-parser/current.next
sudo test ! -L /opt/video-parser/current.next
sudo ln -s "$RELEASE_DIR" /opt/video-parser/current.next
sudo mv -Tf /opt/video-parser/current.next /opt/video-parser/current
sudo systemctl start video-parser
curl --fail --silent --show-error http://127.0.0.1:8787/api/health
npm run release:check -- --frontend https://example.com --api https://example.com --commit "$COMMIT"
```

切换软链接同时选择配对前端/API 文件，但服务停启期间会短暂出现 502/503，已打开页面仍可能持有旧 JS。该流程是**有界停机发布**，不是并行两版本零停机；发布后刷新页面再执行第 7 节真实验收。Nginx 根路径不变时无需为代码更新 reload；若配置变化，先 `nginx -t` 再 reload。不要在此场景启用长期文件句柄缓存。

任一启动、版本或真实媒体验收失败，停止继续推广并回滚；前后端必须一起退回已知可用的同一个 release：

```bash
# PREVIOUS_RELEASE 必须是发布记录中的真实旧目录，而不是猜测的版本。
ROLLBACK_COMMIT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag' \
  "$PREVIOUS_RELEASE/server/version.json")
sudo systemctl stop video-parser
sudo test ! -e /opt/video-parser/current.next
sudo test ! -L /opt/video-parser/current.next
sudo ln -s "$PREVIOUS_RELEASE" /opt/video-parser/current.next
sudo mv -Tf /opt/video-parser/current.next /opt/video-parser/current
# 若本次同时修改配置，先恢复已审查的旧配置；服务单元变更后 daemon-reload。
sudo systemctl start video-parser
npm run release:check -- --frontend https://example.com --api https://example.com --commit "$ROLLBACK_COMMIT"
```

回滚后仍需健康、媒体与浏览器验收；进程重启会清空内存限流。保留至少上一版完整产物与配置备份，确认不再需要回滚后才清理旧 release。不要删除 `current` 指向的目录，也不要仅回滚 API 而继续使用不兼容的新前端。

<a id="separate-frontend"></a>
<a id="9-b2独立静态前端--vps-api"></a>

## 9. 可选：前端与 API 分开部署

Node、systemd、出站限制、证书及日志要求均沿用同机部署；区别只在域名、静态托管与构建配置：

1. API 使用 `api.example.com`，A/AAAA 指向 VPS；为该域名单独申请证书。将 Nginx 两个 `server_name`、HTTP 重定向目标和证书路径改为 API 域名。
2. API-only VPS 保留 `/api` 与 `/api/` 的路由/反代，删除静态 root/index、`/version.json`、`/index.html`、`/assets/` 的 location；将 `location /` 改为 `return 404;`，不在 API 域名提供 SPA。仍须在 HTTP 与 HTTPS 两块禁用原始 error log 并使用安全 access log。
3. 前端在 Vercel 等平台按 [前端构建设置](guides/deployment.md#第三步在-vercel-部署前端) 部署，构建环境设置 `VITE_API_BASE_URL=https://api.example.com`（不要附加 `/api`）。本机构建则用 `VITE_API_BASE_URL=https://api.example.com npm run build --workspace frontend`。必须是浏览器可访问的 **HTTPS**，不能填 `http://127.0.0.1:8787` 或私网地址。
4. 环境变量固化在静态产物中，变更 API 地址后必须重新构建并部署前端；给 Node 的 `server.env` 加 `VITE_API_BASE_URL` 无效。当前 API 已提供无凭据 CORS，不需要把 API 放在 Cloudflare 代理之后，也不要追加冲突的 CORS 响应头。CORS 不是访问认证或滥用防护。
5. 从同一个固定提交分别发布两个产物，确认静态托管对 `/version.json` 不缓存、不套部署登录保护且不误回退 HTML。先验证 VPS API，再发布前端；API 协议不兼容时安排维护窗口。回滚必须同时恢复静态托管的旧前端与 VPS 的旧 Node release，同机部署的软链接无法替你回滚远端前端。

```bash
npm run release:check -- --frontend https://www.example.com --api https://api.example.com --commit "$COMMIT"
npm run release:acceptance -- --worker https://api.example.com \
  --samples "$HOME/video-parser-private/samples.json"
```

只在明确确认接口兼容、刻意保持不同提交时，使用 [分别校验版本](RELEASE_CHECK.md#前后端分别发布时)。不要把“两个版本各自符合预期”解读成已验证接口兼容性。Worker / Node 入口切换也需要重新配置/构建前端并验收，不存在自动 Worker↔Node 故障切换。
