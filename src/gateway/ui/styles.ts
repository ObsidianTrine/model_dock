/**
 * Web 控制台 · styles.ts —— 内联 CSS（由单文件 ui.ts 拆出，T04 Phase 1，行为零变化）。
 * ui.ts 以 <style>
${UI_CSS}</style> 拼装，与拆分前逐字节一致；勿改动片段内换行/转义。
 */
export const UI_CSS = `/* 主题：暗色为品牌默认（独立窗口/系统亮色下也一致）；亮色经 prefers-color-scheme:light
 * 或手动切换（data-theme=light）。切到暗色的场景用 data-theme=dark 抑制 light 块。 */
:root{
  --bg:#0f1115; --card:#171a21; --text:#e5e7eb; --muted:#9ca3af; --border:#2a2f3a;
  --accent:#3b82f6; --accent-weak:#16233c; --ok:#22c55e; --ok-weak:#10241a; --warn:#d97706; --err:#ef4444;
  --warn-weak:rgba(217,119,6,.16); --neutral-weak:rgba(255,255,255,.07); --ok-halo:rgba(34,197,94,.4); --warn-halo:rgba(217,119,6,.4);
  --direct-bg:rgba(217,119,6,.16); --direct-border:rgba(217,119,6,.55); --direct-text:#f5b04c;
  --direct-bg-h:rgba(217,119,6,.28); --direct-border-h:rgba(217,119,6,.8); --direct-text-h:#ffc06a;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* 设计令牌：字号 6 档 / 圆角 3 档 / 星标琥珀，全站只经变量取值（控件图标一律走 SVG 图标集 icon()，句子文案里的 ✓⚠ 除外）；
   * 控件字级=sm 13、按钮=md 14、徽标/注释=xs 12、正文=base 15（见 .agents/conventions/ui-kit.md） */
  --fs-xs:12px; --fs-sm:13px; --fs-md:14px; --fs-base:15px; --fs-lg:17px; --fs-xl:18px;
  --r-sm:8px; --r-md:10px; --r-lg:14px; --r-full:999px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
  --h-sm:28px; --h-md:34px; --h-lg:40px;
  --wrap-ratio:61.8%;
  --shadow-sm:0 1px 2px rgba(0,0,0,.25); --shadow-md:0 4px 14px rgba(0,0,0,.2); --shadow-lg:0 18px 50px rgba(0,0,0,.35);
  --star:#f5a623;
  --scrim:rgba(0,0,0,.5);
  /* 主题不变量（单值双主题，2026-10 自散落值收编）：弱底 tint / 中性细节 / on-accent 白 / 浮动投影 */
  --err-weak:rgba(220,38,38,.08); --warn-tint:rgba(217,119,6,.08);
  --hover-tint:rgba(127,127,127,.18); --divider:rgba(127,127,127,.35);
  --on-accent:#fff; --on-accent-dim:rgba(255,255,255,.33);
  --shadow-accent:0 8px 24px rgba(37,99,235,.45); --shadow-accent-h:0 10px 28px rgba(37,99,235,.55);
  --shadow-accent-soft:0 6px 18px rgba(37,99,235,.22);
  --shadow-float:0 2px 10px rgba(0,0,0,.10); --shadow-pop:0 8px 30px rgba(0,0,0,.35);
  --z-sticky:35; --z-fab:40; --z-toast:50; --z-pop:70; --z-modal:100;
  --dur:.15s;
  color-scheme:dark;
}
:root[data-theme="light"]{
  --bg:#f5f6f8; --card:#ffffff; --text:#1a1f2e; --muted:#6b7280; --border:#e5e7eb;
  --accent:#2563eb; --accent-weak:#eff6ff; --ok:#16a34a; --ok-weak:#f0fdf4; --err:#dc2626;
  --warn-weak:rgba(217,119,6,.12); --neutral-weak:rgba(26,31,46,.06); --ok-halo:rgba(22,163,74,.35); --warn-halo:rgba(217,119,6,.35);
  --direct-bg:rgba(217,119,6,.14); --direct-border:rgba(217,119,6,.5); --direct-text:#b45309;
  --direct-bg-h:rgba(217,119,6,.24); --direct-border-h:rgba(217,119,6,.75); --direct-text-h:#b45309;
  --shadow-sm:0 1px 2px rgba(0,0,0,.08); --shadow-md:0 4px 14px rgba(0,0,0,.1); --shadow-lg:0 18px 50px rgba(0,0,0,.18);
  color-scheme:light;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]):not([data-theme="light"]){
    --bg:#f5f6f8; --card:#ffffff; --text:#1a1f2e; --muted:#6b7280; --border:#e5e7eb;
    --accent:#2563eb; --accent-weak:#eff6ff; --ok:#16a34a; --ok-weak:#f0fdf4; --err:#dc2626;
  --warn-weak:rgba(217,119,6,.12); --neutral-weak:rgba(26,31,46,.06); --ok-halo:rgba(22,163,74,.35); --warn-halo:rgba(217,119,6,.35);
    --direct-bg:rgba(217,119,6,.14); --direct-border:rgba(217,119,6,.5); --direct-text:#b45309;
    --direct-bg-h:rgba(217,119,6,.24); --direct-border-h:rgba(217,119,6,.75); --direct-text-h:#b45309;
    --shadow-sm:0 1px 2px rgba(0,0,0,.08); --shadow-md:0 4px 14px rgba(0,0,0,.1); --shadow-lg:0 18px 50px rgba(0,0,0,.18);
    color-scheme:light;
  }
}
*{box-sizing:border-box}
/* 基础层兜底：button 重置为「无外观」基线（视觉一律由 .btn 等类提供），
   裸按钮不再出现 UA 默认字体——新增控件必须加类，但没有类也至少不丑 */
button{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.55}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-base)/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wrap{margin:0 auto;padding:0 16px 64px}
/* 黄金比例壳：视口 ≥1000px 时内容带恒占 61.8%、两侧留白均分（19.1%×2），任何宽度比例一致、不设上限；
 * <1000px 时 61.8% 容不下固定宽度表格（时段面板 654px / 模型行 416px），回退流式全宽 */
@media (min-width:1000px){.wrap{width:var(--wrap-ratio)}}
/* 内容带按比例收窄后说明行不横贯整屏：行宽兜底与比例同档生效 */
@media (min-width:1000px){.card .desc,.card .shint{max-width:70ch}}
header{position:sticky;top:0;z-index:var(--z-sticky);background:var(--bg);display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid var(--border);margin-bottom:14px}
.logo{display:flex;align-items:center}
.logo svg{display:block;border-radius:7px;box-shadow:0 1px 4px rgba(79,70,229,.35)}
.brand{font-size:var(--fs-xl);font-weight:700;letter-spacing:.01em}
#health{margin-left:8px;font-size:var(--fs-sm);color:var(--muted)}
#health .dot{display:inline-block;width:8px;height:8px;border-radius:var(--r-full);background:var(--ok);margin-right:5px}
/* 语言切换 = .seg 分段控件（选中蓝底白字，见 kit 组件段）；这里只补头部专属定位与紧凑尺寸 */
#langSwitch{margin-left:auto;flex:0 0 auto}
#langSwitch button{padding:3px 12px;font-size:var(--fs-xs)}
#themeSwitch{flex:0 0 auto}
#themeBtn{border:1px solid var(--border);background:var(--card);color:var(--muted);padding:4px 10px;cursor:pointer;font:inherit;font-size:var(--fs-xs);border-radius:var(--r-sm)}
#themeBtn:hover{color:var(--text);border-color:var(--muted)}
/* hidden 属性优先于任何作者 display 规则（#routebox .rrow1 的 display:flex 会压过 UA 的 [hidden]） */
[hidden]{display:none!important}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:20px 22px;margin-bottom:16px}
.card h2{margin:0 0 4px;font-size:var(--fs-lg);font-weight:700;letter-spacing:.01em}
.card .desc{color:var(--muted);font-size:var(--fs-sm);margin:0 0 14px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.chip{border:1px solid var(--border);background-color:var(--bg);color:var(--text);border-radius:var(--r-sm);padding:4px 12px;font-size:var(--fs-sm);cursor:pointer;transition:all .15s}
/* .chip 同时挂在 select 上（「更多服务」）：background 用 background-color，保住基础层自绘箭头 */
select.chip{padding-right:24px}
.chip:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px)}
.chip.active{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
#moreSel{max-width:170px;flex-shrink:12}
/* 服务按钮行只占一行：禁止换行；放不下时「更多服务」框先收窄（收缩权重最高），按钮最后才省略号截断 */
#chips{flex-wrap:nowrap}
#chips .chip{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#addCard .desc{margin:0 0 8px}
/* 卡片搬进弹层后页面标题与弹层标题重复：弹层里不画卡片自己的 h2（内联首用仍保留步骤标题） */
#addOverlay:has(#addCard) #addCard > h2{display:none}
/* 层级须压过同列 .snav（几何上两列不重叠，仅 tooltip 相交）：fab 的 data-tip 伪元素
   被困在 fab 自己的层叠上下文里，snav 同为 z-fab 且 DOM 靠后会整层盖住 tooltip */
.fab{position:fixed;right:22px;bottom:22px;width:54px;height:54px;border-radius:50%;background:var(--accent);border:none;color:var(--on-accent);cursor:pointer;box-shadow:var(--shadow-accent);z-index:calc(var(--z-fab) + 1);display:flex;align-items:center;justify-content:center;padding:0}
.fab[hidden]{display:none}
.fab:hover{transform:translateY(-2px);box-shadow:var(--shadow-accent-h)}
/* 回到顶部/跳到底部按钮：竖排在右下角「＋」按钮上方（dsh 风格细箭头） */
.snav{position:fixed;right:29px;width:40px;height:40px;border-radius:50%;background:var(--card);border:1px solid var(--border);color:var(--muted);cursor:pointer;z-index:var(--z-fab);display:flex;align-items:center;justify-content:center;padding:0;box-shadow:var(--shadow-float);transition:color .15s,border-color .15s,background .15s,transform .15s,box-shadow .15s}
.snav:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-weak);transform:translateY(-2px);box-shadow:var(--shadow-accent-soft)}
.snav svg{display:block}
.snav[hidden]{display:none}
#snavDown{bottom:86px}
#snavUp{bottom:134px}
/* 添加/编辑弹层已迁 createModal 工厂壳（top 变体=顶对齐+遮罩滚动）。
   编辑浮层：头部（标题+关闭）与底部（取消/保存）常驻，仅表单区滚动——长表单（模型表/备用链/拉取面板）
   自然高度互不挤压、滚动时表头吸附，操作按钮不再随内容滚出视野（头/底样式走 kit 的 .modal-head/.modal-foot）。
   宽度/边框走两壳共用的 .svcmodal 变体（modalClass），改一处即可 */
.svcmodal.modal{max-width:680px;margin:auto;border:1px solid var(--border);box-shadow:var(--shadow-lg)}
/* 表头吸附的滚动体就是它：横向滚动兜底也放这里（表头与行同滚动口，横移同步列不错位）；
   禁止在 .editform 与 .mhead 之间再出现 overflow:auto/scroll/hidden 的祖先——会静默困死 sticky 吸顶 */
#editOverlay .editform{overflow:auto;min-height:0;padding:14px 20px 16px}
/* 底栏槽位/按钮通用规则（工厂壳全部弹层生效）：msg 槽占满左侧、按钮不被挤压 */
.modal-foot .testline{flex:1;min-width:0;margin:0}
.modal-foot .btn{flex:0 0 auto}
/* 服务表单公共块样式（.svcform：添加/编辑两壳共用；块 HTML 由 JS 生成） */
.svcform .mhead .defcol{color:var(--star);opacity:.55;font-size:var(--fs-xs)}
.svcform .egrid{display:grid;grid-template-columns:1fr 1fr;column-gap:12px;row-gap:6px}
.svcform .fsec-row{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding-top:12px;margin-top:10px}
.svcform .fsec{font-size:var(--fs-sm);color:var(--text);font-weight:600}
.svcform label.fsec{margin:0}
.svcform label{display:block;font-size:var(--fs-sm);color:var(--muted);margin:8px 0 0}
/* 顶部字段（label 内 input）才用 100% 宽度；模型表里的输入框保持 96px 与表头对齐 */
.svcform label input{width:100%;margin-top:4px;padding:6px 10px;font-size:var(--fs-sm)}
.svcform label select{margin-top:4px;padding:4px 24px 4px 8px;font-size:var(--fs-sm);border-radius:var(--r-sm)}
.svcform .mtable{margin-top:10px}
/* 浮头表格：吸附范围=所属表格块，滚到哪张表吸哪张头；祖先链禁 overflow（契约见 ui-kit「浮头表格」） */
.svcform .mhead{position:sticky;top:0;z-index:2;background:var(--card)}
.svcform .addrow{flex:0 0 auto}
.svcform .mrow{padding:5px 8px}
.svcform .mrow input.bad{border-color:var(--err)}
.svcform .row{margin-top:10px;flex:0 0 auto}
/* hidden 负责裁圆角，但会创建滚动容器困死 sticky；clip 同样裁剪却不困（旧浏览器回退 hidden=不吸顶，不破布局） */
.mtable{margin-top:8px;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;overflow:clip}
.mrow{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--bg)}
.mrow:hover{background:var(--card)}
.mrow:last-child{border-bottom:none}
.mrow .mid{flex:1;min-width:0;font-family:var(--mono);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 显示名副行：与模型 ID 同列纵排；JS 仅在显示名存在且与 ID 不同（忽略大小写/空格）时渲染，缺失不占位 */
.mrow .midwrap{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;gap:1px}
.mrow .midwrap .mid{flex:0 0 auto}
.mrow .msub{min-width:0;max-width:100%;font-size:var(--fs-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3}
.mrow input{width:96px;padding:4px 8px;font-size:var(--fs-sm);border-radius:var(--r-sm)}
.mrow .del{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 6px;display:inline-flex}
.mrow .del:hover{color:var(--err)}
.mhead{display:flex;gap:8px;font-size:var(--fs-xs);color:var(--muted);padding:6px 10px;background:var(--card);border-bottom:1px solid var(--border)}
.mhead span:first-child{flex:1;min-width:0}
.mhead span:nth-child(2),.mhead span:nth-child(3){width:96px;flex:0 0 96px}
.mhead span:nth-child(4){flex:0 0 24px;width:24px}
.mempty{padding:10px;color:var(--muted);font-size:var(--fs-sm)}
.addrow{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--card)}
.addrow input{flex:1;min-width:0;padding:4px 8px;font-size:var(--fs-sm);border-radius:var(--r-sm)}
.addrow input.num{flex:0 0 96px;width:96px}
.mtable .mrow input{flex:0 0 96px;width:96px;margin:0}
#schedPanel{margin:-6px 0 12px;padding:10px 12px;border:1px dashed var(--border);border-radius:var(--r-md)}
#schedPanel .tfield{display:flex;align-items:center;min-width:0}
#schedPanel .tinput{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--r-sm);padding:5px 8px;font:inherit;font-size:var(--fs-sm);width:100%;min-width:0;box-sizing:border-box;margin:0;cursor:pointer}
#schedPanel .tinput.bad{border-color:var(--err)}
#schedPanel select,#schedPanel textarea{background-color:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--r-sm);padding:5px 24px 5px 8px;font:inherit;font-size:var(--fs-sm);width:100%;box-sizing:border-box;margin:0}
#timePickPop{position:fixed;z-index:var(--z-pop);display:none;background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-pop);padding:8px}
/* 检查更新弹窗已迁 createModal 工厂壳（宽度/头部件样式按 id 继续生效） */
#updOverlay .upmodal{max-width:520px}
#updOverlay .modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px}
#updOverlay .modal-head h3{margin:0;font-size:var(--fs-lg);font-weight:700}
#updOverlay .upsub{margin:0 0 10px}
#updOverlay .upnotes{max-height:240px;overflow:auto;white-space:pre-wrap;font-size:var(--fs-sm);color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px;margin:0 0 12px}
#updOverlay .upmore{font-size:var(--fs-sm);margin:-4px 0 12px}
#updOverlay .uphint{font-size:var(--fs-xs);color:var(--muted);margin:8px 0 0}
#updBadge{cursor:pointer}
#timePickPop .tptitle{font-size:var(--fs-xs);color:var(--muted);margin:0 0 6px}
#timePickPop .tpcols{display:flex;gap:6px}
#timePickPop .tpcol{width:72px;height:224px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:4px;scrollbar-width:thin}
#timePickPop .tpcell{display:block;width:100%;border:none;background:none;color:var(--text);border-radius:var(--r-sm);padding:4px 0;font:inherit;font-size:var(--fs-sm);cursor:pointer;text-align:center;line-height:1.4}
#timePickPop .tpcell:hover{background:var(--hover-tint)}
#timePickPop .tpcell.on{background:var(--accent);color:var(--on-accent)}
#schedPanel .shead,#schedPanel .srow{display:grid;grid-template-columns:86px 92px 110px 110px 1fr 1fr 40px;gap:5px;align-items:center}
/* 表头与控件列文字对齐：左内边距 = 控件 padding 8px + 边框 1px；表头是列说明，降为 13px 灰色 */
#schedPanel .shead{font-size:var(--fs-sm);color:var(--muted);font-weight:500;padding-bottom:2px}
#schedPanel .shead span{padding-left:9px}
#schedPanel .srow{margin-top:6px}
#schedPanel .sdel{background:none;border:none;cursor:pointer;color:var(--muted);padding:2px;display:inline-flex}
#schedPanel .sdel:hover{color:var(--err)}
/* 定时面板：操作行 / 说明小字（长说明用 13px 保可读，计数类小字 12px） */
#schedPanel .sline{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap}
/* 说明文字独占一行：勾选框一行、说明一行（上次精简后字数变少，与勾选框挤进了同一行） */
#schedPanel .sline .shint.big{flex-basis:100%}
#schedPanel .sline.hol{margin:6px 0 0}
#schedPanel .sline label{display:flex;align-items:center;gap:6px;cursor:pointer}
#schedPanel label{font-size:var(--fs-sm);color:var(--muted)}
#schedPanel label.hblock{display:block;margin:8px 0 0}
#schedPanel .shint{font-size:var(--fs-xs);color:var(--muted)}
#schedPanel .shint.big{font-size:var(--fs-sm)}
/* 表头/模型行/新增行统一等宽列（grid），避免 flex 各自自适应导致列错位。
   ID 列写 minmax(120px,1fr)：单个 1fr 的最小尺寸是 auto，长 ID 会把该列顶宽、把后面几列挤出可视区；
   而纯弹性列在窄弹层里又会被压成 0 宽（ID 只剩一个省略字）。给下限 + 表内横向滚动，两头都不会错位。 */
.svcform .mhead,
.svcform .mrow,
.svcform .addrow{display:grid;grid-template-columns:28px minmax(120px,1fr) 96px 96px 60px 56px;gap:8px;align-items:center;text-align:left;min-width:416px}
/* 网格子项同样不能按内容撑宽（.midwrap 是中间层，min-width:0 缺一不可） */
.svcform .mhead > *,
.svcform .mrow > *,
.svcform .addrow > *{min-width:0}
.svcform .mhead span{width:auto}
/* 列宽有下限后窄屏可能放不下：横向滚动兜底在滚动体上（.editform/.modal-body），不能放表格块——
   overflow 容器会困死 .mhead 的 sticky 吸顶（2026-10-10 曾因此回归，见 ui-kit「浮头表格」禁律） */
/* 「视觉」勾选列：原生勾选框在网格里按轨道居中；列头文字居中对齐勾选框 */
.svcform .mhead span.vcol{text-align:center}
.svcform .mrow input[type=checkbox].vpick{margin:0;justify-self:center;width:auto;padding:0}
.svcform .mrow .mid{min-width:0}
.mrow .def{background:none;border:none;cursor:pointer;padding:2px;color:var(--muted);line-height:1;display:inline-flex}
/* 默认星标：off=描边星，on=填充星（SVG fill 由 CSS 接管） */
.mrow .def.on{color:var(--star)}
.mrow .def.on svg{fill:currentColor}
.mrow .def:hover{color:var(--accent)}
/* 行内 SVG 图标（iconInline）：与同行文字基线对齐；间距由调用方在文字串里用空格掌控 */
.ic{display:inline-flex;vertical-align:-.17em}
.mtable .addrow input{margin:0}
/* 故障切换顺序表：复用模型表行样式，列改为 备用服务/使用的模型/操作 */
.svcform .fbtable{margin-top:8px}
.svcform .fbtable .mhead,
.svcform .fbtable .mrow,
.svcform .fbtable .addrow{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 96px;min-width:300px}
.svcform .fbops{display:flex;gap:2px;justify-content:flex-end}
.svcform .fbops button{background:none;border:none;cursor:pointer;color:var(--muted);padding:2px 4px;line-height:1;display:inline-flex}
.svcform .fbops button:hover{color:var(--accent)}
.svcform .fbops .del:hover{color:var(--err)}
.svcform .addrow select{width:100%;min-width:0;padding:4px 24px 4px 8px;font-size:var(--fs-sm);border-radius:var(--r-sm);margin:0}
/* 拉取模型面板：行复用 .mrow 网格，勾选列与上方 ★ 列对齐 */
/* 勾选框必须豁免 .mrow input 的 width:96px——被拉宽后原生图形按盒子居中绘制，会压到模型 ID 上 */
.svcform .frow input[type=checkbox]{margin:0;cursor:pointer;width:auto;padding:0}
/* 超长模型 ID / 名一律省略号截断（title 已有全文），不许把后面的数字列顶出行外 */
.svcform .frow .midwrap{overflow:hidden}
.svcform .frow .mid{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.svcform .frow .msub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.svcform .ftag{font-size:var(--fs-xs);color:var(--muted);text-align:right;white-space:nowrap;overflow:hidden}
.svcform .frow.dis .mid,.svcform .frow.dis .ftag{opacity:.55}
.svcform .fetchpanel{margin-top:8px;padding:8px 10px;border:1px dashed var(--border);border-radius:var(--r-md)}
.svcform .fetchpanel .fsearch{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.svcform .fetchq{flex:1;min-width:0;padding:5px 10px;font-size:var(--fs-sm)}
.svcform .fetchcount{font-size:var(--fs-xs);color:var(--muted);white-space:nowrap}
.svcform .fetchpanel .factions{display:flex;align-items:center;gap:8px;margin-top:8px}
.svcform .fetchmsg{flex:1;min-width:0;font-size:var(--fs-xs);color:var(--muted)}
/* 宽度/边框/阴影走两壳共用的 .svcmodal（与编辑弹层同宽 680px）；这里只留添加弹层自己的高度约束 */
#addOverlay .modal{max-height:96vh}
#addModalBody{flex:1 1 auto;min-height:0}
.close-row{display:flex;justify-content:flex-end;margin:0 0 2px}
.close-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 8px;display:inline-flex}
.close-btn:hover{color:var(--text)}
.addform{border-top:1px dashed var(--border);margin-top:10px;padding-top:10px}
.addform h3{margin:0 0 4px;font-size:var(--fs-base);font-weight:700}
/* 表单展开后隐藏次级描述行，首屏让给要填的字段 */
#addCard:has(#addform:not([hidden])) .desc{display:none}
/* Key 输入行：块级 label + 通宽输入框（与编辑页 .svcform label 同规则） */
.flabel{display:block;margin:6px 0 0;font-size:var(--fs-sm);color:var(--muted)}
.flabel > input{display:block;width:100%;margin-top:4px}
.keywrap{display:flex;gap:6px;align-items:center}
.keywrap input{flex:1;min-width:120px}
.flabel .keywrap{margin-top:4px}
.iconbtn{cursor:pointer}
.desc-sm{color:var(--muted);font-size:var(--fs-sm);margin:6px 0 0}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row.end{justify-content:flex-end}
.row .push{margin-left:auto}
/* 输入基线：全类型文本输入 + textarea + select 统一 13px（--fs-sm，对齐原版 svcform 字级），select 自绘箭头 */
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=submit]):not([type=button]),textarea,select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--r-md);padding:7px 10px;font:inherit;font-size:var(--fs-sm)}
select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;padding-right:26px}
input:focus,textarea:focus,select:focus{outline:2px solid var(--accent);border-color:transparent}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
textarea{resize:vertical}
input[type=checkbox]{margin:0;cursor:pointer;accent-color:var(--accent);width:14px;height:14px;flex:none}
::placeholder{color:var(--muted);opacity:.8}
.btn{border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:var(--r-md);padding:7px 14px;font:inherit;font-size:var(--fs-md);cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover{opacity:.88;color:var(--on-accent)}
.btn.danger:hover{border-color:var(--err);color:var(--err)}
.btn.small{padding:4px 12px;font-size:var(--fs-sm);border-radius:var(--r-sm)}
.btn.small.primary{padding:4px 16px;font-weight:600}
/* 独立直连=绕开网关的救援通道，属"特殊/注意"类动作：琥珀软填充（复用 --warn 色相），与蓝色主按钮、绿色状态 pill 区分开 */
.btn.direct{background:var(--direct-bg);border-color:var(--direct-border);color:var(--direct-text)}
.btn.direct:hover{background:var(--direct-bg-h);border-color:var(--direct-border-h);color:var(--direct-text-h)}
.service{display:flex;align-items:center;gap:10px;padding:12px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;border-radius:var(--r-md);transition:background .15s}
.service:not(.cur):hover{background:var(--bg)}
.service:last-child{border-bottom:none}
/* 次要破坏性操作平时收为幽灵按钮（弱灰、无边框），悬停才显危险色——降低列表视觉噪音 */
.btn.ghost-danger{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost-danger:hover{border-color:var(--err);color:var(--err);background:var(--err-weak)}
/* 当前使用中的服务：页面最重要的状态——弱底色 + 左侧主题色竖条，一眼锁定 */
.service.cur{background:var(--accent-weak);border-bottom-color:transparent;box-shadow:inset 3px 0 0 var(--accent);margin:3px 0}
.service.cur:last-child{margin-bottom:0}
.service .info{flex:1;min-width:200px}
.service .name{font-weight:600}
.service.cur .name{color:var(--accent)}
.service .meta{color:var(--muted);font-size:var(--fs-sm);font-family:var(--mono)}
.pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:var(--r-full);font-size:var(--fs-xs);border:1px solid var(--border);color:var(--muted);white-space:nowrap;font-weight:400}
.pill.ok{color:var(--ok);border-color:var(--ok);background:var(--ok-weak)}
.pill.err{color:var(--err);border-color:var(--err);background:var(--err-weak)}
.pill.warn{color:var(--warn);border-color:var(--warn);background:var(--warn-tint)}
.pill.dim{opacity:.75}
/* pillSwitch：状态行开关（kit 组件）。视觉与原 pill 一致；主体 / caret 是两个真实按钮，
   各自可 Tab（role=switch+aria-checked / aria-expanded+aria-controls），内嵌 .ptext 承载文案 */
.pill.sw{cursor:pointer;user-select:none;transition:border-color var(--dur),color var(--dur),background var(--dur)}
.pill.sw:hover{border-color:var(--muted);color:var(--text)}
.pill.sw.ok:hover{border-color:var(--ok);color:var(--ok);background:var(--ok-weak)}
/* 主体按钮显式重置：勿用 all:unset——它会把 [hidden] 的 display 一起重置，caret 将永远隐藏不了 */
.pill>.psw-main{background:none;border:none;padding:0;margin:0;color:inherit;font:inherit;font-size:var(--fs-xs);font-weight:400;cursor:pointer;display:inline-flex;align-items:center}
.pill>.psw-main:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--r-full)}
/* 右侧箭头：热区铺满胶囊右端（全高 + 吃掉右侧内边距与上下留白），分隔线即命中边界。
   此前热区写死 15×12px，视觉上"属于箭头"的那一段里有约七成区域点下去其实是主体的开关——
   手机远程被误关的代价（手机端整体失效）远大于误展开，故把无害的那一侧热区放大 */
.pill>.caret{background:none;border:none;color:inherit;font:inherit;align-self:stretch;margin:-3px -11px -3px 4px;padding:0 11px 0 8px;border-left:1px solid var(--divider);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.pill>.caret::before{content:'';display:inline-block;width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);transition:transform var(--dur)}
.pill>.caret.open::before{transform:rotate(225deg)}
.pill>.caret:hover{color:var(--accent)}
.pill>.caret:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:0 var(--r-full) var(--r-full) 0}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--on-accent-dim);border-top-color:var(--on-accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:-1px;margin-right:6px}
.spin.plain{border:2px solid var(--border);border-top-color:var(--accent)}
@keyframes spin{to{transform:rotate(360deg)}}
.btn:disabled{cursor:not-allowed;opacity:.55}
.empty{color:var(--muted);font-size:var(--fs-md);padding:22px 0;text-align:center}
.migrate{border-color:var(--accent);background:var(--accent-weak)}
.migrate .desc{margin-bottom:10px}
.details-line{font-size:var(--fs-sm);color:var(--muted);margin-top:2px}
/* Toast：堆叠容器（#toastWrap）+ 入场动画 + 手动关闭；API 保持 toast(msg, ok) 兼容全部调用点。
   固定左下角：右下角是 fab「＋」/snav 浮钮栏，z-toast(50)>z-fab(40)，放右下会常驻盖住「添加模型服务」 */
.toast-wrap{position:fixed;left:18px;bottom:18px;z-index:var(--z-toast);display:flex;flex-direction:column;gap:8px;align-items:flex-start;max-width:420px}
.toast{display:flex;align-items:flex-start;gap:8px;background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:var(--r-lg);padding:12px 16px;font-size:var(--fs-md);box-shadow:var(--shadow-md);animation:toastIn .18s ease-out}
.toast .tmsg{flex:1;min-width:0;word-break:break-all}
.toast .tcopy{flex:0 0 auto;background:none;border:none;cursor:pointer;color:var(--muted);padding:0 2px;line-height:1.2;margin-top:1px;display:inline-flex}
.toast .tcopy:hover{color:var(--accent)}
.toast .tx{flex:0 0 auto;background:none;cursor:pointer;color:var(--muted);line-height:1.4;padding:0 2px;margin-top:1px;display:inline-flex}
.toast .tx:hover{color:var(--text)}
.toast.ok{border-left-color:var(--ok)}
.toast.err{border-left-color:var(--err)}
@keyframes toastIn{from{opacity:0;transform:translateY(6px)}}
#logPager{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.pglabel{font-size:var(--fs-xs);color:var(--muted);display:inline-flex;align-items:center;gap:4px}
#logPageSize{padding:3px 22px 3px 8px;font-size:var(--fs-xs);border-radius:var(--r-sm);margin:0;width:auto}
#logPageInfo{font-size:var(--fs-xs);color:var(--muted);white-space:nowrap}
#logTable .lcopy{background:none;border:none;cursor:pointer;color:var(--muted);padding:0 2px;line-height:1.2;margin-left:6px;vertical-align:middle;display:inline-flex}
#logTable .lcopy:hover{color:var(--accent)}
/* 工厂弹层壳（createModal）：统一磨砂遮罩/层高/居中变体；top 变体=顶对齐+遮罩自身滚动（长表单弹层） */
.modal-scrim{position:fixed;inset:0;background:var(--scrim);backdrop-filter:blur(2px);display:flex;justify-content:center;z-index:var(--z-modal)}
.modal-scrim.center{align-items:center}
.modal-scrim.top{align-items:flex-start;overflow:auto;padding:48px 16px}
.modal-scrim[hidden]{display:none}
.modal{background:var(--card);border-radius:var(--r-lg);padding:20px 22px;max-width:480px;width:92%}
.modal h3{margin:0 0 10px}
.modal ul{margin:8px 0 16px;padding-left:18px;color:var(--muted);font-size:var(--fs-sm)}
.modal-body ul{margin:0}
.modal .mono{font-family:var(--mono);font-size:var(--fs-sm);word-break:break-all}
/* 动态状态色工具类：JS 拼接 HTML 时替代内联 style 颜色 */
.hint-warn{color:var(--warn)}
td.st-ok{color:var(--ok)}
td.st-err{color:var(--err)}
a{color:var(--accent)}
.testline{font-size:var(--fs-sm);margin-top:6px}
.testline.ok{color:var(--ok)}
.testline.err{color:var(--err)}
.testres{font-size:var(--fs-xs);margin-right:10px;color:var(--muted);white-space:nowrap;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.testres.ok{color:var(--ok)}
.testres.err{color:var(--err)}
.editform label{display:block;font-size:var(--fs-sm);color:var(--muted);margin:12px 0 0}
.editform input{width:100%;margin-top:5px}
table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);margin-top:10px}
th{text-align:left;color:var(--muted);font-weight:500;padding:5px 8px;border-bottom:1px solid var(--border)}
td{padding:5px 8px;border-bottom:1px solid var(--border);font-family:var(--mono)}
/* 日志表浮头（卡内滚动变体，滚动容器=.tablescroll）：separate 让边框归属单元格——
   collapse 的边框画在表层，sticky 表头滚入吸附位会丢底线；th 加不透明背景盖住滚过的行 */
#logTable{border-collapse:separate;border-spacing:0}
#logTable thead th{position:sticky;top:0;z-index:1;background:var(--card)}
#logTable th,#logTable td{white-space:nowrap}
#logTable td:nth-child(4),#logTable td:last-child{white-space:normal;word-break:break-all}
.note{color:var(--muted);font-size:var(--fs-sm);margin-top:10px}
code{font-family:var(--mono);font-size:var(--fs-sm);background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:1px 6px}
.svc-toolbar{display:flex;gap:10px;margin:0 0 12px;flex-wrap:wrap;align-items:center}
.svc-toolbar input[type=text]{flex:1;min-width:180px}
.svc-toolbar select{flex:0 0 auto}
/* 工具栏控件与卡片内 13px 小按钮同级，不继承全局 15px 大字号 */
.svc-toolbar input[type=text],.svc-toolbar select{font-size:var(--fs-sm);padding:7px 11px;border-radius:var(--r-md)}
/* select 独立补右留白：基础层的自绘箭头经 background-image 绘制，padding 简写覆盖会把它顶到文字下面 */
.svc-toolbar select{padding-right:26px}
/* 路由区：一张卡两行——上行=路由状态与控制，下行=开关组（Switch，绿=开）；空配置时上行隐藏、
   开关组仍在（手机远程是新机扫码导入的入口），solo 去掉分隔线独立成卡 */
#routebox{margin:12px 0 12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--card)}
#routebox .rrow1{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px}
#routebox .rrow2{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;padding:9px 12px;border-top:1px dashed var(--border)}
#routebox.solo .rrow2{border-top:none}
#routebox .rrow1 label{font-size:var(--fs-sm);color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer}
/* 「正在使用」状态横栏（hero 单行状态条）：routeState 唯一口径的桌面展示点（服务卡徽标/手机页/模型列表同源）。
   独立于 routebox 配置卡放在「我的服务」卡之前——实际生效与配置意图分开呈现。
   一行站住「在用谁/为什么/挂了去哪」：状态点（正常=绿呼吸，故障切换/降级=琥珀）+「正在使用：」蓝色服务名 +
   来源小徽（绿=定时窗口生效、琥珀=故障切换/已降级、灰=人工钉定/默认路由）+ 右缘「下一个切换」；
   harness/模型归属不在此列（接入区与服务卡「被 N 个客户端使用」承载）；窄屏自然折行 */
#inuseBar{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;min-height:var(--h-lg);margin:0 0 16px;padding:6px 14px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--card)}
#inuseBar .olmain{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
#inuseBar .idot{flex:0 0 auto;width:7px;height:7px;border-radius:var(--r-full);background:var(--ok);animation:inuse-pulse 2.6s ease-out infinite}
#inuseBar .idot.warn{background:var(--warn);animation-name:inuse-pulse-warn}
@keyframes inuse-pulse{0%{box-shadow:0 0 0 0 var(--ok-halo)}75%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes inuse-pulse-warn{0%{box-shadow:0 0 0 0 var(--warn-halo)}75%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){#inuseBar .idot{animation:none}}
#inuseBar .ollabel{font-size:var(--fs-xs);color:var(--muted);white-space:nowrap}
#inuseBar .iname{font-size:var(--fs-base);font-weight:600;color:var(--accent);white-space:nowrap}
#inuseBar .ichip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:var(--r-full);font-size:var(--fs-xs);line-height:1;white-space:nowrap}
#inuseBar .ichip svg{width:11px;height:11px}
#inuseBar .ichip.ok{background:var(--ok-weak);color:var(--ok)}
#inuseBar .ichip.warn{background:var(--warn-weak);color:var(--warn)}
#inuseBar .ichip.dim{background:var(--neutral-weak);color:var(--muted)}
#inuseBar .inum{font-family:var(--mono)}
#inuseBar .olnext{display:flex;align-items:baseline;gap:2px;margin-left:auto}
#inuseBar .olvalue{font-family:var(--mono);font-size:var(--fs-sm);color:var(--text);white-space:nowrap}
#inuseBar .olvalue.warn{color:var(--warn)}
#pkgPill{margin-left:auto}
#lanPanel{margin:-6px 0 12px;padding:10px 12px;border:1px dashed var(--border);border-radius:var(--r-md)}
#lanPanel .lanflex{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
#lanPanel .laninfo{flex:1;min-width:200px}
#lanPanel .lanurl{word-break:break-all;margin:0 0 8px;cursor:pointer;font-family:var(--mono);font-size:var(--fs-sm)}
#lanPanel .shint{font-size:var(--fs-sm);color:var(--muted);margin:0}
#lanPanel svg{display:block;background:#fff;border-radius:var(--r-sm);padding:4px;width:88px;height:88px}
/* 同网直拉迁移（sync-lan-pull）：配置包统一弹层（pkgOverlay，吸收原 shareOverlay/importOverlay），
   内容样式改挂 #pkgOverlay 继续生效 */
#pkgOverlay .shareurl{display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 12px;margin:0;cursor:pointer}
#pkgOverlay .shareurl:hover{border-color:var(--accent)}
#pkgOverlay .shareurl .u{flex:1;min-width:0;font-family:var(--mono);font-size:var(--fs-sm);white-space:nowrap;overflow-x:auto}
#pkgOverlay .shareurl .u::-webkit-scrollbar{height:6px}
#pkgOverlay .shareurl .u::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
#pkgOverlay .alt-toggle{display:inline-flex;align-items:center;gap:4px;font-size:var(--fs-xs);color:var(--muted);margin:10px 0 0;cursor:pointer}
#pkgOverlay .alt-toggle:hover{color:var(--accent)}
#pkgOverlay .alt-toggle::before{content:'';width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform var(--dur)}
#pkgOverlay .alt-toggle.open::before{transform:rotate(45deg)}
#pkgOverlay .altlist{display:none;margin:6px 0 0}
#pkgOverlay .altlist.open{display:block}
#pkgOverlay .sharealt,#lanPanel .sharealt{font-size:var(--fs-xs);color:var(--muted);margin:2px 0;cursor:pointer;word-break:break-all}
#pkgOverlay .sharealt:hover,#lanPanel .sharealt:hover{color:var(--accent)}
#pkgOverlay .sharealt{font-family:var(--mono)}
.modal-body .help{font-size:var(--fs-xs);color:var(--muted);margin:8px 0 0;line-height:1.5}
#pkgOverlay .shint{font-size:var(--fs-sm);color:var(--muted);word-break:break-all;margin:6px 0}
#pkgOverlay textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;font-family:var(--mono);font-size:var(--fs-sm)}
/* 导入弹层选项卡：三个互斥来源各一页（走 kit 的 .seg.grow，选中蓝底白字） */
#importTabs{margin:0 0 14px}
/* 附近电脑卡片列表 */
#impPeers .peercard{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px;margin:0 0 8px}
#impPeers .peercard .pname{flex:1;min-width:0;word-break:break-all;font-weight:600}
/* 存量收编勾选列表（导入存量配置弹层） */
.legacyrow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)}
.legacyrow:last-child{border-bottom:none}
.legacyrow .lname{flex:1;min-width:0;word-break:break-all;font-size:var(--fs-base)}
.legacyrow .lsrc{flex:0 0 auto;font-size:var(--fs-xs);color:var(--muted)}
/* 添加表单尾部的收编入口：次级文字按钮，弱于主保存动作 */
#addCard .altline{margin:10px 0 0}
/* Progress 进度条（ui-kit 已评审原型落地，规范见 .agents/conventions/ui-kit.md）：
   track 6px 圆角、fill=accent 随 width 过渡；.indet 不确定态=30% 宽往复动画（下载总量未知时用） */
.progress{height:6px;border-radius:var(--r-full);background:var(--bg);border:1px solid var(--border);overflow:hidden}
.progress .progress-fill{height:100%;border-radius:var(--r-full);background:var(--accent);transition:width var(--dur) linear}
.progress.indet .progress-fill{width:30%;animation:progress-indet 1.2s ease-in-out infinite}
@keyframes progress-indet{0%{margin-left:-30%}100%{margin-left:100%}}
/* 已选配置包文件的文件名 chip（可移除） */
.filechip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:var(--r-full);padding:4px 10px;font-size:var(--fs-sm);max-width:60%}
.filechip .fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filechip button{border:none;background:none;color:var(--muted);cursor:pointer;font:inherit;padding:0 2px}
.filechip button:hover{color:var(--accent)}
/* 手机远程开关右侧 V 形箭头：收起/展开二维码面板（与下拉框同款 chevron，分隔语义防误触开关） */
#curSvcSel,#autoRouteSel{font-size:var(--fs-sm);padding:5px 26px 5px 10px;border-radius:var(--r-sm);max-width:200px}
/* 客户端卡片内的钉定路由下拉：小号、紧凑，与卡片 12px meta 行同节奏 */
.routesel{font-size:var(--fs-xs);padding:3px 22px 3px 8px;border-radius:var(--r-sm);border:1px solid var(--border);color:var(--text);max-width:180px}
/* 长列表收尾：服务/客户端列表的展开·收起行——虚线边框 + 弱化配色，作为次要操作不抢视线 */
.listmore{display:flex;justify-content:center;padding:8px 0 2px}
.listmore .btn{border-style:dashed;color:var(--muted);font-size:var(--fs-sm)}
.listmore .btn:hover{color:var(--accent);border-color:var(--accent)}
/* 登录提示（管理面要求凭据时的整页占位） */
.loginbox{margin-top:48px;text-align:center}
.loginbox .name{font-weight:600;font-size:var(--fs-lg)}
.loginbox .desc{color:var(--muted);font-size:var(--fs-sm);margin:10px 0}
/* 令牌输入框独立类名：勿用 .tinput——时间选择弹层的全局委托按该类名误伤登录页 */
.loginbox .linput{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--r-sm);padding:5px 8px;font:inherit;font-size:var(--fs-sm);width:22em;max-width:100%;box-sizing:border-box;margin:0}
/* 添加表单动作区：内联宿主=表单尾一行（msg 左、按钮右）；＋号弹窗宿主由 openAdd 整体搬进 .modal-foot 常驻底栏（与编辑弹层同构） */
.addfoot{display:flex;align-items:center;gap:10px;margin-top:8px}
.addfoot .testline{flex:1;min-width:0;margin:0}
#addOverlay .modal-foot .addfoot{flex:1;min-width:0;margin:0}
/* UI Kit 组件（规范见 .agents/conventions/ui-kit.md；新增 UI 先查这里） */
/* Switch：唯一合法的开关形态（绿=开启，替代旧 pill 文字开关）；.tswitch = 开关+文字组合 */
.switch{position:relative;display:inline-flex;flex:0 0 auto;cursor:pointer;vertical-align:middle}
.switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.switch .track{display:block;width:36px;height:21px;border-radius:var(--r-full);background:var(--border);position:relative;transition:background var(--dur)}
.switch .track::after{content:'';position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:var(--on-accent);box-shadow:var(--shadow-sm);transition:transform var(--dur)}
.switch input:checked+.track{background:var(--ok)}
.switch input:checked+.track::after{transform:translateX(15px)}
.switch input:disabled+.track{opacity:.5}
.tswitch{display:inline-flex;align-items:center;gap:7px;font-size:var(--fs-sm);color:var(--muted);cursor:pointer;white-space:nowrap}
/* Segmented 分段控件：互斥选项切换；.grow=通宽等分（导入弹层选项卡）；选中=蓝底白字 */
.seg{display:inline-flex;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);padding:3px;gap:2px}
.seg button{padding:5px 14px;border-radius:7px;font-size:var(--fs-sm);color:var(--muted);cursor:pointer;white-space:nowrap;transition:all var(--dur)}
.seg button:hover{color:var(--text)}
.seg button.on{background:var(--accent);color:var(--on-accent);font-weight:600}
.seg.grow{display:flex;width:100%}
.seg.grow button{flex:1;justify-content:center;text-align:center}
/* Tooltip：纯 CSS，data-tip 属性（需 i18n 的用 data-i18n-tip 注入）；箭头由 ::before 绘制。
   定位锚点：data-tip 元素自身需为 positioned——fixed/absolute/sticky 元素直接用；
   静态元素补 .tip 类（不得给 [data-tip] 全局加 position:relative，会把 .fab/.snav 的 fixed 顶掉） */
.tip{position:relative}
[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);background:#111827;color:#f5f5f5;border:1px solid rgba(255,255,255,.12);font-size:var(--fs-xs);line-height:1.4;padding:4px 9px;border-radius:var(--r-sm);white-space:nowrap;pointer-events:none;z-index:calc(var(--z-pop) + 1);animation:tipIn .12s ease-out .3s backwards;box-shadow:var(--shadow-md)}
[data-tip]:hover::before{content:'';position:absolute;bottom:calc(100% + 3px);left:50%;transform:translateX(-50%) rotate(45deg);width:7px;height:7px;background:#111827;border-right:1px solid rgba(255,255,255,.12);border-bottom:1px solid rgba(255,255,255,.12);z-index:calc(var(--z-pop) + 1);animation:tipIn .12s ease-out .3s backwards}
@keyframes tipIn{from{opacity:0}}
/* Modal 壳：head/body/foot 三段（head 标题+关闭常驻、body 滚动、foot 操作常驻）；
   .pad0 配合三段结构去全局内边距；.end 把首按钮推到右侧（无 testline 的双按钮 foot） */
.modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 20px 12px;border-bottom:1px solid var(--border);flex:0 0 auto}
.modal-head h3{margin:0;font-size:var(--fs-lg);font-weight:700}
.modal-body{padding:14px 20px 16px;overflow-y:auto;min-height:0}
.modal-foot{display:flex;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--border);flex:0 0 auto}
.modal.pad0{padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:92vh}
.modal.pad0 .modal-body{overflow-y:auto}
/* 添加服务弹窗内含浮头表格：横向滚动兜底同样放滚动体（理由同 #editOverlay .editform） */
#addOverlay .modal-body{overflow-x:auto}
.modal-foot .end{margin-left:auto}
/* 弹层开着时的错误就近写底栏左侧槽，不走全局 toast——遮罩 z 在 toast 之上，磨砂会把 toast 糊掉（textContent 填充，上游报错文本不可信） */
.modal-foot .mferr{flex:1;min-width:0;margin:0;color:var(--err);font-size:var(--fs-sm);word-break:break-all}
/* 自适应兜底（任何宽度恒开，不再只限窄屏）：比例壳 ≥1000px 收窄内容带后，顶栏与固定宽度表格同样要活下来 */
/* 日志表滚动壳=浮头表格契约的卡内滚动容器：竖向也在这里滚（max-height 封顶），thead th 相对它吸附；
   外滚吸附要对齐页面 sticky 页头高度（窄屏折行不定值），故页级表格用内滚变体 */
.tablescroll{overflow:auto;max-height:60vh;-webkit-overflow-scrolling:touch}
/* 顶栏允许折行；健康文本可截断，不把语言/主题按钮挤出内容带 */
header{flex-wrap:wrap;row-gap:4px}
#health{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 定时切换面板列宽固定：行保持最小 654px 列宽，容器放不下时面板内横向滚动、不让页面横移
   （页首表格不套浮头的既定例外，禁律①不适用）；比例壳收窄内容带后与手机断点同一套行为 */
#schedPanel{overflow-x:auto}
#schedPanel .shead,#schedPanel .srow{min-width:654px}
@media (max-width:480px){
  /* 窄屏：固定列收窄（96→72px）但 ID 列仍保 110px 下限，整表横向滚动（滚动容器已在上方统一给） */
  .svcform .mhead,.svcform .mrow,.svcform .addrow{grid-template-columns:20px minmax(110px,1fr) 72px 72px 52px 44px;gap:6px;min-width:400px}
  .svcform .mrow input:not([type=checkbox]),.svcform .addrow input{width:100%;min-width:0;padding:4px 6px}
  .svcform .mhead span{width:auto;flex:none}
  .svcform .addrow .btn{padding:4px 8px}
  /* 拉取面板表头：长标签独占第二行（跨全列），列头钉回第 3/4/5/6 列与数据行对齐 */
  .fetchpanel .mhead span:nth-of-type(1){grid-column:1 / -1;grid-row:2;align-self:center}
  .fetchpanel .mhead span:nth-of-type(2){grid-column:3;grid-row:1}
  .fetchpanel .mhead span:nth-of-type(3){grid-column:4;grid-row:1}
  .fetchpanel .mhead span:nth-of-type(4){grid-column:5;grid-row:1}
  .fetchpanel .mhead span:nth-of-type(5){grid-column:6;grid-row:1}
}
`
