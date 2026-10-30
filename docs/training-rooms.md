# 训练房：服务端节奏开关

`room.create { train: true }` 请求**这一局**用 AI 训练节奏。这份文档说明它由什么控制、
以及为什么它必须是服务端能力而不是客户端能自己开的东西。

> **这部分不属于本仓库。** 它是游戏服务端的一个可选改动（约 100 行）。
> 本仓库只负责**请求**它（`train: true`）并根据 `room.state.train` 决定客户端节奏。
> 服务端没开这个开关时，`train: true` 会被明确拒绝（`TRAIN_DISABLED`），不会静默忽略 —— 这是刻意的。

---

## 1. 两层加速，都由「这一局是不是训练房」决定

```
玩家建房   room.create { mode, difficulty }               → 原版：客户端实时战斗 + 服务端演出延时
AI 训练    room.create { mode, difficulty, train: true }  → 客户端秒算战斗 + 服务端零演出延时
```

| 层 | 普通房 | 训练房 |
|---|---|---|
| **服务端**（演出延时 / 倒计时） | 原样（`timerScale = 1`） | `timerScale = 0`，跳过 `ROUND_START` / `COMBAT_END` / `SETTLE` 的固定延时 |
| **客户端**（战斗模拟节奏） | **实时**：250ms 定时器，与浏览器完全一致 | **秒算**：同一场模拟一次步进到结束 |

关键点：

- **普通房的 `room.state` 不出现 `train` 键**，与改动前逐字节相同。
- **普通房走的是浏览器原本的 250ms 节奏**，客户端不做任何加速。
- 不依赖「测试房」，因此没有测试房「每条输入写 journal」的开销。
- 训练房是给单个 agent 用的。有两名以上真人时休整期带倒计时，`timerScale = 0` 会让它立刻结束，棋子来不及摆。

---

## 2. 服务端参数

| 环境变量 | 取值 | 作用 |
|---|---|---|
| `SP_TRAIN_TIMER_SCALE` | 0–100，**0 = 跳过全部演出延时与倒计时** | 乘在固定延时与每个 `setDeadline` 上；**同时是训练功能的开关**（不设 = 不允许训练房） |
| `SP_TRAIN_SCOPE` | `train`（默认）/ `test` / `all` | `train` = 仅带 `train:true` 的对局；`test` = 仅测试房；`all` = 全部（专用训练机） |
| `SP_TRAIN_COMBAT_SPEED` | 0–200，默认 2 | 服务端驱动的战斗的游戏秒 / 真实秒 |

**未设置任何 `SP_TRAIN_*` 时行为与原来完全一致。**

systemd drop-in 示例：

```ini
# /etc/systemd/system/<your-service>.service.d/train.conf
[Service]
Environment=SP_TRAIN_TIMER_SCALE=0
Environment=SP_TRAIN_SCOPE=train
```

---

## 3. 为什么不能做成插件

游戏的插件系统（如果目标服务端有）**开不了这个口子**，原因是结构性的：

1. **规则开关是封闭集合。** 插件能声明的开关是枚举好的（例如 `shopBias` / `prepLoadout` /
   `morphPairing` / `unequip`），插件**不能新增**开关。
2. **可信插件运行时拿不到 Match。** 它的 IPC 只传副本，不传活的 lobby / session 对象，
   因此插件改不了 `timerScale`。

更根本的一点：**「这一局要不要加速」是发起方的选择，天然属于房间参数，而不是插件内容。**
为了做成插件而先给插件系统开一个只有训练用的口子，会把一个通用机制绑死在单一用途上。

所以正确的切分是：

| 产物 | 内容 | 形态 |
|---|---|---|
| **核心 patch** | `train` 参数、`room.state.train`、`TRAIN_DISABLED`、`timerScale` | 一个独立 commit / PR，约 100 行，**默认关闭** |
| **本仓库** | MCP 驱动、两种节奏的运行器、observation / action 层 | 独立仓库，与具体游戏版本解耦 |
| 插件（可选） | 若将来插件系统开了口子，再把训练房包装成内容插件 | 依赖上面的改动 |

---

## 4. 客户端侧的对应实现

本仓库里的对应部分是：

- **请求**：`game.create_room(mode="solo", difficulty="ABYSS", train=True)`
- **判断**：`mcp/battle/local-sim.js` 的 `isTrainingRoom(client)` 读 `room.state.train`
- **节奏**：`STRONGHOLD_BATTLE_MODE`（`auto` / `fast` / `realtime`）

`burst` 执行的是**相同的确定性引擎、相同 tick 数**，只是中间不插真实时间 ——
结果与实时完全一致。

验证方法：**逐场**看 `battleSimulation.lastResult`。秒算的那一场会带 `steps` / `simMs` 字段
（秒算路径才会写这两个），实时的那一场不会。注意这是**每场战斗**的事实，不是房间的属性 ——
`battleSimulation.fast` 是最近一次决策的结果，一局结束或离开房间后它不会自己归零，
所以 observation 会在 `current.round` 与当前回合不符时标 `stale`（见
[observation.md](observation.md#为什么会有-stale)）。

房间层面唯一可信的标志是 `room.state.train`。

---

## 5. 实测参考

同一 AI、同一玩家逻辑、co-op / HARD：

| 房间 | 每回合 | 2.5 回合 | 客户端战斗路径 |
|---|---|---|---|
| 普通房（真·原版） | 17–24s | 82s | 实时（日志 `sim=None steps=None`） |
| 训练房（`train: true`） | 5–7s | 35s | 秒算（日志 `sim=58ms steps=904`） |

服务端日志也如实区分：

```
[lobby] DFXJ created (coop/HARD) by TrainDriver          ← 普通房
[lobby] ZGEK created (coop/HARD, train) by TrainDriver   ← 训练房
[lobby] ZGEK match #1 starting (coop/HARD, 1 seats, seed ..., train)
```

---

## 6. 回滚

```bash
# 关闭训练功能：train:true 会被拒绝，普通玩家完全不受影响
sudo rm /etc/systemd/system/<your-service>.service.d/train.conf
sudo systemctl daemon-reload && sudo systemctl restart <your-service>

# 回滚服务端源码改动（如果做过）
#   恢复 lobby.js 与 constants.js 的备份，删除 trainMode.js，重启服务
```
