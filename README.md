# TCP Reno 拥塞窗口与快速恢复事件回放（教学后端）

一个只做**发送侧拥塞控制状态机**的事件回放服务：给定初始拥塞窗口、慢启动阈值和有序
的 ACK / 超时事件，逐步输出窗口、阈值、重复确认计数、状态以及建议的重传动作。

技术栈：TypeScript + Node.js（内置 `node:http`、`node:sqlite`，**零第三方运行时依赖、零原生模块**）。
仅提供 HTTP API 与本地 CLI，不建 TCP 连接、不发包、不需要 Docker/WSL/网络服务。

## 教学简化口径（务必先读）

- 单位统一为**完整 MSS 段**。`ssthresh`、`flightSize` 为正整数；`cwnd` 可以是小数。
- 本项目**不模拟**：TCP 连接握手、接收窗口、真实 RTO 定时器、RTT、网络吞吐率、报文发送；
  也不是完整协议栈。所有“重传”都只是**建议动作文本**，不会真正发送任何字节。
- 折半阈值采用固定整段口径：`ssthresh = max(2, floor(flightSize / 2))`。
  `flightSize` 必须在**第三次重复确认**和 **timeout** 事件上由调用方显式提供；
  **不能**用当前 `cwnd` 代替 flightSize。
- 普通 `ack` 表示“一个新的完整段被确认”：
  - 若旧窗口 `< ssthresh`（慢启动）：`cwnd = cwnd + 1`；
  - 否则（拥塞避免）：`cwnd = cwnd + 1/cwnd`；
  - 计算后依据**新窗口**判定状态，并清零重复确认计数。
  - 状态判定边界：`cwnd < ssthresh` 为慢启动，`cwnd >= ssthresh` 为拥塞避免。
- `dup_ack` 表示“当前同一个缺口”的重复确认：
  - 第 1、2 次：窗口不变，只增加计数；
  - 第 3 次：按当时 flightSize 折半设置阈值，`cwnd = 新阈值 + 3`，进入快速恢复，
    仅在这一步建议一次 `FAST_RETRANSMIT`；
  - 恢复中的后续 `dup_ack`：每次 `cwnd + 1`（窗口膨胀），不再重复第三次的初始化与建议。
- `recovery_ack` 的定义：**覆盖本次快速恢复全部未确认数据的完整确认**。
  它把 `cwnd` 缩回 `ssthresh`、清零 dup 计数并退出快速恢复。
  - 快速恢复中**不接受普通 `ack`**（收到报 `EVENT_STATE_CONFLICT`）；
  - 恢复之外收到 `recovery_ack` 同样报状态错误；
  - **未实现 NewReno 部分确认（partial ACK）与 SACK**。
- `timeout` 在任何状态下：`cwnd = 1`、按 flightSize 折半阈值、清空 dup 计数、
  进入慢启动，并建议一次 `TIMEOUT_RETRANSMIT`。
- 新的普通确认会开启新一轮 dup 计数；进程**重启不是超时**——重启后从 SQLite
  保存的初态与事件历史恢复窗口和 dup 计数。

所有比较与增量的“前值 / 公式 / 结果”都保存在每一步的 `explanation` 解释记录中可复核。
非法事件在事务内先完整校验后提交，**不会先改一半窗口再报错**。

## 环境要求

- Windows + Node.js ≥ 22（开发验证环境 Node v25.5.0，使用内置 `node:sqlite`）

```powershell
npm install
```

## 构建 / 测试 / 启动 / 演示

```powershell
npm run build      # TypeScript 编译到 dist/
npm test           # 类型检查 + 23 个测试（引擎/存储/HTTP 端到端）
npm start          # 启动 HTTP 服务，默认自动选择空闲端口
npm run demo       # CLI 内置教学演示（题目两个数值示例）
```

启动参数：

```powershell
npm start -- --port=8080 --db=data/reno.db   # 指定端口；不指定则自动挑空闲端口
```

数据文件默认位于项目内 `data/reno.db`（SQLite，WAL 模式），可用 `--db` 覆盖。

## HTTP API

所有错误统一为 `4xx/5xx` + `{ "error": { "code", "message" } }`。

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /api/models` | 创建模型。body: `{initialCwnd, initialSsthresh, id?}` |
| `GET  /api/models/:id` | 查询当前状态（cwnd/ssthresh/dupAcks/state/version） |
| `POST /api/models/:id/events` | 原子提交事件批次 |
| `GET  /api/models/:id/steps?offset=&limit=` | 分页查看步骤（limit 上限 200） |
| `GET  /api/models/:id/steps/:seq` | 查看某一步的完整计算依据 |
| `GET  /api/models/:id/replay` | 从初态回放全部步骤 |
| `GET  /api/models/:id/export` | 导出原始事件 + 步骤（JSON） |
| `GET  /api/limits` | 批次/累计事件上限与模型口径 |

提交批次 body：

```json
{
  "requestId": "client-unique-id-1",
  "expectedVersion": 0,
  "events": [
    { "type": "ack" },
    { "type": "dup_ack" },
    { "type": "dup_ack" },
    { "type": "dup_ack", "flightSize": 8 },
    { "type": "dup_ack" },
    { "type": "recovery_ack" },
    { "type": "timeout", "flightSize": 8 }
  ]
}
```

- `expectedVersion`：乐观并发版本，必须等于当前 `version`（=已提交事件总数），否则
  `409 VERSION_CONFLICT`。
- `requestId`：客户端幂等键。同一 `(model, requestId)` 的重复请求**不会重复处理事件**，
  返回 `deduplicated: true` 与首次结果；同 requestId 但版本不一致也报冲突。
- 单批上限 500 个事件（`422 BATCH_LIMIT`），每模型累计上限 100000
  （`422 TOTAL_LIMIT`），可在 `src/storage.ts` 调整。

### 错误码

| HTTP | code | 触发情形 |
| --- | --- | --- |
| 400 | `INVALID_CWND` / `INVALID_SSTHRESH` | 初态非正 / ssthresh 非正整数 |
| 400 | `INVALID_FLIGHT_SIZE` | flightSize 非正整数 |
| 400 | `FLIGHT_SIZE_REQUIRED` | 第 3 次 dup_ack / timeout 未提供 flightSize |
| 400 | `INVALID_EVENT_TYPE` | 未知事件类型、坏 JSON、批次非数组等 |
| 400 | `EVENT_STATE_CONFLICT` | 恢复中普通 ack / 恢复外 recovery_ack |
| 404 | `MODEL_NOT_FOUND` / `STEP_NOT_FOUND` / `NOT_FOUND` | 资源不存在 |
| 409 | `VERSION_CONFLICT` | 旧版本提交或重复 requestId 版本不一致 |
| 422 | `BATCH_LIMIT` / `TOTAL_LIMIT` | 超批次/累计上限 |
| 500 | `INTERNAL_ERROR` | 存储等内部失败（事件失败时整批回滚） |

### curl / PowerShell 速览

```powershell
$base = "http://127.0.0.1:51908"   # 以启动时打印的端口为准
$m = Invoke-RestMethod -Method Post "$base/api/models" -ContentType 'application/json' -Body '{"initialCwnd":4,"initialSsthresh":4}'
Invoke-RestMethod -Method Post "$base/api/models/$($m.id)/events" -ContentType 'application/json' -Body '{"requestId":"r1","expectedVersion":0,"events":[{"type":"ack"}]}'
Invoke-RestMethod "$base/api/models/$($m.id)/steps/1"
```

## CLI

```powershell
node dist/src/cli.js create --cwnd 4 --ssthresh 4 --id demo
node dist/src/cli.js events submit --model demo --version 0 --req r1 `
  ack dup_ack dup_ack "dup_ack:8" dup_ack recovery_ack
node dist/src/cli.js step 4 --model demo      # 该步公式与前后值
node dist/src/cli.js steps --model demo       # 状态变化表（--offset/--limit 分页）
node dist/src/cli.js state --model demo
node dist/src/cli.js replay --model demo
node dist/src/cli.js export --model demo      # JSON：原始事件 + 步骤
node dist/src/cli.js limits
node dist/src/cli.js demo
```

事件记号：`ack`、`dup_ack`、`recovery_ack`、`timeout`；需要 flightSize 时写成
`dup_ack:8`、`timeout:8`。CLI 表格中的“快速重传/超时重传”仅为建议，不发送报文。

## 题目数值示例

初态 `cwnd=4, ssthresh=4`：

| 事件 | cwnd | ssthresh | dup | 状态 | 建议 |
| --- | --- | --- | --- | --- | --- |
| ack | 4.25 | 4 | 0 | 拥塞避免 | - |
| dup_ack | 4.25 | 4 | 1 | 拥塞避免 | - |
| dup_ack | 4.25 | 4 | 2 | 拥塞避免 | - |
| dup_ack(flightSize=8) | 7 | 4 | 3 | 快速恢复 | 快速重传 |
| dup_ack | 8 | 4 | 4 | 快速恢复 | - |
| recovery_ack | 4 | 4 | 0 | 拥塞避免 | - |

同初态下 `timeout(flightSize=8)`：`cwnd=1, ssthresh=4`，进入慢启动，建议超时重传。

## 存储与一致性

- 表：`models`（初态、口径、当前状态、版本）、`requests`（幂等键）、
  `steps`（每步前后结果、动作、解释、原始 flightSize、requestId）。
- 每个事件批次在单个 SQLite 事务内“先完整计算再落库”，任一条非法即整体 ROLLBACK。
- 对相同初态与事件序列，**逐条提交、分批提交、重启后续交**结果一致
  （由存储测试用独立数据库交叉核对，不只断言最终一个数字）。

## 明确未实现 / 限制

- 无 NewReno 部分确认、无 SACK；快速恢复必须用明确的 `recovery_ack` 结束。
- 不建模接收方通告窗口、延迟/乱序网络、真实定时器、吞吐率；结果不可用于推断真实网络性能。
- 单进程本地 SQLite，定位为教学/单机使用，未做集群与鉴权。
- `cwnd` 增量按 6 位小数做显示/存储舍入以规避浮点尾差，公式仍逐次按标准 Reno 计算。
