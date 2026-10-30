# 架构与边界

这份文档解释**为什么这样分层**，以及每一层的边界在哪里。想知道「怎么用」看根目录
[README](../README.md)；想知道「字段从哪来」看 [observation.md](observation.md)。

---

## 1. 两层交付物

```
   ┌─────────────────────────────────────────────────────────────┐
   │  Agent（你的策略）                                            │
   └───────────────┬─────────────────────────────┬───────────────┘
                   │ MCP tools                    │ Python SDK
                   ▼                              ▼
   ┌───────────────────────────┐   ┌──────────────────────────────┐
   │  stronghold-mcp           │   │  stronghold_agent            │
   │  · 工具注册               │◄──┤  · 动作简写与错误合并          │
   │  · 协议动作表             │   │  · 等待与轮询辅助              │
   │  · observation 渲染       │   │  （经 driver 调 MCP 工具）     │
   │  · 教程与固定说明         │   │                              │
   │  · 会话生命周期           │   │                              │
   └───────┬───────────┬───────┘   └──────────────────────────────┘
           │           │
           │ ws/wss    │ GET /x/stronghold-agent/bundle（模拟源码 + 数据）
           │ 游戏协议   │ GET /data/*.json（observation 用的数据）
           ▼           ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  游戏服务端（权威）                                           │
   │   └── stronghold-agent 插件（trusted，只读）                  │
   └─────────────────────────────────────────────────────────────┘
```

每一层都可以单独使用：

- **只用 `mcp/game-client.js`**：把游戏会话接进你自己的 Node 程序。
- **只用 MCP**：任何 MCP 客户端（不限于 Python）都能观察与行动。
- **只用 `mcp/observation.js`**：把已有的原始帧渲染成可读快照（纯函数，帧 + 数据文件进，快照出）。
- **只用插件**：别的工具也可以走 `/x/stronghold-agent/` 拿模拟，不必用这里的 MCP。

---

## 2. 桥接层没有特权

这是最重要的一条边界。`stronghold-mcp` 只做一件事：**把浏览器的 WebSocket 会话搬到 MCP 上**。

它发出的每一条消息，浏览器都会发同样的字节：

| 阶段 | 消息 |
|---|---|
| 握手 | `hello`（带名字与可选的重连 token） |
| 房间 | `room.create` / `room.join` / `room.ready` / `room.start` / … |
| 对局 | `g.buy` / `g.move` / `g.sell` / `g.ready` / `g.choice` / … |
| 战斗 | `b.progress` / `b.result`（客户端模拟的回报） |

因此：

- 服务端照常做协议校验、回合校验、房间权限校验、卡池校验。**没有绕过任何服务端权威。**
- 不读游戏内存，不改客户端资源，不做注入。
- 「agent 能做的事」严格等于「浏览器玩家能做的事」的上限 —— 唯一多出来的是**速度**：
  它能不睡觉地连续观察与决策。

如果某个动作被拒绝，那是游戏真的拒绝了，错误码就是游戏自己的错误码。

插件同样没有特权：它读的是服务器**本来就已经**提供给浏览器的那些文件（`/sim/`、`/shared/`、`/data/`），
不进入任何房间、不参与任何对局、不导入游戏的任何模块。

---

## 3. 为什么战斗模拟需要一个插件

协议规定：服务端把一场战斗的 **spec** 发给客户端（`b.start`），客户端自己跑确定性模拟，
回报 `b.progress` 与 `b.result`。浏览器跑的是它从 `/sim/` 下载的那份代码 ——
和服务器、和浏览器共享的同一份纯 ESM。

agent 必须跑**同一份代码**，但有两道坎：

1. **`/sim/` 无法枚举。** 服务器没有目录列表。
2. **Node 不能从 HTTP import。** 浏览器的模块解析器可以，Node 只认磁盘路径。

插件一次解决两件事：给出**确切文件清单** + **内容指纹**，并允许**一次拿到全部源码**。

```
mcp/sim/index.js
   ├── ① plugin.js    GET /x/stronghold-agent/{manifest,bundle,file,data}
   ├── ② crawl.js     退路：从 /sim/spec.js 跟 import 图
   └── ③ store.js     落盘（复刻仓库布局）+ Node 加载 + 完整性校验
```

### 为什么爬取路径会拒绝运行

模拟的内容模块用**计算式动态 import** 加载：

```js
const KIT_REGISTRY = await safeImport('./kits/index.js');
return await import(`./ops/${file}`);          // content/kits/index.js
```

静态爬虫原理上跟不到这些。而游戏故意让模拟**能**在内容模块缺失时继续跑
（`safeImport` 把失败换成空模块）—— 于是会产出一个**看起来合理、服务端也接受、但是错的**战斗结果。

游戏自己的立场写在 `simLoader.js` 里：

> *a battle simulated without part of the data would still produce a plausible result the server
> accepts: never run one*

所以 `store.js` 捕获模拟自己的 `[content] failed to load …` 诊断，只要有缺失就**拒绝运行**并说明原因。
把静默的错误换成响亮的失败，是这条路径唯一诚实的做法。

---

## 4. 落盘布局为什么必须复刻仓库结构

模拟的模块是按**仓库结构**写的，不是按 URL 结构：

| 模块 | 它的 import | URL 上解析成 | 磁盘上必须解析成 |
|---|---|---|---|
| `server/sim/simdata.js` | `../../shared/loadoutRecord.js` | `/shared/…`（被根夹住） | `<root>/shared/…` |
| `server/sim/content/support/index.js` | `../../../data.js` | `/data.js` | `<root>/server/data.js` |

HTTP 上 `..` 在根目录处被夹住，所以看起来没问题；**磁盘上不会夹**，扁平镜像会让 `../../` 多退一层。
所以 `/sim/x` 落到 `server/sim/x`、`/shared/x` 落到 `shared/x`、`/data.js` 落到 `server/data.js`。

这套映射在 `mcp/sim/store.js` 的 `TREE_MAP` / `diskRelFor`，并有单元测试盯着。

---

## 5. 为什么两种节奏要按局决定

| 节奏 | 触发条件 | 行为 |
|---|---|---|
| `realtime` | 默认，普通房永远是这个 | 250ms 一跳，推进 `b.start.speed × 0.25s`，与浏览器一致 |
| `burst` | 仅当 `room.state.train === true` | 同一场模拟、同样 tick 数，一次步进到底 |

`burst` **不是**另一种模拟。它执行同一个 `battle.step()`、同样的总步数，只是不等待真实时间。
所以两者的 `b.result` 逐字节一致。

早期版本用全局环境变量 `STRONGHOLD_FAST_BATTLE=1` 控制，结果普通房也被秒算 ——
那不是原版体验，而且会掩盖真实的时序问题。现在读**房间自己的状态**，
普通房的 `room.state` 里连 `train` 键都不出现。

---

## 6. 错误处理的边界

有四类失败，必须分清：

| 类别 | 例子 | 谁负责报告 |
|---|---|---|
| **传输失败** | 驱动没启动、socket 断了、超时 | `Driver` 抛 `DriverError` |
| **工具失败** | MCP 工具自己抛异常 | 工具返回 `{ok: false, error}` |
| **游戏拒绝** | 钱不够、格子非法、temp 不空 | 服务端回 `{t: "error", code, msg}` |
| **模拟不完整** | 爬取路径漏了内容模块 | `loadMaterialized` 拒绝，写清缺了什么 |

第三类是 agent 最容易踩的坑：MCP 层面「调用成功」，游戏层面「被拒绝」。
`actions.run_actions` 把这三类**合并成每条动作的一个 `ok` 布尔值**，`Agent.act` 在
`ok == False` 时抛 `ActionError`。这样 agent 只需信任一个标志，而不是自己去翻协议。

---

## 7. observation 的边界

`mcp/observation.js` **只渲染服务端已经说过的内容**，加上游戏数据文件里的静态事实。它不做：

- 不预测未来（除了 `next_enemies`，那是服务端自己的预告）
- 不推断对手意图
- 不算「该买什么」

它**会**做的连接：

- 把 `m.private.shop.slots[].id` 接到 `chess.json` / `items.json`，补上名字、价格、面板、所属盟约
- 把 `m.private.bonds[].bondId` 接到 `bonds.json`，补上阈值与是否算手牌
- 把 `m.public.stageId` 接到 `stages.json`，取出可部署格与敌人路线
- 把 `deadline - serverNow` 换算成 `seconds_left`

它**会**做的护栏（都是真实踩过的坑）：

- `connected` / `frames_age_ms`：帧是「最后收到的」，断线或离开房间后它们只是残影
- `battle.stale`：`battleSimulation` 是会话属性，一局结束后 `current` 仍描述着上一场

一个诚实的限制：**`gainedChess`（本回合获得过的干员数）不在 `m.private` 里** ——
它只暴露给战斗效果脚本。叠层流派如果需要它，得自己数买入次数。

---

## 8. 重连即 resync

`hello` 不是「打个招呼」，而是一次**完整 resync**：服务端回 `welcome`，
然后重发 `room.state`，在局内还重发 `m.public` / `m.private` / 战斗 spec。

因此 `game-client.js` 在每次 `hello` 之前**丢弃全部缓存帧**（`_clearCachedFrames`）。
不这样做的话，重连后 `snapshot()` 会继续返回上一局的帧，而 agent 无从分辨。

丢弃是安全的，因为还成立的东西会在同一次握手里重新到达；不成立的东西本来就不该被看到。

---

## 9. 数据来源

observation 读的是**游戏自己服务的 JSON**（浏览器加载的同一份）：

| 文件 | 用途 |
|---|---|
| `chess.json` | 干员面板、价格、职业、所属盟约、是否金色 |
| `items.json` | 装备/藏品 |
| `bonds.json` | 盟约阈值、成员、描述、`countMode` |
| `enemies.json` | 敌人面板、是否飞行、漏怪扣血 |
| `stages.json` | `deployTiles`（可部署格）、`groundPaths`（敌人路线）、地图行 |
| `tokens.json` | 召唤物（无人机、玩偶）的名字与描述 |
| `garrisons.json` | 干员特质（catalog 的 `trait`，教程参考页的叠层分析） |
| `bands.json` | 策略：初始生命值、效果、适用模式（`band_draft`、教程参考页） |
| `config.json` | 当前模式的回合数、收入、价格、商品格、作战时限等（教程章节里的数字） |

这些文件**不包含在本仓库里**。已加载远程模拟时，observation 复用其同来源、同 welcome 内容版本的只读数据。
否则 MCP 在第一次 `stronghold_observe` / `stronghold_lookup` 时从服务器的 `/data/<name>.json` 取一次
（带同一个登录 cookie）并留在内存里；welcome 宣告新内容版本后重新加载。
`STRONGHOLD_DATA_DIR` 指向本机的游戏 `data/` 目录时优先读磁盘。

模拟缓存按来源和内容指纹存储，版本目录不可变；相同目录的模块初始化与数据解析在进程内只执行一次。
下载按来源、缓存目录、鉴权范围和请求选项合并，并只保留正在进行的请求。远程运行器在没有活跃战斗时，
对下一场权威 `b.start` 重新检查 manifest。发布新版本不会删除其他进程可能仍在用的旧目录。

数据是服务器的**原版内容**。装了玩法插件的房间（content set）的战斗，本地运行器**不接手**：
`b.start.spec.cs` 不是 `welcome.content.vanilla` 时不回报 `b.progress` / `b.result`，由服务端在截止后接管 ——
和浏览器的 `csAccepted` 同一条规则。否则用原版数据算出、却标着房间 content set 的结果会被服务端当作合理结果接受。

---

## 10. 固定前缀与按需内容

agent 的提示词分两类内容：

- **固定前缀**：工具定义和服务器 `instructions`（`mcp/instructions.js`）。两者都是代码常量，所有会话逐字节相同，提示词缓存可以跨对局复用。
- **工具结果**：局面、教程正文、参考页，全部按需取得，按时间顺序追加在对话末尾。

`stronghold_guide` 先给目录，正文按 id 读取；`stronghold_observe` 用 `since` 只返回变化。分层与实测数字见 [prompting.md](prompting.md)。
