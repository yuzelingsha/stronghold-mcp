# 提示词与缓存规划

agent 看到的提示词由 MCP 客户端拼成。各家模型的提示词缓存都按**完全相同的前缀**复用，所以这里把内容按“多久变一次”分层：
越稳定的越靠前，所有随对局变化的内容都只出现在对话末尾的工具结果里。

## 分层

| 层 | 内容 | 来源 | 什么时候变 |
|---|---|---|---|
| 1 工具定义 | 工具名、说明、参数（compact 9 个 / full 62 个） | `mcp/tools.js` | 改代码或换工具模式时 |
| 2 系统提示词 | 客户端自带部分 + 本服务器的 `instructions`（约 1.3K 字） | `mcp/instructions.js` | 改代码时 |
| 3 任务提示词 | 用户交给 agent 的任务 | 用户 | 每局；固定部分在前，房间号等变量放最后 |
| 4 对话 | observe 增量、攻略段落、动作回执、事件 | 工具结果 | 每次调用，按时间顺序追加 |

第 1、2 层在所有会话、所有对局之间逐字节相同，跨对局可以复用同一份缓存（命中与否还取决于客户端和模型服务的缓存时效）。第 4 层只追加、不改写，
每一轮请求都以上一轮的完整内容为前缀，同一局内逐轮命中。

`instructions` 的内容：
- 回合循环：observe → 按需读攻略 → action / wait_event；
- 上下文规则：用 `since` 取增量，对话压缩后重新取完整局面；
- 攻略目录：每章的 id、标题和一句简介。

章节简介写在 `guide-notes.js` 各章的 `summary` 里。章节正文带有当前模式的数字，属于对局信息，放在第 4 层。

## 保证前缀稳定的规则

- `INSTRUCTIONS` 和全部工具说明都是模块常量，内容只来自代码，与环境变量、时间、房间、玩家、模式无关。
  `test/prompt.test.mjs` 起两个状态和环境都不同的服务器，比较 `initialize.instructions` 和 `tools/list`，两者要求逐字节相同。
- 工具模式 `STRONGHOLD_MCP_TOOLS` 是部署级设置，同一部署固定使用一种，每种模式各有一份固定的工具列表。
- 工具在服务器启动时一次注册完毕，会话期间工具列表保持原样。
- 动态内容全部走工具结果：局面用 `stronghold_observe`，规则和参考用 `stronghold_guide`。

## 按需取用

- `stronghold_guide` 只传 `topic`（或空参数）时返回目录：每页的 `id` 与 `title`，本会话读过的页标 `read: true`。
  - `auto` 按阶段列出：策略选择前列出教程和本局盟约一览；备战时列出自己的策略、看得到的盟约和 `bonds.generic`。
  - `tutorial` / `bonds` / `bands` 列出整个分类。
- 传 `ids` 时返回这些段落的内容，每次都返回；本局没有的 id 列在 `unknown`。
- 教程章节的 id 写在 `instructions` 里，agent 可以直接按 id 读取，读取前也可以先查目录。

用本服务器真实数据（`mode_single_funny`）实测，单位为字符：

| 调用 | 改前（推送） | 改后（目录） |
|---|---|---|
| 第一次调用 | 8 章教程 + 盟约一览，约 5.4K | 目录 413 |
| 备战阶段 | 策略页 + 7 个盟约页 + 通用叠层，约 10.7K | 目录 425 |
| 单章教程 | — | 273–885 |

## 增量观察

`stronghold_observe` 传 `since=<上次的 rev>`，只返回变化的部分（见 [observation.md](observation.md)）。
本地 10 回合实测：observe 总量从 57 万字符降到 10 万字符，平均每次约 1.6K 字符。

## 客户端压缩对话之后

客户端摘要或截断历史后，旧的工具结果被替换，此后的缓存从新的历史重新建立。`instructions` 写明了这时的做法：
observe 省略 `since` 取一次完整局面（服务器遇到未知的 `since` 也会返回 `resync: true` 的完整局面），
需要的攻略段落按 id 重新读取。

## 任务提示词模板

固定部分在前，变量放最后，每局只有最后几行不同：

```text
你作为一名玩家，用 stronghold 工具完成一局卫戍协议：盟约Ⅱ。
规则和参考按 stronghold_guide 的目录按需读取；每次决策前用 stronghold_observe 读局面，传 since 取增量。
本局：
- 房间：<房间号>
- 玩家名：<名字>
```

模板里写对局目标和授权范围（例如加入哪个房间），打法由 agent 根据教程和局面决定。

## 本地对局记录

`stronghold_observe` 只保留最后一场战报，赛后回看不到中途的掉血回合。设了 `STRONGHOLD_RECORD_DIR` 时，MCP 把每局追加到这个目录下的 `<局 id>.jsonl`；
未设置时不记录，线上部署保持未设置。局 id 形如 `20261031T062539Z-a3f9c1`，文件名按开局时间排序。

每行都有 `v`（格式版本）、`match`（局 id）、`at`（写入时间），再按 `type` 分四种：

| `type` | 写入时机 | 内容 |
|---|---|---|
| `match` | 第一场战斗开始时，此时重随已经结束 | `content`（内容版本）、`mode`、`difficulty`、`stage`、`boss`、`factions`、`disabled_bonds`、`banned_chess`、`seat`；训练房和测试房带 `train` / `test` |
| `round` | 每场战斗开始时 | 上场的 `board`、`hand`、`temp`、`bonds`，`alive`、`lp`、`funds`、`level`、`band`，各座位的 `seats` |
| `battle` | 本座位的运行器跑完一场战斗时 | `round`、`kind`、`reason`、`time`、`killed`、`total`、`report`（同 observe 的 `battle.report`） |
| `result` | 结算时 | `seed`、`victory`、`rounds_passed`、`reason`，`players[]` 用 `me` 标出自己 |

- `round` 的 `lp` 是这一回合开打前的值。本回合的掉血等于它减去下一条 `round` 的 `lp`，最后一回合减去 `result` 里自己的 `lp`。
- 掉血以 `lp` 的差为准。`report.leaks` 是漏怪数，和掉血不一定相等，例如联防接住的漏怪不掉血。
- `battle` 和 `round` 按 `round` 字段对应：秒算时战报可能先写入。联防回合有两条 `battle`，`kind` 为 `unite` 的是联防。
- 淘汰座位的 `result.players[].lineup` 是空的，它的最终阵容看最后一条 `alive` 为 true 的 `round`。
- 没挂战斗运行器时没有 `battle` 行，其余照常。
- 中途离开的局没有 `result` 行。掉线久到被移出房间时，重连补发的结算写进一个新文件，只有 `match` 和 `result` 两行。
- 观战座位没有 `m.private`，不写 `round` 行。
- 字段按名字逐个写入，文件里只有游戏内 id 和数值，其他玩家的昵称和文字进不了文件。干员名称来自游戏数据，也算在内。
- 写入失败时对局继续，错误在 `stronghold_state` 的 `recorder.error`；`recorder.file` 是最近一局的路径。

## 赛后复盘模板

经验写在 agent 自己的本地笔记里，agent 用自己的文件能力读写，MCP 不提供这部分工具。笔记内容通过文件读取进入对话，属于第 4 层，前三层的缓存不受影响。

在任务提示词的固定部分加上：

```text
开局前读 <笔记文件>。笔记是往局留下的线索，规则以 stronghold_guide 为准。
本局结束后复盘并更新笔记：
1. 在 <记录目录> 里找到本局的文件：result 行的 seed 等于 observe 的 result.seed。
2. 用相邻 round 行的 lp 找出掉血回合，对照当回合的阵容和 battle 行的 report 找原因。
3. 读已有条目，决定新增、合并还是替换。
笔记规则：
- 每条写明主题、结论、证据和内容版本。证据是记录的局 id 或 seed 加回合号，房间号不能作证据。
- 只写需要经验判断的结论。路线汇合点、地块、面板能从 field 和 catalog 算出来，这些不写。
- 每个主题最多 <条数> 条，每条不超过 <字数> 字。新内容和旧内容重叠时合并或替换旧条目。
- 内容版本取 match 行的 content。旧条目的版本与本局不同时标记“待重验”，重验之前只作线索。
- 带 test 标记的局不作证据，这种局的局面可以被测试命令改动。
- 只写游戏内 id 和数值，其他玩家的昵称和文字不写入。
```

最后一条防止其他玩家的文字跨对局留存，变成下一局的指令。

统计留到积累足够对局之后再离线聚合。按地图、策略、难度分桶后每桶样本很少，现阶段的数字没有统计意义。
