# Sub-Store 转换来源

固定提交：`ece585cdac30d6a6f25a2b8815ac1dde26414153`，仓库 https://github.com/sub-store-org/Sub-Store 。

`sub-store/` 保存原始转换目录、相关工具、官方入口、上游包说明和 AGPL 许可证。未修改这些上游文件。来源归档和关键转换文件的 SHA-256 记录在 `upstream.lock.json`；构建先核对关键文件。

`scripts/build-converter.mjs` 是全部构建适配：保留原来的 parse、produce、lastParse 及其辅助函数；去除应用服务与脚本导出；替换无副作用日志运行时、预处理和输出注册表。注册表仅开放六协议与内部 YAML 节点转交。输入分拆、YAML 和 Base64 由 SubMeld 的有界输入模块处理。继续使用上游必要规范化，不启动其后台或运行用户代码。

针对当前支持路径的构建补丁：

- Trojan 密码在 URI 中正确百分号编码。
- VMess JSON 分享结果带入明确的证书验证标记。
- TUIC 保留完整 ALPN 列表，认证字段只解码一次，避免破坏含百分号的密码。
- Trojan ALPN 兼容列表／文本表示。

协议正确性由字段断言、独立 URI／JSON 断言和回归共同验证，不能仅依赖上游自解析。生成的依赖清单位于忽略的 `dist/converter/build.json`。锁定的通用库按 Node 原生模块加载，避免 CommonJS/ESM 打包互操作副作用。

运行 `pnpm install --frozen-lockfile` 和 `pnpm build` 可从提交源码重建。运行时不下载代码。发布时一同提供本仓库对应版本源码与构建说明，不包含任何运行数据。
