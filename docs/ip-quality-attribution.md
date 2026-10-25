# IP 质量查询来源

SubMeld 的 IP 查询适配由 xykt / IPQuality 的数据库查询逻辑移植，原作者为 xykt 及项目贡献者，采用 GNU Affero General Public License v3.0。SubMeld 的对应源码及本说明随 `/source.tar.gz` 提供；许可证全文见项目根目录 LICENSE。

- 上游仓库：https://github.com/xykt/IPQuality
- 固定提交：`87397e2c3196ec796f5477c83343c2354df601ea`
- 脚本版本：`v2026-09-16`
- 参考文件：`ip.sh` 的 `db_*` 查询函数及 `ref/dnsbl.list`
- 本地适配版本：`xykt-2026-09-16-submeld-1`

移植部分包括作者聚合接口、IPinfo 演示接口、IPregistry 网页 Key 提取与脚本公开默认 Key、字段映射及各来源评分阈值。默认 Key 仅用于服务端请求，不在前端打包、响应或日志中输出。原脚本不随应用运行，不执行 Bash、安装依赖或上传报告。

SubMeld 的差异：查询目标由用户明确输入；各来源独立失败；缺失字段保留未知；核对上游回显 IP；网段滥用比例与单 IP 评价分开；DB-IP 网页 Key 不支持查询其他地址，因此只展示不支持状态；DNSBL 仅使用下面的明确子集，保留未知和失败状态，不沿用原脚本将异常响应视为干净的判断。

## DNSBL 规则来源

以下域名均来自该固定提交的原名单。仅查询，不发送举报、移除或修改名单请求。

| 名单 | 地址类型 | 域名 | 规则来源 |
| --- | --- | --- | --- |
| SpamCop | IPv4 | bl.spamcop.net | https://www.spamcop.net/fom-serve/cache/351.html |
| PSBL | IPv4 | psbl.surriel.com | https://psbl.org/howto/ |
| DroneBL | IPv4 | dnsbl.dronebl.org | https://dronebl.org/docs/howtouse |
| SEM-BLACK | IPv4 | bl.spameatingmonkey.net | https://spameatingmonkey.com/services |
| SEM-BACKSCATTER | IPv4 | backscatter.spameatingmonkey.net | https://spameatingmonkey.com/services |
| SEM-IPV6BL | IPv6 | bl.ipv6.spameatingmonkey.net | https://spameatingmonkey.com/services |

IPv4 正反测试地址为 127.0.0.2 与 127.0.0.1；SEM-IPV6BL 使用官方公布的对应 IPv4-mapped IPv6 测试名称。2026-10-25 实际查询 DroneBL 正测试记录得到 127.0.0.1，其他名单得到 127.0.0.2，反测试均为 NXDOMAIN。DroneBL 的测试返回码仅用于服务可用性检查，不直接作为普通查询的命中码。

除 DroneBL 外，目标命中码为 127.0.0.2；DroneBL 按官方分类码展示。多个返回码必须全部可解释才能确认为命中。超时、拒绝、未知返回码或正反测试失败均不解释为未命中。
