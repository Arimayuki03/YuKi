# YuKi DESIGN.md — 视觉系统契约（2026-08 视觉升级）

> 本文件是本次「系统性 UI 视觉升级」的实现契约。所有颜色、字号、圆角、阴影、间距、动效必须回溯到这里的令牌。
> 硬约束：只改视觉层；动画只用 transform/opacity；支持 prefers-reduced-motion；复用既有类名与皮肤系统。

## 0. 设计方向

气质参考 **Linear / Vercel / Arc**：
- 中性灰阶做骨架（近无色相），品牌色只做点睛（主按钮、激活态、焦点环、进度）
- 半透明描边 + 多层柔和阴影替代生硬分割线
- 大标题收紧字距、层级拉开；辅助文字弱而不糊
- 克制的渐变背景 + 微噪点质感；控件一律小圆角、胶囊只留给 chip/徽章

## 1. 色彩令牌

### 1.1 中性色（浅色）
| 令牌 | 值 | 用途 |
|---|---|---|
| `--md-surface` | `#F7F7F8` | 应用底 |
| `--md-surface-container` | `#FFFFFF` | 卡片/侧栏面板 |
| `--md-surface-container-high` | `#F0F0F2` | 内嵌输入底/hover 面 |
| `--md-on-surface` | `#19191C` | 主文字 |
| `--md-on-surface-variant` | `#70707A` | 次级文字 |
| `--md-outline` | `#8B8B94` | 高对比描边（勾选环等） |
| `--md-outline-variant` | `rgba(17,17,20,0.10)` | 细腻半透明分割线 |

### 1.2 中性色（深色，html.dark）
| 令牌 | 值 |
|---|---|
| `--md-surface` | `#0C0D10` |
| `--md-surface-container` | `#14151A` |
| `--md-surface-container-high` | `#1D1F25` |
| `--md-on-surface` | `#ECEDEF` |
| `--md-on-surface-variant` | `#9B9EA7` |
| `--md-outline` | `#63666F` |
| `--md-outline-variant` | `rgba(235,236,240,0.10)` |

### 1.3 强调色规则
- 六套内置主题色保留但重调值为现代观感（默认绿 → 祖母绿 emerald 系）。
- **一切派生色用 `color-mix(in srgb, var(--md-primary) N%, …)` 现场计算**（容器底、hover 染色、焦点环、透明度梯度），禁止硬编码假设默认绿 —— 保证设置页自定义取色器照常生效。
- `--md-secondary-container` 改为中性灰面（tonal 按钮/未激活 chip 底），不随主题色变。
- 语义色 error 保持红系；成功/警示沿用现有 asset 色。

## 2. 排版

字体栈不变（MiSans 优先）。基准 14px。
| 层级 | 规格 |
|---|---|
| 页面大题（detail-title） | clamp(26px,3vw,38px) / 700 / ls -0.02em / lh 1.15 |
| 卡片大题（tool-card-title） | 15px / 600 / ls -0.01em |
| 区块小节（set-group、my-sec-title） | 13px / 600 |
| 正文 | 14px / 400 / lh 1.5 |
| 辅助说明（tip-line） | 12.5px / 400 |
| 徽章/meta（vod-remarks、状态徽标） | 11–12px / 500 |
| 数字强调（my-stat-value、评分） | tabular-nums / 700 |

规则：标题一律负字距；正文行高 ≥1.5；meta 信息用 on-surface-variant 弱化但不低于 4.5:1 对比。

## 3. 圆角 / 描边 / 阴影

圆角阶梯（新令牌，组件按语义取用）：
`--radius-sm:8px · --radius-md:10px · --radius-lg:14px · --radius-xl:18px · --radius-pill:999px`
- 输入框/下拉/ep-btn → `--radius-md`；卡片/tool-card → `--radius-lg`；弹窗/浮层 → `--radius-xl`；
  chip/页签/徽章/snackbar 胶囊 → pill 或就近值
- 描边统一 1px `var(--md-outline-variant)`（半透明），深浅色皆适配壁纸

阴影阶梯（多层柔和，新令牌）：
```
--shadow-xs: 0 1px 2px rgba(0,0,0,.05)
--shadow-sm: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.05)
--shadow-md: 0 2px 4px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.08)
--shadow-lg: 0 4px 12px rgba(0,0,0,.08), 0 24px 56px rgba(0,0,0,.14)
```
深色模式整体加深（黑底上阴影需更高 alpha 才可感知）。悬浮态 = 抬升 translateY(-2~-3px) + 阴影升一档 + 描边染 primary。

## 4. 背景 & 质感

- 应用底：`body` 上双层背景 —— 纵向微渐变 + 两角极淡 primary 径向光（≤5% alpha）；壁纸模式下被 JS 内联背景图自然覆盖，无需分支。
- 噪点：`html::before` 固定层铺 SVG feTurbulence data-URI，opacity 浅色 .03 / 深色 .05，pointer-events:none；壁纸模式自动被 body::before 盖住。
- 毛玻璃/壁纸两套既有系统（html.glass-on、body.has-wallpaper）逻辑不动，仅随新令牌换肤。

## 5. 间距

8pt 网格：4 / 8 / 12 / 16 / 20 / 24 / 32。视图 padding 24px、卡片内边距 20px、工具条 gap 10px、网格 gap 16~20px。消除 6/9/11/13/14px 等奇数散值（徽章内边距等微观处允许 4/6px）。

## 6. 动效

令牌：
```
--ease: cubic-bezier(0.4, 0, 0.2, 1)      /* 全局唯一缓动 */
--dur-fast: 150ms · --dur-base: 200ms · --dur-slow: 300ms
```
- 视图切换：viewIn fade + translateY(10px)，250ms
- 卡片入场：fade + translateY(12px)，320ms，nth-child stagger 30ms 封顶 10 张（沿用既有 JS 重触发手法）
- 悬浮抬升：卡片 -2~-3px + 阴影升档，200ms；按压回落 scale(.98) 即时
- 只动 transform/opacity；骨架屏脉冲用 opacity 呼吸（不用 background-position 扫光）
- `@media (prefers-reduced-motion: reduce)`：全局关闭 animation/transition（含既有 hk-pulse 等）
- `html.no-anim`（设置开关）行为保持

## 7. 加载体验

- 网格容器空态（`.vod-grid:empty` 等）显示 CSS 骨架占位块（封面比例灰块 + 文本条），数据渲染后自然消失，零 JS。
- 既有 spinner（loadingToast/search-status）保留但换新配色与圆角；blocking 遮罩行为不变。

## 8. 无障碍

- `:focus-visible` 统一 2px primary 光环保留
- 深浅色正文对比 ≥ 4.5:1；on-surface-variant 仅用于辅助文本
- 动画全部尊重 reduced-motion 与应用内动画开关

## 9. 禁改清单（安全边界）

- 类名、DOM 结构、JS 业务逻辑与数据流
- 皮肤系统挂钩：`html.dark / [data-color] / .glass-on / .glass-blur / .glass-switching / .no-anim`、`body.has-wallpaper / [data-dim] / .frameless / .nav-collapsed`
- 布局度量：侧栏宽 190/64、view 顶距 48、detail 吸顶数学（--tabs-stick-top）、content-visibility 性能优化、T54 毛玻璃下动画禁用规则
- 设置页缩放（zoom/_applyTextScale）联动
