# SubMeld · 订融

私人节点转换与订阅工具。把节点整理清楚，把转换结果交代清楚。

当前版本 `1.0.0` 已实现 P4：文本与远端 HTTPS 来源、手动及每 6 小时自动刷新、有序订阅方案、八种格式的私人订阅地址与立即撤销。增加可保存、可加入订阅的两跳链式代理。保留 P1 的登录、六协议编辑和 URI／Base64 工作台，以及 P2 节点库和三目标导出。明确保存的节点、来源、方案和产物写入数据库；临时工作台、未保存编辑及一次性令牌不写浏览器持久存储。

**验收状态（截至 2026-09-17）：** P1～P3 已实现并通过自动检查，项目所有者确认本机及 v2rayN 导入、连接通过，逐协议／逐目标和客户端／内核版本仍缺记录。P4 已通过 Windows 与 Linux 的工程及三内核检查、桌面／窄屏浏览器流程和实际 Linux 内网 HTTPS 部署验收；真实公网订阅来源及其 v2rayN 更新／连接仍待实际验收，不标为完整 P4 或所有客户端兼容通过。

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

| 协议      | 当前开放范围                                                           |
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
- 已开放文本来源、远端 HTTPS 来源和私人订阅。只有明确保存的远端来源入口联网，工作台文本和 YAML provider 仍不触发抓取。

## 本地节点与三目标导出

在“本地节点”页点击“导入节点”，粘贴文本或上传 UTF-8 文件，选择自动识别／URI／Base64／Clash 或 Mihomo YAML 后点击“解析导入内容”。预览按每页 25 项展示，默认选择全部条目；可直接编辑、取消选择，再点击“添加所选节点”。失败项不会静默跳过，警告不阻止保存，同名节点作为新记录添加。成功后清空导入内容、刷新列表并定位最后一页，不覆盖独立编辑表单中的未保存内容。

导入沿用 4 MiB、2,000 节点限制，不访问 URL 或 provider。修改原文或格式后须重新解析；迟到响应不会恢复旧预览。关闭导入或离开节点页会清空临时导入数据；只有点击“添加所选节点”后才写入节点库，保存失败会保留原文、选择及编辑。

工作台勾选节点后点击“另存为本地节点”，所选节点全部校验成功才原子保存，不自动去重或跳过错误。节点库支持分页、新建、编辑、启停和删除；列表不返回认证秘密。打开编辑时按需读取完整字段，默认遮罩；未修改的秘密不提交，清空使用字段旁的明确按钮，必要凭证不能保存为空。

编辑、启停和删除携带 revision；另一个页面已修改时返回 409。页面保留未提交编辑，重新载入服务器版本会替换它。启用的节点可按列表顺序载入工作台，追加为独立副本；修改、禁用或删除节点库记录不改变已有临时副本。工作台上移／下移决定导出顺序。

| 目标     | 节点片段               | 完整配置                           | 检查内核 |
| -------- | ---------------------- | ---------------------------------- | -------- |
| Mihomo   | 含 `proxies` 的 YAML   | mixed 入站、选择组、MATCH 到选择组 | 1.19.31  |
| sing-box | 含 `outbounds` 的 JSON | mixed 入站、selector、默认路由     | 1.14.1   |
| Xray     | 含 `outbounds` 的 JSON | SOCKS 入站、路由到第一节点         | 26.3.27  |

完整配置固定监听 `127.0.0.1`，默认端口 1080，仅开放端口调整；使用当前排序第一项。无有效节点时报错，不生成 DIRECT-only 配置。采用系统／基础 DNS，不承诺所有 DNS 均走代理；没有 TUN、控制 API、远程规则、测速或失败直连。重复名称或模板保留名称仅在导出副本追加序号并提示。

Mihomo 与 sing-box 覆盖现有六协议范围；Xray 限 SS／VMess／VLESS／Trojan。锁定 Xray 版本已按其日期规则拒绝 allowInsecure，自定义 REALITY ALPN 也无法表达：这些节点在 Xray 目标明确报错，不擅自修改参数，其他目标仍可使用。REALITY 未指定指纹时，这三个目标采用 chrome 并给出提示。

选择目标后生成，切换“基础完整配置／仅节点”复用同批结果。Mihomo 下载 .yaml，其余两目标下载 .json。节点、顺序、排除状态或端口变化使旧结果失效；某目标失败不清除其他已生成目标。仅节点文件是配置片段，不能当作完整客户端配置直接启动。

## 两跳链式代理

在“本地节点”页的“链式代理”区域新建组合，填写链名称，选择不同的前置和出口节点，可交换顺序。路径为 **本机 → 前置代理 → 出口代理 → 目标**。链只保存本地节点引用，原节点参数修改会同步到关联订阅；来源节点须先复制到本地。每页 25 条，最多保存 100 条链，支持编辑、启停与删除。

在“订阅方案”中把输入类型切换为“链式代理”，加入已保存的链并调整顺序。Mihomo、sing-box、Xray 的完整配置和片段均带两跳依赖，完整配置只把链出口列为可选代理，沿用第一个可选项作为默认。输出分别使用出口的 `dialer-proxy`、`detour`、`streamSettings.sockopt.dialerProxy`；前置使用独立名称，不修改原节点或同方案中单独加入的节点。重名在导出副本中确定性追加序号。

名称筛选及前后缀作用于链名称；协议筛选必须同时包含两跳协议，否则整链排除。每条链计为一个可选输出，2,000 节点及 4 MiB 输入限额按展开后的两跳计量。两跳分别执行已有目标校验，Xray 仍限 SS／VMess／VLESS／Trojan。Hysteria2／TUIC 作为出口时会提示前置服务端须支持 UDP，并为 Mihomo 前置副本开启 UDP 转发；不保证任意服务端组合均可连通。

URI／Base64 **明确排除链式代理**，在页面和生成诊断中提示，仅发布另行加入的普通节点，不把链拆成两条单跳节点。排除后没有普通节点则报错，不发布空内容；其他目标仍独立生成。

停用链会整链排除；启用的链若任一成员停用，保留该链的内核格式明确报错，URI／Base64 的普通节点不受此限制。删除被链引用的节点会提示关联链，须先替换引用或删除链。删除链会移除订阅引用，保留两条本地节点。链的编辑、启停、删除及成员修改均在同一事务中递增受影响方案 revision、清除旧产物，随后重建；同一方案即使通过多条路径引用该节点也只递增一次。

管理接口为 `GET/POST /api/chains` 和 `GET/PATCH/DELETE /api/chains/:id`，列表接受零起始 `page`。配置字段为 `name/enabled/entryNodeId/exitNodeId`，更新和删除携带 `revision`；列表与详情只有两跳摘要、启用及可用状态，不返回节点凭证。渲染请求兼容普通条目，并新增 `kind: chain` 条目，包含 `name/entry/exit/available` 与共用的 `nodeIndex/excluded/diagnostics`；`entry/exit` 为现有 NodeDraft，普通工作台仍只编辑单节点。

本次是所有者明确授权的两跳范围扩展，优先于旧规范中排除多跳链的描述；不增加链嵌套、来源节点跨刷新匹配、链式配置反向导入或临时工作台链编辑。

## 来源管理与私人订阅

在“来源管理”页新建文本来源，粘贴 URI、Base64 或含内联节点的 YAML，选择格式后点击“解析并保存来源”。正文必须完整解析且至少包含一个有效节点；错误不会覆盖旧来源，也不会静默跳过失败节点。来源列表不返回正文或节点凭证，打开编辑时按需读取。已保存节点只读，勾选后可复制为独立本地节点；未提交的正文编辑不会改变已保存快照。

在“来源管理”页点击“新建远端来源”，填写公网 HTTPS URL、输入格式及可选 User-Agent、Accept、Authorization，点击“保存远端来源”。配置立即保存并安排抓取，首次失败仍可编辑或重试；只有成功快照存在时才能新加入方案。来源类型创建后不切换，节点可复制为独立本地节点。

URL 和 Authorization 默认遮罩，编辑时按需读取。未修改的地址和请求头不提交，清空请求头使用明确按钮。列表只返回名称、类型、启用状态、节点数、成功／尝试时间、脱敏错误与刷新状态，不返回地址、认证或正文。状态自动刷新不会覆盖未提交表单；快照改变时清除旧节点勾选，避免复制到更新后不同位置的节点。

远端抓取只接受 HTTPS，可显式指定 HTTPS 端口；检查全部 A／AAAA、IP 字面量及实际连接地址，拒绝非公网地址。TLS 验证原始域名或 IP 身份，域名保留 SNI；不跟随任何 3xx，不使用环境代理，不抓取正文中的 URL。请求只允许配置上述三个头，不开放 Host、Cookie、转发头或关闭证书校验的设置。支持 identity、gzip、deflate、br；接收与解压正文各限 4 MiB，DNS、连接、读取和解压共限 15 秒，超时真实取消。完整解析至少一个节点后才接受快照，转换沿用唯一 Worker 和 5 秒时限。

新建、修改 URL／请求头／格式、重新启用远端来源时自动刷新一次；应用启动安排一轮，此后全局每 6 小时顺序刷新。手动“刷新远端来源”与自动刷新采用同一接受规则，重复请求合并，同来源不并发，待刷新 ID 最多 100 项。抓取后等待 Worker 空闲，不因繁忙重复下载；实际失败不无限重试，不重放停机期间错过的周期。

来源 revision 只表示人工配置版本，后台成功／错误写回都检查 revision、存在性和启用状态。刷新成功在事务内替换快照并递增相关方案 revision，保留旧产物直到各格式成功替换；失败保留旧快照、旧产物及真实成功时间，显示最近错误，不设置陈旧停发期限。人工改 URL／请求头／格式则立即清除旧快照与相关产物；启停、删除继续立即使旧产物失效。已引用来源暂时没有成功快照时阻断生成，不静默跳过。

在“订阅方案”页按顺序加入文本／远端来源和本地节点。每个输入只引用一次，来源按其正文顺序展开，不对内容去重。停用输入不参与生成，删除输入会同时移除方案引用。输入组合后、筛选前限制 2,000 节点及 4 MiB；最多保存 100 个来源和 100 个方案。

名称包含／排除使用区分大小写的字面匹配，空值不限制；先筛选、后添加固定前后缀。URI／Base64 共用一组协议筛选，Mihomo、sing-box、Xray 分别有自己的协议筛选，同一内核完整配置和片段共用设置。默认包含六类协议，不会替 Xray 自动排除不支持的节点。默认启用 URI／Base64，完整配置端口为 1080。

| 地址中的格式                   | 内容                        |
| ------------------------------ | --------------------------- |
| `uri`、`base64`                | URI 列表及其同批 Base64     |
| `mihomo`、`mihomo-proxies`     | Mihomo 完整配置／节点片段   |
| `singbox`、`singbox-outbounds` | sing-box 完整配置／节点片段 |
| `xray`、`xray-outbounds`       | Xray 完整配置／节点片段     |

保存后自动生成。页面分别显示各格式的生成时间、节点计数、诊断和可读状态，已发布内容可预览、复制和下载。上方未提交的编辑不会改变下方已发布内容。格式失败独立显示，不影响其他目标；URI／Base64 同时启用时必须同批、同事务替换，Base64 超限时整对均不替换。只启用 URI 时仍可使用未超限的 URI。

人工修改节点、来源内容、引用顺序、筛选、输出设置或启用状态，会在同一事务内递增关联方案 revision 并删除旧产物，随后生成。删除立即失效；零节点报错，不生成空配置。旧生成的成功或错误都不能写回新 revision。手动“更新订阅”只重建已保存设置，不改变它们；失败保留原本可读的最近成功结果，但不会恢复人工修改已经清除的内容。

每方案有一把路径令牌和一把查询 `key`，均为 32 字节随机值，数据库只存 SHA-256 摘要。创建／重置后一次性显示 `PUBLIC_ORIGIN/s/<token>/<format>?key=<key>`，完整地址对管理员可见；离开页面或退出后清空，遗失需重置。路径令牌防止短路径被遍历；`key` 为额外授权。重置后旧路径和旧 `key` 立即 404，已有正文保留，不主动重建；停用方案的地址也立即 404。升级前已有、尚未重置的方案没有 `key`，仍可按旧地址 `/s/<token>/<format>` 读取。正常重启保留摘要。已下载的配置不能远程撤回，持有完整地址的人可以读取该方案启用的格式。

客户端 GET／HEAD 不需 Cookie、Origin 或自定义请求头，只读取已发布结果，绝不解析、渲染或抓取。无效令牌、停用方案或未启用格式返回 JSON 404；有效但无结果或引擎版本不匹配返回 503。HEAD 同权无正文，所有响应均为 `private, no-store`。管理预览通过已登录接口读取，无需再次取得明文令牌。

后台用最多 100 项、按方案 ID 合并的内存集合调度唯一 Worker，繁忙时等待其空闲；实际失败记录后不无限重试。重启后安排缺失／旧引擎产物重建。当前显式引擎标识为 `p4-2`，转换器、组合规则或模板语义改变时必须递增 `ENGINE_VERSION`。不以产物 revision 必须等于当前 revision 作为读取条件。

| 方法与路径                                     | 行为                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/sources?page=0`                      | 每页 25 项来源摘要                                                                                                                   |
| `POST /api/sources`                            | 文本：`{ name, enabled?, format, text, kind?:text }`；远端：`{ kind:remote, name, enabled?, format, url, headers? }`，保存后安排抓取 |
| `GET/PATCH/DELETE /api/sources/:id`            | 按需读取；PATCH 为 revision 加允许的来源字段，DELETE 为 `{ revision }`                                                               |
| `GET /api/subscriptions?page=0`                | 每页 25 项方案摘要，不包含令牌                                                                                                       |
| `POST /api/subscriptions`                      | 保存名称、启用状态、有序 inputs、formats、名称筛选／前后缀、listenPort、各目标 protocols；返回方案和一次性 urls                      |
| `GET/PATCH/DELETE /api/subscriptions/:id`      | 详情含各格式状态；PATCH 为 revision 加允许的方案字段，DELETE 为 `{ revision }`                                                       |
| `POST /api/subscriptions/:id/generate`         | `{ revision }`，合并安排生成并返回 202                                                                                               |
| `POST /api/subscriptions/:id/reset-token`      | `{ revision }`，仅返回一次新 urls                                                                                                    |
| `GET /api/subscriptions/:id/artifacts/:format` | 登录后读取可用正文、时间、计数与诊断                                                                                                 |
| `GET/HEAD /s/:token/:format`                   | 客户端只读分发；新地址带 `?key=`，未重置的旧方案可不带                                                                               |

远端 headers 为 `{ userAgent?, accept?, authorization? }`，默认 User-Agent 为 `SubMeld/1.0.0`、Accept 为 `*/*`、Authorization 为空。PATCH 省略秘密表示保持，headers 中的 null 表示明确清空；不接受类型切换。`POST /api/sources/:id/refresh` 接收 `{ revision }`，返回 202 和当前来源状态；仅已启用远端来源可刷新。详情中的 `savedAt`、`lastAttemptAt`、`error` 可为 null，`refresh` 为 idle／queued／running。

输入引用为 `{ kind: node|source|chain, id }`，protocols 包含 `uri/mihomo/singbox/xray` 四组协议数组。结构与响应校验见 `server/shared/subscriptions.ts`。部分更新中省略 enabled 会保留原状态；所有管理变更沿用同源保护及 revision 冲突规则，409 时页面保留未保存编辑。

## API 与运行边界

管理网页与接口同源；管理 `POST`／`PATCH`／`DELETE` 必须携带有效 JSON Content-Type、`X-SubMeld-Request: 1` 和与 `PUBLIC_ORIGIN` 匹配的 Origin，除登录外还须有有效会话。不开放跨源 CORS。

| 方法与路径                  | 行为                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`      | `{ password }`，登录并设置会话 Cookie                                                                   |
| `GET /api/auth/me`          | 当前会话状态                                                                                            |
| `POST /api/auth/logout`     | 正文 `{}`，立即撤销当前会话                                                                             |
| `POST /api/convert/parse`   | `{ format: auto\|uri\|base64\|yaml, text }`，返回条目、诊断及计数                                       |
| `POST /api/convert/produce` | `{ items }`，校验编辑后的 NodeDraft 和显式排除标记，返回 URI／Base64                                    |
| `GET /api/nodes?page=0`     | 每页 25 项摘要与 total；零起始页码                                                                      |
| `POST /api/nodes`           | `{ drafts }`，原子保存一个或多个节点，返回摘要                                                          |
| `GET /api/nodes/:id`        | 完整节点、modelVersion 和 revision                                                                      |
| `PATCH /api/nodes/:id`      | `{ revision, enabled?, changes? }`，字段白名单增量更新，协议不可更改                                    |
| `DELETE /api/nodes/:id`     | `{ revision }`，删除指定版本                                                                            |
| `POST /api/nodes/load`      | `{ ids }`，按请求顺序载入启用节点；任一无效则整批失败                                                   |
| `POST /api/convert/render`  | `{ items, target: mihomo\|singbox\|xray, listenPort?:1080 }`，返回 target/full/nodes/diagnostics/counts |
| `GET /healthz`              | 仅进程存活，不能代表转换或部署验收                                                                      |
| `GET /source.tar.gz`        | 当前构建对应源码及构建材料                                                                              |

条目包括 `nodeIndex/draft/excluded/diagnostics`；无法解析的条目保留 `draft: null`。诊断为 `level/code/nodeIndex/field?/message`，全局诊断使用 `nodeIndex: -1`。结构定义见 `server/shared/contracts.ts`。输入是业务 NodeDraft，不是上游私有 payload 或新的公共节点交换格式。

节点更新 changes 使用 NodeDraft 的非协议字段；auth.uuid、auth.password、protocolOptions.obfsPassword 省略表示保持，字符串表示替换，null 表示明确清空。合并后按原协议完整校验，不接受遮罩作为保留标记。

统一错误体是 `code/message/diagnostics?`。404 为节点不存在，409 为修订冲突；400 为无效请求，401 未登录，403 同源校验失败，413 超限，415 不支持的正文编码，422 转换失败，429 登录节流，503 Worker 繁忙或不可用。未知 API／订阅路径为 JSON 404，不回退 HTML。

输入／解码正文限制 4 MiB、2,000 节点、结构深度 32。原始 JSON 请求上限 26 MiB，用于覆盖转义包装，实际文本和节点正文仍受 4 MiB 限制；不接受压缩管理请求。URI 与 Base64 各自限制 4 MiB，只有 Base64 超限时仍可使用 URI。

一个转换 Worker，即时转换繁忙返回 503；后台订阅按方案 ID 合并到最多 100 项的内存集合。转换超过 5 秒真正终止并重建。Worker 分离计算，不是任意代码沙箱。管理会话只存内存摘要，固定 24 小时，最多 64 个；重启全部失效。登录按全局 5 分钟最多 10 次尝试，并限制同时一次密码验证，不信任转发 IP。

管理响应和输出为 `no-store`；节点信息以文本呈现；无第三方脚本。日志只记录固定路由模板、状态和错误码。数据库 schema 6 包含 settings、nodes、chains、sources、subscriptions、subscription_inputs、artifacts。节点、来源 URL／认证／文本／快照和产物均为明文，订阅路径令牌与 `key` 仅保存摘要；临时工作台正文不持久化。独立 SQLite 维护锁防止同一数据目录同时运行多个应用或维护命令，进程退出后由系统释放。

## Linux 单容器部署

设置 `.env` 中的 `PUBLIC_ORIGIN=https://你的实际域名`。已有反向代理负责 HTTPS，并转发到宿主 `127.0.0.1:3000`；禁止代理缓存管理响应、记录请求正文、Cookie 或 Authorization。

```sh
docker compose build
docker compose run --rm submeld node dist/server/cli.js init
docker compose up -d
```

Compose 使用一个应用、一个命名数据卷、非 root 用户、只读根文件系统、受限临时目录，内存从 768 MiB 起测；不挂 Docker socket。数据目录 0700，数据库、锁及 WAL 等文件 0600，umask 077。初始化时不可同时运行服务。

P3 部署时，反向代理对 `/s/` 必须关闭缓存和完整访问路径记录，包括错误日志中的 URI；不要将其交给访问分析服务。应用只记录路由模板，不记录令牌。以下 Nginx 片段可并入已有 HTTPS 站点，其他代理需设置等价规则：

```nginx
location ^~ /s/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_cache off;
    access_log off;
    error_log /dev/null;
    add_header Cache-Control "private, no-store" always;
}
```

**P1／P2 期间未运行成功的验收：** Docker Desktop 引擎返回无法启动，因此镜像构建、容器内权限、资源预算及 HTTPS 反向代理路径均待在实际部署环境执行。配置文件和 Windows 测试通过不替代这些检查。

## 本次 Linux 内网 HTTPS 验收

2026-09-17 在 `ssh host-vps-scripts` 对应的 Debian 13.6 / x86_64 主机部署 v1.0.0，Docker Engine 29.8.1、Compose 5.5.1、Nginx 1.26.3。源码与 Compose 位于 `/opt/submeld-p4/source`，Compose 项目为 `submeld-p4`，独立数据卷为 `submeld-p4_submeld-data`；未迁移本机个人运行数据。

内网入口为 <https://192.168.5.65>。本次使用测试 CA 签发的 IP 证书，服务证书到期时间为 **2026-10-01 03:00 UTC**。测试客户端显式指定 CA 校验证书及 IP 身份；没有修改系统全局信任，也没有放宽远端来源的证书或公网地址校验。通过 SSH 取回公开 CA 和读取一次初始化密码：

```sh
scp host-vps-scripts:/opt/submeld-p4/tls/ca.crt .
ssh host-vps-scripts 'cat /opt/submeld-p4/admin-password'
```

管理员密码文件在服务器为 0600，网页没有默认密码。证书仅用于本次内网验收；长期使用需在到期前换用合适的证书。

Linux 镜像构建通过完整 `pnpm check`：92 项工程测试及三种锁定内核检查。实际 HTTPS 请求验证了网页及构建资源、Secure／HttpOnly／SameSite 会话、同源写入保护、八格式发布、URI／Base64 字节一致、GET／HEAD、防缓存、人工修改失效、令牌即时撤销、重启后会话失效及数据／令牌保留。容器以 UID 1000 运行，数据目录 0700、数据库与辅助文件 0600，根文件系统只读，宿主仅绑定回环 3000，内存限额 768 MiB；空闲单次观测约 57 MiB，不作为性能承诺。

部署中的真实 SourceFetcher 对公网 HTTPS 页面完成 DNS／TLS／读取并返回 `SOURCE_HTML_REJECTED`；私网 URL 被拒绝，订阅读取没有触发刷新。Nginx 站点关闭访问日志和含 URI 的错误日志，应用日志已核对未包含密码、测试正文或私人路径。测试创建的来源和方案已删除，服务保持运行。仅清理本次构建缓存，保留镜像、容器和数据卷。

这验证了公网 HTTPS 传输及错误内容拒绝，尚不等同于真实订阅内容闭环。请在“来源管理”录入受控公网 HTTPS 订阅，验证手动／自动更新，再记录实际 v2rayN 导入、连接及客户端／内核版本；公网域名入口未验收。

## 密码重置、升级和备份

本地开发停机后执行 `pnpm admin:reset-password --dev`。容器部署执行：

```sh
docker compose stop
docker compose run --rm submeld node dist/server/cli.js reset-password
docker compose up -d
```

密码只从隐藏终端输入或标准输入读取，不作为命令行参数。维护命令遇到活动的数据目录会拒绝执行。

升级前停止应用并备份整个数据目录／数据卷，不能在运行中只复制主数据库文件。离机备份使用已有可信工具加密。使用同一数据卷顺序迁移；迁移失败停止启动，不删卷重建。回退使用兼容数据库或匹配版本的停机备份。P1 schema 1、P2 schema 2、P3 schema 3 顺序升级到 P4 schema 4，再至 schema 5、schema 6，不需重新初始化或重置管理员密码；schema 4 保留文本来源 ID、快照、方案引用与令牌摘要，允许远端来源尚无成功快照；schema 5 增加可空的订阅 `key` 摘要。schema 6 新增两跳链及订阅链引用，保留所有旧引用顺序、来源快照、路径令牌和 `key` 摘要，后续重启不重跑旧迁移。升级前仍须停机备份；运行旧版程序需恢复匹配版本的数据备份。回退 P1／P2／P3 需恢复匹配的停机备份。恢复后重新登录，并重置每个方案的私人地址；恢复历史数据库可能恢复当时的令牌授权，不能把恢复视为自动撤销。

## 验证命令与实际结果

| 命令                | 用途                                                       |
| ------------------- | ---------------------------------------------------------- |
| `pnpm check`        | 格式、lint、类型、构建、转换／HTTP／存储测试及锁定内核检查 |
| `pnpm test`         | 构建后运行 Node.js 回归                                    |
| `pnpm test:cores`   | 对已构建转换器执行三种锁定内核配置检查                     |
| `pnpm test:browser` | 构建后运行隔离浏览器的桌面与窄屏流程                       |
| `pnpm build`        | 构建固定上游、网页、服务端及对应源码包                     |
| `pnpm format`       | 格式化工程文件，排除原始文档与上游源码                     |

浏览器测试默认使用 Playwright Chromium，可先执行 `pnpm exec playwright install chromium`。也可通过 `PLAYWRIGHT_CHANNEL=msedge` 使用已安装 Edge（PowerShell：`$env:PLAYWRIGHT_CHANNEL='msedge'`）。测试创建临时数据库和隔离浏览器上下文，不使用个人配置；产物位于忽略的 `.cache/browser-results`。

**2026-09-17 两跳链式代理验证：** Windows x64 / Node.js 24.6.0 上 `pnpm check` 通过，含 105 项工程测试、格式／lint／严格类型检查、构建及三种锁定内核配置检查。另通过 7 组隔离回环连通与断链检查：三个内核的 SS → SS，以及 Mihomo／sing-box 的 SS → Hysteria2、SS → TUIC；验证两跳实际到达目标，停止前置并重启客户端后请求失败，没有绕过链。测试使用公开测试凭证及自签名证书夹具，不使用个人节点。

Edge 桌面和 390px 窄屏的 36 项浏览器回归已覆盖：32 项原有流程在完整运行中通过，4 项新增链式流程修正异步列表等待与定位后定向复测通过，新增流程包含跨页选择、交换顺序、订阅发布、下载、成员修改、删除保护、409 编辑保留及状态刷新。schema 5 → 6 的数据／快照／引用／令牌保留、旧版本升级和重复启动均通过隔离数据库验证。本次没有新增 Linux 部署验收；真实 v2rayN 的链式配置导入、订阅更新和连接仍待验证，不将回环测试扩展为所有协议组合或客户端均兼容。

P4 在 Windows x64 / Node 24.6.0 上通过 `pnpm check`：92 项工程测试、格式／lint／严格类型检查、构建及三种锁定内核配置检查通过。Edge 桌面与 390px 窄屏共 32 项浏览器测试通过（30 项首轮通过，另外 2 项修正 option 元素断言后复测通过）。新增覆盖真实 TLS 连接绑定、DNS／IP 分类、证书身份、压缩限额、DNS／握手／读取阶段取消、刷新调度、失败保留、迟到响应、schema 3 升级、远端页面及秘密增量更新。浏览器的远端使用隔离传输替身；真实公网订阅内容和 v2rayN 的 P4 更新／连接仍待所有者通过管理页录入来源后验证。

P3 基线在 Windows x64 / Node 24.6.0 上通过 `pnpm check`：74 项工程测试（含新增 18 项 P3 测试）、格式／lint／严格类型检查、构建及三种锁定内核配置检查均通过。使用 `PLAYWRIGHT_CHANNEL=msedge` 执行 `pnpm exec playwright test`，桌面和 390px 窄屏共 24 项浏览器测试通过（含新增 8 项 P3 流程）。覆盖文本来源保存／复制、独立协议筛选、订阅更新、旧成功／错误拒绝写回、成对发布、只读 GET／HEAD、地址撤销、schema 2 升级／恢复、引擎更换、409 编辑保留和迟到响应清理。剪贴板仍用替身核对调用内容，不宣称已验收系统剪贴板权限。

P2 基线在本次 Windows x64 / Node 24.6.0 环境通过 56 项转换／HTTP／存储测试，以及 Edge 桌面和 390px 窄屏的 16 项浏览器测试。覆盖 P1 路径、本地粘贴／上传解析导入、跨页选择、重复名称新增、保存错误定位、取消不落库、迟到文件读取、节点保存后刷新、增量秘密更新、双页面冲突、启停删除、追加和排序、三目标完整配置／片段下载、修改后失效、目标独立失败及迟到响应丢弃。复制按钮使用剪贴板替身核对调用内容，不宣称已验证系统剪贴板权限。

测试内核首次使用从官方固定发布下载，核对 `tests/kernels.lock.json` 中的 SHA-256，缓存到忽略的 `.cache/kernels`；每次从校验后的归档提取并核对版本，不用系统 PATH 中的未知内核。需要首次联网及 tar，Linux 检查 Xray ZIP 还需要 unzip（镜像构建阶段已安装，生产阶段不包含）。锁覆盖 Windows x64／Linux x64，P2／P3 只实际运行 Windows x64，P4 另已通过 Linux x64 容器检查；不支持的平台或下载／校验失败会明确失败，不跳过。内核和生成夹具不进入生产镜像或源码包。此前基线的 Mihomo／sing-box 各 35 个节点、Xray 30 个节点完整配置通过各自配置检查，覆盖现有传输、加密、指纹及协议选项；这不代表真实连接成功。

P2 人工验收步骤：保存两条受控节点，停机升级并重启，重新登录后确认参数；分别下载三目标完整配置，在实际 v2rayN 支持的自定义配置入口选择相应内核导入。先记录是否接受，再单独记录实际连接结果、v2rayN 版本和其使用的内核版本；仅节点片段须合并进相应已有配置。没有实际导入的目标继续标为未验证。

P3 人工验收步骤：停机备份后使用同一数据目录升级，确认原节点参数保留；建立“文本来源＋本地节点”方案，将一次性 URI／Base64 地址导入实际 v2rayN，修改节点或方案后至少更新一次。分别记录地址接受、节点更新和连接结果；验证重置地址后旧地址失败、新地址可用。记录客户端／内核版本和部署架构。2026-09-17 项目所有者确认本机手动测试及 v2rayN 实际导入、连接通过；具体格式、客户端／内核版本及更新结果未单列，实际容器部署未确认。

计划验收客户端为 **v2rayN**。2026-09-17 项目所有者进一步确认实际导入和连接通过；已测协议、各目标与客户端／内核版本尚待补录。不将内核配置检查或笼统的通过反馈扩展为所有协议、目标及部署环境均已验收。

## 源码与许可

SubMeld 自有代码采用 AGPL-3.0-only。固定 Sub-Store 源码、许可证与适配说明见 [vendor/README.md](vendor/README.md)，固定提交与源码校验值见 `vendor/upstream.lock.json`。生产只运行受控转换包，不运行上游管理服务。

每次构建生成 `dist/submeld-source.tar.gz`，网页页脚提供下载。打包使用明确的源码目录与文件列表，排除运行数据、环境秘密、Git、依赖和缓存。发布镜像时须保留对应源码与构建材料，不能仅发布编译产物。

本次不创建 Git 提交或推送；按所有者确认在指定 Debian 主机进行内网 HTTPS 验收，未开放公网域名访问。
