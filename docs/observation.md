# observation 字段来源

这份文档逐字段说明 observation 里的每个值是**从哪里来的**，以便你判断它的可信度、
以及在字段缺失时知道该去查什么。

observation 由 MCP 工具 `stronghold_observe` 返回（Python 的 `Agent.observe()` 调的就是它）。
渲染代码在 `mcp/observation.js`，数据文件的获取在 `mcp/gamedata.js`。

`detail:"full"` 使用本文的字段结构（`observation()` 与 Python `Agent.observe()` 的默认）。
MCP 工具 `stronghold_observe` 默认 `detail:"compact"`：棋子和敌人的静态面板、盟约名与阈值合并到 `catalog`，
键分别为 `chess:<id>`、`item:<id>`、`token:<id>`、`enemy:<key>`、`bond:<id>`。
棋子和出怪列表保留各自的动态字段，商店 `price` 优先采用服务端价格，`catalog` 中的 `price` 是静态基础价。
敌人的服务端 `fly` 标志也优先于静态定义，所以出怪条目总带 `fly`。

compact 不写出默认值：`null` 的字段、`golden/sold/frozen/elite/boss/counts_hand/disabled_this_match` 为 `false`、
`count` 为 1、`items` 为空时都省略；`me.deploy` 字符串省略（看 `deploy_count` / `deploy_cap`）；
`reward_offer` / `personal_choice` 为空时省略。`battle` 精简为 `mode`、`ready`、上一场结果 `last`、
战斗进行中的 `live`、战报 `report`（不重复 `last` 已有的结果字段），以及出错时的 `error` / `declined` / `stale`。

`includeField:false` 省略地图，`includeReport:false` 省略战报；二者默认均为 `true`，可用于两种 detail。

## 增量：`rev` / `since`

`stronghold_observe` 的每份回复带 `rev`。传 `since:<rev>` 时只返回相对那一份的变化：

- 标量（`phase`、`round`、`seconds_left` …）每次都给；
- 对象或数组段落与 `since` 那份相同时省略，名字列在 `unchanged`；
- `since` 里有、现在没有的键列在 `removed`；
- `catalog` 只含 `since` 那份没有或变了的条目。

服务端保留最近 16 份。`since` 不在其中、或那份是用别的 `detail` / `includeField` / `includeReport` 取的，
回复就是完整观察并带 `resync: true`。内容没变时 `rev` 不变（`frames_age_ms` 和 `seconds_left` 的跳动不算变化）。

---

## 来源标记

| 标记 | 含义 |
|---|---|
| **服务端** | 直接来自最近的 `m.public` / `m.private` / `room.state` 帧 |
| **推导** | 由服务端字段计算得出（例如剩余秒数） |
| **数据** | 来自游戏自己的 JSON 数据文件（`chess.json` 等），是静态事实 |
| **缺失** | 服务端当前没有提供，值为 `null` |

---

## 顶层

| 字段 | 来源 | 说明 |
|---|---|---|
| `connected` | 服务端 | 这个座位当前是否持有活连接 |
| `has_frames` | 推导 | 自上次 `hello` 以来是否收到过状态帧 |
| `frames_age_ms` | 推导 | 距最近一个状态帧过去的毫秒数；`null` = 自上次 hello 后什么都没收到 |
| `phase` | 服务端 | `m.public.phase` |
| `round` | 服务端 | `m.public.round` |
| `seconds_left` | 推导 | `(m.public.deadline - m.public.serverNow) / 1000`，四舍五入到 0.1；`≤ 0` 或非数字时为 `null` |
| `paused` | 服务端 | `m.public.paused`，单人暂停时为 `true` |
| `stage` | 服务端 | `m.public.stageId` |
| `combat_mode` | 服务端 | `m.public.combatMode`：`client` = 浏览器模拟，`server` = 服务端推流 |
| `room` | 服务端 | `room.state` 的 `code` / `mode` / `difficulty` / `train` |
| `band_draft` | 服务端 + 数据 | 仅 `BAND_DRAFT`：见下文 |
| `sp_draft` | 服务端 | 仅 `SP_DRAFT`：见下文 |

### 为什么需要 `connected` 和 `frames_age_ms`

observation 里的所有帧都是「**最后一次收到的**」。因此一个已经断开、或者已经不在任何房间里的座位，
会继续展示它最后看到的那一局 —— 这足以让一个 agent 认真地对着一个几小时前就结束的对局做决策。

`connected` / `has_frames` / `frames_age_ms` 就是给这件事的护栏。经验值：

- `connected == false` → 先重连，别继续决策。
- `frames_age_ms` 很大（比如几十秒）而 `phase` 是 `PREP` → 这个座位很可能已经不在对局里了，帧是残影。

`Agent.wait_for_phase` 在开始等待前会检查 `connected`，不通过就抛 `ConnectionError`，
而不是把整个 timeout 烧在一个已经结束的对局上。

> `room.train` 是**按局**的训练标志。普通房里这个键**不存在**（值为 `null`），
> 这也是判断「这一局有没有被加速」的唯一依据。

---

## `me`（本座位）

全部来自 `m.private`。

| 字段 | 说明 |
|---|---|
| `playerId` / `seat` / `alive` / `lp` | 身份与生命值 |
| `funds` | 当前资金 |
| `band` | 选定的策略盟约 id |
| `level` / `max_level` / `upgrade_price` | 商店等级、上限、升一级的价钱（已满级时服务端给 `0`） |
| `refresh_price` / `free_refreshes` | 刷新价（有免费刷新时服务端给 `0`）、剩余免费刷新次数 |
| `shop_frozen` | 商店是否被冻结 |
| `deploy` / `deploy_count` / `deploy_cap` | `"场上/上限"` 字符串，以及两个原始数字 |
| `ready` / `can_ready` | 是否已就绪；**`can_ready` 是服务端算好的** |
| `stats` | 累计 `dmgDealt` / `kills` / `leaks` / `gold` / `refreshes` / `merges` |

> `can_ready` 已经把「temp 整备区非空」和「有未处理的个人抉择」算进去了。
> **不要自己推这个条件**，直接读。

---

## `shop`

`m.private.shop.slots[]`，每个非空槽位与数据文件连接：

| 字段 | 来源 |
|---|---|
| `slot` | 服务端（数组下标） |
| `kind` | 服务端：`chess` 或 `item` |
| `id` | 服务端 |
| `price` | 服务端（已含折扣） |
| `sold` / `frozen` | 服务端 |
| `name` / `tier` / `prof` / `pos` / `hp` / `atk` / `def` / `res` / `block` / `hit_fly` / `dmg` / `cost` / `bonds` | 数据（`chess.json` / `items.json`） |
| `trait` | 数据（`garrisons.json`）：卡面上的特质文字，例如 `<获得时>自身所属盟约层数+2`。只取第一个特质，与详情面板一致；后面的 id 是同一特质拆出的机制部件 |

`cost` 是部署费用。开战时棋盘上的干员全部免费部署；部署费用只在被击倒或撤退后再部署时消耗。

空槽位是 `{"slot": n, "empty": true}`。

---

## `reward_offer` / `personal_choice`

| 字段 | 来源 | 说明 |
|---|---|---|
| `reward_offer` | 服务端 | `m.private.shop.rewardOffer`。`source` 为 `merge`（晋升奖励）或 `special`；`queued` 是它后面还排着几个 |
| `personal_choice` | 服务端 | `m.private.personalChoice`，带 `id` / `round` / `cards` |

`can_ready` 只看临时整备区是否为空、`personal_choice` 是否已处理（`player/views.js:74`）。`reward_offer`（晋升奖励等）**不挡就绪**，
也不会在回合结束时作废，排在队列里留到之后再选。

---

## `hand` / `temp` / `board`

三者结构一致，都是 `m.private` 对应数组渲染而成。未占用的槽位直接跳过。

| 字段 | 来源 | 说明 |
|---|---|---|
| `slot` | 服务端 | 在数组里的下标（手牌位 / 临时位） |
| `uid` | 服务端 | 棋子实例 id —— **动作里用的就是它** |
| `kind` / `id` | 服务端 | `chess` / `item` 与数据 id |
| `name` / `tier` / `price` / `prof` / `pos` / 面板 / `bonds` | 数据 | 同 `shop` |
| `items` | 服务端 | 装备在这个棋子上的物品 id 列表 |
| `row` / `col` / `dir` | 服务端 | 仅 `board` 上的棋子有 |

另外：

- `hand_free`：手牌空位数（推导：数 `hand` 里的 `null`）。
- `board_tiles`：`"row,col" → uid` 的映射（推导）。用来一眼看出哪些格子被占了，
  以及某个格子上站的是谁。`Agent.tiles_for()` 就是靠它排除已占用格。

> **`uid` 是动作里唯一该用的标识。** `id` 是数据 id（例如 `chess_char_1_02_a`），
> 同一个数据 id 可以同时存在多个实例，用 `id` 发动作会失败。

---

## `bonds`

`m.private.bonds[]`（服务端 `bondList(..., {full: true})`）加上数据文件补充：

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` / `bond` | 服务端 / 数据 | `bondId` 与显示名 |
| `count` | 服务端 | 当前计入的成员数 |
| `active` / `tier` | 服务端 | 是否激活、激活到第几档 |
| `layers` | 服务端 | **实时层数** —— 叠层流派的核心观测量 |
| `thresholds` | 数据 | `bonds.json` 的档位阈值 |
| `counts_hand` | 服务端 | 是否把备战区（手牌）也算进 `count` |
| `disabled_this_match` | 服务端 | 是否被本局禁用（`m.public.disabledBonds`） |
| `off` | 服务端 | 本局禁用但自己有成员（显示为灰盘） |

服务端只列出 `count > 0 || layers > 0 || active` 的盟约。**没列出来的就是 0。**

---

## `effects` / `next_enemies`

| 字段 | 来源 |
|---|---|
| `effects` | `m.private.effects`：`name` / `desc` / `counter` |
| `next_enemies` | `m.private.nextEnemies`，每个出怪动作一条：`at_s`（时间）、`count`、`gate`、`elite`、`fly`、`boss`，再与 `enemies.json` 连接补上面板 |

`fly` 按模拟的规则判断（`server/sim/units.js` `isFlying`）：`motion` 为 `FLY`，或带「近地悬浮」（`hover: true`，沿地面路线走）
都算空中单位，一般不能被阻挡。只看 `isFlyEnemy` 会漏掉这两类，所以有数据记录时不采用出怪预告里按刷怪位给的 `fly`。
`boss_lp` 是数据里的 `lifePointReduce`：只在 Boss / 隐秘回合按它扣团队生命；普通回合每漏 1 只计数的敌人扣 1 点。

`next_enemies` 是**服务端自己的预告**，不是本地推断。

---

## `band_draft`（策略选择）

只在 `phase == "BAND_DRAFT"` 时出现，内容与选择界面一致（`public/js/screens/bandDraft.js`）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `my_turn` / `turn` | 服务端 | `m.public.draft.turn` 是否是自己 |
| `my_pick` / `skips_left` / `untimed` | 服务端 | 自己已选的策略、剩余跳过次数、是否不计时 |
| `options[]` | 数据 | 本模式允许的**全部**策略（`modeTypeList` 含 SINGLE / MULTI），按 `sortId` 排序 |
| `options[].lp` / `effect` / `desc` | 数据 | 初始生命值、效果名、说明 |
| `options[].off_bonds` | 推导 | 策略依赖的盟约本局被禁用（界面上的「本局禁用」），仍可选 |
| `options[].taken_by` | 服务端 | 队友已选，不能再选 |

用 `g.band { bandId }` 选择。

## `sp_draft`（机变）

只在 `phase == "SP_DRAFT"` 时出现，来自 `m.public.sp`：`event` / `name` / `desc`、`my_turn` / `my_pick`，
以及 `cards[]`（`idx` / `kind` / `id` / `name` / `tier` / `price` / `desc`，`sold_out`、`taken_by` 仅在成立时出现）。
用 `g.choice { idx }`（不带 `choiceId`）选择。

---

## `players`

`m.public.players[]`：每个座位的 `seat` / `name` / `bot` / `alive` / `lp` / `level` /
`board` / `ready` / `status` / `band`，以及**前 8 个盟约名**。

联机时用它判断队友在做什么、谁已经就绪、谁快死了。

---

## `field`

来自 `m.public.stageId` → `stages.json`：

| 字段 | 来源 | 说明 |
|---|---|---|
| `region` | 配置 | 本座位半场的 `r0,r1,c0,c1`，默认是游戏自己的 `GEO.FIELD` |
| `axes` | 常量 | 坐标约定（`server/sim/dir.js`）：row 0 在屏幕最下方，`UP` = row+1；默认朝向 `RIGHT`（敌人来的方向） |
| `deploy_melee` | 数据 | `deployTiles.normal.melee` |
| `deploy_ranged_only` | 数据 | `deployTiles.normal.rangedOnly` |
| `lanes` | 数据 | `groundPaths` 中起点落在本半场内的路线 |
| `leak_tile` | 推导 | `[r0, c0]`，漏怪方向的角 |
| `map_rows` | 数据 | 本半场那几行的地图，**从屏幕顶部往下**，每行 `"行号|字符串"`，字符下标就是列号 |

关于 `region`：它镜像游戏源码里的 `GEO.FIELD = { r0: 9, r1: 12, c0: 2, c1: 10 }`，
是一个**常量**而不是每关算出来的。如果你在看一个它描述不了的布局，用 `STRONGHOLD_FIELD_REGION="r0,r1,c0,c1"` 覆盖。

**可部署格的权威来源是 `deployTiles`**（来自关卡数据），`region` 只用于筛路线和裁地图。

---

## `data_error`

只在游戏数据文件取不到时出现（服务器不可达、登录未配置、`STRONGHOLD_DATA_DIR` 指错）。此时帧照常渲染，
只有从数据文件连接过来的名字和面板是 `null`；下一次调用会重试。

数据描述的是服务器的**原版内容**。装了玩法插件的房间（content set）可能改动了部分记录，observation 仍显示原版。

---

## `battle`

只在挂了本地战斗模拟（`STRONGHOLD_LOCAL_BATTLE=1`）时出现：

| 字段 | 说明 |
|---|---|
| `enabled` | 是否挂上 |
| `mode` | `auto` / `fast` / `realtime` |
| `fast` | 最近一次决策用的是不是秒算 |
| `current` | 最近一场跑的：回合、种类、进度 |
| `lastResult` | 最近一场的结果摘要（不含战报） |
| `report` | **最近一场战斗的体检复盘**（层数增量、伤害类型分布、伤亡、漏怪），只出现在这里一份 |
| `stale` | `current.round` 既不是当前回合也不是上一回合时为 `true`（备战阶段看到上一回合的战斗是正常的） |
| `stale_reason` | 具体的错位说明 |
| `declined` | 最近一场**没有接手**的战斗：它跑在本运行器没有的 content set 上，交给服务端模拟 |
| `error` | 失败原因（挂不上时还有 `hint`） |

### 为什么会有 `stale`

`battleSimulation` 是**会话**的属性，不是**回合**的属性。一局结束后（或者座位离开房间后），
`current` 仍然描述着它跑过的最后一场战斗。所以它不能直接当作「现在正在打的那一场」来读。

真实例子：一个座位在训练房里打完第 12 回合后离开，进了另一个房间；此时
`battle.current.round == 12` 而 `phase/round` 来自新房间（或来自残留帧）。
`stale: true` 把这件事直接指出来。

### 关于 `steps` / `simMs`

这两个字段**只有秒算（burst）路径才会写**。所以：

- `lastResult.steps` / `lastResult.simMs` 存在 → **那一场**是秒算的。
- 不存在 → 那一场走的是浏览器的 250ms 实时节奏。

注意这是**逐场**的事实，不是房间的属性。判断房间有没有被加速要看 `room.train`。

### 关于 `battle.report`（战报）

战斗结束后由本地模拟器自动生成的复盘体检表，供 Agent 在下一回合备战时评估阵容表现：

| 字段 | 含义 |
|---|---|
| `layer_gains` | 本场战斗通过干员特质实际增加的**盟约层数增量**（如 `{"kazimierzShip": 24}`） |
| `damage_types` | 友方造成的伤害类型构成（`phys`, `arts`, `true`, `elemental`），用于检查面对高抗怪是否严重刮痧 |
| `casualties` | 阵亡的友方干员与倒下时间（`name`, `time`, `reason`） |
| `leaks` / `leaked_enemies` | 漏怪数量与敌人代号（用于判断是否缺乏对空、阻挡数不足） |
| `units` | 场上干员的输出与生存摘要（`dmg`, `taken`, `heal`, `alive`），按伤害降序排列 |


---

## 关于「重连会清空帧」

`hello` 是一次**完整 resync**：服务端回 `welcome`，然后重发 `room.state`，
在局内还会重发 `m.public` / `m.private`（以及战斗 spec）。

因此桥接层在每次 `hello` 之前**丢弃全部缓存帧**。否则一个 agent 重连后会看到上一局的残影，
并把它当成当前状态。丢弃是安全的：还成立的东西会在同一次握手里重新到达。

这也是为什么 `frames_age_ms` 在刚重连、还没收到新帧时是 `null`。

---

## 已知缺失

| 想要的东西 | 现状 |
|---|---|
| `gainedChess`（本回合获得过的干员数） | **不在 `m.private` 里**。它只暴露给战斗效果脚本（`roundStats`）。需要就自己数买入次数 |
| 对手的手牌与商店 | 服务端不下发（`m.field` 只能看到侦察到的场地） |
| 未来波次的精确时间轴 | 只有 `next_enemies` 的预告 |
| 战斗内的逐帧状态 | `battle.report` 给出整场汇总（层数增量、伤害类型、伤亡）；逐帧细节要挂本地模拟后自己读 |
