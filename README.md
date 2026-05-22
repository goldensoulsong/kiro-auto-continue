# kiro-rs Auto-Continue 一键部署版

> 在 [hank9999/kiro.rs](https://github.com/hank9999/kiro.rs) 基础上做的二次封装。
> 核心新增 **流式自动续写代理**，解决 Claude 在 Kiro 端 8000 token 输出截断问题，
> 配套打包成开箱即用的 Windows 部署版（含编译好的 `kiro-rs.exe` 和一键启动脚本）。

## 来源 / 致谢

- **底层 kiro-rs**：所有 Anthropic API 兼容、凭据管理、Token 刷新、负载均衡逻辑全部来自 [hank9999/kiro.rs](https://github.com/hank9999/kiro.rs)（MIT License），未做改动，本仓库仅引用其编译产物 `kiro-rs.exe`。
- **本仓库新增**：
  - `tools/auto-continue/auto-continue.js` —— 流式自动续写 + 限流 + IDE 互斥保护 + 统一管理面板 + **快捷导入凭据**
  - `tools/auto-continue/config.json` —— 自动续写默认配置
  - `start.bat` —— 一键启动脚本（自动生成随机 key、自动初始化所有配置）
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
| 凭据要手动改 `credentials.json` | **管理面板加了快捷导入**：扫描本机 / 粘贴 JSON / 粘贴 refreshToken 三种方式，无需手改文件 |

---

## 快速部署（3 步搞定）

### 第 1 步：装 Node.js 18+

去 [https://nodejs.org/](https://nodejs.org/) 下载 LTS 版，一路下一步装好。

### 第 2 步：下载本仓库

```bat
git clone https://github.com/goldensoulsong/kiro-auto-continue.git
cd kiro-auto-continue
```

或者 GitHub 网页右上角 `Code → Download ZIP`，解压到任意目录。

### 第 3 步：双击 `start.bat`

第一次启动会**全自动**完成：

- 生成 `config.json` 并自动填入随机的 `apiKey` / `adminApiKey`
- 生成空的 `credentials.json`（凭据等会儿在面板里导入）
- 启动 kiro-rs 后端 + 自动续写代理 + 管理面板
- 5 秒后浏览器自动打开 [http://127.0.0.1:8993](http://127.0.0.1:8993)

cmd 窗口里会打印你的接入信息：

```
------------------------------------------------------------
客户端（酒馆/Cline等）接入信息：
  API URL: http://127.0.0.1:8992
  API Key: sk-kiro-rs-xxxxxxxxxxxxxxxxxxxxxxxx
------------------------------------------------------------
```

**这个 API Key 等会儿要复制到客户端里**，先记着位置。

---

## 导入凭据（管理面板里完成）

打开管理面板 [http://127.0.0.1:8993](http://127.0.0.1:8993)，第一个标签就是 **快捷导入**。三选一：

### 方式 1：扫描本机 Kiro 凭据 ⭐ 推荐

如果你的电脑上已经登录过 Kiro IDE：

1. 点 **扫描本机凭据** 按钮
2. 自动找出 `%USERPROFILE%\.aws\sso\cache\` 下的所有 token 文件
3. 勾选要导入的（默认全选），点 **导入选中**

### 方式 2：粘贴 token JSON

朋友把 `kiro-auth-token.json` 整个文件给你了：直接复制内容粘贴到文本框，点 **解析并导入**。

### 方式 3：粘贴 refreshToken

只有那一长串 `aor...` 字符串：粘贴到 refreshToken 输入框，选好认证方式（social / idc），点 **导入**。IdC 账号需要额外填 `clientId` / `clientSecret`。

导入完成后，切换到 **凭据管理（kiro-rs）** 标签页，能看到刚导入的凭据出现，包含余额信息。

---

## 客户端接入

**酒馆（SillyTavern）**：
- API 类型：`Claude`（Anthropic 官方）
- API URL：`http://127.0.0.1:8992`
- API Key：cmd 里打印的那串 `sk-kiro-rs-...`
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
├── start.bat                            ← 一键启动脚本（自动生成所有配置）
├── config.example.json                  ← 主配置模板
├── credentials.example.social.json      ← Social 登录凭据模板（手动写法参考用）
├── credentials.example.idc.json         ← IdC 登录凭据模板（手动写法参考用）
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
- `config.json` —— 你的真实主配置（含随机生成的 apiKey）
- `credentials.json` —— 你的真实凭据
- `kiro_balance_cache.json` —— 余额缓存
- `kiro_stats.json` —— 调用统计

---

## 关于 apiKey / adminApiKey

| 名字 | 作用 | 是否自动生成 |
|---|---|---|
| `apiKey` | 客户端（酒馆等）调反代时填的 Bearer Token，防止局域网里别人撞到端口偷用你的额度 | 是，第一次启动随机 48 位十六进制 |
| `adminApiKey` | kiro-rs admin UI（凭据增删、看余额）的认证，防止别人乱删你的凭据 | 是，同上 |

两个都建议保留：默认监听 `127.0.0.1` 看着安全，但 VPN / 代理 / 防火墙规则容易意外把端口暴露出去。

要换 key 直接编辑 `config.json` 即可，改完重启 `start.bat` 生效。

---

## 常见问题

**Q：双击 start.bat 一闪而过没反应？**
A：cmd 改用"以管理员身份运行"，先 `cd` 到目录再手动跑 `start.bat`，能看到具体错误信息。最常见原因：没装 Node.js / 当前目录不对 / 端口被占用。

**Q：启动时报 `[互斥保护] 检测到 Kiro IDE 正在运行` 然后退出？**
A：本工具默认禁止 Kiro IDE 和本反代同时跑（同号并发会被风控封号）。先关掉 Kiro IDE 再启动。如果你确认风险想强行跑，把 `tools/auto-continue/config.json` 里 `ideExclusiveEnabled` 改成 `false`。

**Q：扫描本机凭据扫不到任何东西？**
A：1) 确认电脑上登录过 Kiro IDE（不是只装了没登录）；2) 用方式 2 / 3 手动粘贴；3) 看 `%USERPROFILE%\.aws\sso\cache\` 下有没有含 `refreshToken` 的 JSON 文件。

**Q：导入凭据后调用报 `400 缺少 profile arn`？**
A：通常是 IdC 账号但没填正确的 `clientId` / `clientSecret`，或者 region 配错。检查一下；社交账号一般用方式 1 扫描导入会自动带上所有需要字段。

**Q：报 `error request` 或者 token 刷新一直失败？**
A：把 `config.json` 里 `tlsBackend` 从 `rustls` 改成 `native-tls`，重启。

**Q：Claude 写小说到一半还是被截断了？**
A：检查管理面板 `自动续写 → 总开关` 是否打开，统计里 `总续写` 数字有没有增长。如果没动说明触发条件没满足，把 `truncateThreshold` 调小（比如 6500）让它更激进地续写。

**Q：客户端报 429 或 503？**
A：触发了本地限流。管理面板调大 `窗口内最大次数`，或者把 `超额行为` 改成 `排队等待`。

**Q：能不能不用自动续写，只用 kiro-rs？**
A：可以，直接运行 `kiro-rs.exe -c config.json --credentials credentials.json`，客户端连 8991 端口即可。

**Q：凭据怎么搞多账号？**
A：管理面板里多次导入即可，每条凭据自动分配 ID。在"凭据管理"标签页可以单独调每条的优先级。kiro-rs 会按优先级故障转移，详见上游文档：[hank9999/kiro.rs#credentialsjson](https://github.com/hank9999/kiro.rs#credentialsjson)。

---

## 安全提醒

- **千万不要把 `config.json` 和 `credentials.json` 上传到 GitHub**。仓库的 `.gitignore` 已经排除了，clone 下来直接用就行
- 自动生成的 `apiKey` / `adminApiKey` 已经是 48 位十六进制（192 bit 熵），够用
- 服务默认只监听 `127.0.0.1`，不会暴露到公网。如果要远程访问，自己加反向代理 + HTTPS + 认证

---

## License

MIT。原项目版权归 [hank9999](https://github.com/hank9999) 所有，本仓库的新增部分（`tools/auto-continue/`、`start.bat`、文档）同样以 MIT 协议发布。

## 免责声明

本项目仅供学习研究。使用本项目所导致的任何后果（包括但不限于账号封禁）由使用人自行承担，与本项目及上游项目无关。本项目与 AWS / Kiro / Anthropic / Claude 等官方无关。
