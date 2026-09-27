# SubMeld · 订融

SubMeld 2.0 以 Sub-Store 和 Koipy 的原生能力为主，补充结构化节点编辑、两跳链、增强订阅和三内核实测。节点与来源的权威数据保存在独立 Sub-Store 服务中；项目不再构建或运行内嵌 Sub-Store、转换 Worker 或自建来源抓取器。

## 当前基线

2026-09-27 所有者确认本次上游化方案，优先于旧文档中的单容器、禁止上游管理服务、抓取限制及旧数据库升级要求。采用上游原生脚本、联网、缓存与刷新行为。普通管理接口仅供自己的管理员使用。

| 服务      | 职责                                                             |
| --------- | ---------------------------------------------------------------- |
| Sub-Store | 原生网页、节点与来源、普通组合订阅、转换和分享                   |
| Koipy     | Telegram 指令、测试流程与结果展示                                |
| miaospeed | Koipy 使用的测试后端，基于 Mihomo                                |
| SubMeld   | 登录入口、增强编辑、链和配置组装、增强发布、三内核实测及内核更新 |

官方镜像固定摘要见 [upstreams.lock.json](upstreams.lock.json)。当前 Sub-Store 后端为 2.42.2。上游保持原样，不维护分支；SubMeld 保留少量 URI 边界修正，覆盖 Trojan 密码编码、VMess 证书标记、TUIC ALPN 与密码解码，并核对输出字段。Xray 原生 JSON 输出、固定配置模板和两跳链仍由 SubMeld 补充。

这是新数据版本：**无需迁移旧数据，也不会删除或覆盖旧目录。** 使用新的 `data-v2` / Compose 卷。发现旧 `submeld.sqlite` 时拒绝打开该目录。旧版验收结果不能直接视为 2.0 已验收。

## 文档索引

保留三份原始文档及文件名，作为历史需求参考。本次确认的架构和 README / AGENTS.md 为当前执行基线。

| 文件                                                          | 原文逻辑名称              |
| ------------------------------------------------------------- | ------------------------- |
| [开发规范与安全边界](docs/SubMeld_开发规范与安全边界_v1.0.md) | `docs/DEVELOPMENT.md`     |
| [分阶段开发计划](docs/SubMeld_分阶段开发计划_v1.0.md)         | `docs/PLAN.md`            |
| [旧版产品设计](docs/SubMeld_产品与技术设计文档_v1.0.md)       | 仅供参考，不是缺失的 v1.1 |

Node.js 24.6.0、pnpm 10.33.2；一个根包，Vue + TypeScript、Node.js + Hono、SQLite。依赖使用精确版本。

## 本地开发

1. `pnpm install --frozen-lockfile`。
2. 复制 `.env.example` 为 `.env`。默认开发入口 `http://127.0.0.1:5173`，数据目录 `./data-v2`。
3. `docker compose -f compose.dev.yaml up -d`，独立上游仅绑定回环 39091。该开发服务使用自己的新数据卷；测试不会连接或重置它。
4. 应用停止时运行 `pnpm admin:init --dev`，按提示设置至少 12 字符的密码。
5. `pnpm dev`，打开 `http://127.0.0.1:5173/submeld/` 登录。

站点根路径是 Sub-Store；`/submeld/` 是服务入口和增强工具。首次构建/准备内核需要联网，缓存复用。直接运行构建产物时，将 PUBLIC_ORIGIN 改为 `http://127.0.0.1:3000`，执行 `pnpm build`、`pnpm cores:prepare`、`pnpm start --dev`。

开发服务的正常停止命令为 `docker compose -f compose.dev.yaml stop`。不用 `down -v` 清理需要保留的数据。

## 使用流程

**日常订阅管理：** 从服务入口打开 Sub-Store，使用其原生来源、本地内容、组合订阅、处理操作、文件与分享。普通订阅采用上游缓存及按请求生成语义；上游支持的额外协议可在原生界面使用。

**结构化本地节点：** 在增强工具创建、编辑或批量导入节点。每条独立节点保存为 Sub-Store 的单节点本地订阅，名称初始为 `sm-node-<UUID>`。`_submeld` 元数据记录稳定身份，原生重命名不会改变引用。停用使用带标记的内置过滤操作，不删除凭据；三内核测试仍可读取停用节点的保存内容。原生界面也可以编辑这些订阅，需保持其单节点含义。

**来源预览：** “上游节点预览”列出普通上游订阅和组合订阅。可读取、手动更新快照、复制所选节点为独立本地节点，或单项/批量测试。复制后的节点不跟随原来源变化。增强编辑与测试继续限定原有 SS、VMess、VLESS、Trojan、Hysteria2、TUIC 范围；不能完整表达的节点明确报错，不在增强输出中默默丢失。

VLESS 增强输出保留上游默认 XUDP，其他 UDP 编码仍明确拒绝。Mihomo、sing-box 字段由上游输出并核对；Xray 用其原生 XUDP 配置表达。前台转换与后台发布顺序执行，等待期间可取消，整个请求最长两分钟。

**两跳链：** 引用两个不同的独立本地节点，路径为本机 → 前置 → 出口 → 目标。提供 Mihomo、sing-box、Xray 完整配置及片段；URI/Base64 明确排除链。被链引用的节点不能通过正常管理删除或批量替换。导入或外部改写清除身份标记后，旧引用显示失效，需要重新选择，不能靠同名节点自动接续。

**增强订阅：** 引用上游订阅/组合、本地节点及链，保留顺序、名称/协议筛选、八种输出和可撤销私人地址。八种输出为 URI、Base64，以及三个目标的完整配置与节点片段。固定配置默认只监听回环，不生成空代理或失败直连配置。Xray 继续限定现有四协议及已验证参数组合。

增强产物在后台生成，启动、手动生成及每六小时更新；来源内容交给上游获取。来源面板的“更新上游快照”可强制绕过上游缓存。自动失败保留最近成功产物；人工修改先清除旧产物，再从上游重建。管理写入口在调用上游前先失效增强产物，避免跨服务失败恢复旧内容；本版本保守重建全部增强方案。私人 GET/HEAD 只读已有产物，不触发来源抓取或转换。

**三内核测试：** 保留单批次、单项/批量、进度、取消、最近结果和网页官方内核更新。测试不改变发布内容。来源节点使用 `snapshotHash + nodeIndex`，刷新重排后不能串用结果。测试对象允许保存的内网/回环地址；目标仍限定公网 HTTPS，无重定向、无直连回退。真实内核版本由批次固定，更新失败保留当前版本。

**Telegram：** 给自己的 Koipy 机器人发送普通节点的 Mihomo 分享链接，使用其原生测试指令。机器人必须能够访问该链接；测试结果保留在 Koipy，不与网页同步。本轮没有增加 Telegram 整链测试；两跳链在网页三内核测试。Koipy 本身不替代 sing-box/Xray 实测。

## Linux 容器部署

四服务见 [compose.yaml](compose.yaml)。仅 SubMeld 的 3000 端口发布到宿主回环；使用自己的 HTTPS 反向代理，保留路径和 Cookie。不要公开其他服务端口。代理不缓存私人订阅，不记录带令牌的完整 URL。

1. 准备新的 `.env`，将 PUBLIC_ORIGIN 改为真实 HTTPS origin。
2. 配置 Koipy 激活码、Bot Token、机器人用户名、管理员 Telegram 数字 ID，以及至少 16 字符随机 `MIAOSPEED_TOKEN`。这些值不提交 Git。
3. `node --env-file=.env deploy/configure-koipy.mjs`。它从 [Koipy 配置模板](deploy/koipy.config.example.json) 填入管理员 ID 和 miaospeed token，仅在文件不存在时生成 `runtime-v2/koipy/config.yaml`，避免覆盖通过 Koipy 原生指令修改的配置。JSON 是合法 YAML，生成器只需 Node.js。
4. `docker compose build submeld`。
5. `docker compose run --rm --no-deps submeld node dist/server/cli.js init`，通过隐藏终端输入密码。
6. `docker compose up -d`。登录 `/submeld/` 后，从入口进入 Sub-Store 或 Telegram。

Koipy 激活码与 Bot Token 通过其支持的环境变量读取，后端地址在本地配置文件中。若主机访问 Telegram 需要代理，按 Koipy 官方配置设置 bot 代理。本项目不提供 Docker socket、网页容器更新或自动部署。

Sub-Store 与 SubMeld 使用独立新卷；Koipy 的配置文件单独持久保存。备份时停止服务，保存两个卷、Koipy 配置和私有环境配置。SQLite 不保存第二份可编辑节点凭据库，但生成产物仍包含节点秘密，应按私人配置保管。

密码重置：先停止 SubMeld，再执行 `docker compose run --rm --no-deps submeld node dist/server/cli.js reset-password`。开发模式使用 `pnpm admin:reset-password --dev`。

## 接口与验证

增强 API 保留 `/api/auth`、`/api/convert`、`/api/nodes`、`/api/chains`、`/api/subscriptions`、`/api/node-tests`、`/api/kernels`。来源 API 仅提供列表、详情及手动读取上游快照；创建/编辑由原生 Sub-Store API 完成。来源详情与测试对象使用 `snapshotHash`。`/upstream/sub-store/*` 的管理请求经过登录和同源写保护；`/share/*` 及原生前端可能生成的 `/upstream/sub-store/share/*` 直接交给上游验证分享令牌。当前上游分享支持 GET，HEAD 返回 405；增强 `/s/*` 支持 GET/HEAD，由 SubMeld 验证令牌与 key。

| 命令                 | 检查范围                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `pnpm check`         | 格式、lint、严格类型、构建、工程/真实上游集成、三内核配置、链和 HTTPS 连通 |
| `pnpm test`          | 构建与工程/真实上游集成                                                    |
| `pnpm test:cores`    | 三内核配置、7 组链检查、每内核 7 项 HTTPS 场景                             |
| `pnpm test:browser`  | 桌面与 390px 窄屏，原生界面和增强流程                                      |
| `pnpm cores:prepare` | 准备锁定基线内核及其官方源码                                               |

测试入口自动创建临时官方 Sub-Store 容器，使用随机回环端口且不挂个人数据卷，完成后停止容器。需要可用 Docker；缺少上游时明确失败，不静默跳过。浏览器可用 `PLAYWRIGHT_CHANNEL=msedge`；内核检查支持 Windows x64 / Linux x64。构建镜像不运行依赖外部服务的工程测试，发布前应在验证环境运行 `pnpm check`。

2026-09-27 本次实际验证：

- Windows `pnpm check`：格式、lint、严格类型、构建及 79 项工程/隔离 Sub-Store 集成测试通过。
- Windows 与 Linux amd64：Mihomo 1.19.31、sing-box 1.14.1、Xray 26.3.27 配置检查通过，分别包含 41/41/33 个节点；每个平台的 7 组链式连接检查、每内核 7 项真实 HTTPS 场景通过。使用受控测试节点，不代表个人公网节点或所有客户端已验收。
- Microsoft Edge 桌面与 390px 窄屏：30 项浏览器回归通过，包括原生界面内容编辑/重命名后的 UUID 保留、批量保存、停用测试、链成员保护、来源替换及失败节点明细。
- Linux 最终运行镜像构建、非 root 只读运行、普通分享与增强发布通过。两个容器重启后节点、引用、产物和上游令牌保留，登录会话失效；撤销分享与上游暂停时读取最近产物通过。使用 Docker Desktop 隔离网络和新临时卷，没有切换现有部署。
- Compose 配置校验、Koipy 模板生成及防覆盖检查通过；固定 miaospeed 镜像按 Compose 参数启动通过。

**尚未验收：** 真实 Koipy 激活及 Telegram 测速、个人公网节点、v2rayN 实际导入/更新/连接，以及新架构的正式 HTTPS 反代和公网部署。缺少相应凭据或实际环境，未用模拟结果代替。

## 源码

自有代码采用 AGPL-3.0-only。构建生成 `dist/submeld-source.tar.gz`，增强页面提供下载。内核准备步骤添加对应官方源码及许可证。原生上游由独立官方镜像提供，版本与镜像摘要可单独检查和升级；升级后须验证本项目使用的 API、身份元数据保留及转换字段。
