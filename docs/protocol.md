# 协议与动作表

桥接层说的是游戏自己的客户端协议。这份文档说明帧的形状、动作表在哪里、以及怎么加一个新动作。

---

## 1. 帧格式

所有帧都是 JSON，都带一个 `t` 字段表示类型。

### 客户端 → 服务端

```json
{ "t": "g.buy", "rid": 7, "slot": 0 }
```

- `t`：动作类型。
- `rid`：请求 id。服务端会在回执里原样带回，客户端用它配对。
  **实时回报类**（`b.progress` / `b.result` / `b.rehearsalResult`）不带 `rid`，也没有 `ok` 回执。
- 其余字段就是动作自己的字段，**平铺在顶层**，不是嵌在 `f` 里。

> 内部表示用 `{t, f}` 只是为了在 SDK 里方便地传递；`game-client.js` 在发送前会把 `f` 摊平。

### 服务端 → 客户端

| 帧 | 含义 |
|---|---|
| `welcome` | 握手回执，带 `playerId` 与重连 `token` |
| `ok` | 某个带 `rid` 的请求被接受 |
| `error` | 请求被拒绝，带 `code` / `msg` / `detail` |
| `room.state` | 房间状态（含 `train` 标志） |
| `m.public` | 对局公开状态（阶段、回合、截止时间、所有座位） |
| `m.private` | **仅本座位**的私有状态（资金、商店、手牌、场上、盟约层数、下一波） |
| `m.field` | 侦察某个玩家的场地视图 |
| `b.start` | 一场战斗的 spec，客户端需要自己模拟 |
| `b.pool` | 共享 boss 血池同步 |
| `b.end` | 服务端要求结束这场战斗 |
| `m.result` | 对局结算 |

`stronghold_state` 返回的 `last` 就是**每种帧最后一次收到的内容**，这正是 observation 的原料。

---

## 2. 动作表

动作表在 **`mcp/protocol.js`** 的 `ACTIONS` 数组里，格式是 `[类型, 说明]`。

它是**唯一来源**：

- MCP 的工具列表由它生成（每个动作一个 `stronghold_<名字>` 工具）
- `stronghold_protocol` 工具返回它
- 文档与 SDK 的简写都以它为准

当前动作覆盖：房间生命周期（`room.*`，21 个）、对局操作（`g.*`，30 个）、
战斗回报（`b.*`，3 个）。完整列表直接调用：

```python
from stronghold_agent import Agent
with Agent.connect() as game:
    for action in game.protocol():
        print(action["type"], "—", action["description"])
```

---

## 3. 加一个新动作

只需在 `mcp/protocol.js` 的 `ACTIONS` 里加一行：

```js
['g.newThing', 'Do the new thing; fields: { uid: number, mode: "a"|"b" }.'],
```

MCP 工具 `stronghold_g_newThing` 会自动出现，`stronghold_protocol` 会列出它。
Python 侧如果要一个顺手的简写，在 `python/stronghold_agent/actions.py` 的 `ALIASES` 里加一条，
或在 `Agent` 上加一个方法。**不写简写也能用** —— `game.send("g.newThing", uid=1, mode="a")` 直接可用。

---

## 4. 战斗回报的三个动作

这三个是**客户端模拟**的产物，不是请求，因此 `game-client.js` 不会等它们的 `ok`：

| 动作 | 何时发 | 内容 |
|---|---|---|
| `b.progress` | 模拟过程中定期发 | `battleId`、`gt`（游戏时间）、`killed` / `total` / `done` / `leaks`，boss 战还有 `bossDmg` / `by` |
| `b.result` | 模拟结束发一次 | `compactResult()` 压缩后的结算 |
| `b.rehearsalResult` | 回应服务端委托的预演 | `taskId` + 选择或错误标记 |

挂上 `mcp/battle/` 之后这些由 `local-sim.js` 自动发出，agent 不需要管。
不挂的话，需要你自己在收到 `b.start` 后模拟并回报，否则这一回合不会推进。

---

## 5. 重连

`welcome` 帧里带一个 `token`。`game-client.js` 把它存在内存里，下次 `hello` 时带上，
因此断线重连会**回到同一个座位**，而不是新开一个。

`game-client.js` 自动做这件事，节奏与浏览器相同（`public/js/net.js`）：每 4 秒发一次 `ping`，15 秒没有任何入站帧就主动断开，
再按 0.5～10 秒退避重连。`stronghold_disconnect` 之后和关闭码 `4001`（同一身份在别处登录）不重连。

这个 token 等价于会话凭据：

- `snapshot()` 返回的 `welcome` 已经被**剥掉** `token` 字段（`redactWelcome`），
  所以把它交给模型或写进日志都不会泄漏。
- 需要持久化重连能力时，自己保存它，并像对待密码一样对待它。
