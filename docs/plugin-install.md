# stronghold-agent · 游戏侧插件

给 [卫戍协议：盟约 · Stronghold Protocol: Alliance](https://github.com/sganggs/Stronghold-Protocol)（0.3.x）服务器装的一个 `trusted` 插件。它只做一件事：**把 AI agent 运行战斗模拟所需的文件，通过一个 HTTP 接口交给它。**

它不碰任何游戏行为 —— 不进入房间、不参与对局、不改任何数据。它只是把服务器本来就已经提供给浏览器的那些文件（`server/sim/`、`shared/`、`data/`），按 agent 需要的形状吐出来。

---

## 为什么需要它

游戏协议是这样工作的：

```
服务端：这一波敌人的数据（battle spec）给你，你自己模拟战斗，打完把结果报给我
客户端：好（跑模拟）……报结果
```

浏览器跑模拟，用的是它从 `/sim/` 下载的那份代码。agent 也必须跑同一份代码，否则结果对不上。

问题是：

- **`/sim/` 无法枚举。** 服务器没有目录列表，HTTP 上你不知道有哪些文件。
- **Node 不能从 HTTP import。** 浏览器的模块解析器可以，Node 不行。

插件把这两件事一次解决：给出**确切文件清单** + **内容指纹** + **一次拿到全部源码**。

没有插件也能用（MCP 会退化成爬 `/sim/`），但那条路**必然不完整** —— 模拟的内容模块是用计算式动态 import 加载的（`import(path)`、`` import(`./ops/${file}`) ``），静态爬虫跟不到。所以 MCP 在爬取路径下会**检测到缺失并拒绝运行**，而不是给你一个看起来合理、实际错误的战斗结果。

---

## 安装

### 1. 放进插件目录

把本文件夹复制成游戏安装目录下的 `plugins/stronghold-agent/`：

```bash
cp -r plugin/ /path/to/Stronghold-Protocol/plugins/stronghold-agent/
```

### 2. 检查

```bash
cd /path/to/Stronghold-Protocol
node tools/plugin.mjs check stronghold-agent
# 期望：0 problem(s), 0 warning(s)
```

### 3. 打包出锁文件

```bash
node tools/plugin.mjs pack stronghold-agent
# 写出 plugins/stronghold-agent/plugin.lock.json
```

### 4. 把锁的 SHA-256 写进 `plugins/config.json`

这是**所有者授权**：游戏只运行被显式钉住的代码。

```bash
cd /path/to/Stronghold-Protocol
LOCK=$(sha256sum plugins/stronghold-agent/plugin.lock.json | cut -d' ' -f1)
python3 - "$LOCK" <<'PY'
import json, sys
path = 'plugins/config.json'
try:
    cfg = json.load(open(path))
except FileNotFoundError:
    cfg = {}
cfg.setdefault('trusted', {})['stronghold-agent'] = sys.argv[1]
json.dump(cfg, open(path, 'w'), indent=2)
print(open(path).read())
PY
```

### 5. 打开 trusted 插件执行

```ini
# /etc/systemd/system/<your-service>.service.d/agent.conf
[Service]
Environment=SP_PLUGIN_SCRIPTS=trusted
```

**公网监听必须用 `trusted-force`。** `trusted` 模式只接受本地/内网监听地址；监听 `0.0.0.0` 或挂在公网反向代理后面时，游戏会拒绝执行并打印 `PLUGIN_TRUST_PUBLIC`：

```ini
Environment=SP_PLUGIN_SCRIPTS=trusted-force
```

### 6. 重启并验证

```bash
sudo systemctl daemon-reload && sudo systemctl restart <your-service>
curl -s localhost:3000/healthz | grep -o '"plugins":[0-9]*'
curl -s 'localhost:3000/x/stronghold-agent/manifest' | head -c 200
```

看到 `ok: true` 和文件清单就成了。

---

## 接口

全部只读，全部在 `/x/stronghold-agent/` 下（插件系统强制的前缀）。

| 路由 | 返回 |
|---|---|
| `/manifest` | `{ ok, app, fingerprint, files: [{url, bytes}], data: [{name, bytes}] }` —— 很小，用来判断缓存是否还有效 |
| `/bundle` | `{ ok, fingerprint, sources: {url: 源码}, data: {name: 记录} }` —— **一次拿全**，约 10 MB |
| `/file?path=/sim/x.js` | `{ ok, path, source }` —— 单个模块，bundle 被拒时的退路 |
| `/data?name=chess` | `{ ok, name, value }` —— 单个数据文件 |

`fingerprint` 是覆盖 `server/sim` + `shared` + `data` 实际内容及生成的 `/data.js` 替身的 SHA-256。
大小、mtime、ctime 等元数据用于复用单文件哈希；指纹没变，agent 就不用重新下载。插件还会复用已解析的 bundle。

handler 只拿到 `{ method, path, url }`（插件系统的约定，没有 headers、没有 body），所以这些路由**不读查询参数以外的任何输入**，也不需要认证 —— 但整个站点若开了登录门禁，agent 仍要用它自己的会话 cookie 访问。

### 上限

- 单次请求 **5 秒**（插件系统约定）。当前体积约 10 MB / 0.9 秒，余量充足。
- bundle 超过 32 MB 时插件会拒绝并提示改用 `/file`。
- 插件子进程 **128 MB** old-space 堆。

---

## 卸载

```bash
sudo rm /etc/systemd/system/<your-service>.service.d/agent.conf
sudo systemctl daemon-reload && sudo systemctl restart <your-service>
# 插件文件夹留着不影响任何东西；要删就 rm -rf plugins/stronghold-agent
```

关掉之后 agent 会退回爬取路径 —— 而爬取路径会因为内容缺失而拒绝运行，并明确告诉你需要这个插件或一份本地游戏安装。

---

## 为什么是 `trusted` 而不是别的类

插件系统里只有 `trusted` 能跑服务端代码并注册 HTTP 路由（`server/plugins/trustedEntry.js` 的 `api.http.route`，需要 `trusted.server` 权限）。`content` 只能加数据，`ui` 只能读屏幕，`script` 跑在战斗模拟里、拿不到 HTTP。

好消息是：**`scope: ["server"]` 的独立服务端插件不需要玩家逐人同意** —— 只有房间/页面级的插件才需要。所以服主要做的就三件事：放文件夹、写 pin、开 `SP_PLUGIN_SCRIPTS`。

---

## 安全边界

- 插件读文件的范围被 `TREE_MAP` 限定在 `server/sim/`、`shared/` 和 `data/` 内；`/file?path=` 只在**已枚举的清单**里查表，不做路径拼接，所以 `../` 之类无从下手。
- 插件不导入游戏的任何模块（它只 `import` `node:fs` / `node:path` / `node:crypto`），所以游戏代码的状态不可能被它影响。
- 但它确实是**本机原生代码**，跑在服务器进程的子里。`trusted` 的信任门槛（锁 + pin + 复核）就是这个意思：**只装你读过的代码**。
