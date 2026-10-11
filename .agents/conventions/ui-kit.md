# ModelDock Web UI Kit — 使用规范

> 适用范围：`src/gateway/ui.ts`（桌面控制台）、后续任何 ModelDock Web 界面。
> 组件 CSS/JS 的唯一事实来源是 `src/gateway/ui.ts` 内嵌样式与脚本；本文件是**使用规范**（什么场景用什么、不许怎么做）。
> 改组件本身 = 改 ui.ts + 同步更新本文件。原型评审稿见会话产物 `/tmp/modeldock-ui-kit/*.html`（不进 git）。

## 1. 令牌（设计令牌）

全站只经 CSS 变量取值，**禁止写死**字号/圆角/颜色/间距/阴影/z-index。主题相关色（bg/card/text/muted/border/accent/ok/warn/err/direct-*、shadow-*）在 `:root`（暗色）与两个 light 分支（`[data-theme="light"]` + `prefers-color-scheme` 媒体查询）**三处同步定义**；新增主题无关令牌只放 `:root`。

| 组 | 令牌 |
|----|------|
| 字号 | `--fs-xs 12 / --fs-sm 13 / --fs-md 14 / --fs-base 15 / --fs-lg 17 / --fs-xl 18` |
| 圆角 | `--r-sm 8 / --r-md 10 / --r-lg 14 / --r-full 999` |
| 间距 | `--sp-1 4 / --sp-2 8 / --sp-3 12 / --sp-4 16 / --sp-5 20 / --sp-6 24` |
| 控制高度 | `--h-sm 28 / --h-md 34 / --h-lg 40` |
| 阴影 | `--shadow-sm`（卡内浮起）/ `--shadow-md`（下拉/toast）/ `--shadow-lg`（弹窗） |
| 其他色 | `--star`（默认星标琥珀，主题无关） |
| 层级 | `--z-sticky 35 / --z-fab 40 / --z-toast 50 / --z-pop 70 / --z-modal 100`（一切弹层=modal，无 60 档） |
| 其他 | `--scrim`（遮罩）、`--dur .15s`（过渡）、`--mono`（等宽栈） |

## 2. 字级约定（对齐原版，评审定稿）

| 元素 | 字号 |
|------|------|
| 正文 / 服务名 / 弹窗标题以下 | 15px（`--fs-base`） |
| **输入框 / 下拉 / 文本域**（基础层已统一） | **13px（`--fs-sm`）** |
| 按钮（`.btn`，含弹窗 foot 主按钮） | 14px（`--fs-md`） |
| 行内小按钮 `.btn.small` / 表格 / 描述 / 字段 label | 13px（`--fs-sm`） |
| 徽标 `.pill` / 注释 / 密集表格输入 / seg 紧凑态 | 12px（`--fs-xs`） |

按钮略大于输入框是**有意的主次关系**，勿改平。

## 3. 色彩语义（评审定稿）

| 颜色 | 含义 | 用在哪 |
|------|------|--------|
| 绿 `--ok` | **开启 / 使用中 / 正常 / 已接入** | Switch 开启态、`.pill.ok`、成功 testline/toast |
| 蓝 `--accent` | 主操作 / 链接 / 焦点 | `.btn.primary`、seg 选中态、链接、focus 轮廓 |
| 琥珀 `--warn`/`--direct-*` | 警告 / 独立直连（救援通道） | `.pill.warn`、`.btn.direct` |
| 红 `--err` | 危险 / 错误 | `.pill.err`、`.btn.danger`/`.ghost-danger`、错误提示 |
| 灰 | 关闭 / 次要 / 未接入 | Switch 关闭态、`.pill`/`.pill.dim` |

- Switch 开启态固定绿色（**不是** accent 蓝）。
- pill 只做**状态展示**（可点击展开面板的除外，如「定时」）；**开关一律用 Switch**，禁止再用 pill 文字当开关。
- 「正在使用」等状态 pill 内不加对号图标；「已接入」保留锁 + 对号（历史约定；锁/链/对号 2026-10 起一律走 SVG `icon()`，不再是 emoji 字形）。

## 4. 组件清单与用法

### 已落地（ui.ts 可直接用）

| 组件 | 类名/入口 | 场景与要点 |
|------|-----------|-----------|
| 按钮 | `.btn` + `primary`/`small`/`danger`/`ghost-danger`/`direct` | 主操作蓝底；破坏性列表操作用 ghost-danger；独立直连琥珀 |
| 状态徽标 | `.pill` + `ok/err/warn/dim` | 只读状态；可点击展开面板的加 `#schedToggle` 式 cursor |
| **状态行开关** | JS `pillSwitch(rootId, opt)` + HTML 骨架 `.pill.sw > button.psw-main(role=switch) [+ button.caret]` | **路由区/工具栏的状态开关一律用它**（视觉=原 pill）。形态由 `caret` 决定：A=无 caret（自动路由/开机自启/临时故障切备用）、B=带 caret（定时/手机远程，**caret 仅开启时显示**、点击只开合面板不停服务）。选项：`label`（**接线在模块顶层只执行一次，切语言的 pill 必须传 `function(){ return t(...) }` 惰性求值**，字符串会把 t() 固化在加载时语言）/ `on` / `text(on)`（自定义状态文案，如定时的「07:00–23:59 / N 个时段 / 已停用」）/ `okOn(on)`（何时算绿色生效态）/ `panel()` / `onToggle(next, api)` / `onExpand(open)` / `tip`；返回 `set({on,busy,open})` / `isOn()` / `isOpen()` / `setTip()` / `render()` |
| 开关（表单用） | `.switch`（label.switch > input + span.track）/ `.tswitch`（带文字） | **表单内的参数开关**用它（当前 ui.ts 暂无使用点，kit 保留）；onchange 提交，失败回弹 `checked`，请求期间 `disabled` 防连点 |
| 分段控件 | `.seg`（容器）+ `.on`；通宽 `.seg.grow` | 互斥选项卡/语言切换；**选中=蓝底白字**；JS 切换只改按钮 `className = 'on'/' '` |
| 字段 | `.svcform label`（label>span+input）/ `.flabel` | label 13px muted；输入框走基础层 13px；新字段勿再发明第三种写法 |
| Toast | JS `toast(msg, ok)`；容器 `#toastWrap` | 固定**左下角**（右下角是 fab「＋」/snav 浮钮栏，z-toast(50)>z-fab(40)，放右下会常驻盖住「添加模型服务」）；堆叠、入场动画、复制按钮、✕ 手动关；错误 8s/其余 4.2s；**签名勿变**（74+ 调用点） |
| Tooltip | `data-tip` 属性（+`data-i18n-tip` 走 i18n） | 纯 CSS 悬停 0.3s 延迟；**宿主须 positioned**：fixed/absolute/sticky 元素直接用，静态元素补 `.tip` 类——**禁止**给 `[data-tip]` 全局加 position（会顶掉 .fab/.snav 的 fixed，已踩坑） |
| Modal 壳 | **工厂 `createModal(opts)` 代码化（ui.ts）——七个弹层壳已全部迁入，新增弹层一律走工厂，禁止再手写壳 HTML**。opts：`id`（scrim 沿用既有 overlay id，id 作用域 CSS/JS 全部继续生效）、`title`（`中文\|\|English`）/`titleId`（动态标题）、`align:'top'\|'center'`（top=顶对齐+遮罩滚动，长表单用）、`modalClass`（宽度变体如 upmodal；svcmodal=添加+编辑服务弹层共用的 680px 宽度/边框/阴影，改宽度只动这一条）、`closeButton:false`=确认类无 ✕、`closeOnEsc/closeOnScrim`（默认 true）、`bodyClass/bodyId/bodyHtml`、`footId/footHidden`、`foot:[{slot:'msg',id,kind:'err'\|'info'}（.mferr/.testline 左槽 flex:1）\|{id,label/html,title,primary,end,disabled,onClick}]`；返回 `{open/close/isOpen/body/foot}`，open 自动清 .mferr；全局 Esc=关最上层（modalStack，closeOnEsc:false 不穿透）；底栏槽位规则已归一 `.modal-foot .testline/.mferr{flex:1}`、`.modal-foot .btn{flex:0 0 auto}` | head=标题+✕常驻、body 滚动、foot 操作常驻；长表单放 body。**底栏规则（评审定稿）**：有 ✕ 的弹层 footer 不放「关闭/取消」；footer 只放与内容直接相关的动作，主按钮=用户下一步最可能的动作（分享弹层=复制链接，重新生成降次要；复制成功图标/文案翻转「✓ 已复制」1.6s）；确认类小弹层（无 ✕，如删除确认）保留「取消」=唯一反悔路径。**共享表单双宿主的动作区**（添加服务：首用内联卡 + ＋号弹窗）：`.addfoot` 单实例放表单尾，openAdd 时整体搬入工厂 foot 常驻、closeAdd 搬回（单元素 appendChild 搬移，**勿复制成两份 id**）；foot 显隐随表单（pickPreset 亮、close 熄）。**弹层开着时错误与一切提示（校验 / 接口失败 / 进度反馈）一律写底栏 msg 槽位**（`.mferr` 红=kind:'err'、`.testline` 中性+`.ok/.err` 语义色；textContent 填充，上游报错文本不可信；open 自动清 .mferr），**禁止走全局 toast**——遮罩 z-modal(100) 盖过 z-toast(50) 且带磨砂，toast 会被糊掉不可见；只有动作会关闭弹层/页面时反馈才走 toast（成功即关弹层，无遮挡；确认弹窗回调在 close 后执行，toast 可见）；弹层内复制成功的即时反馈=按钮图标/文案翻转，不走槽位也不走 toast。**新弹层 foot 必须配 `{slot:'msg'}`**（updM 曾漏配：4 条失败路径的 toast 全被遮罩糊掉）；「开着写槽位 / 已关 toast」分流写法参考 createOffer（shareM）/ updFail（updM）。**正文原则=内容即界面**：引导段落不进弹层，说明压成一行 `.help`（12px muted）或收进悬停提示（如分享链接框 title）。**正文里的网址自动可点**：`confirmModal` 的每一行都过 `linkifyText()`（按原文切出 http(s) 链接 → 展示文本与 href 各自转义 → 交 `docLinkA` 加外链图标新窗口打开），指引类文案直接写网址即可，不必拼 HTML；只认 `http(s)://`，其余文本与标签一律转义（弹层里可能有上游错误文本），因此**不要**改成 innerHTML 直插 |
| 选择器 | 基础层 select 自绘箭头 | 全站下拉**必须有右侧箭头**；密集小下拉参考 `.routesel`。**覆盖禁则**：① 禁止对 select 写 `background:` 简写（会连箭头 background-image 一起清掉，用 `background-color`）；② 覆盖 `padding` 时右侧留白 ≥22px（箭头占位），否则箭头压字——基础层默认 `padding-right:26px` |
| 文件 chip | `.filechip`（.fname + 移除按钮） | 已选文件名展示 |
| **图标** | JS `icon(name, size)` + `IC` 注册表（check/close/copy/eye/eye-off/star/plus/arrow-up/arrow-down/lock/link/gear/arrow-up-right…）；**行内**用 `iconInline(name, size)`（包 `.ic` 壳与文字基线对齐） | 控件上的图标一律用它，**禁止字符字形**（✕★👁⧉↑↓＋🔒🔗⚙🕐↗）；句子文案内嵌的 ✓⚠✗ 保留文本形态；静态 HTML 可先写字形、init 时统一 `innerHTML = icon(...)` 填充；星标实心态走 CSS `.on svg{fill:currentColor}`；链接类外链图标由 `docLinkA` 统一追加，文案里不写 ↗ |
| 浮动按钮 | `.fab`（＋添加）/ `.snav`（↑↓跳转） | fixed 右下；显隐由滚动/状态控制 |
| 展开行 | `.listmore`（虚线 btn） | 长列表「显示全部 N 个」 |
| 输入基线 | 全类型文本 input + textarea + select | 13px/7px 10px/圆角 r-md；新控件**必须加类**，但裸控件不再走样 |
| **浮头表格** | 表格块（`.mtable`/`.fetchpanel` 等，自然高度）+ 表头行 `.mhead`（`position:sticky;top:0` + 不透明背景 + z-index）；滚动容器 = `.modal-body`/`.editform`；页级表格用卡内滚动变体（`.tablescroll` + `thead th`） | 长列表滚动时表头吸附滚动口顶、滚过最后一行自动让位、多表各吸各头（sticky 原生语义，零 JS）。**结构契约与禁律见下方「浮头表格落地要点」** |

### 已评审原型、待后续落地（勿自行另造）

Tabs（下划线式）、Progress（含不确定态）、Skeleton、Empty（图标+标题+描述+动作）、KeyValue 列表、Dropdown Menu/Pop（`openPop` 定位原语）、Stepper。需要时先按原型补 CSS 再用。**扩充此清单必须先出原型经用户审核**。

### pillSwitch 落地要点（都是实测过的坑）

- 文案写内嵌 `.ptext`，**禁止**直写根 `textContent`（会冲掉 caret）。
- 切语言的 pill：`label` 传惰性函数 + `applyLang` 末尾对存量 pill 逐个 `render()`（组件文案在内部自绘，静态 `data-i18n` 扫不到 `.ptext`；曾因字符串 label 固化加载时语言，切英文后「自动路由」等 5 颗不跟随）。
- 状态只经 `set({on,busy,open})` 写入：5s 轮询重绘与点击回调共用同一份状态，绕过 setter 会回灌旧值。
- 请求在飞期间（`busy`）不要让轮询把服务端旧值写回开关态（否则视觉闪回；定时那处用 `schedToggleBusy` 守住）。
- caret 点击要 `stopPropagation`（只开合面板，不切换开关，服务不停）。
- **caret 热区必须铺满胶囊右端**：`.pill>.caret` 用 `align-self:stretch` + 负外边距吃到胶囊的内边距/边框（`margin:-3px -11px -3px 4px`），左右边界＝分隔线。写死小尺寸（曾为 15×12px）会让"看着属于箭头"的一段里约七成区域点下去其实是开关——手机远程被误关的代价（手机端整体失效）远大于误展开，热区必须偏向无害的那一侧；caret 不要设 `border-radius`（圆角会把角落的命中漏给父级＝开关），圆角只留给 `:focus-visible` 描边。
- CSS 里给这些按钮做重置时**不能用 `all:unset`**：它会把 `[hidden]` 的 `display:none` 一起重置，caret 就永远隐藏不了。
- **面板未渲染时不得按 DOM 收集表单数据**：定时开关从 pill 直接切换时面板没打开，按 DOM 抓行会得到空数组并把已存时段一起 POST 掉（实测数据丢失）——未渲染时要用服务端快照（`schedWindowsSnapshot`）。

### 浮头表格落地要点（结构契约）

- 结构三层：**滚动容器**（真正滚动的元素，如 `.modal-body`/`.editform`）⊇ **表格块**（`.mtable`/`.fetchpanel`，自然高度不设 max-height）⊇ **表头行 `.mhead`**。吸附范围 = 所属表格块：滚过最后一行表头被推走，滚动进入哪张表就吸哪张表头。新表格按此结构挂 `.mhead` 即自动获得浮头。
- **禁律①**：`.mhead` 与滚动容器之间**不得出现 `overflow:auto/scroll/hidden` 的祖先**——任何 overflow 容器都会成为 sticky 的吸附基准，而表格块自己不竖向滚动，表头就静默失效（2026-10-10 实锤回归：拉取面板表头被「表内横向滚动」规则困死一整天）。确需圆角裁剪写 `overflow:hidden;overflow:clip`（clip 裁剪但不产生滚动容器；旧浏览器回退 hidden＝不吸顶，不破布局）。
- **禁律②**：横向滚动兜底放**滚动容器**（`overflow-x:auto`），不放表格块——表头与行同处一个滚动口，横向平移永远同步、列不错位。
- **页级表格用卡内滚动变体**：主页面表格（如请求日志表 `#logTable`）的外层滚动体是 document，外滚吸附要对齐页面 sticky 页头高度（窄屏折行后是变值，对不稳）——改用**卡内滚动容器**：`.tablescroll{overflow:auto;max-height:60vh}` 自己就是滚动容器，表头 `thead th{position:sticky;top:0}` 相对它吸附。真 `<table>` 的 sticky 表头须配 `border-collapse:separate;border-spacing:0`（collapse 的边框画在表层，吸附后丢底线）+ 表头不透明背景。
- **例外：页首表格不套浮头**（如定时切换面板 `#schedPanel`）——位于页面顶部、行数少，页面滚动永远不会「滚过它的表头」，吸附永不触发；且窄屏横滚兜底必须留在表格块内（上移到 document 会让整页横移），按禁律①它注定与 sticky 无缘。硬套样式是无效果死代码，记录例外即可。

## 5. 新增/修改 UI 的流程

1. **先查本文件**：有现成组件直接用；没有 → **扩充组件库，且扩充必须先经用户审核**（原型/截图评审通过后才能进 ui.ts kit 段与本文件），禁止就地发明一次性样式绕过组件库。
2. 新颜色/令牌：主题相关必须三分支同步；语义色严格按第 3 节，不得新造含义。
3. 文案：一切用户可见文案走 `t(中, 英)` / `data-i18n*`（含 `data-i18n-tip`），双语同写。
4. ui.ts 是 JS 模板字符串：内嵌代码**禁用反引号与 `${`**；正则反斜杠双写；`\n` 要写 `\\n`；改完必须 `node --check` 抽查内嵌脚本。
5. 验收：`npm test` 全绿 + `MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx` 起隔离实例真开页（IAB）过一遍交互；**tsx 无热重载，改码后必须重启实例**。端口红线见 AGENTS.md（8687/8890 禁占）。
6. 移动端 `/m`（lan.ts）暂有独立迷你令牌，对齐桌面是技术债（见下）。

## 6. 已知例外与技术债

- 主题按钮的 🎨🌙☀️ 前缀是按钮三态文本的一部分（textContent 切换），保留 emoji；句子文案里的 ✓⚠✗ 同理（如 toast 的「✓ 已切换」、延迟探测的「✗ 网络不通」）。**状态/语义图标（锁 🔒 / 链 🔗 / 齿轮 ⚙ / 时钟 🕐 / 外链 ↗）已全部 SVG 化**——emoji 只允许留在装饰性标题（🧲/📲）与句子文案里；提示语要指向某个控件时写「点右侧按钮」这类文字，不要在文案里画图标。
- `#updOverlay`（更新弹层）保留旧自包含结构，未迁 `.pad0` 三段壳（近期刚改过，避免无谓回归）；其余弹层（编辑/添加/确认/分享/导入/配置包）均已三段化。
- `/m` 手机页（lan.ts）与云控制台（cloud/console.ts）令牌已与桌面同源（§1 值一致）；控件为**移动变体**保留自有形态（16px 输入=iOS 聚焦防缩放、44px 触控高度、左下角 toast，与桌面同口径），新增移动端 UI 也先查本文件选令牌，勿再自造色值。
- svcform 三公共块的 label 写法与 `.field` 规范等价，暂不重写模板。
