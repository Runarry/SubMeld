# SubMeld Agent

Agent 是独立 Linux amd64/arm64 服务。它只向面板发起 HTTPS 长轮询，使用每台机器独立的 Bearer Token；不开放管理端口。既有节点、配置目录和代理服务仍由 vps-script-lite 的 `vpsctl` 管理。

安装前先更新 vps-script-lite 管理脚本至带 `service proxy machine` 接口的版本，保留现有节点与代理服务。还需要 Bash、curl、jq、sha256sum、timeout 和 systemd/OpenRC。安装器先验证实际快照 schemaVersion=1；旧版本或异常快照会明确停止安装。安装器不安装或卸载代理内核，不迁移已有代理配置，也不自动下载未发布的 vpsctl 源码。下载的 Agent 二进制与同目录 `.sha256` 校验文件必须由同一面板构建提供。

```sh
bash install.sh --server https://panel.example --machine-id MACHINE_UUID --token MACHINE_TOKEN
# 可信内网测试可额外指定 --allow-http；HTTPS 始终验证证书。
```

安装位置为 `/usr/local/bin/submeld-agent`、`/etc/submeld-agent/config.json` 和 `/var/lib/submeld-agent`。配置文件必须为 `0600`，状态目录为 `0700`。`install.sh --uninstall` 只移除 Agent 二进制和服务，保留 vpsctl、节点、代理服务和 Agent 私有配置/状态。卸载会停止 Agent 托管的隧道。

配置示例：

```json
{
  "server": "https://panel.example",
  "machineId": "预先在面板生成的 UUID",
  "token": "机器独立 Token",
  "vpsctl": "/usr/local/bin/vpsctl",
  "stateDir": "/var/lib/submeld-agent"
}
```

`server` 必须是无路径、认证或查询参数的 origin。`vpsctl` 与 `stateDir` 可指定绝对路径用于隔离开发。`allowHttp: true` 仅用于可信内网。HTTP 重定向不会被跟随；没有关闭 TLS 校验的选项。

CLI 配置与令牌轮换：

```sh
# 未传 machine-id 且无已有配置时，生成并持久保存 UUID；之后保留。
printf '%s' "$MACHINE_TOKEN" | submeld-agent setup --server https://panel.example --token-stdin
# setup 保留未指定的已有字段；变更后重启自己的 Agent 服务。
printf '%s' "$NEW_TOKEN" | submeld-agent setup --token-stdin
systemctl restart submeld-agent
# OpenRC: rc-service submeld-agent restart
submeld-agent run --config /etc/submeld-agent/config.json
submeld-agent version
```

Agent 每次进程启动生成 `bootId`；`machineId` 长期保存在配置中。克隆机器应指定新的机器 ID、Token 和空状态目录。每个状态目录只允许一个 Agent 进程。

每台机器串行执行变更。Agent 先将请求写入 `active.json`，再使用 stdin 调用 vpsctl 的 `machine apply`，不执行 shell 字符串。重复请求先查 `machine result --id UUID`；仅 `found:false` 表示可执行新请求，已记录的 `unknown` 不重做。应用结果持久保存后回传，重启优先恢复或补发，网络失败不触发重复执行。已确认结果保留为去除快照的紧凑回执，用于相同 ID 的重复下发；同 ID 内容变化被拒绝。

快照只在 vpsctl 正常退出且返回完整结构时上报；失败保留面板上一份有效数据。结果状态 `applied`、`pending_restart`、`conflict`、`failed`、`unknown` 原样传递。非零退出即使输出 success 也不会被冒充成功。快照及尚未回传的任务含原生凭据，只存私有状态文件或通过认证连接传输；服务日志只记录阶段，不输出 Token、命令参数、节点链接或 helper 原文。

长轮询可被服务停止取消；连接超时、有限响应大小及带抖动退避限制错误时的资源使用。停止时终止运行中的 vpsctl 子进程组，由 vpsctl 持久请求日志处理未确定结果。Agent 以 root 运行，以便使用现有 vpsctl 服务管理能力。

面板使用同一个二进制的证书 helper；它无需配置或 root，生成仅用于指定 DNS/IP 的三年自签 ECDSA 证书（ServerAuth）及 PKCS#8 私钥，JSON 仅输出到 stdout：

```sh
submeld-agent certificate --server-name tunnel.example
```

构建和局部验证需要 Go 1.26，标准库实现：

```sh
go test ./...
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w -X main.version=VERSION' -o submeld-agent-linux-amd64 .
GOOS=linux GOARCH=arm64 go build -trimpath -ldflags '-s -w -X main.version=VERSION' -o submeld-agent-linux-arm64 .
```

Go 单测使用受控 HTTP 服务和 vpsctl 接口替身，验证轮询取消、重定向拒绝、回执重传与本地恢复；它们不替代 vps-script-lite 真机或隧道真实 TCP/UDP 验收。实际 vps-script-lite 脚本只在授权的 `host-vps-scripts` 环境测试。
