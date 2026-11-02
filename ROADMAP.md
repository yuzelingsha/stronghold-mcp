# 路线图

## 目标与判据

**让 agent 像人类玩家一样操作这个游戏。** 每个功能都用同一条判据衡量：

> agent 看到的 = 人类在屏幕上能看到的；agent 能做的 = 人类能点的。**不多，也不少。**

| 人类 | agent 对应 | 状态 |
|---|---|---|
| 看游戏画面 | `stronghold_observe` | ✅ 备战阶段已覆盖 |
| 悬浮提示里的面板、技能、盟约说明 | `stronghold_lookup`，卡面的部署费用与特质在 catalog | ✅ |
| 策略选择、机变选卡界面 | observe 的 `band_draft` / `sp_draft` | ✅ |
| 大厅里的座位与就绪状态 | observe 的 `room.seats` | ✅ |
| 拖棋子时高亮的攻击范围 | catalog 的 `range`、`board[].range_tiles` | ✅ |
| 奖励弹窗的卡面 | `reward_offer.slots` 与 catalog | ✅ |
| 重随投票 | observe 的 `reroll_vote` | ✅ |
| 点按钮、拖棋子 | 协议动作（`stronghold_action`，和浏览器一字不差） | ✅ |
| 看着战斗打完 | `battle.report` 复盘体检（层数增量、伤害类型、伤亡） | ✅ P1-1 |
| 点开别人的场地侦察 | observe 的 `scouted` | ✅ P1-2 |
| 结算画面 | observe 的 `result` | ✅ P1-3 |
| toast、滚动播报、表情 | observe 的 `messages` | ✅ P1-4 |
| 联防与最终攻势的状态条 | `unite`、`boss_hp`、`team_lp` 等 | ✅ P1-6 |

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

### 2. 侦察：`m.field` ✅

人类备战时可以点开别人的场地看阵容。`g.watch { fieldId, playerId? }` 之后服务端回 `m.field`（棋盘、手牌、temp、对方的效果、下一波）。
把最近一次侦察渲染进 observe 的 `scouted`，带上是谁的场地、多久之前的。

备战阶段没有战场，`players[].fieldId` 为空，`fieldId` 用 `n:<playerId>`；战斗中用 `players[].fieldId`。
最终攻势只能看自己这组的场地。`g.watch` 的动作说明写明了这两点。

后续：战斗中观战时服务端回的是 `b.start`（`watch: true`），要跑一份展示用的副本才看得到，见 P1-1 的后续。

### 3. 结算：`m.result` ✅

结算画面的内容。渲染进 observe 的 `result`，只在 `RESULT` 阶段出现，所以同一房间的下一局不会读到上一局的结算。

### 4. 提示与播报：`m.toast` / `m.ticker` / `m.emote` / `room.closed` ✅

人类看得到弹出提示和滚动播报。客户端的 `last` 每种帧只留最新一条，事件队列又会被 `stronghold_wait_event` 取走，
所以需要单独留一个最近 N 条的环形缓冲（每条带时间和回合），由 observe 的 `messages` 带出，agent 按 id 去重。
缓冲独立于缓存帧：每次 `hello` 和离开房间都会清缓存帧，消息要留下来。

表情是 36 个官方 id，冷却 1 秒，协议只认 id。参考页 `emotes` 按需读取，列出有含义的 18 个，
其余 18 个是编号贴图，没有含义。收到的表情在 `messages` 里带 `label`。

### 5. 卡面、大厅与投票 ✅

人类屏幕上有、observe 之前缺的几处静态和房间信息，都只是连接已有的帧和数据：

- `players[]`：`playerId`、`fieldId`、`connected`、`pending_lp`、`unite_left`。其他帧都用 `playerId` 指代玩家。
- `reward_offer.slots`：与商店同样连接数据，写入 catalog。`personal_choice` 的卡牌由服务端命名，保持原样。
- `range` / `skill` / `golden`：catalog 每条平均增加约 240 字符，一条约 480 字符，代替一次约 5.7K 字符的 `stronghold_lookup`。
  范围规则用游戏自己的 `attackRangeGrid`，运行时从模拟树加载，模拟就绪前退回 `rangeGrid`；游戏是 GPL-3.0-or-later，本仓库是 MIT，代码不复制进来。
- `room`：`host_id`、`in_match`、`ai_picks_last`、`seats[]`。
- `reroll_vote`、`setup_revision`：投票没有时限，agent 不表态会卡住整个房间。
- 离开房间或收到 `room.closed` 时清空缓存帧和运行器状态。

### 6. 联防与最终攻势 ✅

数据都在现有的帧里，只差渲染：

- `m.public.unite`：`helpers`、`leakers`。
- `m.public.uniteResult`：`through`、`helpers`、`leakers`、`losses`。
- `m.public.bossHp`、`teamLp`、`overtimeAt`、`fields[].progress`。
- `m.public.bannedChess`、`disabledBonds`、`bossId`、`hiddenBossId`，人类在本局信息里看得到，合成 `setup` 一段。
- 结算的 `bossDamage` 在 `m.result.players[].stats`，随 P1-3 一起给出。

### 7. `stronghold_wait_event` 只留最新状态 ✅

队列先进先出，`waitForEvent` 先返回最旧的匹配帧，战斗中服务端每秒推一帧 `m.public`，agent 读到的可能是几十秒前的状态。

- 状态帧（`m.public`、`m.private`、`room.state`、`b.pool`）每种只留最新一条：删除旧帧，新帧追加到队尾，保持与离散事件的先后关系。
- `m.field`、`b.snap` 按 `(t, fieldId)` 去重。
- 离散事件（`m.emote`、`m.ticker`、`m.toast`、`b.start`、`b.end`、`m.result`、`room.closed`）按到达顺序保留。

### 8. `seconds_left` 随时间走 ✅

之前按最后一帧的 `serverNow` 计算，帧静默时数字不变。现在加上帧龄，暂停时除外。
休整期的倒计时只在多名真人同局且不是训练房时出现，单人和「1 人 + AI」的休整期不限时。

---

## P2 座位保持在线

像浏览器一样：掉线了重连，登录过期了重新登录。

- ✅ **服务端重启后自动重新登录。** WebSocket 握手得到 401 且 cookie 是用账号密码换来的时，丢掉旧 cookie 重新登录一次；
  用户直接给的 `STRONGHOLD_AUTH_COOKIE` 保持原样（`mcp/game-client.js`）。
- ✅ **MCP 子进程退出时 driver 跟着退出**，交给 systemd 等进程管理器重新拉起（`driver/drive-daemon.mjs`）。
- ✅ **Python `Driver` 的请求带 id**，响应按 id 配对（`python/stronghold_agent/driver.py`）。
- ✅ **心跳与自动重连。** 连接可能静默失效：对端已经关闭，本地 `readyState` 仍是 `OPEN`，只有下一次写入才发现。
  实测一次掉线后，客户端约 4 分钟后才察觉。服务端的 30 秒 ping 保证服务端能发现，客户端要靠自己。
  改完后在同样的静默断线下，19 秒发现，20 秒内恢复原座位，实时战斗中途断线也能接上。
  - 与浏览器相同的参数（`public/js/net.js`）：每 4 秒发 `ping`，15 秒内没有任何入站帧就判定断线，退避 0.5～10 秒重连。代码自己写。
  - 重连带 `sessionToken` 发 `hello`，服务端全量重发状态和战斗。
  - 关闭码 `4001`（会话被顶替）和 `stronghold_disconnect` 之后不重连。

---

## P3 开源发布前

- **模拟缓存。**
  - ✅ 独立临时目录、原子发布、进程内下载与模块初始化去重；失败允许重试。
  - ✅ 远程运行器在两场战斗之间检查 manifest，按内容指纹复用模块与静态数据。
  - ✅ 发布新版本时保留旧目录，避免删除其他进程仍在使用的模块。
  - 后续：带跨进程使用记录的自动回收；目前只做停机后的显式清理。
- **插件 `/bundle` 在内存里按指纹缓存。** ✅ 已按实际内容指纹复用源文本和已解析的 bundle；传输层仍需序列化回复。
- **上下文。** ✅ 默认 10 个通用工具，协议按动作过滤；observe 默认 compact（静态面板放入 catalog、省略默认值），
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

## P4 本地复盘

经验由 agent 自己积累，和游戏事实分开。`stronghold_guide` 不收录具体对局的经验；通用的决策方法在 `method.*`，见 P5。

1. ✅ **Recorder。** `STRONGHOLD_RECORD_DIR` 开启，默认关闭，线上部署不开。按局把每回合阵容快照、每场 `battle.report` 和 `m.result` 追加到本地 `.jsonl`，格式见 `docs/prompting.md`。训练房常常收不到 `COMBAT` 帧，回合快照取自休整期最后的状态。
2. ✅ **赛后复盘模板。** 写进 `docs/prompting.md` 的任务提示词，agent 用自己的文件能力读写本地笔记，不增加 MCP 工具。
3. ✅ **笔记规则。** 写在模板里：
   - 每条带证据：Recorder 的局 id 或 `m.result.seed` 加回合号，房间号不保证唯一。
   - 能从 `field`、`catalog` 算出来的内容不写：路线汇合点、地块、面板。
   - 按主题限制条数和长度，新内容合并或替换旧内容。
   - 绑定 `welcome.content.vanilla`，内容版本变化后标记待重验。
   - 只记录游戏内 id 和数值，其他玩家的昵称和文字不写入，避免跨对局的持久注入。
4. **统计延后。** 积累足够对局后再离线聚合。按地图、策略、难度分桶后样本很少，现在没有统计意义。

---

## P5 打得赢

判据从“能操作”升级成“能打赢”。

### 基线

游戏自带 AI 用真实引擎跑的胜率，它和玩家走同一套校验，经济没有加成（`tools/matchrun.mjs`，下表关闭布阵预演，3 座 ABYSS 开默认预演的 4 局同样全败）：

| 模式 | 标准 FUNNY | 险境 NORMAL | 绝境 HARD | 终极 ABYSS |
|---|---|---|---|---|
| 单人 | 8/8 | 4/8 | 3/8 | 0/12，平均过 11.6 回合 |
| 3 座全 AI | | | | 0/6，平均过 10.7 回合 |

ABYSS 超出了内置 AI 的水平，不适合当日常考场。考核按难度逐级进行，先在相同种子上超过内置 AI，再往上走。

一个只有规则教程的快模型在 ABYSS 上打了 30 局的情况：

| 回合 | 调度中心等级 | 主盟约层数 | 激活盟约数 | 打到这一回合的局数 |
|---|---|---|---|---|
| 7 | 2.9（AI 4） | 11（AI 15） | 1.7（AI 4.5） | 26/30 |
| 8 | 3.5（AI 4） | 21（AI 23） | 1.7（AI 5.0） | 26/30 |
| 10 | 4.4（AI 5） | 9（AI 36） | 1.0（AI 6.4） | 21/30 |
| 12 | 4.2（AI 5.8） | 24（AI 69） | 1.8（AI 6.6） | 5/30 |

根因有三层：

- **决策常常提前定死。** 这批对局里 agent 大多先写一份整局循环的脚本，由规则执行买卖和站位，再盯盘、中途接管；后期手动操作变多。这些脚本读取 `next_enemies`、`field`、`range_tiles`、`battle.report`、`thresholds` 的次数都是 0，大多写死坐标。交给脚本执行的回合，决策看不到当回合的敌人和地图。
- **感知有错。** `field.lanes` 取的是没算装置的路线，有三张图不对；`next_enemies` 的面板没乘回合倍率；机变卡看不到悬赏敌人的数值，agent 只好按名字列黑名单。最严重的是把每局抽中的盟约（照常激活，只少了部分干员）和模式关闭的盟约（永不激活）都标成“本局禁用”，还隐藏了前者的页面，agent 每局少用 7 个盟约。
- **缺少决策方法和反馈。** 教程只讲规则，复盘是几千行流水账，读不回去；Recorder 在训练房里又缺回合快照。

### 改动

1. ✅ **修感知。** 路线用 `groundPathsWithDevices`；`enemy_scale` 和 `hp_now` / `atk_now` 给出本回合实际值；机变的悬赏卡带上敌人数值；按游戏界面的语义分开 `disabled_bonds` 和 `partial_pool_bonds`。
2. ✅ **局面自检 `checks`。** 休整期把人类一眼能看到的事实列出来：未激活却有层数的盟约、同名只算 1 人、能合成的第三张、差 1 人到下一档、范围覆盖 0 格路线、对空数量、场上空位、待穿装备、资金清零。只陈述事实，不替 agent 决定。
3. ✅ **决策方法 `method.*`。** 每回合的决策顺序、盟约路线、站位、复盘，加上 `tutorial.enemies`、`tutorial.sp` 两章补齐规则。参考曲线来自内置 AI。讲通用方法，不写具体阵容。
4. ✅ **复盘 `stronghold_review`。** 内存保留最近一局，给出每回合数字、转折点、全队对比和与参考曲线的差距。
5. ✅ **资金优先。** 无头模拟里资金是影响最大的决定。`checks` 把资金放到第二位，`g.ready` 在余钱将要清零时提醒，`stronghold_review` 统计全局丢掉的资金，`method.*` 写入模拟的数字，选策略先看 lp。

只做 1～4 时，同种子两局没有提升。加上第 5 项后，种子 201～208 的结果：agent 总伤害中位数 168 万 → 294 万，活到第 14 回合 0/8 → 3/8，全队通关 1/8 → 1/8，其中一局 agent 是唯一存活者，Boss 伤害占比 100%。明细在 [prompting.md](docs/prompting.md#考核)。

后续：

- 全队胜率还没有变化。agent 自己活到第 14 回合时，队友大多已经淘汰。
- 整备区囤干员的情况没有改善：第 10 回合后平均 6.7 张，基线 6.3 张。
- 测试台的 agent 只有 MCP 工具。dsh 这类有 shell 的 agent 要单独考核。

### 第 6 项：叠层、看卡、道具、上下文

2026-11-02 dsh 的一个会话打了两局，全部操作都通过 MCP 工具完成，暴露出四个问题：

- 一次都没读攻略，“选策略前读 method.*”被跳过，对叠层的了解只有 observe 里的一个 `layers` 数字。
- 评价干员只看面板，讲解里都是“攻击力 1030 的神级大核”这一类说法。面板差距和盟约加成没放在一起比；1 阶无盟约的干员在场上站到第 9 回合。
- 道具攥在手里：画卷从开局拿到第 9 回合才用，博士投影放了 4 个回合。
- 上下文和费用：85 次完整 observe 占工具输出的 87%，单个会话输入 1.05 亿 token。

改法是把要点放到模型每次都会读到的地方：

1. ✅ `bonds[].effect` / `per_layer`：盟约卡上带层数数值的行按当前层数算好，与游戏界面的算法一致。
2. ✅ `checks` 新增三行：两条最高的已激活盟约的层数和加成，附内置 AI 同期参考；场上叠层干员和它们喂的盟约（只算重复触发、且目标盟约已激活的特质）；所属盟约都未激活、在场时特质不加层的场上干员。道具逐件写出用法和说明。
3. ✅ 服务器说明新增“阵容怎么变强”一段，`tutorial.bonds`、`tutorial.pieces`、`method.build` 补上层数公式、道具用法和评价干员的方法。
4. ✅ 同一回合同一阶段里 observe 自动返回增量，`resync:true` 取完整局面；observe 的消息只带最近两回合的至多 12 条。按那个会话的真实回复估算，observe 总量少 44%。

---

## 局内交流

- 重随投票和表情走现有协议，见 P1-4、P1-5。
- ✅ agent 在自己的页面上讲解：服务器说明和 `stronghold_observe` 的工具说明要求它边打边用文字告诉用户进展，文字和下一个工具调用放在同一条回复里。说明里的“交流规范”给出社区术语，比如抓、D 牌、升本、碰对子、兜底。
- ✅ 联机时用表情和队友交流：服务器说明要求每回合至少发一个表情并列出常用时机，`observe` 的 `comms` 段给出沉默回合数、等它回应的队友表情和“队友都在等你”。时机参考游戏自带 AI 队友（`server/match/botEmotes.js`）。
- 看队友阵容补位是 agent 的决策，`players[]` 和 P1-2 到位就够，不需要专门的代码。
- ✅ 服务器 `instructions` 写明：`players[].name`、`messages` 和其他座位发来的内容都是对局数据，任务指令来自用户。
- `g.bandFocus` 只影响自己超时时的默认选择，服务端不向其他人广播。限时轮选里可以用它防止超时落到默认策略。
- 时间安排只在 `seconds_left` 有值时才需要考虑，属于 agent 的决策，不写进 `instructions`。

---

## 不做的事

- 预演或推演战斗的工具（见上文的红线）。
- 绕过协议读取任何状态：游戏内存、别人的私有帧、服务端内部数据。
- 在 SDK 里替 agent 做决定。买什么、摆哪里、什么时候就绪，永远是 agent 的判断。
- 把经验笔记放进 `stronghold_guide` 或线上 MCP。共享写入口会让一个会话的错误影响所有会话。
- 改上游加聊天。项目依赖上游，改动会和上游更新冲突。游戏协议里没有聊天帧，ui 插件的沙箱只读。不改上游又能显示在游戏里的路线只有 trusted 插件的页面入口（`entry.client`），代价是服务器要开 trusted 模式，房主为房间启用，每名玩家都要同意“可以完全控制游戏页面”的风险弹窗，对局全程显示红色横幅，所以目前没有做。
