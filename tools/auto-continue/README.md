# Auto-Continue 自动续写代理

挂在 `kiro-rs` 前面的本地 Node.js 代理，解决 Claude 在 Kiro 上 8000 token 输出截断问题，并附带：

- **流式自动续写**：检测到 `max_tokens` 截断或字数超阈值时，自动发起续写并保持 SSE 流不中断
- **本地限流防封号**：滑动窗口 + 串行队列，避免短时间高并发触发风控
- **IDE 互斥保护**：检测到 `Kiro.exe` 在跑时自动停止反代，防止同号并发被封
- **统一管理面板**：网页端开关 / 实时统计 / 凭据管理（嵌入 kiro-rs 自带 admin UI）

## 端口分配

| 端口 | 服务 |
|---|---|
| 8991 | kiro-rs 后端（被本脚本自动启动） |
| 8992 | 代理端口（**酒馆 / Cline 等客户端连这个**） |
| 8993 | 管理面板（浏览器打开） |

## 启动

项目根目录双击 `start.bat`，会一并启动 kiro-rs 和本代理。

或者手动启动：

```bat
cd tools\auto-continue
node auto-continue.js
```

## 配置

编辑 `config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 自动续写总开关，关掉就只做透传 |
| `listenPort` | `8992` | 代理监听端口（客户端连这个） |
| `adminPort` | `8993` | 管理面板端口 |
| `targetHost` / `targetPort` | `127.0.0.1` / `8991` | kiro-rs 地址 |
| `maxContinuations` | `5` | 单条消息最多续写几次 |
| `truncateThreshold` | `7600` | 字数超过此值且没正常结束就触发续写 |
| `continuePrompt` | `"继续"` | 续写提示词（保留兼容字段） |
| `rateLimitEnabled` | `true` | 启用本地限流 |
| `rateLimitWindowMs` | `60000` | 限流窗口（毫秒） |
| `rateLimitMaxRequests` | `3` | 窗口内最大请求数 |
| `rateLimitOnExceed` | `"queue"` | `queue` 排队 / `reject` 直接 429 |
| `ideExclusiveEnabled` | `true` | 启用 IDE 互斥保护 |
| `kiroExe` | `../../kiro-rs.exe` | kiro-rs 可执行文件相对路径 |
| `kiroConfig` | `../../config.json` | kiro-rs 配置文件相对路径 |
| `kiroCredentials` | `../../credentials.json` | kiro-rs 凭据文件相对路径 |

## 关闭自动续写

把 `config.json` 里 `enabled` 改成 `false`，重启脚本，所有请求纯透传。
