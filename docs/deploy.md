# 部署 MCP 桥（HTTP 服务）

把 MCP 跑成服务器上的常驻服务，供远程 MCP 客户端通过反向代理连接。游戏侧插件的安装见
[plugin-install.md](plugin-install.md)，两者独立部署。

---

## 1. 目录与进程

```
/srv/apps/<mcp-dir>/            服务的 WorkingDirectory
├── mcp/                        入口 mcp/index.js
├── node_modules/               随包带上（服务器可以只装 node）
├── package.json / package-lock.json
├── README.md / LICENSE / docs/
```

systemd 单元（示例）：

```ini
# /etc/systemd/system/<mcp-service>.service
[Unit]
Description=Stronghold Protocol MCP bridge
After=network.target <game-service>.service
Requires=<game-service>.service

[Service]
Type=simple
User=<user>
WorkingDirectory=/srv/apps/<mcp-dir>
EnvironmentFile=/etc/stronghold/auth.env          # 站点登录凭据，root 600
Environment=MCP_TRANSPORT=http
Environment=MCP_HTTP_HOST=127.0.0.1
Environment=MCP_HTTP_PORT=8787
Environment=STRONGHOLD_WS_URL=ws://127.0.0.1:3000/ws
Environment=STRONGHOLD_HTTP_URL=http://127.0.0.1:3000
Environment="STRONGHOLD_NAME=MCP Player"
ExecStart=/usr/bin/node mcp/index.js
Restart=on-failure
RestartSec=5
```

单元原来的入口是根目录的 `index.js` 时，用 drop-in 改入口，原单元文件保持原样：

```ini
# /etc/systemd/system/<mcp-service>.service.d/entry.conf
[Service]
ExecStart=
ExecStart=/usr/bin/node mcp/index.js
```

## 2. 凭据

| 用途 | 读取顺序 |
|---|---|
| `/mcp` 的 Basic Auth | `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD` → `STRONGHOLD_AUTH_*` → `SP_AUTH_*` |
| 站点登录（换 cookie、取 `/data/*.json`） | `STRONGHOLD_AUTH_*` → `SP_AUTH_*` |

`SP_AUTH_USER` / `SP_AUTH_PASSWORD` 是游戏服务端自己的变量名，同一个 `auth.env` 可以同时给游戏和 MCP 用。
给 `/mcp` 单独设一组 `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD` 时，远程客户端用这一组登录，游戏的登录密码只留在服务器上。

## 3. 反向代理

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # Streamable HTTP 的事件流
    proxy_read_timeout 3600s;       # stronghold_wait_event 等长请求
    proxy_send_timeout 3600s;
}
```

## 4. 运行设置

- **工具模式**：默认 `compact`（9 个工具）。远程客户端依赖 `stronghold_g_buy` 这类按动作的工具时，加
  `Environment=STRONGHOLD_MCP_TOOLS=full`（62 个）。一个部署固定用一种模式，工具定义才能保持逐字节稳定（见 [prompting.md](prompting.md)）。
- **战斗运行器**：`STRONGHOLD_LOCAL_BATTLE=1` 时，这个服务替它的座位跑战斗模拟（模拟从游戏插件或本机安装取得，见 README「战斗模拟从哪来」）。
  未设置时，座位收到的 `b.start` 由其他客户端或服务端接管。
- **攻击范围**：游戏和 MCP 在同一台服务器时，加 `Environment=STRONGHOLD_SIM_ROOT=/srv/apps/<game-dir>`。`range` 和 `range_tiles` 这样就用游戏自己的规则计算，这个设置本身不开启战斗运行器。
  未设置且没挂战斗运行器时，它们来自棋子数据里的 `rangeGrid`，部分精英棋子会少一格。
- **对局记录**：`STRONGHOLD_RECORD_DIR` 只给本地 agent 用，线上服务保持未设置（见 [prompting.md](prompting.md)「本地对局记录」）。
- **会话**：每个 HTTP 会话有自己的玩家连接。客户端发 `DELETE` 时关闭；`MCP_HTTP_IDLE_SECONDS`（默认 1800）秒内没有请求也会关闭。
  重启 MCP 服务只断开 MCP 会话，游戏房间由游戏服务保存。

## 5. 升级步骤

1. **本地验证**：`npm test`、`npm run check`。
2. **打包**运行所需的文件。`.env` 留在本地，服务器的凭据来自 `EnvironmentFile`：

   ```bash
   tar --exclude='*.map' -czf mcp-deploy.tgz mcp package.json package-lock.json node_modules README.md LICENSE docs
   ```

3. **解到旁边的目录**（例如 `/srv/apps/<mcp-dir>.new`）并预检：
   - `for f in $(find mcp -name '*.js'); do node --check "$f"; done`
   - 用 stdio 做一次握手。空环境下进程只回答 MCP 请求，第一次工具调用才连游戏：

     ```bash
     printf '%s\n' \
       '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"preflight","version":"0"}}}' \
       '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
       '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
       | env -i PATH=/usr/bin:/bin HOME=/tmp timeout 8 node mcp/index.js
     ```

     比较 `instructions` 的 SHA-256 与本地的
     `node -e "import('./mcp/instructions.js').then(m=>console.log(require('crypto').createHash('sha256').update(m.INSTRUCTIONS).digest('hex')))"`。
4. **切换**：把旧目录改名为 `<mcp-dir>.bak-<时间戳>`，把新目录改名为 `<mcp-dir>`；需要时加入口 drop-in，
   然后 `systemctl daemon-reload && systemctl restart <mcp-service>`。
5. **验证**：
   - `systemctl is-active <mcp-service>`；日志出现 `HTTP listening on 127.0.0.1:8787`。
   - 不带凭据请求 `/mcp`，返回 401。
   - 带凭据完成一次会话：
     - `initialize` 的 `instructions` 哈希与本地一致；
     - `tools/list` 有 9 个工具；
     - `stronghold_guide` 返回目录，`ids:["tutorial.shop"]` 返回带本服务器收入数字的段落（这一步同时验证了站点登录和 `/data/config.json`）；
     - 最后 `DELETE` 关闭会话。

## 6. 回滚

```bash
sudo rm /etc/systemd/system/<mcp-service>.service.d/entry.conf    # 这次加过入口 drop-in 时
sudo systemctl daemon-reload
mv /srv/apps/<mcp-dir> /srv/apps/<mcp-dir>.failed
mv /srv/apps/<mcp-dir>.bak-<时间戳> /srv/apps/<mcp-dir>
sudo systemctl restart <mcp-service>
```
