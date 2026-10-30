# 路线图

## 目标与判据

**让 agent 像人类玩家一样操作这个游戏。** 每个功能都用同一条判据衡量：

> agent 看到的 = 人类在屏幕上能看到的；agent 能做的 = 人类能点的。**不多，也不少。**

| 人类 | agent 对应 | 状态 |
|---|---|---|
| 看游戏画面 | `stronghold_observe` | ✅ 备战阶段已覆盖 |
| 悬浮提示里的面板、技能、盟约说明 | `stronghold_lookup`，卡面的部署费用与特质在 catalog | ✅ |
| 策略选择、机变选卡界面 | observe 的 `band_draft` / `sp_draft` | ✅ |
| 点按钮、拖棋子 | 协议动作（`stronghold_action`，和浏览器一字不差） | ✅ |
| 看着战斗打完 | `battle.report` 复盘体检（层数增量、伤害类型、伤亡） | ✅ P1-1 |
| 点开别人的场地侦察 | 能发 `g.watch`，但看不到回来的内容 | ❌ P1-2 |
| 结算画面 | — | ❌ P1-3 |
| toast、滚动播报、表情 | — | ❌ P1-4 |

两条红线：

- **不越界。** agent 只拿浏览器本来就会收到的帧和下载的文件。模拟虽然就在本地，也**不提供「预演一下这样摆会怎样」的工具** —— 人类做不到，那就是代打。训练房的秒算可以，因为是服务端允许、按房间开启的。
- **不缺位。** 人类在画面上能看到的，agent 都应该能读到。下面的 P1 都是这一条。

---

## P1 补齐感知

### 1. 战报 ✅

本地运行器订阅模拟自己发出的事件（`deploy`、`blocked`、`enemyLeak`、`death`、`kill`、`damaged`、`battleEnd`），
把整场汇总成 `battle.report`：层数增量、伤害类型、伤亡与单位指标。口径与前端「作战统计」一致
（`public/js/battle/metrics.js` 的 `trackCombat`）。订阅只读，挂不挂战报 `b.result` 逐字节一致，两种节奏共用同一份。
字段见 [observation.md](docs/observation.md#关于-battlereport战报)。

后续：
- 服务端模拟的对局（`combat_mode: "server"`）从 `b.snap` 推流里取。
- 观战（非权威的 `b.start`）跑一份展示用的副本，可选。

### 2. 侦察：`m.field`

人类备战时可以点开别人的场地看阵容。`g.watch { fieldId, playerId? }` 之后服务端回 `m.field`（棋盘、手牌、temp、对方的效果、下一波）。
把最近一次侦察渲染进 observe 的 `scouted`，带上是谁的场地、多久之前的。

### 3. 结算：`m.result`

结算画面的内容。渲染进 observe 的 `result`，有它就说明这一局已经结束。

### 4. 提示与播报：`m.toast` / `m.ticker` / `m.emote` / `room.closed`

人类看得到弹出提示和滚动播报。客户端的 `last` 每种帧只留最新一条，事件队列又会被 `stronghold_wait_event` 取走，
所以需要单独留一个最近 N 条的环形缓冲（每条带时间和回合），由 observe 的 `messages` 带出，agent 按 id 去重。

---

## P2 座位保持在线

像浏览器一样：掉线了重连，登录过期了重新登录。

- ✅ **服务端重启后自动重新登录。** WebSocket 握手得到 401 且 cookie 是用账号密码换来的时，丢掉旧 cookie 重新登录一次；
  用户直接给的 `STRONGHOLD_AUTH_COOKIE` 保持原样（`mcp/game-client.js`）。
- ✅ **MCP 子进程退出时 driver 跟着退出**，交给 systemd 等进程管理器重新拉起（`driver/drive-daemon.mjs`）。
- ✅ **Python `Driver` 的请求带 id**，响应按 id 配对（`python/stronghold_agent/driver.py`）。

---

## P3 开源发布前

- **模拟缓存。**
  - ✅ 独立临时目录、原子发布、进程内下载与模块初始化去重；失败允许重试。
  - ✅ 远程运行器在两场战斗之间检查 manifest，按内容指纹复用模块与静态数据。
  - ✅ 发布新版本时保留旧目录，避免删除其他进程仍在使用的模块。
  - 后续：带跨进程使用记录的自动回收；目前只做停机后的显式清理。
- **插件 `/bundle` 在内存里按指纹缓存。** ✅ 已按实际内容指纹复用源文本和已解析的 bundle；传输层仍需序列化回复。
- **上下文。** ✅ 默认 9 个通用工具，协议按动作过滤；observe 默认 compact（静态面板放入 catalog、省略默认值），
  ✅ 带 `rev` / `since` 的增量观察，未知版本自动 `resync`。✅ `stronghold_guide` 按需取用：只给 topic 返回目录，内容按 id 读取。
  ✅ 固定的服务器 `instructions` + 工具定义逐字节稳定，提示词前缀可以跨对局缓存（docs/prompting.md，test/prompt.test.mjs）。
- **HTTP 传输。**
  - ✅ 会话空闲超时（`MCP_HTTP_IDLE_SECONDS`，默认 1800 秒），连同游戏座位一起关闭。
  - Basic Auth 改用单独的 `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD`。现在的线上部署只有游戏的 `SP_AUTH_*`，
    代码按 `MCP_HTTP_*` → `STRONGHOLD_AUTH_*` → `SP_AUTH_*` 读取。服务器设好单独的一组之后，去掉后两级。
- **安全说明。** ✅ README「安全」一节：连接服务器即允许它在本机执行模拟代码、凭据只在内存、HTTP 必须认证、driver 只给本机。
  后续可选加固：把模拟放进开了 Node 权限模型（`--permission`）的子进程里跑。
- **整理。**
  - ✅ LICENSE 与包元数据署名（reisa）；✅ `pyproject.toml` 的 `readme` 指向 `python/README.md`。
  - ✅ CI：`.github/workflows/test.yml` 跑 `npm run check`、`npm test` 和 Python unittest，都不需要服务器。
  - ✅ 英文概览 `README.en.md`；详细文档保持中文。
  - ✅ 仓库地址：https://github.com/yuzelingsha/stronghold-mcp（`package.json` 的 `repository` / `homepage` / `bugs`，`pyproject.toml` 的 `[project.urls]`）。

---

## 不做的事

- 预演或推演战斗的工具（见上文的红线）。
- 绕过协议读取任何状态：游戏内存、别人的私有帧、服务端内部数据。
- 在 SDK 里替 agent 做决定。买什么、摆哪里、什么时候就绪，永远是 agent 的判断。
