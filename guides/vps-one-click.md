# VPS 一键发布

发布会自动安装并验证[运行监控与本机告警](monitoring.md)，同时为 API 和监控配置专用日志保留策略；首次无需另行安装监控。

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

一键发布负责更新已有应用，并安装本项目的监控 service/timer 和 journal 补充配置。不负责安装系统软件、签发证书或替换 Nginx、API 主 service、业务环境配置。首次基础配置完成后，每次更新复用这些配置。监控要求 systemd 247 及以上；默认日志容量约 128 MiB、保留 7 天，已有私有监控阈值及专用日志配置不会被覆盖。

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

工作流在独立的构建任务中安装依赖、执行测试并打包。部署任务根据产物 ID 取回同一次运行的发布包，校验后使用主干对应提交中的发布脚本。只有部署任务可以读取生产环境的 Secrets。密钥和连接配置写入该任务的临时目录，任务结束时清理。

Actions 日志显示提交和发布结果，连接目标和原始 SSH 输出仅供本机排查。填写 Secret 时保留私钥完整的头尾和换行。

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

监控安装和首次采样也属于发布事务。成功记录包含 `monitoring: verified`；失败时恢复原监控安装及 timer 状态，同时尝试恢复业务版本。独立安装的监控不依赖业务 `current`，因此之后手动回滚到早期业务 release 仍可监控服务可用性。

服务器先在临时目录展开新版本，写完文件和切换记录后才将它移到正式版本目录。如果解包时磁盘写满，释放空间后可以用同一份发布包重试。

服务器切换完成后，客户端从公网再次核对提交号、前端构建时间、Node 运行时和本次构建的 UUID。若这一步失败，先查看服务器的 `/opt/video-parser/last-deployment.json`，再核对 `current`、健康接口及公网版本。服务器可能已经成功切换。需要在已有正式版本目录的情况下重新发布同一提交时，重新运行整个工作流以生成新的构建 UUID。

旧版本目录会保留，便于按 [手动回滚步骤](../VPS_DEPLOY.md#8-更新原子切换与回滚) 排查和恢复。自动回滚依赖 SSH 连接和服务器仍可用，不覆盖服务器失联、进程被强制结束或旧版本本身无法启动的情况；这些情况下需要按发布日志检查服务器当前状态。

Nginx、API 主 service、证书和环境文件不属于应用版本目录；如果另外改动过这些配置，切回应用版本不会还原它们。监控文件仅在本次发布失败时由发布器恢复，事后手动回滚业务版本保留已安装监控。不要在更新过程中删除正在使用的版本或上一版。
