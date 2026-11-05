# VPS 一键发布

[返回 README](../README.md) · [首次配置 VPS](../VPS_DEPLOY.md) · [版本检查](../RELEASE_CHECK.md)

完成一次服务器和 SSH 配置后，日常更新只需在 GitHub 打开 **Actions → Deploy VPS → Run workflow**。工作流从所选主干提交检查和构建，把前端与 Node 后端一起上传，切换到新版本并核对线上版本；启动或版本检查失败时恢复上一版。

本流程用于 **Nginx + Node 同源部署**，固定使用以下已有结构：

| 内容           | 位置                                  |
| -------------- | ------------------------------------- |
| 配套版本目录   | `/opt/video-parser/releases/<版本>`   |
| 当前版本软链接 | `/opt/video-parser/current`           |
| systemd 服务   | `video-parser`                        |
| Node 监听      | `127.0.0.1:8787`                      |
| 网页与 API     | 同一个 HTTPS 域名，API 路径为 `/api/` |

前端构建使用 `VITE_API_BASE_URL=/`，因此解析和备用下载均请求当前站点。浏览器优先直连媒体 CDN 的下载策略继续生效。

## 1. 一次性准备服务器

先按 [VPS 部署指南第 1–7 节](../VPS_DEPLOY.md#1-准备与安全边界) 完成 Node 运行时、服务用户、Nginx、HTTPS、网络和首个配套版本。启用自动发布前，确认：

- `/opt/video-parser/current` 是指向 `releases/` 内完整版本的软链接，前端和 Node 的版本文件配套。
- `video-parser` 服务能启动，`http://127.0.0.1:8787/api/health` 返回健康状态及 Node 版本。
- 公网站点的 `/version.json` 和 `/api/health` 都能直接访问，二者提交一致。
- SSH 发布账号是已有运维账号，使用专用部署密钥；该账号能非交互执行所需的特权发布命令，或使用已授权的 root 账号。普通账号的 `sudo -n` 需要可用。

一键发布负责更新已有应用，不负责安装系统软件、签发证书或替换 Nginx、systemd、环境配置。首次配置完成后，每次更新都复用这些配置。

### 从静态前端迁移

如果现有 VPS 仅提供静态网页，前端仍连接独立的 Worker API，需要先完成一次迁移：由同机 Nginx 将 `/api/` 转发给 Node，并将网页根目录指向 `/opt/video-parser/current/frontend`。

迁移完成后再启用此工作流。为其他站点继续保留 Vercel + Worker 的发布配置，不需要把 Cloudflare 凭据填入本流程。

## 2. 一次性配置 SSH 密钥与主机指纹

在受信任的电脑创建仅用于该站点发布的 SSH 密钥，例如：

```bash
ssh-keygen -t ed25519 -f video-parser-deploy -C video-parser-deploy
```

GitHub 非交互发布使用专用的无口令密钥；将公钥 `video-parser-deploy.pub` 加入服务器发布账号的 `~/.ssh/authorized_keys`。私钥保存在下一节的 GitHub Secret 或本机私有文件中，不加入仓库。

通过已核实身份的 SSH 连接或服务器控制台核对主机公钥指纹，保存对应的 `known_hosts` 记录。22 以外的端口使用 `[主机]:端口` 格式。不要在每次发布时通过临时 `ssh-keyscan` 直接信任当时返回的密钥；更换服务器主机密钥时，重新核实后更新记录。

先在本机验证一次免密连接：

```bash
ssh -i ./video-parser-deploy -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=./known_hosts deploy@server.example.com true
```

普通发布账号还需确认 `sudo -n` 能运行发布操作。该账号发布受信任的服务器程序，需按实际运维权限配置；本项目不会修改 SSH 登录方式或自动授予 sudo 权限。

## 3. 在 GitHub 设置发布环境

打开仓库 **Settings → Environments**，创建名为 **`production-vps`** 的环境，允许部署分支设为 `main`。然后配置以下环境 Secrets；实际主机、账号和站点地址也使用 Secret，使工作流日志自动遮盖这些值：

| 类型   | 名称                  | 示例或内容                                         |
| ------ | --------------------- | -------------------------------------------------- |
| Secret | `VPS_HOST`            | `server.example.com`，SSH 主机名或 IP              |
| Secret | `VPS_USER`            | `deploy`，服务器上的发布账号                       |
| Secret | `VPS_PORT`            | `22`，不填时默认 22                                |
| Secret | `VPS_SITE`            | `https://video.example.com`，公网 HTTPS 站点根地址 |
| Secret | `VPS_SSH_PRIVATE_KEY` | 上一步私钥文件的完整内容                           |
| Secret | `VPS_SSH_KNOWN_HOSTS` | 已核实的 SSH 主机公钥记录                          |

工作流只在 `main` 上运行，发布同一站点的任务按顺序执行，不会取消正在执行的版本切换。SSH 开启严格主机校验，缺少配置或无法免密连接会停止发布。

密钥和连接配置只写入该次 Actions 运行的临时目录，任务结束时清理。填写 Secret 时保留完整的头尾和换行；不要把私钥粘贴到 Issue、PR 或公开日志里。

## 4. 以后如何发布

1. 将准备发布的 PR 合并到 `main`。
2. 打开 **Actions → Deploy VPS → Run workflow**，选择 `main` 并运行。
3. 等待工作流检查、构建、上传和版本核对完成。
4. 打开站点刷新页面，再检查真实作品解析及保存。

工作流文件合并到默认分支后，GitHub 才会显示手动运行入口。推送或合并代码本身不会自动触发这个发布工作流。

发布会执行 `npm run check`，用同一提交构建前后端，打包并验证配套版本。服务器将新文件写入独立版本目录，排空旧服务、原子切换 `current`、启动 Node，再核对本机健康和公网前后端版本。Nginx 的网页根路径不变时无需为代码更新重载配置。

切换期间会有短暂服务中断，进行中的长下载可能受影响。版本、健康检查通过后，还应按 [真实验收步骤](../VPS_DEPLOY.md#7-公网健康版本及真实媒体验收) 核对解析及实际文件保存。

## 5. 从本机执行同一条发布命令

也可以把连接配置保存到本地已忽略的 `docs/vps-deploy.json`：

```json
{
  "host": "server.example.com",
  "user": "deploy",
  "port": 22,
  "site": "https://video.example.com",
  "identityFile": "C:/Users/you/.ssh/video-parser-deploy",
  "knownHostsFile": "C:/Users/you/.ssh/known_hosts"
}
```

先安装项目依赖、检出要发布的提交，并保持 Git 工作区已提交。预览配置和当前提交：

```bash
npm run deploy:vps -- --config docs/vps-deploy.json
```

实际发布：

```bash
npm run deploy:vps -- --config docs/vps-deploy.json --deploy
```

真实发布会先运行检查与构建，因此不需要另外手工上传文件、切软链接或重启后端。版本以本次命令启动时的完整 Git SHA 为准。

## 6. 发布失败与回滚

上传、校验或首次预检失败时，旧版本继续运行。切换后若新服务启动失败，或服务器检查到本机/公网版本不匹配，服务器发布器尝试恢复旧 `current`、启动旧服务并核对健康；工作流仍报告本次发布失败。

服务器发布器完成后，客户端还会从公网再次核对前后端版本。若这一步因客户端网络问题等原因失败，命令会报告失败，但服务器可能已成功切换，不表示已经自动回滚。应先查看服务器的 `/opt/video-parser/last-deployment.json`，再核对 `current`、健康接口及公网版本，确定当前实际运行状态。

旧版本目录会保留，便于按 [手动回滚步骤](../VPS_DEPLOY.md#8-更新原子切换与回滚) 排查和恢复。自动回滚依赖 SSH 连接和服务器仍可用，不覆盖服务器失联、进程被强制结束或旧版本本身无法启动的情况；这些情况下需要按发布日志检查服务器当前状态。

Nginx、systemd、证书和环境文件不属于应用版本目录；如果另外改动过这些配置，切回应用版本不会还原它们。不要在更新过程中删除正在使用的版本或上一版。
