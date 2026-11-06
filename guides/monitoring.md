# 运行监控与日志告警

第一版面向使用 systemd 的 Node VPS：独立定时探测 `/api/health`，读取指定服务最近十分钟的诊断日志，按构建版本统计，并将告警与恢复记录写入本机 journal。默认每次采样结束后约一分钟再运行，不发送外部通知，也不执行真实作品解析或媒体下载探测。

## 查看哪些数据

- `health`：健康探测结果、运行环境、构建版本和可用的提交号。默认探测本机 Node，只证明 API 健康；需要覆盖 HTTPS 和反代时，把私有配置中的地址改为公网 `/api/health`。
- `logs.versions`：按构建版本统计解析终态、成功率、首个可用结果及最终结果 P50/P95、上游 403/429/超时、下载响应状态和代理传输终态。
- `activeAlerts`：当前仍处于告警状态的规则。`monitor_alert` 记录状态变化；`firing` 表示首次告警，`reminder` 表示持续异常提醒，`recovered` 表示恢复。

解析成功率沿用诊断统计的样本口径；客户端取消和未结束请求不计入成功率分母。解析服务错误告警只统计 5xx 或解析终态错误，普通 400 输入错误不会触发该告警。P95 采用已有 `sinceRequestMs`，不是响应头到达时间。

`download_transfer` 只表示后端读取的媒体流正常结束、出错或取消。HTTP 200/206 响应头不能代替传输成功，主动 Range 请求也计为一次传输，不等于整个文件，更不能证明用户已保存到相册。浏览器直连不经过 API，因此本工具不统计直连成功率或直连回退率。

## 告警规则

| 规则                      | 默认条件                                                      |
| ------------------------- | ------------------------------------------------------------- |
| `service_unavailable`     | 健康探测失败、超过 5 秒、返回异常格式或重定向                 |
| `diagnostics_unavailable` | 无法读取日志、日志超限，或健康 API 的当前版本没有可用诊断记录 |
| `parse_server_errors`     | 至少 20 个已结束解析样本，服务错误占比达到 20%                |
| `parse_latency`           | 至少 20 个终态耗时样本，P95 达到 15 秒                        |
| `upstream_rejected`       | 至少 20 次非取消上游尝试，403/429 合计占比达到 50%            |
| `upstream_timeouts`       | 至少 20 次非取消上游尝试，超时占比达到 50%                    |
| `proxy_request_errors`    | 至少 20 个下载响应，5xx 占比达到 20%                          |
| `proxy_transfer_errors`   | 至少 20 个非取消传输终态，失败占比达到 20%                    |

连续两轮满足条件才告警，连续两轮有足够正常证据才恢复，持续异常最多每 30 分钟提醒一次。每轮都是滑动窗口，连续异常不代表发生了两批独立故障。低流量、日志不可用或当前版本无数据时，业务指标为未知，不触发业务告警，也不把已有告警误判为恢复。

健康请求本身会生成诊断记录，无业务访问时仍可检查日志来源。服务停机且窗口无日志时，只能确定服务异常，不额外断言日志系统故障。监控不依赖 API 服务启动，API 停止后仍可运行。

## 随一键发布启用

已完成基础 VPS 配置后，将代码合并到 `main`，在 **Deploy VPS → Run workflow** 选择 `main` 发起一次新运行即可；不要重新运行旧提交的历史任务。不需要新增 GitHub Secrets、手动上传监控文件或另外重启服务。首次启用要求 systemd 245 及以上、`systemd-journal` 组和既有 `/usr/bin/node`；不满足条件会在停止业务服务前拒绝发布。

新发布包必须包含监控程序和全部配置模板。发布器会自动安装 service/timer、创建缺失的私有配置、配置专用 journal，并先实际采样一次。只有采样结果新鲜、API 版本正确、当前版本日志可读取、timer 已启用且运行时，服务器才记录发布成功。

监控程序独立安装在 `/opt/video-parser/monitor/monitor.mjs`，不依赖 `current`。重复发布更新监控程序、service/timer 和本项目的 `60-video-parser-journal.conf` 服务补充配置，但保留已有 `/etc/video-parser/monitor.json`、`/etc/systemd/journald@video-parser.conf` 和告警状态。对 service/timer 的额外定制使用单独的 systemd drop-in 文件，不直接编辑托管模板。

安装、服务启动或首次采样失败时，发布器尝试恢复原有监控文件、timer 状态和前后端版本，并将本次发布标为失败；恢复也失败时会明确记录 `rollback_failed`。强制结束发布进程或服务器失联不属于自动恢复保证，仍需检查部署记录。基础系统软件、证书、Nginx 配置仍按 [VPS 部署指南](../VPS_DEPLOY.md) 初始化。

按实际端口、服务名和流量修改 `/etc/video-parser/monitor.json`。该文件及监控状态都留在服务器；本地配置放到已忽略的 `docs/`，不要提交真实地址或运行记录。模板使用动态系统用户，只读业务服务日志，状态目录由 systemd 管理；配置文件通过 `systemd-journal` 组提供读取权限。

```bash
# 最近采样、告警和恢复记录
sudo journalctl --namespace=video-parser -u video-parser-monitor.service --since '1 hour ago' -o cat
# API 诊断日志（启用前的旧记录仍在默认 journal）
sudo journalctl --namespace=video-parser -u video-parser.service --since '10 minutes ago' -o cat
# 最近一次完整聚合快照及持久化告警状态
sudo cat /var/lib/video-parser-monitor/latest.json
# 确认定时任务实际在运行
systemctl list-timers video-parser-monitor.timer
systemctl status video-parser-monitor.service
```

`monitor_failed` 或 service 失败表示监控自身未完成，例如配置错误、状态损坏、时钟回退或写盘失败，不能解释为业务正常。快照原子更新；状态文件损坏会停止本轮处理，避免静默重置后重复告警。确认原因后可备份并移走 `latest.json` 重建状态，已有告警去重状态也会随之重置。修改监控配置会开始新的告警判定周期。

模板限制单次运行 45 秒、内存 384 MiB；journal 读取最多 15 秒、64 MiB、单行 64 KiB，单窗口最多 100,000 个请求和 16 个构建版本。超限按采集失败处理，缩短窗口或分离服务日志后再运行。正常运行会抑制重复告警；若进程在快照写入后、journal 输出前被强制终止，该轮告警可在 `latest.json` 的 `alerts` 中找回。

## 日志容量与清理

API 和监控进程的输出进入 `video-parser` 专用 journal namespace，默认配置如下：

- 磁盘日志 `SystemMaxUse=128M`，单文件 `SystemMaxFileSize=8M`；内存回退日志 `RuntimeMaxUse=32M`。
- `MaxRetentionSec=7day`，`MaxFileSec=1day`；journald 自动轮转并清理归档日志。活跃文件不被直接删除，因此这是保留策略，不是任意时刻精确的 128 MiB 硬上限。
- `ForwardToSyslog=no`，避免这部分日志再复制到系统 syslog；全局 journald、rsyslog 和其他应用配置不变。启用前的历史记录保留，按原有系统策略清理。
- `latest.json` 每轮原子覆盖，只保留最近一次统计与告警状态，不按分钟新增文件。

需要调整容量或保留天数时，只修改服务器上的 `/etc/systemd/journald@video-parser.conf`，下次发布会保留配置并重启本项目 journal 使其生效。不会对全机日志执行 vacuum 或删除历史记录。

Nginx 访问日志仍沿用发行版 `/etc/logrotate.d/nginx` 与 `logrotate.timer`，本次发布不改 Nginx 日志路径、不添加重叠轮转规则；其周期和份数以服务器现有配置为准。检查专用 journal 占用可执行 `sudo journalctl --namespace=video-parser --disk-usage`。部署包和旧 release 的保留不属于日志轮转范围。

## 本地验证与边界

```bash
# 单次采样；非 Linux 环境可读取带 timestamp 的原始 NDJSON，或 journalctl -o json 导出的记录
npm run monitor:once -- --config docs/monitor.local.json --state-dir docs/monitor-state --log-file docs/api.ndjson
```

同一状态目录不允许并行运行。命令正常结束会释放锁；命令行进程被强制终止时，确认旧进程已退出后再清理该状态目录的 `monitor.lock`。systemd 模板将锁放在运行时目录，服务退出后由系统清理。采集输出只保留固定分类、版本和聚合数字，不输出作品内容、媒体地址、请求编号、原始异常或探测地址。

统计只覆盖能观察到的诊断事件：日志丢失、窗口边界和跨窗口长下载会造成未结束样本；Node HTTP 适配层在进入业务核心之前的拒绝不包含在核心解析统计中。没有新增前端数据上报。

这是一台服务器上的本机监控，服务器整机停机时也无法运行或通知；跨主机探测和外部通知留待后续接入。手动切回尚未包含 `monitor.mjs` 的旧业务 release 时，独立安装的监控仍可运行；用旧发布包发布时也保留现有监控。旧版本日志没有代理传输终态时，这项指标保持未知。

配置语义参考 [journalctl 官方文档](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)、[systemd.timer 官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) 和 [journald.conf 官方文档](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)。
