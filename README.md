# kiro-rs Auto-Continue 一键部署版

> 在 [hank9999/kiro.rs](https://github.com/hank9999/kiro.rs) 基础上做的二次封装。
> 核心新增 **流式自动续写代理**，解决 Claude 在 Kiro 端 8000 token 输出截断问题，
> 配套打包成开箱即用的 Windows 部署版（含编译好的 `kiro-rs.exe` 和一键启动脚本）。

## 来源 / 致谢

- **底层 kiro-rs**：所有 Anthropic API 兼容、凭据管理、Token 刷新、负载均衡逻辑全部来自 [hank9999/kiro.rs](https://github.com/hank9999/kiro.rs)（MIT License），未做改动，本仓库仅引用其编译产物 `kiro-rs.exe`。
- **本仓库新增**：
  - `tools/auto-continue/auto-continue.js` —— 流式自动续写 + 限流 + IDE 互斥保护 + 统一管理面板
  - `tools/auto-continue/config.json` —— 自动续写默认配置
  - `start.bat` —— 一键启动脚本
  - 中文部署教程

如果觉得有用，请同时给上游 [hank9999/kiro.rs](https://github.com/hank9999/kiro.rs) 一个 Star。

---

## 这玩意能干啥

把 AWS Kiro IDE 的 Claude 额度变成本地 Anthropic 兼容 API，可直接接到酒馆（SillyTavern）、Cline、Continue 等任何支持 Anthropic API 的客户端里用。

**自动续写**是相对上游的关键增强：

| 上游 kiro-rs | 本项目额外做的事 |
|---|---|
| Claude 写到一半被 Kiro 8000 token 上限截断，输出戛然而止 | 检测到 `max_tokens` 截断 / 字数超阈值 / 流意外结束，**自动用历史对话发起续写**，对客户端是无感的连续 SSE 流 |
| 高频请求容易被风控 | 内置滑动窗口限流（默认 60 秒 3 次，可配队列或拒绝） |
| Kiro IDE 和反代同时跑同号会被封 | 启动前 + 运行中检测 `Kiro.exe`，发现就自动停反代 |
| Web 管理面板需要单独打开 | 主面板 iframe 嵌入 kiro-rs 自带 admin，一个页面搞定凭据管理 + 自动续写开关 + 实时统计 |

---

## 快速部署（5 分钟）

### 第 1 步：环境准备

需要装两个东西：

1. **Node.js 18+**：[https://nodejs.org/](https://nodejs.org/) 直接装 LTS 版
2. **Git**（可选）：用来 clone 仓库，没有就直接 Download ZIP

### 第 2 步：拉取本仓库

```bat
git clone https://github.com/goldensoulsong/kiro-auto-continue.git
cd kiro-auto-continue
```

或在 GitHub 网页右上角 `Code → Download ZIP`，解压到任意目录。

### 第 3 步：拿到 Kiro 凭据

注册并登录 Kiro IDE（[https://kiro.dev](https://kiro.dev)），在本地用户目录里找：

```
%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json
```

打开它，里面会有 `refreshToken`、`expiresAt`、`authMethod` 三个字段。

> 不同版本 Kiro 的 token 文件路径可能略有不同，可在用户目录全局搜 `refreshToken` 关键字定位。

### 第 4 步：写凭据文件

把仓库根目录下的 `credentials.example.social.json` 复制一份，命名为 **`credentials.json`**，把字段替换成你的：

```json
[
  {
    "refreshToken": "你的 refreshToken（aor 开头那一长串）",
    "expiresAt": "2099-12-31T00:00:00.000Z",
    "authMethod": "social"
  }
]
```

> 是 IdC 账号就用 `credentials.example.idc.json` 那个模板（多两个字段 `clientId` / `clientSecret`）。
> 多账号自动故障转移：直接在数组里加多个对象，每个加 `"priority": 0/1/2...` 数字越小越优先。

### 第 5 步：写主配置（首次启动会自动生成）

直接双击 `start.bat`，如果检测不到 `config.json` 会自动从 `config.example.json` 复制一份并用记事本打开。**改两个 key**：

```json
{
  "host": "127.0.0.1",
  "port": 8991,
  "apiKey": "sk-kiro-rs-换成你自己的随机字符串",
  "adminApiKey": "sk-admin-换成你自己的随机字符串",
  "region": "us-east-1",
  "tlsBackend": "rustls",
  "defaultEndpoint": "ide",
  "kiroVersion": "0.12.200"
}
```

- `apiKey`：客户端（酒馆等）调用时填的 Key，自己定一个长一点的随机串就行
- `adminApiKey`：进管理面板用的，必须配，不配 admin UI 不会启动
- `tlsBackend`：默认 `rustls`，如果遇到 token 刷新失败 / `error request` 报错，改成 `native-tls`

保存关闭。

### 第 6 步：启动

再次双击 `start.bat`：

```
============================================================
  kiro-rs Auto-Continue 一键启动
============================================================
  kiro-rs 后端:  http://127.0.0.1:8991
  代理端口:      http://127.0.0.1:8992  ← 客户端连这个
  管理面板:      http://127.0.0.1:8993
============================================================
```

5 秒后浏览器自动打开管理面板 [http://127.0.0.1:8993](http://127.0.0.1:8993)，能看到：

- kiro-rs 服务状态
- 自动续写开关 / 阈值 / 续写次数
- 限流配置
- IDE 互斥保护状态
- 实时统计
- "凭据管理（kiro-rs）" 标签页：查看余额、添加/删除凭据

### 第 7 步：客户端接入

**酒馆（SillyTavern）**：
- API 类型：`Claude`（Anthropic 官方）
- API URL：`http://127.0.0.1:8992`
- API Key：你在 `config.json` 里设的 `apiKey`
- 模型：`claude-sonnet-4-20250514` / `claude-opus-4-20250514` 等

**Cline / Continue**：
- Provider：`Anthropic`
- Base URL：`http://127.0.0.1:8992`
- API Key：同上

> 注意端口是 **8992**（代理）不是 8991（后端），这样才有自动续写。
> 如果要绕过自动续写直连后端，连 8991 即可，但失去续写能力。

---

## 端口速查

| 端口 | 用途 | 谁来连 |
|---|---|---|
| 8991 | kiro-rs 后端 | 仅自动续写代理内部使用 |
| 8992 | **自动续写代理** | **客户端连这个** |
| 8993 | 管理面板 | 浏览器打开 |

---

## 目录结构

```
kiro-auto-continue/
├── kiro-rs.exe                          ← 上游编译好的 Anthropic API 兼容代理
├── start.bat                            ← 一键启动脚本
├── config.example.json                  ← 主配置模板
├── credentials.example.social.json      ← Social 登录凭据模板
├── credentials.example.idc.json         ← IdC 登录凭据模板
├── tools/
│   └── auto-continue/
│       ├── auto-continue.js             ← 自动续写代理 + 管理面板（核心新增）
│       ├── config.json                  ← 自动续写默认配置（随仓库分发）
│       └── README.md
├── docs/
│   └── 部署教程.md                       ← 详细图文教程
├── README.md
├── LICENSE
└── .gitignore
```

启动后会生成（已在 `.gitignore` 里）：
- `config.json` —— 你的真实主配置（含 apiKey）
- `credentials.json` —— 你的真实凭据
- `kiro_balance_cache.json` —— 余额缓存
- `kiro_stats.json` —— 调用统计

---

## 常见问题

**Q：启动时报 `[互斥保护] 检测到 Kiro IDE 正在运行` 然后退出？**
A：本工具默认禁止 Kiro IDE 和本反代同时跑（同号并发会被风控封号）。先关掉 Kiro IDE 再启动。如果你确认风险想强行跑，把 `tools/auto-continue/config.json` 里 `ideExclusiveEnabled` 改成 `false`。

**Q：报 `error request` 或者 token 刷新一直失败？**
A：把 `config.json` 里 `tlsBackend` 从 `rustls` 改成 `native-tls`，重启。

**Q：Claude 写小说到一半还是被截断了？**
A：检查管理面板 `自动续写 → 总开关` 是否打开，统计里 `总续写` 数字有没有增长。如果没动说明触发条件没满足，把 `truncateThreshold` 调小（比如 6500）让它更激进地续写。

**Q：客户端报 429 或 503？**
A：触发了本地限流。管理面板调大 `窗口内最大次数`，或者把 `超额行为` 改成 `排队等待`。

**Q：能不能不用自动续写，只用 kiro-rs？**
A：可以，直接运行 `kiro-rs.exe -c config.json --credentials credentials.json`，客户端连 8991 端口即可。

**Q：凭据怎么搞多账号？**
A：`credentials.json` 里数组放多个对象，每个加 `priority`。kiro-rs 会按优先级故障转移，详见上游文档：[hank9999/kiro.rs#credentialsjson](https://github.com/hank9999/kiro.rs#credentialsjson)。

---

## 安全提醒

- **千万不要把 `config.json` 和 `credentials.json` 上传到 GitHub**。仓库的 `.gitignore` 已经排除了，clone 下来直接用就行
- `apiKey` 和 `adminApiKey` 自己随机生成长一点（建议 24 位以上）
- 服务默认只监听 `127.0.0.1`，不会暴露到公网。如果要远程访问，自己加反向代理 + HTTPS + 认证

---

## License

MIT。原项目版权归 [hank9999](https://github.com/hank9999) 所有，本仓库的新增部分（`tools/auto-continue/`、`start.bat`、文档）同样以 MIT 协议发布。

## 免责声明

本项目仅供学习研究。使用本项目所导致的任何后果（包括但不限于账号封禁）由使用人自行承担，与本项目及上游项目无关。本项目与 AWS / Kiro / Anthropic / Claude 等官方无关。
