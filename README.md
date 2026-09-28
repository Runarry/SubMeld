# SubMeld · 订融

SubMeld 使用独立 Sub-Store 保存全部代理配置，并提供统一节点管理、两跳链、输出方案、三内核测试和 Koipy 配置入口。Sub-Store 负责实际转换、文件脚本执行、缓存和分享；SubMeld 不维护另一份可编辑节点库，不构建内嵌 Sub-Store。

## 当前架构

2026-09-27 所有者确认上游化重构，随后确认统一存储与流程精简。本基线优先于历史文档中的单容器、内嵌转换、节点分类和预生成发布要求。

| 服务      | 职责                                                                        |
| --------- | --------------------------------------------------------------------------- |
| Sub-Store | 原生前端、节点订阅、组合订阅、链与方案文件、模板、脚本执行、按需生成与分享  |
| Koipy     | Telegram 普通节点测速与结果展示                                             |
| miaospeed | Koipy 的实际测试后端，基于 Mihomo                                           |
| SubMeld   | 登录与代理入口、统一增查删、链与方案表单、三内核实测、内核更新及 Koipy 配置 |

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

### 两跳链与输出方案

两跳路径为本机 → 前置 → 出口 → 目标。可直接选择订阅或组合中的节点，无需复制。成员按资源 UUID 与精确节点名称引用：资源重命名保留关联，同名节点的新地址和凭据自动生效；节点消失、重名或 UUID 丢失时必须重新选择。

链、方案、模板和运行脚本使用 Sub-Store 原生文件保存，带用途、UUID 和格式版本元数据。首次保存方案时初始化缺失的配套文件，启动不会覆盖已有文件。“配套文件”页可手动写入当前内置版本，执行前检查文件版本并提示覆盖自定义内容。

方案支持订阅、组合、单节点和链的有序输入，以及名称、协议筛选和前后缀。保留八种输出：URI、Base64，Mihomo／sing-box／Xray 的完整配置和节点片段。URI／Base64 排除链。

Mihomo 与 sing-box 经上游转换及链式字段输出；Xray 使用随项目交付、在 Sub-Store 中执行的适配脚本，保持现有四协议和参数范围。三内核测试与文件脚本复用转换校验。生成检查节点数量、连接字段和模板中的节点列表，错误返回失败明细。

默认模板为 JSON 文本，允许在原生文件页面修改。占位符包括 `$nodes`、`$outbounds`、`$names`、`$first`、`$port`，按完整值替换。保留节点列表占位符；无效模板不会生成残缺配置。完整配置默认监听回环地址。

### 按需生成与分享

预览、客户端拉取均由 Sub-Store 当次生成，使用上游缓存、脚本和联网规则。“刷新并生成”请求上游绕过缓存。没有六小时发布任务、预生成产物库、本地分享密钥或旧 `/s/*` 地址。

在方案页面创建或撤销分享，令牌由 Sub-Store 保存与验证。原生 `/share/file/*`、订阅和组合分享经同源代理转发。上游停机时输出不可用；不会返回 SubMeld 缓存的旧配置。分享遵循原生 GET 行为，HEAD 仍由上游决定。

### 测试与 Koipy

三内核测试保留批次进度、取消、最近结果、官方内核检查与手动更新。节点引用使用资源 UUID、快照摘要和位置；链测试同时固定两个成员的快照。内容变化或上游状态无法确认时，不保存迟到结果。处理规则排除的原始节点仍可测试。

默认 HTTPS 目标为 `https://cp.cloudflare.com/generate_204`。DNS 失败、198.18.0.0/15 Fake-IP、非公网目标标为“测试目标异常”，不能据此判断节点失效。可在“节点测试”页更改测试地址；不会放行 Fake-IP。

Koipy 管理页配置机器人用户名、激活码、Bot Token、管理员 ID、代理和 miaospeed 后端。直接写共享原生配置文件，保留其他后端和自定义字段；已保存的凭据不回传，留空保留，显式清除才删除。保存后按提示手动重启 Koipy。

给 Koipy 发送其可访问的普通节点 Mihomo 原生分享链接。Telegram 测试结果留在 Koipy；整链与 sing-box／Xray 实测由网页提供。

## 数据与兼容

SQLite 仅保存账号、运行设置和测试结果，节点及配置预览在内存中。测试需要的临时凭据配置会在进程结束后清理。没有第二份可编辑节点凭据库。

保留现有 Sub-Store 数据、UUID、登录和 Koipy 配置。本次当前环境没有已保存的旧链或增强方案；允许升级空业务定义的 v2 本地库，重建索引。旧测试引用不作为新快照的有效结果，需要重新测试。若旧库仍有链或方案则拒绝自动搬迁，保留原库并提示使用新目录；不实现通用旧配置或旧分享地址迁移。

含旧版 `submeld.sqlite` 的目录仍拒绝打开，不删除、覆盖或迁移旧目录。旧 `#/sources`、`#/library` 和 `#/workbench` 书签进入统一节点页；旧来源和转换管理 API 已移除。

## 本地运行

1. `pnpm install --frozen-lockfile`，复制 `.env.example` 为 `.env`。
2. `docker compose -f compose.dev.yaml up -d`，上游仅绑定回环 39091。
3. 应用停止时运行 `pnpm admin:init --dev`，初始化密码；已有账号不重复初始化。
4. `pnpm dev`，访问 `http://127.0.0.1:5173/submeld/`。

运行构建产物时，将 PUBLIC_ORIGIN 设置为 `http://127.0.0.1:3000`，依次执行 `pnpm build`、`pnpm cores:prepare`、`pnpm start --dev`。默认数据目录 `data-v2`。

停止开发上游使用 `docker compose -f compose.dev.yaml stop`；不要用 `down -v` 清理需要保留的数据。

## Linux 容器部署

四服务配置见 [compose.yaml](compose.yaml)。仅 SubMeld 的 3000 端口绑定宿主回环；使用自己的 HTTPS 反向代理，保留路径和 Cookie。

1. 准备私有 `.env`，设置实际 HTTPS PUBLIC_ORIGIN 和随机 MIAOSPEED_TOKEN。
2. 可通过 `node --env-file=.env deploy/configure-koipy.mjs` 初始化 `runtime-v2/koipy/config.yaml`。已有文件不会被覆盖。也可先创建共享目录，再通过网页填写配置。
3. Linux 下使容器用户 UID 1000 可写共享配置目录。
4. `docker compose build submeld`。
5. 新安装运行 `docker compose run --rm --no-deps submeld node dist/server/cli.js init`。
6. `docker compose up -d sub-store submeld`，登录配置 Koipy；核对 miaospeed Token 后运行 `docker compose up -d miaospeed koipy`。
7. 后续网页修改 Koipy 配置，执行 `docker compose restart koipy` 生效。

KOIPY_CONFIG_PATH 指向共享原生文件；Compose 不使用环境变量覆盖网页保存的 Koipy 凭据，也不挂载 Docker socket。备份时停止服务并保存 Sub-Store 卷、本地账号与测试数据卷、Koipy 配置及私有环境配置。

密码重置需先停止 SubMeld：开发使用 `pnpm admin:reset-password --dev`，容器使用 `docker compose run --rm --no-deps submeld node dist/server/cli.js reset-password`。

## 接口与验证

`/api/nodes` 负责统一节点管理；`/api/chains`、`/api/subscriptions` 适配上游文件；`/api/node-tests`、`/api/kernels` 保留测试与内核管理。`/api/integrations/koipy` 管理原生配置，`/api/integrations/files` 管理配套文件更新。上游原生管理使用 `/upstream/sub-store/*`。

| 命令                 | 内容                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm check`         | 格式、lint、严格类型、构建、工程和隔离上游集成、三内核配置及真实连通 |
| `pnpm test`          | 构建与工程／隔离上游集成                                             |
| `pnpm test:cores`    | 三内核配置、7 组链式连接、每内核 7 项 HTTPS 场景                     |
| `pnpm test:browser`  | 桌面及 390px 窄屏、原生页面、统一管理与增强流程                      |
| `pnpm cores:prepare` | 准备锁定内核与官方源码                                               |

测试自动创建隔离官方 Sub-Store 容器，随机选择并固定测试期间的回环端口，不挂个人数据卷，结束后停止容器。依赖 Docker；缺失或失败不会模拟通过。镜像构建不运行依赖容器的验收。Windows 浏览器可设置 PLAYWRIGHT_CHANNEL=msedge。

配置与真实连通检查使用 Sub-Store 文件脚本生成的配置；HTTP 目标、链两端使用受控测试服务。浏览器和任务状态测试使用受控探测结果，只用于验证交互和状态，不代表公网节点或 Telegram 已验证。

2026-09-27 本轮格式、lint、严格类型和构建通过；隔离上游完整复跑通过 84 项工程测试、三内核配置检查、7 组真实链式连接和 21 项 HTTPS 场景。Edge 桌面与窄屏共 20 项浏览器回归通过。Windows 连续验收中出现过内核启动超时、QUIC 链路失败及一次超时用例返回连接错误，部分 `pnpm check` 因此失败；保留失败日志后完整复跑通过。未放宽超时或跳过用例，间歇性原因尚未确定。

更新后的本地服务另外使用现有的一个 VLESS 公网节点重新完成三内核 HTTPS 实测，三次均返回 204；未修改其订阅内容、UUID 或登录密码。

**需要实际环境另行验收：** 真实 Koipy 授权与 Telegram 测速、v2rayN 导入／更新／连接，以及正式 HTTPS 公网部署。旧版本的实际结果不自动延续到本架构。

## 原始文档与源码

保留原始文档，不改写其历史内容；缺失的 v1.1 不以 v1.0 冒充：

- [开发规范与安全边界](docs/SubMeld_开发规范与安全边界_v1.0.md)
- [分阶段开发计划](docs/SubMeld_分阶段开发计划_v1.0.md)
- [旧版产品设计](docs/SubMeld_产品与技术设计文档_v1.0.md)

自有代码采用 AGPL-3.0-only。构建生成对应源码 `dist/submeld-source.tar.gz`、前端、服务端和自有配套脚本；内核准备添加官方源码及许可证。不复制或修改上游源码，不维护上游分支。升级官方镜像后需验证原生 API、脚本接口、元数据保留与转换字段。
