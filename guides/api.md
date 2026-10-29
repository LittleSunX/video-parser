# API 说明

[返回 README](../README.md) · [部署指南](deployment.md) · [API 说明](api.md) · [实现与开发说明](implementation.md)

Cloudflare Worker 与 Node 共用以下接口。本地 API 默认地址为 `http://127.0.0.1:8787`，生产环境使用自己部署的 HTTPS API 基址。

| 方法 | 路径            | 用途                           |
| ---- | --------------- | ------------------------------ |
| POST | `/api/parse`    | 解析作品，支持 JSON 或渐进结果 |
| GET  | `/api/download` | 流式代理媒体，供备用下载等使用 |
| GET  | `/api/health`   | 健康与版本信息                 |

## 解析作品

```http
POST /api/parse
Content-Type: application/json
```

请求：

```json
{
  "url": "https://v.douyin.com/xxxx/"
}
```

也可以直接传完整的抖音分享文案。

同时支持 `application/x-www-form-urlencoded`，字段仍为 `url`。网页使用 `URLSearchParams` 提交分享文案，首次跨域解析即可直接 POST，减少一次 OPTIONS 预检；不缓存作品或媒体地址，不改变解析策略、画质、资源数量及作者、封面、音乐等返回信息。

```http
POST /api/parse
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

url=https%3A%2F%2Fv.douyin.com%2Fxxxx%2F
```

两种格式均受 32 KiB 请求体和 5000 字符输入限制，继续执行域名校验与解析限流。表单只接受一个 `url` 字段；字节限制按编码后的请求体计算。网页在表单编码超过请求体上限时直接使用 JSON，避免缩小原有长文案的可提交范围。

跨域分开发布时先更新 API，再更新前端；VPS 同域部署按版本目录成对切换。旧 JSON 调用保持兼容；新前端连接旧 API 收到 HTTP 415 时，仅回退一次 JSON 请求，其他错误不自动重复解析。只有前后端都更新后，普通分享文案的首次解析才能省掉预检。

网页同时通过 `Accept: application/x-ndjson` 请求渐进结果。这个请求头仍满足简单跨域请求条件，同一次 POST 先返回 `{"type":"preview","data":...}`，选优完成后返回 `{"type":"result","data":...}`；流中失败返回 `{"type":"error","error":...}`。候选内容可提前显示，下载入口在最终结果到达前锁定；流中断、取消或没有最终事件时不会把候选结果当成成功。旧 API 返回 JSON 时无需重发请求；未请求此格式的 API 调用仍返回原 JSON。

渐进显示改善的是首次看到内容的等待，最终可下载时间仍包括资源完整性和画质补强。重试列表、画质选择和已知实况资源保留规则不因此缩减。取消或关闭响应流会取消同一解析任务。

视频响应示例：

```json
{
  "success": true,
  "data": {
    "platform": "douyin",
    "mediaType": "video",
    "videoId": "1234567890",
    "sourceUrl": "https://...",
    "title": "作品标题",
    "author": "作者昵称",
    "cover": "https://...",
    "duration": 12345,
    "videoUrl": "https://..."
  }
}
```

> `duration` 单位统一为 **毫秒**。

解析成功的数据还包含 `parseStatus` 和 `parseReason`：正常满足策略条件时为 `complete` / `complete`；超时或策略耗尽返回已有资源时为 `unverified` / `timeout` 或 `unverified` / `exhausted`。`unverified` 不表示已经证明缺项，`complete` 也不是对上游完整性的独立证明。前端兼容不提供这些字段的旧后端；要显示新提示，需部署更新后的前后端。

图文结果另有 `imagesComplete`，表示解析来源列出的图片及已声明实况资源是否已获取，与各图片的 `watermarkFree` 独立。完整来源必须覆盖合并后的列表才可确认；新增资源或明确缺项会撤销确认。此字段不保证上游未提供的资源也已获取。前端在 `imagesComplete: true` 时不再把策略耗尽或超时误提示为缺图；没有此字段的旧后端仍使用原有完整性提示。

图文 / Live Photo 会返回：

```json
{
  "mediaType": "image",
  "images": [
    {
      "url": "https://...",
      "livePhotoUrl": "https://...",
      "watermarkFree": true
    }
  ],
  "musicUrl": "https://...",
  "musicTitle": "背景音乐"
}
```

## 备用下载

```http
GET /api/download?url=<MEDIA_URL>&filename=<FILE_NAME>
```

该接口由 Worker 或 Node 获取媒体并流式转发给浏览器。网页默认优先请求解析结果中的媒体直链；视频、图片、Live Photo、封面、音乐和 ZIP 批量任务均遵循 [下载策略](implementation.md#下载策略)，并非所有文件都经过此接口。

网页会在以下情况调用它：

- 普通视频或单个实况 MP4 直连下载失败、超过页面缓冲阈值，且任务未被取消时；文件已接收但发起保存失败时使用“再次保存”，不重新下载。
- 普通视频的解析结果已提供有效文件大小，且超过 64 MiB 时，跳过页面直连缓冲，直接交给 API 流式下载。
- 单张图片、封面或音乐直连发生 `NETWORK`、`TIMEOUT`、`EXPIRED`、`INVALID_MEDIA` 错误时，回退一次；取消、文件过大等其他错误不自动回退。
- ZIP 中某个媒体获取失败时回退一次；取消和 `TOO_LARGE` 不触发代理回退，打包仍在浏览器完成。
- 用户手动选择“备用下载”时。

接口通过 `Content-Disposition` 提供建议文件名；自定义文件名本身不会让网页强制走代理，直连成功后也会使用建议文件名保存。实际名称和保存操作由浏览器决定。

## 健康检查

```http
GET /api/health
```

响应节选（省略版本 ID、提交号和时间）：

```json
{
  "success": true,
  "data": {
    "service": "video-parser-api",
    "status": "ok",
    "runtime": "node"
  }
}
```

Worker 的 `runtime` 为 `cloudflare-worker`。完整版本字段和校验方法见 [部署版本检查](../RELEASE_CHECK.md)。

## 限制与保护

Worker 使用 Cloudflare 原生 Rate Limiting；Node 使用单进程内存固定窗口。按客户端 IP 的额度如下：

| 接口                | 限制         |
| ------------------- | ------------ |
| `POST /api/parse`   | 60 秒 10 次  |
| `GET /api/download` | 60 秒 120 次 |

其他保护：

- 仅接受 HTTPS 资源
- 拒绝 URL 用户名 / 密码
- 拒绝非 443 自定义端口
- 媒体下载域名白名单
- 解析请求体最大 32 KiB（JSON / 表单均适用）
- 分享文案最大 5000 字符
- 下载 URL 最大 8192 字符
- API 解析总预算约 30 秒
- 前端等待上限 35 秒
- 支持主动取消解析
- 超限返回 HTTP 429

Node 接收请求头及请求体有 10 秒总期限，每秒检查一次；超时由 HTTP 层返回 408 并关闭连接，不保证应用 JSON、CORS 或诊断头。请求接收完成后，该期限不限制解析或下载响应时长。

健康检查和 OPTIONS 请求不占用业务限流额度。Cloudflare 限流的本地/最终一致语义与 Node 的固定窗口不完全相同；Node 重启会重置额度，多进程不共享，限流 key 数量有上限及过期清理。Node 默认全局并发解析 8、下载 16、单 IP 下载 4，满额返回 503。

域名 allowlist 不等于 DNS/IP 层 SSRF 防护；VPS 必须额外限制出站私网、loopback、metadata 等目标，并保持 Node loopback 监听。代理必须覆盖可信客户端 IP、禁用含 query/签名 URL/`errorToken` 的原始访问及错误日志，具体见 [VPS 安全部署](../VPS_DEPLOY.md)。

## 错误与诊断

应用在响应开始前失败时，通常返回非 2xx 状态和以下结构：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "请输入有效的作品分享链接或分享文案"
  }
}
```

限流为 HTTP 429；容量不足或服务不可用可能返回 503，有 `Retry-After` 时应按其秒数等待。渐进解析开始后的失败通过 `error` 事件返回，不能只看 HTTP 200 判断成功；媒体流开始后的失败会终止连接。网页原生下载的错误回传模式、Node HTTP 层或反代自行产生的错误，可能不是 JSON。

应用响应提供 `X-Request-ID`、`X-API-Version` 和 `X-API-Runtime`，并保留兼容头 `X-Worker-Version`。排查时记录错误码和请求编号，避免记录含签名的媒体 URL。字段类型以 [shared/video.ts](../shared/video.ts) 为准。
