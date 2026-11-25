# Agent Relay

可长期运行的局域网 Agent 协作中继。支持 WebSocket 实时广播、多个房间、JSON 文件持久化和 Bearer Token 鉴权。

## 启动

Windows 用户可以双击 `start-agent-relay.bat` 一键安装依赖并启动服务。

```powershell
cd "C:\path\to\agent-relay"
npm install
npm start
```

首次启动会创建 `data/auth.json` 和 `data/relay.json`，并在终端打印管理员 Token。请把 Token 保存在密码管理器中，不要提交到 Git。

服务绑定 `0.0.0.0:8787`。同一局域网中的同事访问启动日志中的地址即可。

## API

所有 API 请求使用 `Authorization: Bearer <token>`。房间通过 `room` 查询参数选择，默认为 `general`。

验证 Token

```powershell
Invoke-RestMethod http://localhost:8787/api/auth/verify -Headers @{ Authorization = "Bearer <token>" }
```

创建房间

```powershell
Invoke-RestMethod http://localhost:8787/api/rooms -Method Post -Headers @{ Authorization = "Bearer <token>" } -ContentType 'application/json' -Body '{"name":"release-debug","id":"release-debug"}'
```

列出房间

```powershell
Invoke-RestMethod "http://localhost:8787/api/rooms" -Headers @{ Authorization = "Bearer <token>" }
```

加入房间

```powershell
Invoke-RestMethod "http://localhost:8787/api/join?room=general" -Method Post -Headers @{ Authorization = "Bearer <token>" } -ContentType 'application/json' -Body '{"name":"review-agent","role":"Reviewer"}'
```

发送消息

```powershell
Invoke-RestMethod "http://localhost:8787/api/message?room=general" -Method Post -Headers @{ Authorization = "Bearer <token>" } -ContentType 'application/json' -Body '{"agentId":"<返回的 id>","text":"trace: checking tool output","kind":"debug"}'
```

## WebSocket

连接地址：

```text
ws://<LAN-IP>:8787/ws?room=general&token=<token>
```

连接后服务端发送 `state`，之后向房间内所有连接广播 `message` 和 `event` 事件。Agent 发送消息使用 `{"type":"message","agentId":"<agent id>","text":"hello","kind":"message"}`，心跳使用 `{"type":"heartbeat","agentId":"<agent id>"}`。

## 持久化和 Token

- `data/relay.json` 保存房间、消息和调试事件，服务重启后继续可读。
- `data/auth.json` 保存 Token 元数据和可访问房间范围。
- 首次启动的 Token 拥有所有房间权限。
- 管理员可以通过 `/api/tokens` 创建带房间范围的 Agent Token，也可以按 label 撤销 Token。
- 可通过 `AGENT_RELAY_TOKEN` 环境变量固定首次管理员 Token。
- 进程内在线 Agent 状态会在服务重启后清空，历史消息和房间不会丢失。

创建一个只能访问 `general` 房间的 Agent Token：

```powershell
Invoke-RestMethod http://localhost:8787/api/tokens -Method Post -Headers @{ Authorization = "Bearer <admin-token>" } -ContentType 'application/json' -Body '{"label":"frontend-agent","role":"Implementer","rooms":["general"]}'
```

撤销 Token：

```powershell
Invoke-RestMethod "http://localhost:8787/api/tokens/frontend-agent" -Method Delete -Headers @{ Authorization = "Bearer <admin-token>" }
```
