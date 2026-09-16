# SubMeld · 订融

私人节点转换与订阅工具。把节点整理清楚，把转换结果交代清楚。

当前版本 `0.1.0` 已实现 P1 临时转换工作台：单管理员登录、文本导入、六类基础节点编辑、URI／Base64 预览、复制与下载。工作台内容不保存到数据库或浏览器持久存储，刷新或退出即清空。

**P1 状态：部分验收（v0.1.0）。** 项目所有者于 2026-09-16 确认已完成基础手动测试，尚未完整测试所有协议。此前已通过工程检查、转换与 HTTP／存储测试、隔离浏览器的桌面及窄屏操作测试。全协议手动覆盖、实际容器部署及客户端验收记录仍待补充；不据此标记 P1 完整验收。P2～P4 尚未开始。

## 文档与基线

冲突时优先采用精简开发规范和分阶段计划。被引用的 v1.1 精简设计尚缺，现有 v1.0 仅作参考，不恢复字段加密、多包结构、多令牌或发布依赖向量。

| 顺序 | 文件                                                          | 原文逻辑名称          |
| ---- | ------------------------------------------------------------- | --------------------- |
| 1    | [开发规范与安全边界](docs/SubMeld_开发规范与安全边界_v1.0.md) | `docs/DEVELOPMENT.md` |
| 2    | [分阶段开发计划](docs/SubMeld_分阶段开发计划_v1.0.md)         | `docs/PLAN.md`        |
| 3    | [旧版产品设计](docs/SubMeld_产品与技术设计文档_v1.0.md)       | 参考资料，不是 v1.1   |

开发基线为 Node.js `24.6.0`、pnpm `10.33.2`，一个根包。新增依赖精确锁定。SQLite 使用 `better-sqlite3@12.6.2`，已在本次 Windows x64 / Node 24.6.0 环境加载；13.x 在该环境需要未就绪的编译工具链，因此未采用。密码采用 Argon2id，19 MiB、2 次迭代、并行度 1。

## 本地启动

1. 安装依赖：`pnpm install --frozen-lockfile`。
2. 将 `.env.example` 复制为 `.env`，显式设置 `PUBLIC_ORIGIN=http://127.0.0.1:5173`、`DATA_DIR=./data`。
3. 应用停止时运行 `pnpm admin:init --dev`，按提示输入至少 12 个字符的管理员密码。
4. 运行 `pnpm dev`，打开 <http://127.0.0.1:5173>，使用刚设置的密码登录。

`pnpm dev` 先构建 Worker，再启动 Vite 和 Hono。前端与服务端代码可自动重载；修改转换 Worker 后需重新运行 `pnpm dev`。端口为 5173 与 3000，开发服务仅监听回环地址。端口占用时先停止占用进程，不自动换端口。

运行构建后的完整网页时，先停止开发服务，把 `PUBLIC_ORIGIN` 改为 `http://127.0.0.1:3000`，再执行：

```sh
pnpm build
pnpm start --dev
```

生产不能使用 `--dev`。Windows 本机仅支持开发模式；生产数据权限与部署使用 Linux 容器验证。没有默认密码、公开注册或通过请求 Host 自动开启的 HTTP 例外。

## 工作台与公开支持范围

粘贴 URI、Base64 订阅正文，或含 `proxies` 的 Clash／Mihomo YAML；上传文件必须是 UTF-8 文本。也可在空工作台选择协议并添加节点。修改节点后点击“生成 URI 与 Base64”，预览、复制和下载使用同批生成结果；任意编辑立即使旧结果失效。

| 协议      | P1 开放范围                                                            |
| --------- | ---------------------------------------------------------------------- |
| SS        | `aes-128-gcm`、`aes-256-gcm`、`chacha20-ietf-poly1305`；SIP002 URI     |
| VMess     | v2rayN JSON/Base64 分享格式；AEAD / alterId=0；TCP、WS、gRPC           |
| VLESS     | TCP、WS、gRPC；TLS；TCP 基础 REALITY；适用组合的 `xtls-rprx-vision`    |
| Trojan    | TLS；TCP、WS、gRPC                                                     |
| Hysteria2 | 密码、SNI、证书验证标记、可选 Salamander；接受 `hy2`，输出 `hysteria2` |
| TUIC      | v5 UUID／密码、SNI、ALPN、拥塞控制、UDP relay mode、reduce RTT         |

公开关键字段包含中文名称、IPv6、认证、SNI、ALPN、TLS 指纹、REALITY 公钥／short ID、WS path／Host 和 gRPC serviceName，以各协议表单开放项为准。Hysteria2 URI 本阶段不开放自定义 ALPN／客户端指纹，TUIC 不开放客户端指纹。参数组合仍须经过校验，不承诺所有客户端或全部分享方言。

- Base64 只允许一层订阅包装；输入兼容标准和 URL-safe 编码，输出标准 Base64、带 padding、不折行。URI 使用 UTF-8 与 LF，末尾不额外换行。Base64 不提供保密性。
- URL、provider、规则和节点地址不会触发网络访问。YAML 只提取内联节点，其他配置范围显示警告；只有 provider 的文件不能成功导入。
- SS2022、插件、XHTTP、端口跳跃、ECH、额外证书文件、原生 Xray／sing-box JSON 输入等未开放。未知关键类型或已知重要参数无法表达时阻断输出。
- 失败节点保留在列表，必须修正或明确排除，不会静默减少输出节点。节点明确关闭证书验证时保留该值并告警。
- 原始输入中未纳入验证的附加参数显示警告，不带入输出。完整配置和规则语义不随节点转换保留。
- 目前没有节点库、订阅地址、远端抓取或三内核配置输出。

## API 与运行边界

管理网页与接口同源；`POST` 必须携带有效 JSON Content-Type、`X-SubMeld-Request: 1` 和与 `PUBLIC_ORIGIN` 匹配的 Origin，除登录外还须有有效会话。不开放跨源 CORS。

| 方法与路径                  | 行为                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `POST /api/auth/login`      | `{ password }`，登录并设置会话 Cookie                                |
| `GET /api/auth/me`          | 当前会话状态                                                         |
| `POST /api/auth/logout`     | 正文 `{}`，立即撤销当前会话                                          |
| `POST /api/convert/parse`   | `{ format: auto\|uri\|base64\|yaml, text }`，返回条目、诊断及计数    |
| `POST /api/convert/produce` | `{ items }`，校验编辑后的 NodeDraft 和显式排除标记，返回 URI／Base64 |
| `GET /healthz`              | 仅进程存活，不能代表转换或部署验收                                   |
| `GET /source.tar.gz`        | 当前构建对应源码及构建材料                                           |

条目包括 `nodeIndex/draft/excluded/diagnostics`；无法解析的条目保留 `draft: null`。诊断为 `level/code/nodeIndex/field?/message`，全局诊断使用 `nodeIndex: -1`。结构定义见 `server/shared/contracts.ts`。输入是业务 NodeDraft，不是上游私有 payload 或新的公共节点交换格式。

统一错误体是 `code/message/diagnostics?`。400 为无效请求，401 未登录，403 同源校验失败，413 超限，415 不支持的正文编码，422 转换失败，429 登录节流，503 Worker 繁忙或不可用。未知 API／订阅路径为 JSON 404，不回退 HTML。

输入／解码正文限制 4 MiB、2,000 节点、结构深度 32。原始 JSON 请求上限 26 MiB，用于覆盖转义包装，实际文本和节点正文仍受 4 MiB 限制；不接受压缩管理请求。URI 与 Base64 各自限制 4 MiB，只有 Base64 超限时仍可使用 URI。

一个转换 Worker、无排队，超过 5 秒真正终止并重建。Worker 分离计算，不是任意代码沙箱。管理会话只存内存摘要，固定 24 小时，最多 64 个；重启全部失效。登录按全局 5 分钟最多 10 次尝试，并限制同时一次密码验证，不信任转发 IP。

管理响应和输出为 `no-store`；节点信息以文本呈现；无第三方脚本。日志只记录固定路由模板、状态和错误码。P1 数据库仅有 settings，保存管理员密码哈希；转换正文不持久化。独立 SQLite 维护锁防止同一数据目录同时运行多个应用或维护命令，进程退出后由系统释放。

## Linux 单容器部署

设置 `.env` 中的 `PUBLIC_ORIGIN=https://你的实际域名`。已有反向代理负责 HTTPS，并转发到宿主 `127.0.0.1:3000`；禁止代理缓存管理响应、记录请求正文、Cookie 或 Authorization。

```sh
docker compose build
docker compose run --rm submeld node dist/server/cli.js init
docker compose up -d
```

Compose 使用一个应用、一个命名数据卷、非 root 用户、只读根文件系统、受限临时目录，内存从 768 MiB 起测；不挂 Docker socket。数据目录 0700，数据库、锁及 WAL 等文件 0600，umask 077。初始化时不可同时运行服务。

**本次未运行成功的验收：** Docker Desktop 引擎返回无法启动，因此镜像构建、容器内权限、资源预算及 HTTPS 反向代理路径均待在实际部署环境执行。配置文件和 Windows 测试通过不替代这些检查。

## 密码重置、升级和备份

本地开发停机后执行 `pnpm admin:reset-password --dev`。容器部署执行：

```sh
docker compose stop
docker compose run --rm submeld node dist/server/cli.js reset-password
docker compose up -d
```

密码只从隐藏终端输入或标准输入读取，不作为命令行参数。维护命令遇到活动的数据目录会拒绝执行。

升级前停止应用并备份整个数据目录／数据卷，不能在运行中只复制主数据库文件。离机备份使用已有可信工具加密。使用同一数据卷顺序迁移；迁移失败停止启动，不删卷重建。回退使用兼容数据库或匹配版本的停机备份。P1 没有订阅令牌。

## 验证命令与实际结果

| 命令                | 用途                                             |
| ------------------- | ------------------------------------------------ |
| `pnpm check`        | 格式、lint、类型、构建、转换／HTTP／存储集成测试 |
| `pnpm test`         | 构建后运行 Node.js 回归                          |
| `pnpm test:browser` | 构建后运行隔离浏览器的桌面与窄屏流程             |
| `pnpm build`        | 构建固定上游、网页、服务端及对应源码包           |
| `pnpm format`       | 格式化工程文件，排除原始文档与上游源码           |

浏览器测试默认使用 Playwright Chromium，可先执行 `pnpm exec playwright install chromium`。也可通过 `PLAYWRIGHT_CHANNEL=msedge` 使用已安装 Edge（PowerShell：`$env:PLAYWRIGHT_CHANNEL='msedge'`）。测试创建临时数据库和隔离浏览器上下文，不使用个人配置；产物位于忽略的 `.cache/browser-results`。

本次 Windows x64 / Node 24.6.0 环境已运行工程回归，以及 Edge 的桌面和 390px 窄屏浏览器测试。浏览器覆盖登录、YAML 上传、名称／SNI 编辑、错误项排除、同批 URI／Base64、下载字节、修改后失效、迟到响应丢弃及退出清空。复制按钮使用剪贴板替身核对调用内容，不宣称已验证系统剪贴板权限。

计划验收客户端为 **v2rayN**。本次基础手动测试反馈未列出已测协议、客户端版本、导入结果和真实连接情况，因此只记录部分验收，不推断这些项目已完成。具体协议覆盖和客户端验收记录仍待补充，自动测试不能替代它们。

## 源码与许可

SubMeld 自有代码采用 AGPL-3.0-only。固定 Sub-Store 源码、许可证与适配说明见 [vendor/README.md](vendor/README.md)，固定提交与源码校验值见 `vendor/upstream.lock.json`。生产只运行受控转换包，不运行上游管理服务。

每次构建生成 `dist/submeld-source.tar.gz`，网页页脚提供下载。打包使用明确的源码目录与文件列表，排除运行数据、环境秘密、Git、依赖和缓存。发布镜像时须保留对应源码与构建材料，不能仅发布编译产物。

项目当前不执行 Git 提交、推送或公网部署。
