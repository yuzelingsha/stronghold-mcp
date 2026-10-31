# stronghold-mcp

**通过 MCP 让 AI agent 像玩家一样玩《明日方舟：卫戍协议·盟约》。** · [English](README.en.md)

基于 **[卫戍协议：盟约 · Stronghold Protocol: Alliance](https://github.com/sganggs/Stronghold-Protocol)**（sganggs/Stronghold-Protocol，GPL-3.0-or-later）——
「卫戍协议：盟约」的非官方同人联机网页复刻。本项目为它的服务器提供 AI agent 接入，适配 0.3.x 版本。

两个可独立安装的部分：

| 装在哪 | 装什么 | 谁装 |
|---|---|---|
| **游戏服务器** | 一个插件（`trusted` 类，**不改源码**）—— 挂一个只读接口，把 agent 跑战斗模拟所需的文件交出去 | 服主 |
| **Agent 侧** | 一个 MCP 服务 —— 连上服务器，像浏览器一样打这一局 | 用 agent 的人 |

> 这是**陪玩**而不是代打：这个仓库里没有任何一行做决定。买哪个、卖哪个、站哪里、什么时候升级、
> 什么时候就绪，全是 agent 自己的判断。这里只负责两件事 —— 把局面讲清楚，把动作发出去。

```
┌────────────────┐   MCP tools    ┌──────────────────┐  游戏协议   ┌──────────────┐
│   AI agent     │ ─────────────► │  stronghold-mcp  │ ──────────► │  游戏服务器   │
│ (任何 MCP 客户端)│ ◄───────────── │                  │ ◄────────── │  (权威校验)   │
└────────────────┘   state 帧      └────────┬─────────┘   ws/wss    └──────┬───────┘
                                            │                              │
                                            │  GET /x/stronghold-agent/    │
                                            │  bundle  （模拟源码 + 数据）  │
                                            └──────────────────────────────┘
                                                     ▲
                                    ┌────────────────┴─────────────────┐
                                    │ stronghold-agent 插件（trusted）  │
                                    │ 只读 server/sim + shared + data  │
                                    └──────────────────────────────────┘
```

**桥接层没有任何特权。** 它发出的每条消息都是浏览器会发的普通客户端消息，服务端照常做协议校验与房间权限校验。
插件也是只读的：它读服务器**本来就已经**提供给浏览器的那些文件，不进入任何房间、不参与任何对局。

---

## 目录

- [基于的项目](#基于的项目)
- [为什么需要一个插件](#为什么需要一个插件)
- [30 秒上手](#30-秒上手)
- [游戏侧：装插件](#游戏侧装插件)
- [Agent 侧：装 MCP](#agent-侧装-mcp)
- [observation：agent 看到什么](#observationagent-看到什么)
- [action：agent 能做什么](#actionagent-能做什么)
- [战斗模拟从哪来](#战斗模拟从哪来)
- [训练房与节奏控制](#训练房与节奏控制)
- [配置参考](#配置参考)
- [安全](#安全)
- [仓库结构](#仓库结构)
- [设计取舍与踩过的坑](#设计取舍与踩过的坑)
- [许可与声明](#许可与声明)

文档：[架构与边界](docs/architecture.md) · [observation 字段](docs/observation.md) · [提示词与缓存](docs/prompting.md) ·
[协议与动作表](docs/protocol.md) · [插件安装](docs/plugin-install.md) · [部署 MCP 服务](docs/deploy.md) ·
[训练房](docs/training-rooms.md) · [路线图](ROADMAP.md)

---

## 基于的项目

| | |
|---|---|
| 项目 | [卫戍协议：盟约 · Stronghold Protocol: Alliance](https://github.com/sganggs/Stronghold-Protocol) |
| 作者 | Stronghold-Protocol contributors（仓库 `sganggs/Stronghold-Protocol`） |
| 适配版本 | 0.3.x（插件清单 `"app": ">=0.3.0 <0.4.0"`，在 0.3.1 上开发与验证） |
| 许可 | 代码 GPL-3.0-or-later；《明日方舟》相关素材与数据归原权利人，见上游 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md) |

本项目用到的上游部分：

- **客户端协议**：MCP 发出的每条消息都是上游浏览器客户端的协议消息，由上游服务器校验。
- **插件系统**：`plugin/` 是装进上游插件系统（`trusted` 类）的插件，通过它的 `api.http.route` 挂只读接口。
- **战斗模拟与数据**：MCP 在运行时从你自己部署的上游服务器取得 `server/sim/`、`shared/` 和 `data/*.json`，
  按上游浏览器的方式加载执行。这些代码和数据保持上游的许可与声明。
- **规则核对**：`stronghold_guide` 教程里标注的源码位置（`server/…`、`data/config.json`）都指上游 0.3.1 的文件。

---

## 为什么需要一个插件

游戏协议把每场战斗的 **spec** 交给客户端，由**客户端自己模拟**并回报结果：

```
服务端：这一波敌人的数据给你，你自己跑模拟，打完把结果报给我
客户端：好（跑模拟）……报结果
```

浏览器跑模拟用的是它从 `/sim/` 下载的那份代码（`server/sim/`，和服务器、和浏览器共享的同一份纯 ESM）。
agent 必须跑**同一份代码**，否则结果对不上、服务端会判它不可信。

而 `/sim/` 有两个硬问题：

1. **无法枚举。** 服务器没有目录列表，HTTP 上你不知道该请求哪些文件。
2. **Node 不能从 HTTP import。** 浏览器的模块解析器可以，Node 只认磁盘路径。

插件一次解决这两件事：给出**确切文件清单**、**内容指纹**，并允许**一次拿到全部源码**。

没有插件也能跑（MCP 会退化成爬 `/sim/`），但那条路**必然不完整**：模拟的内容模块用的是计算式动态
import（`import(path)`、`` import(`./ops/${file}`) ``），静态爬虫原理上跟不到。所以 MCP 在爬取路径下
**检测到缺失就拒绝运行** —— 而不是交出一个看起来合理、实际错误的战斗结果。

---

## 30 秒上手

需要 **Node.js ≥ 22**；Python SDK 需要 **Python ≥ 3.10**（只用标准库）。

```bash
git clone https://github.com/yuzelingsha/stronghold-mcp.git && cd stronghold-mcp
npm install

# ---- 游戏侧（在游戏安装目录里做一次）----
cp -r plugin/ /path/to/Stronghold-Protocol/plugins/stronghold-agent/
cd /path/to/Stronghold-Protocol
node tools/plugin.mjs check stronghold-agent     # 期望 0 problem(s), 0 warning(s)
node tools/plugin.mjs pack stronghold-agent      # 写出 plugin.lock.json
# 把锁的 sha256 写进 plugins/config.json，并设 SP_PLUGIN_SCRIPTS=trusted
# 完整步骤见 docs/plugin-install.md

# ---- Agent 侧 ----
cd /path/to/stronghold-mcp
cp .env.example .env     # 填服务器地址；站点有登录门禁就填账号密码（MCP 与 driver 启动时自动读取）
node driver/drive-daemon.mjs

# 另开一个终端
pip install -e python/
python python/examples/01_observe.py
```

### 跑测试

两套测试都不需要游戏服务器、不需要凭据、不需要游戏源码：

```bash
npm test                                                   # 协议 / 客户端 / 插件 / 模拟缓存 / observation / 教程 / 提示词前缀 / HTTP 会话
python3 -m unittest discover -s python/tests -t python    # 动作展开 / 游戏级错误合并 / 精简观察的放置辅助
```

Node 侧用一个内存里的协议桩（`test/fake-server.mjs`）验证握手、回执配对、事件排队、重连丢帧；
用一份合成的游戏安装验证插件的四个路由；用临时目录验证 URL→磁盘的路径映射。

---

## 游戏侧：装插件

插件在 [`plugin/`](plugin/)，两个文件：`plugin.json`（清单）和 `server.js`（服务端入口）。

**完整安装步骤（含 pin 与 `SP_PLUGIN_SCRIPTS`）见 [docs/plugin-install.md](docs/plugin-install.md)。** 摘要：

```bash
cp -r plugin/ /path/to/Stronghold-Protocol/plugins/stronghold-agent/
cd /path/to/Stronghold-Protocol
node tools/plugin.mjs check stronghold-agent && node tools/plugin.mjs pack stronghold-agent
# 把 plugin.lock.json 的 sha256 填进 plugins/config.json: { "trusted": { "stronghold-agent": "<sha256>" } }
```

```ini
# /etc/systemd/system/<your-service>.service.d/agent.conf
[Service]
Environment=SP_PLUGIN_SCRIPTS=trusted
# 公网监听必须用 trusted-force（trusted 只接受本地/内网地址）
```

接口（全部只读，全在插件系统强制的 `/x/stronghold-agent/` 前缀下）：

| 路由 | 返回 |
|---|---|
| `/manifest` | `{ ok, app, fingerprint, files: [{url, bytes}], data: [{name, bytes}] }` |
| `/bundle` | `{ ok, fingerprint, sources: {url: 源码}, data: {name: 记录} }` —— 一次拿全，约 10 MB |
| `/file?path=/sim/x.js` | 单个模块（bundle 被拒时的退路） |
| `/data?name=chess` | 单个数据文件 |

`fingerprint` 覆盖 `server/sim` + `shared` + `data` 全部文件，指纹没变 agent 就不重新下载。
实测 10 MB / 0.93 秒，插件系统给的预算是单次请求 5 秒。

---

## Agent 侧：装 MCP

### A. 直接用 MCP

```json
{
  "mcpServers": {
    "stronghold": {
      "command": "node",
      "args": ["/absolute/path/to/stronghold-mcp/mcp/index.js"],
      "env": {
        "STRONGHOLD_WS_URL": "wss://your-server/ws",
        "STRONGHOLD_NAME": "MCP Player",
        "STRONGHOLD_LOCAL_BATTLE": "1"
      }
    }
  }
}
```

暴露的工具：

| 工具 | 作用 |
|---|---|
| `stronghold_observe` | **决策用的局面快照**（见下文 observation），agent 每回合读这个；带 `since` 只返回变化 |
| `stronghold_lookup` | 按 id 查一条游戏数据：干员、装备、敌人、召唤物、策略，或盟约（含阈值与成员） |
| `stronghold_guide` | 游戏教程（数字取自本服务器配置）与本局盟约、策略的参考页（见下文） |
| `stronghold_action` / `stronghold_protocol` | 发任意协议动作 / 列出全部动作与字段 |
| `stronghold_connect` / `stronghold_disconnect` / `stronghold_state` / `stronghold_wait_event` | 会话、原始帧、等事件 |

默认使用 `STRONGHOLD_MCP_TOOLS=compact`，只注册上面 9 个通用工具，减少工具定义占用的上下文。
所有动作通过 `stronghold_action` 发出。需要 `stronghold_g_buy`、`stronghold_room_create` 等便利工具时，
设 `STRONGHOLD_MCP_TOOLS=full`，共注册 62 个工具。
`stronghold_protocol {"type":"g.move"}` 或 `{"prefix":"room."}` 可以只取需要的动作说明。

也可以跑成 Streamable HTTP（`MCP_TRANSPORT=http`，入口 `/mcp`，默认 `127.0.0.1:8787`，
`MCP_HTTP_USER` / `MCP_HTTP_PASSWORD` 做 Basic Auth），方便挂反向代理。服务器上的 systemd、nginx、升级与回滚步骤见
[docs/deploy.md](docs/deploy.md)。

### B. 用 Python SDK

```python
from stronghold_agent import Agent, ActionError

with Agent.connect(name="Agent") as game:
    obs = game.wait_for_phase("PREP", timeout=300)
    print(obs["phase"], obs["round"], obs["seconds_left"], obs["me"]["funds"])

    for slot in obs["shop"]:
        if not slot.get("empty") and game.can_afford(obs, slot["price"]):
            game.buy(slot["slot"])

    obs = game.observe()
    for piece in list(obs["hand"]):
        tiles = game.tiles_for(piece, obs)
        if tiles:
            game.place(piece["uid"], *tiles[0], direction="RIGHT")

    game.ready()
```

`Agent` 上还有 `sell` / `refresh` / `freeze` / `level_up` / `rotate` / `equip` / `unequip` /
`deploy_art` / `reward` / `choice` / `band` / `emote` / `leave_match`，房间侧有
`create_room` / `join` / `room_ready` / `start_room`。

`observe()` 由 MCP 渲染：游戏数据文件由 MCP 从服务器取得，所以 Agent 这边**不需要任何游戏文件**。

**失败是响的。** `game.buy(...)` 在**游戏**拒绝时抛 `ActionError`（不只是传输失败）。
「MCP 调用成功」≠「游戏接受」这个坑在 SDK 里已经合并成一个布尔判断 —— 静默失败是 agent 最不该猜的事。
预期会被拒的动作用 `game.try_act(...)`，它返回每条的成败而不抛异常。

三个渐进示例在 [`python/examples/`](python/examples/)：
`01_observe.py` → `02_play_a_turn.py` → `03_play_a_match.py`。

---

## observation：agent 看到什么

`stronghold_observe`（Python 里是 `game.observe()`）把服务端最近的帧和游戏数据文件连接成一份快照：

| 字段 | 含义 |
|---|---|
| `connected` / `has_frames` / `frames_age_ms` | **先看这三个。** 帧是「最后收到的」，断线后它们只是残影（离开房间时会清空） |
| `phase` / `round` / `seconds_left` | 阶段、回合、距截止还剩几秒 |
| `stage` / `combat_mode` / `room` | 关卡；战斗由客户端还是服务端模拟；房间号、模式、难度、**是否训练房**、房主与全部座位（大厅里就靠它） |
| `me` | 资金、商店等级与升级价、刷新价、部署数/上限、就绪状态、累计统计 |
| `shop` | 每个卡槽，已与 `chess.json` / `items.json` 连接（名称、价格、职业、面板、所属盟约、精锐、攻击范围、技能） |
| `reward_offer` / `personal_choice` | 晋升奖励（卡牌已连接数据；保留到领取，待领取时也能就绪）与个人抉择（处理后才能就绪） |
| `hand` / `temp` / `board` | 每个棋子的完整信息 + 所在格与朝向；`board[].range_tiles` 是攻击覆盖格；`board_tiles` 是 `"row,col" → uid` |
| `bonds` | 每个盟约的**实时层数** `layers`、计数、激活档位、阈值、是否本局禁用 |
| `effects` / `next_enemies` | 计数器与悬赏；下一波每个出怪动作（时间、数量、精英、飞行、boss） |
| `players` | 每个座位（`playerId`、名字、bot、在线状态、血量、等级、场上人数、就绪状态、主要盟约）—— 联机用 |
| `setup` | 本局抽到的内容：回合数、敌人派系、禁用盟约与干员、Boss |
| `scouted` | 备战时最近一次侦察（`g.watch`）看到的场地 |
| `fields` / `unite` / `boss_hp` / `team_lp` | 战场进度、联防、最终攻势的血池 |
| `messages` | 最近的提示、播报和表情，传 `since` 时只给新的 |
| `comms` | 联机时的沉默回合数、等你回应的队友表情、队友是否在等你 |
| `result` | 结算画面，只在 `RESULT` 阶段出现 |
| `field` | 可部署格（近战 / 仅远程）、敌人行进路线、渲染出的地图切片 |
| `battle` | 本地战斗模拟器的状态；`stale` 表示它描述的是上一场 |
| `data_error` | 只在数据文件取不到时出现：帧照常渲染，只有连接来的名字与面板为空 |

三点值得注意：

- **`bonds[].layers` 是真实层数**，直接读，不用自己算。这是叠层流派的核心观测量。
- **`field` 的可部署格来自关卡数据本身**（`stages.json` 的 `deployTiles`）。`tiles_for()` 已经做了
  「近战只能站近战格、远程两处都能站、排除已占用」的过滤 —— 把远程干员放到近战格会被游戏以 `BAD_TILE` 拒绝。
- **`battle` 不是「现在正在打的那一场」。** 它是会话属性：一局结束后 `current` 仍描述着上一场；
  它的回合既不是当前回合也不是上一回合时标 `stale: true`。

字段级来源见 [`docs/observation.md`](docs/observation.md)。

### 减少每次观察的上下文

MCP 工具 `stronghold_observe` 默认 `detail:"compact"`：静态面板（含部署费用 `cost` 和特质 `trait`）合并到
`catalog["kind:id"]`，每种干员、装备、敌人、盟约在一份回复里只定义一次；默认值不写出（没出现的标志就是
`false`，没有装备就没有 `items`）。棋子列表保留 uid、位置、装备和金色状态，商店保留服务端给出的实时价格。
`battle` 只留上一场的结果 `last` 和战报 `report`。`detail:"full"` 返回上表的完整字段结构（Python 的
`Agent.observe()` 默认仍是 full）。

**增量观察。** 每份观察带 `rev`。把上一次的 `rev` 作为 `since` 传回，只返回变化的部分：

| 键 | 含义 |
|---|---|
| `unchanged` | 与 `since` 那份相同、本次省略的段落名 |
| `removed` | `since` 里有、现在没有的键（例如关掉的弹窗、结束的选择阶段） |
| `catalog` | 只含 `since` 那份没有的定义 |
| `resync: true` | 服务端已不记得 `since`（太旧、换了参数、重启过），本次是完整观察 |

阶段、回合等标量每次都给。在本地游戏上实测 10 个回合，按“每个动作后观察一次”的节奏，观察累计约 10 万字符，
同一批局面用旧的 compact 渲染约 57 万字符。丢了上下文的调用方不传 `since` 即可拿到完整观察。

```python
obs = game.observe(detail="compact")
piece = obs["board"][0]
base = obs["catalog"][f'{piece["kind"]}:{piece["id"]}']
print(base["name"], base["cost"], base["trait"], piece["uid"])

delta = game.observe(detail="compact", since=obs["rev"])   # 只含变化
```

使用放置辅助函数时，应传入带 `field` 的完整观察。

### 教程：`stronghold_guide`

`stronghold_guide` 是这个游戏的整体教程，外加按当前对局生成的参考页。它讲清规则，选择留给 agent。

- **教程章节**（`mcp/guide-notes.js`）：对局流程、坐标与朝向、调度中心与资金、干员与装备、盟约与层数、作战、生命值与漏怪、策略。
  每条规则对照游戏源码核实并注明位置；章节里的数字（收入、价格、格子数、作战时限、机变回合、隐秘核心条件等）
  取自服务器的 `config.json` 当前模式，与浏览器加载的是同一份。
- **参考页**（从数据生成）：本局使用的每个盟约——阈值、说明、数值参数 `params`、哪些干员的特质给它叠层（按触发时机标出
  `获得时` / `部署时` / `战斗中` …）、哪些干员随它的层数变强；以及策略页。参考页覆盖本局启用的盟约和本局干员池。
- **按需取用**：只传 `topic` 时返回目录（id 与标题，读过的标 `read:true`）：`auto` 按阶段列出相关页，
  `tutorial` / `bonds` / `bands` 列出整个分类；传 `ids` 时返回这些段落的内容。目录约 400 字符，正文由 agent 按需读取。
- **文字规范**：只写游戏里存在的东西；用陈述句；讲机制，不给固定打法。`test/guide.test.mjs` 会检查教程里的否定句。

```python
game.guide()                                  # 当前阶段的目录
game.guide(ids=["tutorial.shop", "bond.kazimierzShip"])  # 读取段落
game.guide(topic="bonds")                     # 本局全部盟约的目录
```

### 提示词与缓存

服务器在 MCP 握手时下发一段固定的 `instructions`（`mcp/instructions.js`，约 1.2K 字）：回合循环、上下文规则、攻略目录。
客户端把它放进系统提示词。它和工具定义都是代码常量，所有会话逐字节相同，提示词缓存可以跨对局命中；
局面、教程正文等随对局变化的内容只出现在工具结果里，追加在对话末尾。分层、规则和任务提示词模板见
[docs/prompting.md](docs/prompting.md)，`test/prompt.test.mjs` 检查前缀的稳定性。

---

## action：agent 能做什么

动作面就是游戏自己的客户端协议，一字不改。简写或原始协议都行：

```python
game.buy(0)                                   # {"t": "g.buy",  "f": {"slot": 0}}
game.place(uid=12, row=9, col=5, direction="RIGHT")
game.send("g.offer", offerId="...", pluginId="...", seq=1, idx=0)   # 原始协议
game.act({"buy": 0}, {"place": {"uid": 12, "row": 9, "col": 5}})    # 批量
```

`game.protocol()` 列出**全部**动作与字段（和 MCP 的 `stronghold_protocol` 同一份表，源自
[`mcp/protocol.js`](mcp/protocol.js)）。任何没覆盖的动作都能用 `{"t": ..., "f": ...}` 原样发出。

---

## 战斗模拟从哪来

`mcp/sim/` 负责拿到模拟并让 Node 能跑它。两条来源，按顺序尝试：

| 来源 | 条件 | 代价 |
|---|---|---|
| **① 插件接口** | 服务器装了 `stronghold-agent` 插件 | 一次约 10 MB 请求 + 一个内容指纹 |
| **② 爬 `/sim/`** | 没装插件 | 数百次请求，**且必然不完整**（内容模块是计算式动态 import） |
| **③ 本地游戏安装** | 设了 `STRONGHOLD_SIM_ROOT` / `STRONGHOLD_SIM_SPEC` | 零下载，最快 |

拿到之后，MCP 把源码写到本地缓存，**按真实仓库布局**落盘，再交给 Node 的模块解析器：

```
<cache>/<server>/<fingerprint>/
├── server/sim/…        ← /sim/…
├── shared/…            ← /shared/…
├── server/data.js      ← /data.js（服务器生成的替身）
└── data/*.json         ← /data/*.json
```

**这个布局是承重的。** 模拟的模块是按仓库结构写的：`server/sim/simdata.js` 里
`import '../../shared/loadoutRecord.js'`、`server/sim/content/support/index.js` 里
`import '../../../data.js'`。HTTP 上这些会被根目录夹住所以看起来没问题，但磁盘上不会夹 ——
扁平镜像会让 `../../` 多退一层。所以 `/sim/x` 必须落到 `server/sim/x`。

落盘后按浏览器的顺序初始化（`public/js/battle/simLoader.js`）：
`setSimData(raw)` → `setGameData(null)` → `rememberOfficialBounds(raw)` → import `spec.js`。

### 两条节奏，**按局**决定

| 节奏 | 何时使用 | 行为 |
|---|---|---|
| `realtime` | 普通房间**永远**是这个 | 和浏览器完全一致：250ms 一跳，每跳推进 `speed × 0.25s` |
| `burst` | **只在**训练房（`room.state.train === true`） | 同一场模拟、同样 tick 数，一次步进到底，只是中间不插真实时间 |

`STRONGHOLD_BATTLE_MODE=auto`（默认）/ `fast`（永远秒算，仅限只跑训练房的机器）/ `realtime`。

**普通房间不出现 `train` 键，因此拿到的就是原版节奏，一点加速都没有。** 两种节奏结果逐字节一致。

模拟是**懒加载**的：MCP 启动不等下载，第一场 `b.start` 等它。进度在 `stronghold_state` 的
`battleSimulation` 里可见（`ready` / `source` / `fingerprint` / `error`）。

远程运行器在上一场战斗已结束后、下一场权威 `b.start` 到来时重新检查 manifest。
版本不变时复用已加载的模块与数据；并发请求合并下载，失败允许重试。observation 也会复用已就绪的同版本模拟数据。
插件按实际文件内容生成指纹，并在指纹不变时复用已读取和解析的 bundle。

缓存使用独立临时目录和原子发布，已发布的版本保持不变。旧版本可能仍被其他进程使用，因此不再自动删除；
磁盘清理应在停止使用该缓存的进程后进行。更新插件后首次访问会因指纹算法变化重新建立缓存。

---

## 训练房与节奏控制

`room.create { train: true }` 请求**这一局**用 AI 训练节奏：客户端秒算战斗，服务端跳过固定演出延时与倒计时。

```python
game.create_room(mode="solo", difficulty="ABYSS", train=True)
```

这是**服务端**能力，不是客户端能自己开的：服务端没开训练开关时 `train: true` 会被明确拒绝
（`TRAIN_DISABLED`），不会静默忽略。服务端侧开关（`SP_TRAIN_TIMER_SCALE` 等）见
[`docs/training-rooms.md`](docs/training-rooms.md)。

普通房间完全不受影响 —— 这是刻意保证的：**「这一局要不要加速」是发起方的选择，属于房间参数**，
不是全局开关，更不该做成插件。早期版本用全局环境变量加速，结果普通房也被秒算了，那不是原版体验。

---

## 配置参考

全部通过环境变量，全部有合理默认值。完整列表见 [`.env.example`](.env.example)。
MCP 和 driver 启动时会读仓库根目录的 `.env`；**已经在环境里的变量优先**（MCP 客户端配置里的 `env`、systemd 单元都比 `.env` 说了算）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `STRONGHOLD_WS_URL` | `ws://127.0.0.1:3000/ws` | 游戏 WebSocket 地址 |
| `STRONGHOLD_HTTP_URL` | 由 WS 地址推导 | 登录取 cookie、以及取模拟用的 HTTP 源 |
| `STRONGHOLD_NAME` | `MCP Player` | 这个座位显示的名字 |
| `STRONGHOLD_AUTH_USER` / `_PASSWORD` | 空 | 网站有登录门禁时使用（只在内存里换 cookie）；未设置时读游戏服务端的 `SP_AUTH_USER` / `SP_AUTH_PASSWORD` |
| `STRONGHOLD_AUTH_COOKIE` | 空 | 直接给一个已拿到的会话 cookie |
| `STRONGHOLD_LOCAL_BATTLE` | 空（driver 下默认 `1`） | `1` = 挂战斗运行器 |
| `STRONGHOLD_SIM_ROOT` | 空 | 本地游戏安装（仓库根或 `server/`）—— 可选快路径；没挂战斗运行器时，攻击范围规则也从这里加载 |
| `STRONGHOLD_SIM_SPEC` | 空 | 直接指向 `spec.js` |
| `STRONGHOLD_SIM_AUTODISCOVER` | 空 | `1` = 允许从工作目录向上找安装（默认关闭，避免静默掩盖远程来源） |
| `STRONGHOLD_SIM_CACHE` | `~/.cache/stronghold-mcp` | 模拟缓存目录 |
| `STRONGHOLD_BATTLE_MODE` | `auto` | `auto` / `fast` / `realtime` |
| `STRONGHOLD_MCP_TOOLS` | `compact` | 默认 9 个通用工具；`full` 额外注册每个动作的便利工具，共 62 个 |
| `STRONGHOLD_DATA_DIR` | 空 | 本机游戏的 `data/` 目录；不设则从服务器 `/data/` 取 observation 用的数据 |
| `STRONGHOLD_FIELD_REGION` | `9,12,2,10` | 本座位半场的 `r0,r1,c0,c1`，默认即游戏 `GEO.FIELD` |
| `STRONGHOLD_RECORD_DIR` | 空 | 每局一个 `.jsonl` 写到这个目录，供赛后复盘（见 [docs/prompting.md](docs/prompting.md)）；空 = 不记录 |
| `MCP_TRANSPORT` | `stdio` | `http` = Streamable HTTP |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `8787` | HTTP 传输监听地址 |
| `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD` | 空 | HTTP 传输的 Basic Auth；未设置时依次用 `STRONGHOLD_AUTH_*`、`SP_AUTH_*` |
| `MCP_HTTP_IDLE_SECONDS` | `1800` | HTTP 会话多久没有请求就关闭（连同它的游戏座位）；`0` = 只在 DELETE 时关闭 |
| `DRIVER_HOST` / `DRIVER_PORT` | `127.0.0.1` / `8899` | 常驻驱动监听地址（**别暴露到公网**） |
| `DRIVER_TIMEOUT` | `180` | 单次请求默认超时（秒，driver 与 Python SDK 同一单位） |

服务端侧（不是这个仓库的）：`SP_PLUGIN_SCRIPTS`、`SP_TRAIN_TIMER_SCALE`、`SP_TRAIN_SCOPE`。

---

## 安全

- **连接一台服务器，等于允许它在你的机器上执行代码。** 挂了战斗运行器（`STRONGHOLD_LOCAL_BATTLE=1`）时，MCP 从游戏服务器
  下载模拟源码并在本机的 Node 里执行，和浏览器执行同一份代码一样。只连接你信任的服务器；只想观察和行动时不挂运行器即可。
- **凭据只在内存里。** 账号密码只用来换会话 cookie，不写日志、不落盘。`.env` 在 `.gitignore` 里，提交前确认它没有被加进来。
- **HTTP 传输必须认证。** `MCP_TRANSPORT=http` 时每个请求都要 Basic Auth，一组凭据都没配置时一律 401。默认只监听 `127.0.0.1`，
  对外经反向代理和 HTTPS。没设 `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD` 时会借用站点登录凭据；给远程客户端单独设一组更好，
  站点密码只留在服务器上。空闲会话按 `MCP_HTTP_IDLE_SECONDS` 自动关闭。
- **driver 端口只给本机。** 本地 TCP 行协议没有认证，`DRIVER_HOST` 保持 `127.0.0.1`。
- **插件只读，并按哈希钉住。** 见 [docs/plugin-install.md](docs/plugin-install.md) 的「安全边界」。

---

## 仓库结构

```
stronghold-mcp/
├── plugin/                    ★ 游戏侧：装到服务器的插件（不改源码）
│   ├── plugin.json            manifest（class: trusted, scope: server）
│   └── server.js              activate(api)：注册四个只读路由
├── mcp/                       ★ Agent 侧：MCP 桥接层
│   ├── index.js               stdio / Streamable HTTP 传输
│   ├── server.js              一个会话的 MCP 服务器：instructions + 工具
│   ├── instructions.js        固定的服务器说明（进入系统提示词，可缓存）
│   ├── tools.js               工具注册（full / compact）
│   ├── http-sessions.js       HTTP 会话表与空闲关闭
│   ├── game-client.js         真实玩家 WebSocket 会话
│   ├── protocol.js            动作表（工具列表与文档的唯一来源）
│   ├── observation.js         帧 + 数据文件 → 决策用快照
│   ├── observe-log.js         增量观察（rev / since）
│   ├── recorder.js            本地对局记录（STRONGHOLD_RECORD_DIR）
│   ├── guide.js               stronghold_guide：教程章节 + 本局参考页
│   ├── guide-notes.js         教程章节（对照源码核实，数字取自 config.json）
│   ├── gamedata.js            observation 用的数据文件（服务器 /data/ 或本机目录）
│   ├── env.js                 读仓库根目录的 .env
│   ├── sim/                   拿到并加载战斗模拟
│   │   ├── index.js           编排：插件 → 爬取 → 落盘 → 加载
│   │   ├── plugin.js          插件接口客户端
│   │   ├── crawl.js           无插件时的 /sim/ 爬虫
│   │   └── store.js           URL→磁盘映射、缓存、Node 加载与完整性校验
│   └── battle/
│       ├── index.js           attachBattle：选来源，挂运行器
│       ├── local-sim.js       两种节奏的战斗运行器
│       └── resolve-sim.js     本地游戏安装解析（显式）
├── driver/                    常驻 MCP 进程 + 本地 TCP 行协议
├── python/                    Python SDK（纯标准库）+ 3 个示例 + 13 个测试
├── test/                      Node 测试（104 个，含内存协议桩与合成安装）
├── .github/workflows/        CI：Node 测试 + Python 测试
├── README.en.md               English overview
├── ROADMAP.md                 目标判据（像人类一样操作）与下一步
└── docs/
    ├── plugin-install.md      插件安装、pin、卸载、安全边界
    ├── architecture.md        分层、边界、为什么这么切
    ├── protocol.md            游戏协议与动作表
    ├── observation.md         observation 每个字段的来源
    ├── prompting.md           提示词分层与缓存规划、按需取用
    ├── deploy.md              MCP 跑成服务器常驻服务：systemd、nginx、升级与回滚
    └── training-rooms.md      训练房与服务端节奏开关
```

---

## 设计取舍与踩过的坑

1. **SDK 不做决定。** 一旦 SDK 里出现「该买什么」，它就从陪玩工具变成了代打脚本，agent 也退化成调用方。

2. **游戏级错误必须合并进返回值。** MCP 调用成功不代表游戏接受 —— 后者会回一个 `t: "error"` 帧。
   早期脚本只看 MCP 的成败，于是「买失败了」被当成「买成功了」，策略在错误的状态上继续跑。

3. **镜像必须复刻仓库布局，不是 URL 布局。** `server/sim/` 比 `/sim/` 深一层，而模块里的
   `../../shared/…` 是按前者写的。扁平镜像会让它多退一层，报 `ERR_MODULE_NOT_FOUND`。

4. **`/data.js` 在模块图里是 `server/data.js`。** `server/sim/content/support/index.js` 里
   `../../../data.js` 落到 `server/data.js`；HTTP 上的 `/data.js` 是服务器生成的替身。落盘时要放到前者。

5. **爬取路径必须诚实失败。** 内容模块用计算式动态 import 加载，静态爬虫原理上跟不到。
   所以 MCP 捕获模拟自己的 `[content] failed to load …` 诊断，有缺失就拒绝运行 ——
   游戏自己也是这个立场：*"a battle simulated without part of the data would still produce a plausible
   result the server accepts: never run one"*。

6. **普通房必须真无加速。** 早期用全局环境变量控制，导致普通房也被秒算。现在按 `room.state.train`
   **逐局**判断，普通房与浏览器逐字节一致。

7. **`hello` 是一次完整 resync，不是打招呼。** 服务端会重发 `room.state` 和（在局内）`m.public` /
   `m.private`。所以桥接层在每次 `hello` 前丢弃全部缓存帧 —— 否则重连后 `snapshot()` 继续返回上一局的帧，
   而 agent 无从分辨。

8. **`battleSimulation` 是会话属性，不是回合属性。** 一局结束后它不会自己归零。
   observation 因此在 `current.round` 既不是当前回合也不是上一回合时标 `stale: true`。

9. **手牌满会溢出到 temp，temp 非空时不能就绪。** `me.can_ready` 已经算好了，别自己推。

10. **远程干员放不进近战格。** 游戏回 `BAD_TILE`。用 `tiles_for()` 过滤，别硬试。

11. **别用 `pkill -f <脚本名>` 清理进程**，它会匹配到执行该命令的 shell 自身。
    用 `pkill -f '^node .*drive-daemon'`，或者按监听端口找 pid。

12. **别把文档放进插件文件夹。** 锁覆盖文件夹里**每一个**文件，改一行 README 就会让
    `PLUGIN_TRUST_PIN` 失效。插件目录只留可执行内容。

13. **凭据不落盘。** `start-daemon.sh` 支持从文件或命令注入 `SP_AUTH_USER` / `SP_AUTH_PASSWORD`
    （游戏服务端自己的变量名），再以 MCP 读取的 `STRONGHOLD_AUTH_*` 交给它，不打印、不写文件。

14. **只模拟原版内容。** 装了玩法插件的房间，战斗 spec 带着那个 content set 的 `cs`，服务端只核对结果里的
    `cs` 对不对得上。用原版数据算、却标着房间 `cs` 的结果会被当作合理结果接受 —— 所以运行器遇到不是
    `welcome.content.vanilla` 的 `cs` 就**不接手**，交给服务端（和浏览器同一条规则），状态里记在 `battle.declined`。

---

## 许可与声明

本仓库的代码以 MIT 发布（见 [LICENSE](LICENSE)）。

本项目是非官方同人作品 [卫戍协议：盟约 · Stronghold Protocol: Alliance](https://github.com/sganggs/Stronghold-Protocol) 的配套工具，与鹰角网络（Hypergryph）、
Yostar 及其关联方无关。《明日方舟》及相关名称、角色、素材与数据的一切权利归原权利人所有。

本仓库只做协议适配、插件接口与观察渲染，**不包含任何游戏素材、数据文件或上游服务端代码**。战斗模拟源码与数据都在运行时
从使用者自己部署的服务器取得，继续适用上游的 GPL-3.0-or-later 许可与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)：
仅供学习交流与个人非商业使用。请同时遵守目标服务器的规则与当地法律。
