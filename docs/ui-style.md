# SubMeld 界面规范

SubMeld 固定采用冷灰与蓝色的浅色界面。适用于 `/submeld/` 登录、管理页面、浮层、图表和浏览器 PNG 导出。Sub-Store 原生前端与服务端 Telegram 图片生成不属于此主题。

## 唯一视觉来源

[`web/tokens.css`](../web/tokens.css) 定义全部共享视觉常量，由入口先于公共样式加载。修改配色、字号、圆角或间距时，先修改这个文件，不在页面中另设一套常量。固定 `color-scheme: light`，不随系统明暗变化。

| 用途                     | Token                                                      | 基准                              |
| ------------------------ | ---------------------------------------------------------- | --------------------------------- |
| 页面 / 面板 / 次级背景   | `--bg` / `--surface` / `--surface-subtle`                  | `#F8FAFC` / `#FFFFFF` / `#F1F5F9` |
| 主文字 / 辅助文字        | `--text` / `--muted`                                       | `#0F172A` / `#475569`             |
| 主操作 / 悬停 / 选中底色 | `--primary` / `--primary-hover` / `--row-active`           | `#2563EB` / `#1D4ED8` / `#EFF6FF` |
| 分隔线 / 输入边界        | `--border` / `--control-border`                            | `#E2E8F0` / `#7C8BA1`             |
| 成功 / 警告 / 错误       | `--ok-text` / `--warn-text` / `--danger`                   | `#15803D` / `#B45309` / `#B91C1C` |
| 文字层级                 | `--text-title` / `--text-lg` / `--text-base` / `--text-xs` | 24 / 18 / 14 / 12px               |
| 控件 / 面板 / 弹窗圆角   | `--radius` / `--radius-panel` / `--radius-dialog`          | 8 / 12 / 16px                     |

色值参考 [Radix 颜色用途分层](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)，界面层级参考 [Linear 的整理思路](https://linear.app/now/behind-the-latest-design-refresh)。不依赖这些产品的组件库。

## 页面与组件

- 页面按标题与说明、主要操作、筛选、内容排列。标题 24px，正文 14px，辅助文字至少 12px；使用系统中文字体，配置文本使用 `--mono`。
- 桌面侧栏 224px，内容留白 24px；800px 以下保留顶部品牌和底部导航，内容留白 16px。手机底部考虑安全区。现有组件断点保留，媒体查询中的宽度不是颜色或主题配置。
- 间距使用 `--space-*` 的 4px 刻度。数据列宽、SVG 坐标、导出图片尺寸等内容几何留在组件中，不为了集中而引入无意义 token。
- 实心蓝色用于主要提交操作；普通按钮使用中性色，链接使用蓝色，危险操作使用红色。导航、页签和筛选的选中态使用浅蓝背景；不把所有操作都画成主要按钮。
- 面板用细分隔线，菜单、弹窗和抽屉用各自的阴影 token。公共控件和状态样式放在 `web/style.css`，组件的 scoped 样式只负责自身布局和特有展示。
- 表单字段上方放标签；帮助文字放在字段旁；复选框与文案横排，选中项保留可辨认的勾选标记。移动端按空间堆叠，宽报告只在自身容器内滚动。
- 保留悬停、选中、禁用、错误、加载和键盘焦点。焦点不被边界裁掉；动画只用于颜色、边框和阴影，并遵守 `prefers-reduced-motion`。

## 状态与报告

状态 token 表达已有数据含义，不改变业务结论。测得数值、完成执行不等于平台解锁；未知、不支持、目标异常、失败与过期信息始终保留文字说明。

浏览器报告与 PNG 导出共用状态配色映射，Canvas 从计算样式读取颜色与 `--export-*-font`。不要在 TypeScript 中复制主题色值。脚本返回的 `#RRGGBB` 是结果数据，保留原色；根据其相对亮度选择 `--data-on-light` 或 `--data-on-dark`，这两个 token 固定为黑白以保证任意结果底色的最大对比度。

## 后续改动与验收

1. 先复用语义 token。只有出现独立的视觉用途才新增 token，不以页面名或旧色值命名。
2. 修改公共样式或相关组件，删除被替代的重复声明。颜色、阴影和共享字体、圆角、间距不得重新写死在消费位置；`transparent`、`currentColor` 和动态结果颜色除外。
3. 检查普通文字 4.5:1、必要控件与焦点标识 3:1 的对比度，依据 [WCAG 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)及[非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。装饰分隔线不作为输入边界使用。
4. 运行项目要求的 `pnpm check` 和受影响浏览器回归，使用隔离官方上游。检查桌面、390px 窄屏及涉及的断点，并查看截图和 PNG 输出。验证布局、功能与真实业务结果分别记录。
