# TCP Reno 拥塞窗口与快速恢复事件回放（教学后端）

只做**发送侧拥塞控制状态**的教学事件回放：输入初始拥塞窗口、慢启动阈值和有序
ACK/超时事件，逐步输出拥塞窗口、阈值、重复确认计数、状态与建议重传动作。

- 纯后端：HTTP/JSON API + 本地 CLI，无前端、无鉴权、无外部服务。
- TypeScript + Node.js（内置 `node:sqlite`，**无需编译原生模块**）。
- 数据保存在项目内 `data/` 目录的 SQLite 文件；重启后恢复窗口与重复计数。
- Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 在线 API。

> 本项目不建立 TCP 连接、不传文件、不模拟接收窗口、真实定时器或网络吞吐率，
> 也不是完整协议栈；输出的重传动作只是**建议**，不会真正发送任何报文，
> 更不能据此推断真实网络性能。

## 环境要求

- Node.js >= 22.5（开发验证环境为 Node v25.5.0；依赖内置的 `node:sqlite`，
  运行时需要加 `--experimental-sqlite` 标志）。
- Windows PowerShell；`npm` 可用。

## 安装与构建

```powershell
npm install
npm run build       # tsc 编译到 dist/
```

## 教学演示（不落盘）

```powershell
npm run demo
```

演示序列（初态 cwnd=4, ssthresh=4）：

| 步骤 | 事件 | flightSize | cwnd 后 | ssthresh 后 | dup | 状态 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `ack` | — | 4.25 | 4 | 0 | 拥塞避免 | — |
| 2 | `dup_ack` | — | 4.25 | 4 | 1 | 拥塞避免 | — |
| 3 | `dup_ack` | — | 4.25 | 4 | 2 | 拥塞避免 | — |
| 4 | `dup_ack` | 8 | **7** | **4** | 3 | 快速恢复 | **快速重传 1 段** |
| 5 | `dup_ack` | — | 8 | 4 | 4 | 快速恢复 | — |
| 6 | `recovery_ack` | — | 4 | 4 | 0 | 拥塞避免 | — |

另外演示 `timeout`（flightSize=8）：cwnd 直接降为 1，ssthresh=4，dup=0，
建议超时重传。每一步都打印规则、公式与前后取值，便于核对。

## 状态机口径（简化的整段教学口径）

单位统一为**完整 MSS 段**；cwnd 可以是小数（如 4.25）。浮点增量结果统一
四舍五入到 6 位小数，避免 `0.30000000000000004` 类显示噪声。

- **普通确认 `ack`**：代表一个新的完整段被确认。
  - 旧 cwnd < ssthresh（慢启动）：`cwnd = cwnd + 1`；
  - 旧 cwnd >= ssthresh（拥塞避免）：`cwnd = cwnd + 1/cwnd`；
  - 计算后按**新**窗口判定状态，并把重复确认计数清零。
- **重复确认 `dup_ack`**：表示同一个当前缺口的重复确认。
  - 第 1、2 次：窗口与阈值不变，仅计数 +1；
  - 第 3 次：必须由用户显式提供当时的 `flightSize`，
    `ssthresh = max(2, floor(flightSize/2))`，`cwnd = ssthresh + 3`，
    进入快速恢复，产生**一次**快速重传建议；
  - 恢复中继续收到 `dup_ack`：每收到一个 `cwnd = cwnd + 1`（窗口膨胀），
    不再重复第三次的初始化。
- **恢复确认 `recovery_ack`**：定义为“已覆盖本次快速恢复发起时全部未确认
  数据的完整确认”。收到后 `cwnd = ssthresh`、重复计数清零、退出恢复。
  - 恢复中**不接受**普通 `ack`，必须用明确的 `recovery_ack`；
  - 恢复**外**收到 `recovery_ack` 报 `INVALID_STATE` 错误。
- **超时 `timeout`**：任何状态下都必须显式提供当时的 `flightSize`，
  `ssthresh = max(2, floor(flightSize/2))`、`cwnd = 1`、重复计数清零、
  退出恢复并进入慢启动，产生超时重传建议。
- **阈值折半只使用用户显式给出的 `flightSize`**，严禁用拥塞窗口代替。
- 新的普通确认会打断旧缺口的重复计数（清零后开始新一轮）。

## 明确未实现的协议特性

- 无 NewReno 部分确认（partial ACK）处理、无 SACK；
- 不模拟 RTT、RTO 真实定时器、接收窗口、排队、丢包率或吞吐率；
- 不处理连接建立/拆除、报文封装与真实网络 I/O；
- 不做拥塞窗口与接收窗口的最小值仲裁，不做发送调度；
- 飞行数据量（flightSize）仅作为事件输入，系统不自行估算。

进程重启只是从 SQLite 恢复保存的状态，**不会**被解释成 TCP 超时。

## HTTP API

启动（默认自动选择空闲端口，仅监听 127.0.0.1）：

```powershell
npm start                                         # 自动空闲端口，数据 data/reno.db
node --experimental-sqlite dist/src/server.js --port 8080 --db data/reno.db
# 也可用环境变量 PORT / RENO_DB
```

启动后 stdout 输出一行 JSON，例如
`{"status":"listening","baseUrl":"http://127.0.0.1:64238","db":"data/reno.db"}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与公开上限 |
| POST | `/models` | 创建模型 `{id?, initialCwnd, initialSsthresh}`，id 缺省自动生成 |
| GET | `/models/:id` | 查询初态、版本与当前状态 |
| POST | `/models/:id/events` | 原子提交事件批次 |
| GET | `/models/:id/events?limit=&offset=` | 分页查询步骤（含计算依据） |
| GET | `/models/:id/steps/:seq` | 查看某一步的完整计算依据 |
| GET | `/models/:id/replay` | 从初态回放全部步骤 |
| GET | `/models/:id/export` | 导出初态与**原始事件** JSON |

提交批次请求体：

```json
{
  "requestId": "batch-001",
  "expectedVersion": 0,
  "events": [
    { "type": "ack" },
    { "type": "dup_ack" },
    { "type": "dup_ack" },
    { "type": "dup_ack", "flightSize": 8 },
    { "type": "recovery_ack" }
  ]
}
```

- `expectedVersion` 可选（省略表示不检查）；与当前版本不符返回
  `409 VERSION_CONFLICT`，旧版本提交不会覆盖新状态。
- 同一 `(modelId, requestId)` 且载荷完全相同：返回原批次结果，
  HTTP 200 且 `deduplicated: true`，**不重复处理事件**。
- 同一 `requestId` 但载荷不同：`409 REQUEST_ID_CONFLICT`。
- 批次内先整体演算再写库；任何事件非法都整体回滚，
  错误中带 `eventIndex`（批次内从 0 开始），不会先改一半窗口。

### 错误码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 初态/事件字段非法、缺 flightSize、JSON 非法 |
| 400 | `INVALID_STATE` | 恢复中收 ack、恢复外收 recovery_ack 等状态错误 |
| 400 | `STEP_NOT_FOUND`/`MODEL_NOT_FOUND`（404） | 历史读取目标不存在 |
| 404 | `NOT_FOUND` | 路由不存在 |
| 409 | `VERSION_CONFLICT` | 乐观版本过期 / 并发提交冲突 |
| 409 | `REQUEST_ID_CONFLICT` / `MODEL_EXISTS` | 请求编号复用但载荷不同 / 模型 id 已存在 |
| 413 | `BATCH_TOO_LARGE` / `EVENT_LIMIT_REACHED` | 超批次长度或累计上限 |
| 500 | `STORAGE_ERROR` / `INTERNAL_ERROR` | SQLite 存储失败等 |

### 公开上限

- 单批次最多 `200` 个事件；单模型累计最多 `100000` 个事件；请求体上限 2MB。
  可在 `src/types.ts` 调整。

curl 示例（PowerShell）：

```powershell
curl.exe -s -X POST http://127.0.0.1:<port>/models `
  -H "Content-Type: application/json" `
  -d '{\"id\":\"demo\",\"initialCwnd\":4,\"initialSsthresh\":4}'
```

## CLI

```powershell
node --experimental-sqlite dist/src/cli.js demo
node --experimental-sqlite dist/src/cli.js simulate --cwnd 4 --ssthresh 4 `
  --events '[{"type":"ack"},{"type":"dup_ack","flightSize":8}]'   # 纯演算不落盘
node --experimental-sqlite dist/src/cli.js create m1 --cwnd 4 --ssthresh 4
node --experimental-sqlite dist/src/cli.js submit m1 --request-id b1 `
  --expected-version 0 --events '[{"type":"dup_ack","flightSize":8}]'
node --experimental-sqlite dist/src/cli.js state m1
node --experimental-sqlite dist/src/cli.js steps m1 --limit 50 --offset 0 --explain 4
node --experimental-sqlite dist/src/cli.js replay m1
node --experimental-sqlite dist/src/cli.js export m1
node --experimental-sqlite dist/src/cli.js limits
# 所有持久化命令可用 --db 路径 指定数据库（默认 data/reno.db）
```

CLI 表格展示旧/新 cwnd、ssthresh、dup、中文状态与重传建议；`--explain`
输出该步规则、公式与全部前后取值。

## 存储与一致性

SQLite 三张表（见 `src/store.ts`）：

- `models`：初态、版本（每成功一批 +1）、累计事件数；
- `batches`：requestId、基础/新版本、起始序号、原始载荷 JSON；
- `events`：每步前后状态、动作建议与解释 JSON，保留原始事件类型与 flightSize。

提交在单个 `BEGIN IMMEDIATE` 事务内完成并配合乐观版本更新。
对相同初态与事件序列，**逐条提交、分批提交、重启后续交**结果一致
（有测试覆盖）。

## 测试

```powershell
npm test          # 先构建，再运行 node:test（14 个测试）
npm run typecheck # 仅类型检查（含测试）
```

测试覆盖：独立状态转移表逐步核对（慢启动跨阈值、dup 被新确认打断、
快速恢复中超时、flightSize 下限为 2、恢复后状态判定）、非法状态回滚、
requestId 幂等与冲突、版本冲突、重启恢复、逐条/分批一致性、步骤分页、
上限校验、存储失败路径，以及全部 HTTP 错误码与历史读取。

## 目录结构

```
src/
  engine.ts   纯函数 Reno 状态机（无 I/O，可独立核对）
  types.ts    类型、错误码与公开上限
  store.ts    SQLite 持久层（原子批次/幂等/版本）
  server.ts   HTTP/JSON API
  cli.ts      命令行（演示/演算/持久化操作）
test/         node:test 测试（engine/store/api）
data/         SQLite 数据目录（运行时生成，已 gitignore）
```
