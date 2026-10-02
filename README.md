# SubMeld · 订融

SubMeld 使用独立 Sub-Store 保存全部代理配置，提供统一节点管理、两跳链、输出方案和网页测试中心。综合测试直接对接 AirportR miaospeed；保留 Mihomo、sing-box、Xray 三内核 HTTPS 检查。可选 Telegram 机器人入口默认关闭，无需 Koipy 或激活码。

## 当前架构

2026-09-27 所有者确认上游化重构与统一存储，2026-09-28 确认直接封装 miaospeed。本基线优先于历史文档中的单容器、内嵌转换、节点分类、Koipy 和预生成发布要求。

| 服务      | 职责                                                                       |
| --------- | -------------------------------------------------------------------------- |
| Sub-Store | 原生前端、节点订阅、组合订阅、链与方案文件、模板、脚本执行、按需生成与分享 |
| miaospeed | AirportR 4.7.6，API v3，基于 Mihomo 的综合检测，启用上下行测速             |
| SubMeld   | 登录与代理入口、统一管理、链与方案、网页测试中心、脚本与报告、三内核检查   |

根路径是 Sub-Store 原生前端，`/submeld/` 是 SubMeld。管理 API 经登录与同源校验，普通和增强输出均使用上游原生分享令牌。原生 Service Worker 保留自己的离线缓存，SubMeld 页面和 API 直接访问服务端。

官方镜像摘要固定于 [upstreams.lock.json](upstreams.lock.json)，与 Compose 一致；Sub-Store 后端为 2.42.2。沿用 Vue、TypeScript、Hono、SQLite 单根包，Node.js 24.6.0、pnpm 10.33.2。

## 使用流程

### 节点

“节点”页直接读取全部 Sub-Store 订阅，不再区分独立节点与来源节点。默认汇总各订阅；组合订阅单独预览，避免重复计数。支持搜索、批量选择、原始与处理后内容查看，以及单项或批量测试。

添加可粘贴节点文本或填写订阅地址，直接保存为原生订阅。节点凭据、原始文本、远程地址和处理操作都保存在 Sub-Store。复杂编辑、启停、脚本和普通组合订阅使用原生页面。

删除行为：

- 手动导入的节点从原始 JSON、YAML 或文本行中实际移除，保留其他节点、配置字段和处理操作。无法验证原始位置或剩余内容时拒绝修改，提示进入原生编辑器。
- 远程订阅和脚本生成节点追加精确名称排除规则；不会修改提供者的订阅。节点同名更新后继续排除，改名后需重新设置；同名歧义不自动处理。
- 组合预览的排除只影响该组合。被链引用的节点不能直接删除。
- 删除使用资源版本与快照摘要，刷新或重排后的旧选择不能用于删除。

原生支持但 SubMeld 尚不能完整表达的协议或参数仍会显示。测试和增强输出明确说明不支持的项目，不将其静默减少或替换成直连。

### 机器节点上报

在“节点 → 上报设置”生成共用 Token 并启用功能。默认关闭；Token 仅在生成或重置时显示，关闭弹窗后无法重新查看。重置后旧 Token 立即失效，所有机器需配置新 Token。停用接口保留已上报节点。

每台机器自行生成并持久保存一个 UUID，每次向 `PUT /api/node-reports/<machineId>` 提交自己的**完整节点列表**。同 ID 覆盖原列表，不同 ID 分别保存；同名机器不会合并。UUID 丢失后重新生成会成为另一台机器，克隆机器时应生成新 UUID。以下 Linux 示例仅需 Python 3 和 cURL：

```sh
umask 077
mkdir -p "$HOME/.local/state/submeld-report"
if [ ! -s "$HOME/.local/state/submeld-report/machine-id" ]; then
  python3 -c 'import uuid; print(uuid.uuid4())' > "$HOME/.local/state/submeld-report/machine-id"
fi
MACHINE_ID="$(cat "$HOME/.local/state/submeld-report/machine-id")"

# 将本机完整节点内容保存为 nodes.txt；此步骤保留换行、引号和节点参数。
python3 - <<'PY' > report.json
import json
from pathlib import Path
print(json.dumps({"name": "东京服务器", "content": Path("nodes.txt").read_text(encoding="utf-8")}))
PY

# REPORT_TOKEN 由机器自己的私有环境配置提供，不要写入共享脚本或日志。
curl --fail-with-body --request PUT \
  "https://submeld.example/api/node-reports/$MACHINE_ID" \
  --header "Authorization: Bearer $REPORT_TOKEN" \
  --header "Content-Type: application/json" \
  --data-binary @report.json
```

请求体仅含 `name`（必填、最多 512 字符）和 `content`。内容支持多行节点链接、Base64，以及 Sub-Store 可解析的含内联节点的 YAML/JSON；每份最多 4 MiB、2,000 个节点。JSON 节点列表请使用 `{"proxies":[...]}`；固定上游的本地订阅解析器不支持裸 JSON 数组，会拒绝该格式。不抓取配置中的远程订阅或 provider。空内容、无法解析的项目或整份解析数量不一致会拒绝整次更新，保留旧列表。上报成功只表示内容已保存，不表示节点连通性测试通过。

首次成功返回 `201`，之后返回 `200`，响应示例为 `{"machineId":"机器 UUID","action":"updated","nodeCount":2}`。`action` 可为 `created`、`updated` 或 `unchanged`。完全相同的内容与名称不重复写入，不改变资源版本；并发提交以最后成功写入的内容为准。断线或上游错误后使用同一 ID 重试，即使上次已写入但响应丢失，也不会另建订阅。

| HTTP 状态    | 含义                                                     |
| ------------ | -------------------------------------------------------- |
| `400`        | UUID、请求结构、名称无效或列表为空；启用前尚未生成 Token |
| `401`        | 上报 Token 缺失、错误或已被重置                          |
| `403`        | 上报功能已停用                                           |
| `409`        | UUID／内部名称冲突，或目标订阅已变成远程／混合来源       |
| `413`        | 请求正文、解码内容或节点数量超限                         |
| `415`        | 非 JSON 请求或使用了压缩请求体                           |
| `422`        | 内容无法完整解析，不保存部分节点                         |
| `502`／`503` | 上游请求失败或不可用；保留同一 ID 后重试                 |

每台机器对应一个 Sub-Store 本地订阅，UUID 不变，原生订阅重命名和处理操作会保留。上报只更新节点原文和显示名称；网页手动修改的节点内容会被下次有效上报覆盖。同名节点的新连接参数自动生效；移除或改名后，引用它的链会明确失效，旧测试结果不能覆盖新内容的结果。上报周期由机器自行安排，离线记录持续保留。

上报接口仅使用专用 Bearer Token，不需要 Cookie、`Origin` 或 `X-SubMeld-Request`。Token 不能调用管理接口；设置和生成 Token 的管理接口仍要求网页登录及同源校验。SQLite 仅保存启停设置和 Token 摘要，节点原文与身份标记仍只存 Sub-Store。

### 两跳链与输出方案

两跳路径为本机 → 前置 → 出口 → 目标。可直接选择订阅或组合中的节点，无需复制。成员按资源 UUID 与精确节点名称引用：资源重命名保留关联，同名节点的新地址和凭据自动生效；节点消失、重名或 UUID 丢失时必须重新选择。

链、方案、模板和运行脚本使用 Sub-Store 原生文件保存，带用途、UUID 和格式版本元数据。首次保存方案时初始化缺失的配套文件，启动不会覆盖已有文件。“配套文件”页可手动写入当前内置版本，执行前检查文件版本并提示覆盖自定义内容。

方案支持订阅、组合、单节点和链的有序输入，以及名称、协议筛选和前后缀。保留八种输出：URI、Base64，Mihomo／sing-box／Xray 的完整配置和节点片段。URI／Base64 排除链。

Mihomo 与 sing-box 经上游转换及链式字段输出；Xray 使用随项目交付、在 Sub-Store 中执行的适配脚本，保持现有四协议和参数范围。三内核测试与文件脚本复用转换校验。生成检查节点数量、连接字段和模板中的节点列表，错误返回失败明细。

默认模板为 JSON 文本，允许在原生文件页面修改。占位符包括 `$nodes`、`$outbounds`、`$names`、`$first`、`$port`，按完整值替换。保留节点列表占位符；无效模板不会生成残缺配置。完整配置默认监听回环地址。

### 按需生成与分享

预览、客户端拉取均由 Sub-Store 当次生成，使用上游缓存、脚本和联网规则。“刷新并生成”请求上游绕过缓存。没有六小时发布任务、预生成产物库、本地分享密钥或旧 `/s/*` 地址。

在方案页面创建或撤销分享，令牌由 Sub-Store 保存与验证。原生 `/share/file/*`、订阅和组合分享经同源代理转发。上游停机时输出不可用；不会返回 SubMeld 缓存的旧配置。分享遵循原生 GET 行为，HEAD 仍由上游决定。

### 测试中心

三内核测试保留批次进度、取消、最近结果、官方内核检查与手动更新。节点引用使用资源 UUID、快照摘要和位置；链测试同时固定两个成员的快照。内容变化或上游状态无法确认时，不保存迟到结果。处理规则排除的原始节点仍可测试。

综合测试覆盖延迟采样、最大延迟、抖动、丢包、HTTP 状态、上下行平均/峰值/逐秒速度、UDP/NAT、入口/出口拓扑和测速劫持检测。普通节点默认使用 miaospeed 内置 Mihomo，通过 Sub-Store 无保存转换生成完整节点，保留原生协议字段。已保存节点和临时节点也可选择独立 Mihomo、sing-box 或 Xray，通过带随机认证的临时 SOCKS 入口测试；REALITY 兼容性问题可选择 Xray。所选内核不能完整表达的节点在原位置显示不支持，不自动换内核或直连。

两跳链综合测试单独选择执行内核，默认 Mihomo，也可选择 sing-box 或 Xray。内核启动带随机认证的临时 SOCKS 入口，miaospeed 经该入口检测完整链。桥接测试的入口拓扑单独取真实节点或前置节点地址，出口与性能经所选路径测得；报告与导出记录所选内核及独立内核版本。Compose 不发布临时测试端口。

预置 16 个脚本：YouTube、Netflix、Disney+、ChatGPT/OpenAI、Claude、Copilot、TikTok、Spotify、Wikipedia、Bilibili 国际及大陆、Viu、IPv4/IPv6 质量与风险、DNS 地区、SSH 22。前 14 项固定 [CloudPassenger/miaospeed-scripts v1.0.0](https://github.com/CloudPassenger/miaospeed-scripts/releases/tag/v1.0.0)，发布包及索引校验值见 [miaospeed-scripts.lock.json](miaospeed-scripts.lock.json)，构建附带原始来源和源码；后两项由 SubMeld 实现。脚本可添加、编辑、启停及按批次选择，保存在 Sub-Store 原生文件。初始化只补齐缺失项，恢复内置版本检查 revision。

综合测试与三内核检查同时只运行一个批次。可取消并保留部分结果；后端断线停止，重启后未结束报告标记中断。报告支持筛选、排序、延迟/速度曲线、IP/ASN 详情、手动删除、当前页 PNG 与全部筛选结果 CSV。对象变化后保留历史快照并标为过期，不覆盖当前有效结果。

4.7.6 没有中断已执行宏的 API。取消后立即停止后续节点并关闭临时链入口；当前普通节点探测结束前保留批次锁，页面显示“正在取消”。断线后不再提交节点，后端已发出的请求仍可能运行到自身超时。

临时测试支持文本、订阅 URL、配置文件。先预览和筛选，使用 Sub-Store 无保存接口；节点凭据仅保存在内存，预览闲置 30 分钟过期，任务结束清除副本。历史临时报告重测需重新输入。

默认 HTTPS 目标为 `https://cp.cloudflare.com/generate_204`；其他参数沿用锁定后端的有效默认值：上下行 3 秒、各 1 线程，Ping 1 次、重试 3 次、请求超时 5000 毫秒。4.7.6 的上行单次超时使用时长整除 2，因此上行时长至少 2 秒。DNS 失败、198.18.0.0/15 Fake-IP、非公网目标单独标为目标异常；缺失矩阵、异常响应或无法确定的平台结果为未知，不表示节点失效或解锁成功。

### Telegram 测速

在测试中心的“Telegram”栏目保存 Bot Token、Telegram 数字用户 ID 白名单和独立测试预设，再启用机器人。用户私聊 `/start` 可查看自己的 ID。支持可选 HTTP/HTTPS 代理及代理认证，代理仅用于 Telegram 收发消息和文件，不影响 Sub-Store、miaospeed 或测试流量。设置读取不返回 Token 或代理认证信息；留空保留原值，显式清除才删除。Token 与运行设置存放在现有私有 SQLite 数据目录中。

SubMeld 使用 Bot API 长轮询，无需公网 Webhook 或新增容器。一个机器人只交给一个服务运行；已有 Webhook 或另一实例占用时显示错误，不自动移除旧 Webhook。停用机器人不影响网页测试入口。

白名单用户发送节点文本、单个 HTTP(S) 订阅地址或 UTF-8 配置文件即可排队，无需再次确认。每份输入最多 4 MiB、2,000 个节点，沿用 Sub-Store 临时解析。机器人预设初始复制网页保存的参数并选中全部指标与启用脚本，保存后独立管理。每个任务固定提交时的参数、指标和脚本选择；开始时读取脚本当前版本，脚本已删除或停用会明确失败。

Telegram 任务按提交顺序等待现有综合测试／三内核检查的共享锁。排队超过 30 分钟会清除临时输入并要求重发；网页发起测试仍沿用忙碌提示。节点文本、订阅地址和文件内容不写入 SQLite。服务重启后未完成任务标记中断并通知重发，已经生成的历史报告保留。停用机器人会取消其任务；移除用户白名单会取消该用户任务并停止回传。更换为另一个机器人后，不向新机器人发送旧任务报告。

机器人命令：

- `/start`、`/help`：查看自己的 ID 和使用说明。
- `/status`：查看自己最近的任务和排队状态。
- `/cancel <任务号>`：取消自己的任务，也可点击任务消息中的取消按钮。运行中取消保留部分结果，后端实际结束前继续持有测速锁。
- `/result <任务号>`：再次获取自己的结果，回传失败时继续补发尚未确认发送的部分。

进度消息最多每 5 秒更新一次。完成、取消或失败后回复真实状态；有报告时发送分页 PNG 和完整 CSV。图片分组展示所选指标与脚本结论，CSV 保留采样、拓扑、错误明细和内核版本。容器包含中文及 Emoji 字体。未知、目标异常或不支持不会显示为测速成功或平台解锁。

测速状态与回传状态分别记录。暂时断网或限流会重试回传，最多自动尝试五次，之后可在网页或通过 `/result` 补发；补发不重复测速。发送成功回执之前连接中断时，重试可能重复发送同一附件。真实 Telegram 收发验收需要在网页配置专用机器人；本地协议夹具不代表公网 Telegram 验收通过。

## 数据与兼容

SQLite 仅保存账号、运行设置、测试结果及 Telegram 任务归属／回传元数据，节点及配置预览在内存中。测试需要的临时凭据配置会在进程结束后清理。没有第二份可编辑节点凭据库。

保留现有 Sub-Store 数据、UUID、登录、旧测试数据及旧 Koipy 配置文件/目录。SQLite 增量增加报告和结果表；仅保存展示字段，不保存后端回显的节点载荷、订阅 URL 或凭据。旧业务库的兼容规则保持不变，不实现通用旧链或旧分享地址迁移。共享链配置版本为 `upstream-native-4`。

含旧版 `submeld.sqlite` 的目录仍拒绝打开，不删除、覆盖或迁移旧目录。旧 `#/sources`、`#/library` 和 `#/workbench` 书签进入统一节点页；旧来源和转换管理 API 已移除。

## 本地运行

1. `pnpm install --frozen-lockfile`，复制 `.env.example` 为 `.env`。
2. 设置随机 `MIAOSPEED_TOKEN`，`docker compose -f compose.dev.yaml up -d`；Sub-Store 与 miaospeed 分别绑定回环 39091、39092。
3. 应用停止时运行 `pnpm admin:init --dev`，初始化密码；已有账号不重复初始化。
4. `pnpm dev`，访问 `http://127.0.0.1:5173/submeld/`。

运行构建产物时，将 PUBLIC_ORIGIN 设置为 `http://127.0.0.1:3000`，依次执行 `pnpm build`、`pnpm cores:prepare`、`pnpm start --dev`。默认数据目录 `data-v2`。

停止开发上游使用 `docker compose -f compose.dev.yaml stop`；不要用 `down -v` 清理需要保留的数据。

`MIAOSPEED_URL`、`MIAOSPEED_TOKEN` 仅供服务端使用。`MIAOSPEED_BRIDGE_HOST` 必须是 miaospeed 容器可达的开发主机地址。Windows Docker Desktop 请设为主机局域网 IPv4：`host.docker.internal` 的 TCP 转发可能让 Mihomo 返回回环 UDP 地址。测试容器在 Windows 自动选择首个非回环 IPv4，也可通过 `SUBMELD_TEST_BRIDGE_HOST` 明确指定。完整 Compose 环境使用 `submeld` 服务名。

## Linux 容器部署

三服务配置见 [compose.yaml](compose.yaml)。SubMeld 默认将 3000 端口绑定宿主回环；使用自己的 HTTPS 反向代理，保留路径和 Cookie。`PORT` 可设置为其他 1–65535 端口，监听、端口映射及健康检查同步使用该端口。

1. 准备私有 `.env`，设置实际 HTTPS PUBLIC_ORIGIN 和随机 MIAOSPEED_TOKEN。
2. `docker compose build submeld`。
3. 新安装运行 `docker compose run --rm --no-deps submeld node dist/server/cli.js init`；已有账号不重复初始化。
4. `docker compose up -d sub-store miaospeed submeld`。

可信局域网可显式设置 `ALLOW_HTTP=true`，并将 `PUBLIC_ORIGIN` 设置为实际的 `http://内网IP:端口`。该模式仍以生产方式运行，保留登录和同源检查；会话 Cookie 使用普通名称及 HttpOnly、SameSite=Strict，HTTP 不设置 Secure。密码、会话与订阅内容经局域网明文传输。HTTPS 配置仍使用原有安全 Cookie。分享地址支持 HTTP 浏览器的复制回退，复制失败时保留可选取的地址。

macvlan 部署应复用已配置的外部网络，仅将 SubMeld 加入局域网；Sub-Store 和 miaospeed 保留在项目自己的 bridge 网络。将 `MIAOSPEED_BRIDGE_BIND` 设置为 SubMeld 在该 bridge 网络上的固定 IPv4，使三内核临时 SOCKS 的 TCP/UDP 仅监听内部地址；`MIAOSPEED_BRIDGE_HOST` 则填写 miaospeed 可达的该地址或服务名。macvlan 不需要发布宿主机端口。持久化数据可通过绑定挂载放在项目目录，SubMeld 数据目录需允许容器的 node 用户（UID 1000）读写。

网页不接触 miaospeed Token，不挂载 Docker socket。备份时停止服务并保存 Sub-Store 卷、账号与测试报告卷、私有环境配置；已有 Koipy 配置目录保留。旧 `#/koipy` 链接进入测试中心。

密码重置需先停止 SubMeld：开发使用 `pnpm admin:reset-password --dev`，容器使用 `docker compose run --rm --no-deps submeld node dist/server/cli.js reset-password`。

## 接口与验证

`/api/nodes` 负责统一节点管理；`/api/chains`、`/api/subscriptions` 适配上游文件；`/api/node-tests`、`/api/kernels` 保留三内核检查。`/api/miaospeed/{preview,tests,reports,scripts,settings,status}` 提供综合测试；`/api/telegram/{settings,status,check,tasks}` 管理可选机器人与任务，任务支持 `cancel`、`resend`；`/api/integrations/files` 管理配套文件更新。上游原生管理使用 `/upstream/sub-store/*`。

| 命令                 | 内容                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm check`         | 格式、lint、严格类型、构建、工程和隔离上游集成、三内核配置及真实连通 |
| `pnpm test`          | 构建与工程／隔离上游集成                                             |
| `pnpm test:cores`    | 三内核配置、7 组链式连接、每内核 7 项 HTTPS 场景                     |
| `pnpm test:browser`  | 桌面及 390px 窄屏、原生页面、统一管理与增强流程                      |
| `pnpm cores:prepare` | 准备锁定内核与官方源码                                               |

测试自动创建隔离官方 Sub-Store 和 miaospeed 容器，随机回环端口，不挂个人数据卷，结束后停止容器。依赖 Docker；缺失或失败不会模拟通过。镜像构建不运行依赖容器的验收。Windows 浏览器可设置 PLAYWRIGHT_CHANNEL=msedge。

配置与真实连通检查使用 Sub-Store 文件脚本生成的配置；HTTP 目标、STUN、链两端使用受控测试服务。miaospeed 契约测试验证真实签名、进度、数值单位、三内核 TCP/UDP 两跳、认证、取消/断线、全部预置脚本执行和结果清理。浏览器旧三内核检查使用受控时延结果，仅验证交互；综合测试使用真实 miaospeed VM。

2026-09-27 本轮格式、lint、严格类型和构建通过；隔离上游完整复跑通过 84 项工程测试、三内核配置检查、7 组真实链式连接和 21 项 HTTPS 场景。Edge 桌面与窄屏共 20 项浏览器回归通过。Windows 连续验收中出现过内核启动超时、QUIC 链路失败及一次超时用例返回连接错误，部分 `pnpm check` 因此失败；保留失败日志后完整复跑通过。未放宽超时或跳过用例，间歇性原因尚未确定。

更新后的本地服务另外使用现有的一个 VLESS 公网节点重新完成三内核 HTTPS 实测，三次均返回 204；未修改其订阅内容、UUID 或登录密码。

上述 2026-09-27 记录属于前一基线，不作为本次综合测试通过的依据。外部平台限制或超时如实记录；脚本执行通过不代表所有节点解锁。v2rayN 导入/更新/连接及正式 HTTPS 公网部署仍需对应环境验收。

## 原始文档与源码

保留原始文档，不改写其历史内容；缺失的 v1.1 不以 v1.0 冒充：

- [开发规范与安全边界](docs/SubMeld_开发规范与安全边界_v1.0.md)
- [分阶段开发计划](docs/SubMeld_分阶段开发计划_v1.0.md)
- [旧版产品设计](docs/SubMeld_产品与技术设计文档_v1.0.md)

自有代码采用 AGPL-3.0-only。构建生成对应源码 `dist/submeld-source.tar.gz`、前端、服务端和自有配套脚本；内核准备添加官方源码及许可证。不复制或修改上游源码，不维护上游分支。升级官方镜像后需验证原生 API、脚本接口、元数据保留与转换字段。
