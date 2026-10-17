/**
 * Web 控制台 v2：面向用户任务而非内部概念。
 * 三步式：① 添加模型服务（粘贴 Key 即可）→ ② 点「应用」切换 → ③ 一键接入 AI 客户端。
 * 管理面读写一律要求 admin 凭据（x-modeldock-admin 头，或 ?token= 登录种下的 mdk_admin cookie）；
 * 未带凭据打开时由 showLoginRequired 给出可操作指引。
 */
import { CONSOLE_SHARED_JS } from './console-shared.js'
export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>ModelDock</title>
<script>try{document.documentElement.setAttribute('data-theme',localStorage.getItem('mdk_theme')||'auto')}catch(e){}</script>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236d7cff'/%3E%3Cstop offset='1' stop-color='%234f46e5'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='15' fill='url(%23g)'/%3E%3Cpath d='M14 46V20l18 15 18-15V46' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
/* 主题：暗色为品牌默认（独立窗口/系统亮色下也一致）；亮色经 prefers-color-scheme:light
 * 或手动切换（data-theme=light）。切到暗色的场景用 data-theme=dark 抑制 light 块。 */
:root{
  --bg:#0f1115; --card:#171a21; --text:#e5e7eb; --muted:#9ca3af; --border:#2a2f3a;
  --accent:#3b82f6; --accent-weak:#16233c; --ok:#22c55e; --ok-weak:#10241a; --warn:#d97706; --err:#ef4444;
  --direct-bg:rgba(217,119,6,.16); --direct-border:rgba(217,119,6,.55); --direct-text:#f5b04c;
  --direct-bg-h:rgba(217,119,6,.28); --direct-border-h:rgba(217,119,6,.8); --direct-text-h:#ffc06a;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* 设计令牌：字号 6 档 / 圆角 3 档 / 星标琥珀，全站只经变量取值（控件图标一律走 SVG 图标集 icon()，句子文案里的 ✓⚠ 除外）；
   * 控件字级=sm 13、按钮=md 14、徽标/注释=xs 12、正文=base 15（见 .agents/conventions/ui-kit.md） */
  --fs-xs:12px; --fs-sm:13px; --fs-md:14px; --fs-base:15px; --fs-lg:17px; --fs-xl:18px;
  --r-sm:8px; --r-md:10px; --r-lg:14px; --r-full:999px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
  --h-sm:28px; --h-md:34px; --h-lg:40px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.25); --shadow-md:0 4px 14px rgba(0,0,0,.2); --shadow-lg:0 18px 50px rgba(0,0,0,.35);
  --star:#f5a623;
  --scrim:rgba(0,0,0,.5);
  --z-sticky:35; --z-fab:40; --z-toast:50; --z-pop:70; --z-modal:100;
  --dur:.15s;
  color-scheme:dark;
}
:root[data-theme="light"]{
  --bg:#f5f6f8; --card:#ffffff; --text:#1a1f2e; --muted:#6b7280; --border:#e5e7eb;
  --accent:#2563eb; --accent-weak:#eff6ff; --ok:#16a34a; --ok-weak:#f0fdf4; --err:#dc2626;
  --direct-bg:rgba(217,119,6,.14); --direct-border:rgba(217,119,6,.5); --direct-text:#b45309;
  --direct-bg-h:rgba(217,119,6,.24); --direct-border-h:rgba(217,119,6,.75); --direct-text-h:#b45309;
  --shadow-sm:0 1px 2px rgba(0,0,0,.08); --shadow-md:0 4px 14px rgba(0,0,0,.1); --shadow-lg:0 18px 50px rgba(0,0,0,.18);
  color-scheme:light;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]):not([data-theme="light"]){
    --bg:#f5f6f8; --card:#ffffff; --text:#1a1f2e; --muted:#6b7280; --border:#e5e7eb;
    --accent:#2563eb; --accent-weak:#eff6ff; --ok:#16a34a; --ok-weak:#f0fdf4; --err:#dc2626;
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
.wrap{max-width:860px;margin:0 auto;padding:0 16px 64px}
header{position:sticky;top:0;z-index:var(--z-sticky);background:var(--bg);display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid var(--border);margin-bottom:14px}
.logo{display:flex;align-items:center}
.logo svg{display:block;border-radius:7px;box-shadow:0 1px 4px rgba(79,70,229,.35)}
.brand{font-size:var(--fs-xl);font-weight:700;letter-spacing:.01em}
#health{margin-left:8px;font-size:var(--fs-sm);color:var(--muted)}
#health .dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:var(--ok);margin-right:5px}
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
.fab{position:fixed;right:22px;bottom:22px;width:54px;height:54px;border-radius:50%;background:var(--accent);border:none;color:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(37,99,235,.45);z-index:calc(var(--z-fab) + 1);display:flex;align-items:center;justify-content:center;padding:0}
.fab[hidden]{display:none}
.fab:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(37,99,235,.55)}
/* 回到顶部/跳到底部按钮：竖排在右下角「＋」按钮上方（dsh 风格细箭头） */
.snav{position:fixed;right:29px;width:40px;height:40px;border-radius:50%;background:var(--card);border:1px solid var(--border);color:var(--muted);cursor:pointer;z-index:var(--z-fab);display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.10);transition:color .15s,border-color .15s,background .15s,transform .15s,box-shadow .15s}
.snav:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-weak);transform:translateY(-2px);box-shadow:0 6px 18px rgba(37,99,235,.22)}
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
#timePickPop{position:fixed;z-index:var(--z-pop);display:none;background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:0 8px 30px rgba(0,0,0,.35);padding:8px}
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
#timePickPop .tpcell:hover{background:rgba(127,127,127,.18)}
#timePickPop .tpcell.on{background:var(--accent);color:#fff}
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
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{opacity:.88;color:#fff}
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
.btn.ghost-danger:hover{border-color:var(--err);color:var(--err);background:rgba(220,38,38,.06)}
/* 当前使用中的服务：页面最重要的状态——弱底色 + 左侧主题色竖条，一眼锁定 */
.service.cur{background:var(--accent-weak);border-bottom-color:transparent;box-shadow:inset 3px 0 0 var(--accent);margin:3px 0}
.service.cur:last-child{margin-bottom:0}
.service .info{flex:1;min-width:200px}
.service .name{font-weight:600}
.service.cur .name{color:var(--accent)}
.service .meta{color:var(--muted);font-size:var(--fs-sm);font-family:var(--mono)}
.pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:var(--r-full);font-size:var(--fs-xs);border:1px solid var(--border);color:var(--muted);white-space:nowrap;font-weight:400}
.pill.ok{color:var(--ok);border-color:var(--ok);background:var(--ok-weak)}
.pill.err{color:var(--err);border-color:var(--err);background:rgba(220,38,38,.08)}
.pill.warn{color:var(--warn);border-color:var(--warn);background:rgba(217,119,6,.08)}
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
.pill>.caret{background:none;border:none;color:inherit;font:inherit;align-self:stretch;margin:-3px -11px -3px 4px;padding:0 11px 0 8px;border-left:1px solid rgba(127,127,127,.35);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.pill>.caret::before{content:'';display:inline-block;width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);transition:transform var(--dur)}
.pill>.caret.open::before{transform:rotate(225deg)}
.pill>.caret:hover{color:var(--accent)}
.pill>.caret:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:0 var(--r-full) var(--r-full) 0}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-1px;margin-right:6px}
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
.testres{font-size:var(--fs-xs);margin-right:10px;color:var(--muted);white-space:nowrap}
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
#pkgPill{margin-left:auto}
#lanPanel{margin:-6px 0 12px;padding:10px 12px;border:1px dashed var(--border);border-radius:var(--r-md)}
#lanPanel .lanflex{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
#lanPanel .laninfo{flex:1;min-width:200px}
#lanPanel .lanurl{word-break:break-all;margin:0 0 8px;cursor:pointer;font-family:var(--mono);font-size:var(--fs-sm)}
#lanPanel .shint{font-size:var(--fs-sm);color:var(--muted);margin:0}
#lanPanel svg{display:block;background:#fff;border-radius:8px;padding:4px;width:88px;height:88px}
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
.filechip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:99px;padding:4px 10px;font-size:var(--fs-sm);max-width:60%}
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
.switch .track::after{content:'';position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:var(--shadow-sm);transition:transform var(--dur)}
.switch input:checked+.track{background:var(--ok)}
.switch input:checked+.track::after{transform:translateX(15px)}
.switch input:disabled+.track{opacity:.5}
.tswitch{display:inline-flex;align-items:center;gap:7px;font-size:var(--fs-sm);color:var(--muted);cursor:pointer;white-space:nowrap}
/* Segmented 分段控件：互斥选项切换；.grow=通宽等分（导入弹层选项卡）；选中=蓝底白字 */
.seg{display:inline-flex;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);padding:3px;gap:2px}
.seg button{padding:5px 14px;border-radius:7px;font-size:var(--fs-sm);color:var(--muted);cursor:pointer;white-space:nowrap;transition:all var(--dur)}
.seg button:hover{color:var(--text)}
.seg button.on{background:var(--accent);color:#fff;font-weight:600}
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
/* 窄屏兜底（手机浏览器/半屏分屏）：主布局本就流式折行，这里只处理固定宽度表格与顶栏 */
/* 日志表滚动壳=浮头表格契约的卡内滚动容器：竖向也在这里滚（max-height 封顶），thead th 相对它吸附；
   外滚吸附要对齐页面 sticky 页头高度（窄屏折行不定值），故页级表格用内滚变体 */
.tablescroll{overflow:auto;max-height:60vh;-webkit-overflow-scrolling:touch}
@media (max-width:600px){
  /* 顶栏允许折行；健康文本可截断，不把语言/主题按钮挤出视口 */
  header{flex-wrap:wrap;row-gap:4px}
  #health{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 定时切换面板保持网格列宽，面板内横向滚动（网格列多为固定 px，窄屏放不下）；
     1fr 列需最小宽度，否则被压成逐字竖排而不是触发滚动 */
  #schedPanel{overflow-x:auto}
  #schedPanel .shead,#schedPanel .srow{min-width:654px}
}
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
</style>
</head>
<body>
<div class="wrap">
<header>
  <span class="logo"><svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#hlg)"/><path d="M14 46V20l18 15 18-15V46" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand">ModelDock</span>
  <span id="health">连接中…</span>
  <span id="syncBadge" class="pill" hidden></span>
  <span id="updBadge" class="pill" hidden></span>
  <span id="langSwitch" class="seg"><button type="button" data-lang="zh">中文</button><button type="button" data-lang="en">EN</button></span>
  <span id="themeSwitch"><button type="button" id="themeBtn" class="tip" data-i18n-tip="主题：自动跟随系统 / 暗色 / 亮色||Theme: auto (follow system) / dark / light" data-tip="主题：自动跟随系统 / 暗色 / 亮色">🎨 自动</button></span>
</header>

<div class="card migrate" id="migrateCard" hidden>
  <h2 data-i18n="🧲 检测到旧配置，可以一键搬进来||🧲 Old configs detected — import them in one click">🧲 检测到旧配置，可以一键搬进来</h2>
  <p class="desc" id="migDesc"></p>
  <div class="row">
    <button class="btn primary" id="migGo" data-i18n="一键导入||Import now">一键导入</button>
    <button class="btn" id="migSkip" data-i18n="暂不导入||Not now">暂不导入</button>
  </div>
  <div class="testline" id="migMsg"></div>
</div>

<div class="card migrate" id="shareReqCard" hidden>
  <h2 data-i18n="📲 附近的电脑请求拉取你的配置||📲 A nearby computer requests your config">📲 附近的电脑请求拉取你的配置</h2>
  <p class="desc" id="shareReqDesc"></p>
  <div class="row">
    <button class="btn primary" id="shareReqAllow" data-i18n="允许拉取||Allow">允许拉取</button>
    <button class="btn" id="shareReqDeny" data-i18n="拒绝||Deny">拒绝</button>
  </div>
</div>

<div id="addCardSlot"></div>

<div class="card" id="addCard" hidden>
  <h2 id="addH">① 添加模型服务</h2>
  <p class="desc" data-i18n="选一个服务商，粘贴 Key 即用；Key 只保存在你自己电脑上。||Pick a provider, paste your API key, and you're set. The key stays on your own computer.">选一个服务商，粘贴 Key 即用；Key 只保存在你自己电脑上。</p>
  <div class="chips" id="chips"></div>
  <div class="addform svcform" id="addform" hidden>
    <h3 id="afTitle"></h3>
    <!-- 字段由三个公共块生成（端点/模型/故障切换，与编辑页同构）；壳里只留 Key 与动作区 -->
    <div id="afEpHost"></div>
    <label class="flabel">API Key
      <span class="keywrap">
        <input type="password" id="afKey" data-i18n-ph="粘贴 API Key（输入不回显）||Paste API key (input hidden)" placeholder="粘贴 API Key（输入不回显）">
        <button type="button" id="afKeyToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn">👁</button>
      </span>
    </label>
    <div id="afModelHost"></div>
    <div id="afFbHost"></div>
    <div class="addfoot" id="afActions">
      <div class="testline" id="afMsg"></div>
      <button class="btn" id="afCancel" data-i18n="取消||Cancel">取消</button>
      <button class="btn primary" id="afSave" data-i18n="保存||Save">保存</button>
    </div>
    </div>
    <!-- 收编入口放 addCard 直属层（不进 #addform）：不选服务商也要可见可用 -->
    <p class="altline"><button type="button" class="btn small" id="legacyImportLink" data-i18n="从本机客户端导入存量配置…||Import existing configs from local apps…">从本机客户端导入存量配置…</button></p>
  </div>

<div class="card">
  <h2 id="svcH">② 我的服务</h2>
  <p class="desc" data-i18n="点「应用」全局切换，已接入的客户端立即生效。||Click &quot;Apply&quot; to switch globally; attached clients take effect immediately.">点「应用」全局切换，已接入的客户端立即生效。</p>
  <div class="svc-toolbar">
    <input type="text" id="svcQ" data-i18n-ph="搜索名称 / 接口地址 / 模型 ID…||Search name / URL / model ID…" placeholder="搜索名称 / 接口地址 / 模型 ID…">
    <select id="svcSort">
      <option value="default" data-i18n="排序：使用中置顶 · 名称||Sort: in-use first · name">排序：使用中置顶 · 名称</option>
      <option value="name-az" data-i18n="名称 A→Z||Name A→Z">名称 A→Z</option>
      <option value="name-za" data-i18n="名称 Z→A||Name Z→A">名称 Z→A</option>
      <option value="cnt-desc" data-i18n="模型数 多→少||Models high→low">模型数 多→少</option>
      <option value="cnt-asc" data-i18n="模型数 少→多||Models low→high">模型数 少→多</option>
    </select>
    <select id="svcFilter">
      <option value="all" data-i18n="全部||All">全部</option>
      <option value="key" data-i18n="有 Key||Has key">有 Key</option>
      <option value="nokey" data-i18n="缺 Key||Missing key">缺 Key</option>
      <option value="current" data-i18n="使用中||In use">使用中</option>
    </select>
  </div>
  <div id="routebox">
    <div class="rrow1" id="rrow1">
      <label><span data-i18n="当前||Current" data-i18n-title="实际使用中的主服务：「自动 · X」=由程序按定时窗口/默认路由选；人工选某服务=立即钉定使用它（优先于定时窗口，直到选回「自动」）||The primary service in use: &quot;Auto · X&quot; = the program picks it via schedule windows/default route; picking a service pins it immediately (overrides schedule windows until you pick &quot;Auto&quot; again)" title="实际使用中的主服务：「自动 · X」=由程序按定时窗口/默认路由选；人工选某服务=立即钉定使用它（优先于定时窗口，直到选回「自动」）">当前</span>
        <select id="curSvcSel"></select>
      </label>
      <span class="pill sw" id="schedPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="定时切换||Scheduled switching" data-i18n-title="按时间段自动切换主服务/模型（如：工作日高峰期避开 2 倍计费的服务；法定节假日全天谷价，加一条「法定节假日」时段优先走它）；人工钉定主服务期间窗口暂停；主体=启用/停用，右侧箭头=展开/收起时段列表||Switch primary service/model by time of day (e.g. avoid double-billed services at weekday peaks; add a &quot;Holidays&quot; window to prefer the off-peak service all day on statutory holidays); windows pause while the primary is pinned manually; body = enable/disable, arrow = expand/collapse windows"><span class="ptext">定时</span></button>
        <button type="button" class="caret" id="schedCaret" aria-expanded="false" aria-controls="schedPanel" data-i18n-title="展开/收起时段面板（不停服务）||Expand/collapse the schedule windows (service stays on)"></button>
      </span>
      <label><span data-i18n="下一个切换||Next failover" data-i18n-title="主服务不可用时切换到的服务：「自动 · B」=按故障切换顺序（备用服务优先级/实测耗时）自动选；人工选某服务=把它钉为下一个切换目标（主服务恢复后仍回主服务）；未设故障切换顺序时显示「自动 · 无备用服务」——主服务不可达将无处可切，可在服务编辑页的「故障切换顺序」里添加，或在此直接钉定一个服务||The service to switch to when the primary is down: &quot;Auto · B&quot; = picked by the failover order (fallback priority/latency); picking a service pins it as the next failover target (traffic returns to the primary once it recovers); with no failover order configured it reads &quot;Auto · no fallback&quot; — a failing primary has nowhere to switch to (add fallback services in the service editor, or pin one here)">下一个切换</span>
        <select id="autoRouteSel"><option value="">自动</option></select>
      </label>
    </div>
    <div class="rrow2" id="rrow2">
      <span class="pill sw" id="autoRoutePill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="自动路由||Auto route" data-i18n-title="开启后：定时时段由程序自动接管主服务（按窗口/默认路由选主）。故障切换（主服务不可达时切「下一个切换」）不受此开关影响，始终可用||When on, the program takes over primary selection during schedule windows (by window/default route). Failover (switching to Next when the primary is down) is always available regardless of this switch"><span class="ptext">自动路由</span></button>
      </span>
      <span class="pill sw" id="errPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="临时故障切备用||Failover on transient errors" data-i18n-title="主服务返回 429 限流或 503 服务不可用（过载）时，若还有备用服务则自动改发（请求未产出内容，无重复计费风险）||When the primary returns 429 (rate limited) or 503 (unavailable/overloaded) and a fallback exists, the request is re-sent automatically (nothing was produced, so no double billing)"><span class="ptext">临时故障切备用</span></button>
      </span>
      <span class="pill sw" id="fbPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="自动备用链||Auto fallback chain" data-i18n-title="手动备用链之外，自动把已启用的服务补进切换候选（按定时窗口 / 优先级 / 实测耗时排序，上限 3 个）；模型名原样透传，换模型请在客户端里换||Beyond the manual fallback list, eligible enabled services are appended as failover candidates (ranked by schedule window / priority / latency, capped at 3); the model name passes through unchanged — switch models in your client"><span class="ptext">自动备用链</span></button>
      </span>
      <span class="pill sw" id="asPill">
        <button type="button" class="psw-main" role="switch" aria-checked="false" data-i18n-aria="开机自启||Autostart" data-i18n-title="开机自动启动网关、崩溃自动拉起：重启/崩溃不再导致所有客户端断连。macOS 用 LaunchAgent，Linux 用 systemd 用户服务，Windows 用启动文件夹||Auto-start the gateway at login and revive it after crashes: reboots/crashes no longer disconnect every client. macOS uses LaunchAgent, Linux systemd user service, Windows Startup folder"><span class="ptext">开机自启</span></button>
      </span>
      <span class="pill sw" id="lanPill">
        <button type="button" class="psw-main" role="switch" aria-checked="false" data-i18n-aria="手机远程||Mobile console" data-i18n-title="手机扫码查看当前服务并切换（仅限局域网，不含 Key）；点击开关手机远程，点右侧箭头收起/展开二维码||Scan to view the active service and switch from your phone (LAN only, no keys); click to enable/disable, click the arrow to collapse/expand the QR"><span class="ptext">手机远程</span></button>
        <button type="button" class="caret" id="lanCaret" aria-expanded="false" aria-controls="lanPanel" data-i18n-title="展开/收起二维码面板（不停服务）||Expand/collapse the QR panel (service stays on)"></button>
      </span>
      <button type="button" class="btn small" id="pkgPill" data-i18n="配置包||Config package" data-i18n-title="把服务/路由/自定义预设/定时规则封装成口令保护的加密 .msync 文件（含 Key 密文），或生成一次性链接、允许附近电脑直接拉取；也能从文件/链接/附近电脑导入。客户端接入等机器态不随包||Seals providers, routes, custom presets, and schedule rules into a passphrase-protected encrypted .msync file (keys encrypted), or generates a one-time link and lets nearby computers pull directly; import from a file, a link, or nearby computers as well. Client attaches stay put">配置包</button>
    </div>
  </div>
  <div id="lanPanel" hidden>
    <div class="lanflex">
      <div id="lanQr"><p class="empty">…</p></div>
      <div class="laninfo">
        <p class="lanurl" id="lanUrl"></p>
        <div id="lanAlt" hidden>
          <p class="shint" data-i18n="手机连不上？换下面这条地址再试——电脑有多块网卡时，二维码可能选到了手机连不上的那块（VPN / 虚拟机网卡）：||Phone cannot connect? Try another address below — with several network adapters the QR may point at one your phone cannot reach (VPN or virtual-machine adapter):">手机连不上？换下面这条地址再试——电脑有多块网卡时，二维码可能选到了手机连不上的那块（VPN / 虚拟机网卡）：</p>
          <div id="lanAltUrls"></div>
        </div>
        <p class="shint" data-i18n="手机与电脑连同一 Wi-Fi，扫码或输入地址进入；页面只含「看状态 + 切服务」，不含 Key。||Phone on the same Wi-Fi: scan or type the address. The page is view &amp; switch only — no keys.">手机与电脑连同一 Wi-Fi，扫码或输入地址进入；页面只含「看状态 + 切服务」，不含 Key。</p>
        <p class="shint" id="lanWinHint" hidden data-i18n="Windows 首次开启手机远程会弹防火墙提示：请点「允许访问」，且把「专用网络」「公用网络」都勾上；漏点或点「取消」会导致手机打不开。||On Windows, enabling the mobile console pops a firewall alert the first time: click 'Allow access' and keep both Private and Public networks checked. Dismissing it makes the phone page unreachable.">Windows 首次开启手机远程会弹防火墙提示：请点「允许访问」，且把「专用网络」「公用网络」都勾上；漏点或点「取消」会导致手机打不开。</p>
      </div>
    </div>
  </div>
  <div id="schedPanel" hidden>
    <div class="sline">
      <span class="shint big" data-i18n="命中时段优先走指定服务/模型，或避开所选服务；其余时间走默认路由。需先开启自动路由。||Within a window: prefer the chosen service/model, or avoid a service; other times use the default route. Auto route must be on." data-i18n-title="多个优先时段按顺序取首个命中；所选服务全被避开时，其余服务照常优先级使用，不断供。||Multiple prefer windows: first match in order wins. If the avoided services cover everything available, the rest apply in original priority — no downtime." title="多个优先时段按顺序取首个命中；所选服务全被避开时，其余服务照常优先级使用，不断供。">命中时段优先走指定服务/模型，或避开所选服务；其余时间走默认路由。需先开启自动路由。</span>
    </div>
    <div class="shint" id="schedToday"></div>
    <div class="shead"><span data-i18n="模式||Mode">模式</span><span data-i18n="生效日||Days">生效日</span><span data-i18n="开始||Start">开始</span><span data-i18n="结束||End">结束</span><span data-i18n="服务||Service">服务</span><span data-i18n="使用的模型||Model used">使用的模型</span><span></span></div>
    <div id="schedRows"></div>
    <div class="srow">
      <select id="schedNewMode"><option value="" data-i18n="优先走||Prefer">优先走</option><option value="avoid" data-i18n="避开||Avoid">避开</option></select>
      <select id="schedNewDays" data-i18n-title="工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日||Weekdays = Mon&ndash;Fri plus makeup workdays, excluding statutory holidays; Weekend = Sat &amp; Sun; Holidays = statutory off days per State Council announcements" title="工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日"><option value="" data-i18n="每天||Every day">每天</option><option value="wd" data-i18n="工作日||Weekdays">工作日</option><option value="we" data-i18n="周末||Weekend">周末</option><option value="hol" data-i18n="法定节假日||Holidays">法定节假日</option></select>
      <span class="tfield"><input type="text" class="tinput" id="schedNewStart" inputmode="numeric" maxlength="5" placeholder="--:--" data-i18n-title="点击选择时间，也可直接键入 HH:mm||Click to pick a time, or type HH:mm" title="点击选择时间，也可直接键入 HH:mm"></span>
      <span class="tfield"><input type="text" class="tinput" id="schedNewEnd" inputmode="numeric" maxlength="5" placeholder="--:--" data-i18n-title="点击选择时间，也可直接键入 HH:mm||Click to pick a time, or type HH:mm" title="点击选择时间，也可直接键入 HH:mm"></span>
      <select id="schedNewSvc"></select>
      <select id="schedNewModel"></select>
      <button type="button" class="btn small" id="schedAdd" data-i18n-title="添加时段||Add window" title="添加时段">＋</button>
    </div>
    <div class="sline hol" id="schedUpcomingRow" hidden>
      <span id="schedUpcoming" class="shint"></span>
    </div>
    <div class="testline" id="schedMsg"></div>
  </div>
  <div id="services"></div>
</div>

<div class="card">
  <h2 id="cliH"><span id="cliHText">③ 接入你的 AI 客户端</span> <span class="pill ok" id="cliCount" hidden></span></h2>
  <p class="desc" data-i18n="每个客户端只需接入一次。接入时只改它的「接口地址」，改前自动备份，随时可断开还原。||Attach each client once. Attaching only changes its base URL, with an automatic backup beforehand — detach anytime to restore.">每个客户端只需接入一次。接入时只改它的「接口地址」，改前自动备份，随时可断开还原。</p>
  <div id="clients"></div>
</div>

<div class="card">
  <h2><span data-i18n="请求日志||Request log">请求日志</span></h2>
  <p class="desc" data-i18n="仅展示错误请求（4xx/5xx）与控制台操作；正常请求只写入 logs/ 日志文件，不在这里刷屏。||Only error requests (4xx/5xx) and console operations are shown; normal requests are written to the logs/ files only.">仅展示错误请求（4xx/5xx）与控制台操作；正常请求只写入 logs/ 日志文件，不在这里刷屏。</p>
  <div class="tablescroll"><table id="logTable"></table></div>
  <div id="logPager">
    <span class="pglabel">
      <span data-i18n="每页||Per page">每页</span>
      <select id="logPageSize">
        <option value="10">10</option>
        <option value="30">30</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
      <span data-i18n="条||entries">条</span>
    </span>
    <button class="btn small" id="logPrev" data-i18n="上一页||Prev" title="上一页">上一页</button>
    <span id="logPageInfo">1 / 1</span>
    <button class="btn small" id="logNext" data-i18n="下一页||Next" title="下一页">下一页</button>
  </div>
  <p class="note"><span data-i18n="配置和 Key 保存在 ||Config and keys are stored in ">配置和 Key 保存在 </span><code id="cfgPath">~/.modeldock/</code><span data-i18n="。本页覆盖日常操作；模型别名映射等高级配置用命令行 ||. This page covers daily operations; advanced settings like model alias mapping use the CLI ">.本页覆盖日常操作；模型别名映射等高级配置用命令行 </span><code>modeldock --help</code><span data-i18n="。||.">。</span></p>
</div>
</div>

<button class="fab" id="fabAdd" hidden data-i18n-tip="添加模型服务||Add a model service" data-tip="添加模型服务">＋</button>

<button class="snav" id="snavUp" hidden data-i18n-tip="回到页面顶部||Back to top" data-tip="回到页面顶部"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.8 12 8.8l6 6"/></svg></button>
<button class="snav" id="snavDown" hidden data-i18n-tip="跳到页面底部||Jump to bottom" data-tip="跳到页面底部"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.2 12 15.2l6-6"/></svg></button>

<div class="toast-wrap" id="toastWrap" role="status" aria-live="polite"></div>


<script>
(function () {
  var $ = function (s) { return document.querySelector(s) }
  // SVG 图标集（kit 组件）：24 网格 / currentColor / stroke 2，替代跨平台不一致的字符字形；
  //    句子文案内嵌的 ✓⚠ 等保留文本形态，只有「控件上的图标」走这里
  var IC = {
    check: '<path d="M20 6L9 17l-5-5"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    // 状态/语义图标：锁=由本网关托管、链=独立直连、齿轮=控制台操作、外链箭头=打开外部文档
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    'arrow-up-right': '<path d="M7 17L17 7M8 7h9v9"/>',
  }
  function icon(name, size) {
    var w = size || 14
    return '<svg width="' + w + '" height="' + w + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[name] || '') + '</svg>'
  }
  // 行内图标（pill / 表格单元格 / 标题前缀）：包一层与文字基线对齐的壳，间距由调用方的空格掌控
  function iconInline(name, size) {
    return '<span class="ic">' + icon(name, size) + '</span>'
  }
  // 弹层壳组件（kit「Modal 壳」代码化）：统一磨砂遮罩 / head+body+foot 三层 / Esc+遮罩关闭 / aria / 底栏槽位。
  // 此前 6 份手写壳两种背景、Esc 与遮罩关闭各有各的写法；底栏=可配置槽位（msg 槽 + 按钮序列），
  // 谁有取消、谁是主按钮仍由调用方定（评审定稿语义不变）。scrim 沿用既有 overlay id——
  // id 作用域的 CSS/JS 引用全部保持有效；壳逐期迁入（未迁壳走原静态 HTML，互不影响）。
  var modalStack = []
  function createModal(opts) {
    var scrim = document.createElement('div')
    scrim.className = 'modal-scrim ' + (opts.align === 'top' ? 'top' : 'center')
    scrim.id = opts.id
    scrim.hidden = true
    var modal = document.createElement('div')
    modal.className = 'modal pad0' + (opts.modalClass ? ' ' + opts.modalClass : '')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    var head = document.createElement('div')
    head.className = 'modal-head'
    var h3 = document.createElement('h3')
    if (opts.titleId) h3.id = opts.titleId
    if (opts.title) { h3.setAttribute('data-i18n', opts.title); h3.textContent = t(opts.title.split('||')[0], opts.title.split('||')[1]) }
    head.appendChild(h3)
    if (opts.closeButton !== false) {
      var xrow = document.createElement('div')
      xrow.className = 'close-row'
      var x = document.createElement('button')
      x.type = 'button'
      x.className = 'close-btn'
      x.setAttribute('data-i18n-title', '关闭||Close')
      x.title = t('关闭', 'Close')
      x.onclick = function () { m.close() }
      xrow.appendChild(x)
      head.appendChild(xrow)
    }
    modal.appendChild(head)
    var body = document.createElement('div')
    body.className = 'modal-body' + (opts.bodyClass ? ' ' + opts.bodyClass : '')
    if (opts.bodyId) body.id = opts.bodyId
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml
    modal.appendChild(body)
    var foot = document.createElement('div')
    foot.className = 'modal-foot'
    if (opts.footId) foot.id = opts.footId
    ;(opts.foot || []).forEach(function (it) {
      if (it.slot === 'msg') {
        var s = document.createElement(it.kind === 'err' ? 'span' : 'div')
        s.id = it.id
        s.className = it.kind === 'err' ? 'mferr' : 'testline'
        foot.appendChild(s)
        return
      }
      var b = document.createElement('button')
      b.type = 'button'
      b.id = it.id
      b.className = 'btn' + (it.primary ? ' primary' : '') + (it.end ? ' end' : '')
      if (it.html) b.innerHTML = it.html
      else if (it.label) { b.setAttribute('data-i18n', it.label); b.textContent = t(it.label.split('||')[0], it.label.split('||')[1]) }
      if (it.title) { b.setAttribute('data-i18n-title', it.title); b.title = t(it.title.split('||')[0], it.title.split('||')[1]) }
      if (it.disabled) b.disabled = true
      if (it.onClick) b.onclick = it.onClick
      foot.appendChild(b)
    })
    if (opts.footHidden) foot.hidden = true
    modal.appendChild(foot)
    scrim.appendChild(modal)
    document.body.appendChild(scrim)
    if (opts.closeOnScrim) {
      scrim.addEventListener('click', function (e) { if (e.target === scrim) m.close() })
    }
    var m = {
      scrim: scrim, body: body, foot: foot,
      _closeOnEsc: opts.closeOnEsc !== false,
      isOpen: function () { return !scrim.hidden },
      open: function () {
        if (!scrim.hidden) return
        Array.prototype.forEach.call(foot.querySelectorAll('.mferr'), function (el) { el.textContent = '' })
        scrim.hidden = false
        modalStack.push(m)
        if (opts.onOpen) opts.onOpen()
      },
      close: function () {
        if (scrim.hidden) return
        scrim.hidden = true
        var at = modalStack.indexOf(m)
        if (at >= 0) modalStack.splice(at, 1)
        if (opts.onClose) opts.onClose()
      },
    }
    return m
  }
  // Esc 关最上层弹层（closeOnEsc:false 的壳跳过且不穿透到下层）
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !modalStack.length) return
    for (var i = modalStack.length - 1; i >= 0; i--) {
      var mm = modalStack[i]
      if (mm._closeOnEsc !== false) { mm.close(); break }
    }
  })
  // 配置包统一弹层（导出|导入 一级方向 Seg；导出=附近的电脑/导出链接/导出配置包 三方式，
  // 与导入面板同名同序镜像）。吸收原 shareM（链接）与 importM（导入三来源），
  // 导入内部结构原样保留（segNearby/segLink/segFile 等 id 不变，JS 接线零改动）。
  var pkgM = createModal({
    id: 'pkgOverlay',
    title: '配置包||Config package',
    align: 'top',
    closeOnScrim: true,
    bodyHtml: '<div id="pkgDir" class="seg grow">' +
      '<button type="button" class="on" id="pkgDirExport" data-i18n="导出||Export">导出</button>' +
      '<button type="button" id="pkgDirImport" data-i18n="导入||Import">导入</button></div>' +
      '<div id="pkgExportPane">' +
      '<div id="pkgExpTabs" class="seg grow" style="margin-top:10px">' +
      '<button type="button" id="segExpNearby" data-i18n="附近的电脑||Nearby computers">附近的电脑</button>' +
      '<button type="button" id="segExpLink" data-i18n="导出链接||Export a link">导出链接</button>' +
      '<button type="button" class="on" id="segExpFile" data-i18n="导出配置包||Export package file">导出配置包</button></div>' +
      '<div id="panelExpNearby" hidden style="margin-top:10px">' +
      '<p class="testline" id="expNearbyState"></p>' +
      '<p class="row" style="margin:6px 0 0"><button type="button" class="btn small" id="expLanOn" hidden data-i18n="立即开启||Enable now">立即开启</button></p>' +
      '<p class="help" data-i18n="无需导出操作：对方在「导入 → 附近的电脑」里选中这台电脑即可直接拉取；对方发起时你会收到授权请求，点「允许拉取」完成。Windows 首次开启会弹防火墙提示，选「允许访问」。||Nothing to export here: on the other computer, pick this machine under Import → Nearby computers to pull directly. When they initiate, you get an approval prompt — click Allow. On Windows, first enable pops a firewall alert; choose Allow access.">无需导出操作：对方在「导入 → 附近的电脑」里选中这台电脑即可直接拉取；对方发起时你会收到授权请求，点「允许拉取」完成。Windows 首次开启会弹防火墙提示，选「允许访问」。</p></div>' +
      '<div id="panelExpLink" hidden style="margin-top:10px">' +
      '<div id="shareUrls"></div><button type="button" class="alt-toggle" id="shareAltToggle" hidden></button><div class="altlist" id="shareAlts" hidden></div>' +
      '<p class="help" data-i18n="10 分钟内有效 · 拉取一次即作废 · 链接含口令，仅发本人；两台电脑需连同一局域网。||Valid for 10 minutes and works once; the link carries the passphrase — send it only to the intended recipient. Both computers need the same LAN.">10 分钟内有效 · 拉取一次即作废 · 链接含口令，仅发本人；两台电脑需连同一局域网。</p></div>' +
      '<div id="panelExpFile" style="margin-top:10px">' +
      '<span class="keywrap"><input type="password" id="pkgPw" autocomplete="new-password" data-i18n-ph="设置口令||Set a passphrase" placeholder="设置口令">' +
      '<button type="button" id="pkgPwToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn"></button></span>' +
      '<p class="help" data-i18n="文件含全部 Key · 口令丢失无法找回，建议与文件分开发送；不要求同一局域网。||The file carries every key (encrypted); a lost passphrase cannot be recovered — send it separately from the file. No LAN needed.">文件含全部 Key · 口令丢失无法找回，建议与文件分开发送；不要求同一局域网。</p></div>' +
      '</div>' +
      '<div id="pkgImportPane" hidden>' +
      '<div id="importTabs" class="seg grow" style="margin-top:10px">' +
      '<button type="button" class="on" id="segNearby" data-i18n="附近的电脑||Nearby computers">附近的电脑</button>' +
      '<button type="button" id="segLink" data-i18n="粘贴链接||Paste a link">粘贴链接</button>' +
      '<button type="button" id="segFile" data-i18n="配置包文件||Package file">配置包文件</button></div>' +
      '<div id="importPanels"><div id="panelNearby"><p class="shint" id="nearbyStatus" style="margin-top:0"></p><div id="impPeers"></div></div>' +
      '<div id="panelLink" hidden><textarea id="impUrl" data-i18n-ph="粘贴分享链接：http://192.168.x.x:8787/…#p=…||Paste the share link: http://192.168.x.x:8787/…#p=…" placeholder="粘贴分享链接：http://192.168.x.x:8787/…#p=…"></textarea></div>' +
      '<div id="panelFile" hidden><p class="row" style="margin:0 0 10px;align-items:center">' +
      '<button type="button" class="btn" id="impFileBtn" data-i18n="选择文件||Choose file">选择文件</button>' +
      '<span id="impFileChip" class="filechip" hidden></span>' +
      // 不设 accept：iOS 选择器会把未注册的 .msync 灰掉（见 lan.ts 同处说明）
      '<input type="file" id="impFile2" hidden></p>' +
      '<input type="password" id="impPw2" data-i18n-ph="配置包口令（导出时设置）||Package passphrase (set at export)" placeholder="配置包口令（导出时设置）" style="width:100%;box-sizing:border-box"></div></div>' +
      '<div id="impPreview" hidden style="margin-top:8px"><p class="testline" id="impPreviewLine"></p>' +
      '<p class="row" style="margin:8px 0 0;align-items:center"><button type="button" class="btn small" id="impBackBtn" data-i18n="返回||Back">返回</button>' +
      '<button type="button" class="btn small primary" id="impConfirmBtn" data-i18n="确认导入||Confirm import">确认导入</button></p></div>' +
      '<p class="help" data-i18n="导入会整体替换现有服务、路由、预设与定时规则，导入前自动快照；客户端接入与网关设置不受影响。||Importing replaces providers, routes, presets and schedule rules; a snapshot is taken first — client attaches and gateway settings are untouched.">导入会整体替换现有服务、路由、预设与定时规则，导入前自动快照；客户端接入与网关设置不受影响。</p></div>',
    foot: [
      { slot: 'msg', id: 'pkgErr', kind: 'err' },
      { id: 'shareRegen', label: '重新生成||Regenerate', end: true, title: '作废当前链接并生成新的||Invalidate the current link and create a new one' },
      { id: 'shareCopyBtn', primary: true, html: '<span id="shareCopyIc"></span><span id="shareCopyTxt" data-i18n="复制链接||Copy link">复制链接</span>' },
      { id: 'impImportBtn', label: '导入||Import', primary: true, end: true, disabled: true },
      { id: 'pkgSaveBtn', label: '生成并下载||Create and download', primary: true, end: true },
    ],
  })
  // 存量收编重开入口（设计定稿）：首启横幅之外的常驻路径——从「添加服务」进入，勾选式导入；
  // 与配置包导入是两个概念（收编=本机客户端配置；配置包=.msync 文件/链接/附近）。
  var legacyM = createModal({
    id: 'legacyOverlay',
    title: '导入存量配置||Import existing configs',
    align: 'top',
    closeOnScrim: true,
    bodyHtml: '<p class="shint" id="legacyDesc" style="margin-top:0"></p><div id="legacyList"></div>' +
      '<p class="help" data-i18n="只读收编：读取一份副本建服务，原客户端不受影响；导入后可在「我的服务」里切换。||Read-only: a copy is read to create services; your original apps stay untouched. Switch them under My services afterwards.">只读收编：读取一份副本建服务，原客户端不受影响；导入后可在「我的服务」里切换。</p>',
    foot: [
      { slot: 'msg', id: 'legacyErr', kind: 'err' },
      { id: 'legacyGo', label: '导入所选||Import selected', primary: true, end: true, disabled: true },
    ],
  })
  var confirmM = createModal({
    id: 'overlay',
    titleId: 'mTitle',
    closeButton: false, // 确认类小弹层无 ✕：取消=唯一反悔路径（kit 底栏规则）
    closeOnScrim: false,
    bodyHtml: '<ul id="mList"></ul>',
    foot: [
      { id: 'mCancel', label: '取消||Cancel', end: true, onClick: function () { confirmM.close() } },
      { id: 'mOk', primary: true, onClick: function () { var cb = mCb; confirmM.close(); if (cb) cb() } },
    ],
    onClose: function () { mCb = null },
  })
  // 存量收编勾选列表已并入上方 legacyM；检查更新弹窗保持独立
  var updM = createModal({
    id: 'updOverlay',
    modalClass: 'upmodal',
    titleId: 'updTitle',
    closeOnScrim: true, // 点遮罩/Esc = 稍后（下个会话仍会提醒），与旧语义一致
    bodyHtml: '<div class="desc-sm" id="updSub"></div>' +
      // 更新进度（v1.1.1 起由 update-progress.json 驱动）：下载/校验/替换/重启各阶段 + 百分比
      '<div id="updProgress" hidden style="margin:8px 0 4px"><div class="progress"><div class="progress-fill" id="updProgressFill" style="width:0%"></div></div>' +
      '<p class="shint" id="updProgressText" style="margin:6px 0 0"></p></div>' +
      '<div class="upnotes" id="updNotes" hidden></div><div class="upmore" id="updMore" hidden></div>' +
      '<div class="uphint" data-i18n="更新时网关会短暂中断，完成后本页自动重连。||The gateway restarts briefly during the update; this page reconnects automatically.">更新时网关会短暂中断，完成后本页自动重连。</div>',
    foot: [
      { slot: 'msg', id: 'updMsg', kind: 'info' },
      { id: 'updCopy', label: '复制说明||Copy notes' },
      { id: 'updDismiss', label: '此版本不再提醒||Skip this version' },
      { id: 'updGo', primary: true },
    ],
  })
  // 三期迁入：编辑服务 / 添加模型服务（门户模式：addCard 内联卡与弹窗双宿主，open/close 时搬入搬出）
  var editM = createModal({
    id: 'editOverlay',
    align: 'top',
    modalClass: 'svcmodal',
    titleId: 'editTitle',
    bodyClass: 'editform svcform',
    bodyHtml: '<div id="efEpHost"></div>' +
      '<label>API Key<span class="keywrap"><input type="password" id="efKey" placeholder="已保存（留空不修改；点右侧按钮查看并拷贝）">' +
      '<button type="button" id="efKeyToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn"></button></span></label>' +
      '<div id="efModelHost"></div><div id="efFbHost"></div>',
    foot: [
      { slot: 'msg', id: 'efMsg', kind: 'info' },
      { id: 'efCancel', label: '取消||Cancel', onClick: function () { closeEdit() } },
      { id: 'efSave', label: '保存||Save', primary: true },
    ],
    onClose: function () { editing = null },
  })
  var addM = createModal({
    id: 'addOverlay',
    align: 'top',
    modalClass: 'svcmodal',
    title: '添加模型服务||Add a model service',
    bodyId: 'addModalBody',
    bodyClass: 'addmodal',
    footId: 'addFoot',
    footHidden: true,
    foot: [],
    closeOnScrim: true,
    onClose: function () {
      // 动作区随表单回内联宿主（原位=表单尾），卡片搬回页面槽位
      addOpen = false
      document.getElementById('addFoot').hidden = true
      document.getElementById('addform').appendChild(document.getElementById('afActions'))
      document.getElementById('addCardSlot').appendChild(document.getElementById('addCard'))
      if (view && view.services.length > 0) {
        document.getElementById('addCard').hidden = true
        $('#fabAdd').hidden = false
      }
    },
  })
  // 静态 HTML 里的图标按钮在此一次性填充（innerHTML 不含文本，applyI18n 只改 title 不受影响）
  document.querySelectorAll('.close-btn').forEach(function (el) { el.innerHTML = icon('close', 15) })
  var fabAddIc = document.getElementById('fabAdd')
  if (fabAddIc) fabAddIc.innerHTML = icon('plus', 24)
  var schedAddIc = document.getElementById('schedAdd')
  if (schedAddIc) schedAddIc.innerHTML = icon('plus', 13)
  var afKeyIc = document.getElementById('afKeyToggle')
  if (afKeyIc) afKeyIc.innerHTML = icon('eye', 14)
  var efKeyIc = document.getElementById('efKeyToggle')
  if (efKeyIc) efKeyIc.innerHTML = icon('eye', 14)
  var pkgPwIc = document.getElementById('pkgPwToggle')
  if (pkgPwIc) pkgPwIc.innerHTML = icon('eye', 14)
  var shareCopyIc = document.getElementById('shareCopyIc')
  if (shareCopyIc) shareCopyIc.innerHTML = icon('copy', 14)
  /* pillSwitch：状态行开关（kit 组件，见 .agents/conventions/ui-kit.md）。
     视觉 = 原 pill（.ptext 内嵌文案 + 可选 caret）；主体与 caret 是两个真实按钮（各自可 Tab）。
     封装四个历史坑：① 文案写内嵌 .ptext（直写根 textContent 会冲掉 caret）
     ② 唯一 set({on,busy,open}) 写入口（轮询重绘与回调共用，避免回灌旧值）
     ③ caret 点击 stopPropagation（不触发热区开关，收起面板不停服务）
     ④ busy 期显示「· …」并防连点；失败回弹由调用方 set({on:旧值}) */
  function pillSwitch(rootId, opt) {
    var root = document.getElementById(rootId)
    if (!root) return null
    var mainBtn = root.querySelector('.psw-main')
    var textEl = root.querySelector('.ptext') || mainBtn || root
    var caret = root.querySelector('.caret')
    var st = { on: !!opt.on, busy: false, open: false }
    var tipOverride = ''
    function fmt() {
      // label 允许传函数（惰性求值）：接线在模块顶层只跑一次，字符串 label 会把 t() 固化在加载时的语言里
      var label = typeof opt.label === 'function' ? opt.label() : opt.label
      if (st.busy) return label + t(' · …', ' · …')
      return opt.text ? opt.text(st.on) : label + ' · ' + (st.on ? t('开', 'on') : t('关', 'off'))
    }
    function render() {
      textEl.textContent = fmt()
      root.classList.toggle('ok', !st.busy && (opt.okOn ? opt.okOn(st.on) : st.on))
      if (mainBtn) mainBtn.setAttribute('aria-checked', st.on ? 'true' : 'false')
      // 悬停整颗 pill 都能看到提示：动态 tipOverride 优先，否则用主体按钮上的静态 i18n title
      root.title = tipOverride || (mainBtn ? (mainBtn.title || '') : '')
      if (caret) {
        caret.hidden = !st.on
        caret.setAttribute('aria-expanded', st.open ? 'true' : 'false')
        caret.classList.toggle('open', st.open)
      }
    }
    var api = {
      set: function (patch) {
        if (patch.on !== undefined) st.on = !!patch.on
        if (patch.busy !== undefined) st.busy = !!patch.busy
        if (patch.open !== undefined) st.open = !!patch.open
        render()
      },
      isOn: function () { return st.on },
      isOpen: function () { return st.open },
      setTip: function (text) { tipOverride = text || ''; render() },
      render: render,
    }
    root.addEventListener('click', function (e) {
      if (caret && e.target.closest && e.target.closest('.caret')) {
        e.stopPropagation()
        if (st.busy) return
        st.open = !st.open
        if (opt.panel) opt.panel().hidden = !st.open
        render()
        if (opt.onExpand) opt.onExpand(st.open)
        return
      }
      if (st.busy) return
      if (opt.onToggle) opt.onToggle(!st.on, api)
      else { st.on = !st.on; render() }
    })
    render()
    return api
  }
  var COMMON = ['custom', 'deepseek-anthropic', 'openai', 'anthropic']
  // 「更多服务」Top 10 白名单（2026-10 热度排序）：按服务商合并、条目本身已带多协议端点，
  // 选完表单里三行协议地址自动填好。协议变体与长尾厂商不再在 UI 列出（预设库保留，CLI / presets.json 仍可用）
  var MORE_TOP = ['bigmodel-anthropic', 'kimi-anthropic-cn', 'ark-coding-plan', 'ark-agent-plan', 'zai-anthropic', 'kimi-anthropic-global', 'mimo-token-plan-cn', 'dashscope-openai', 'openrouter', 'gemini-openai']
  var view = null
  var svcQ = '', svcSort = 'default', svcFilter = 'all'
  // 长列表防撑高：服务默认只渲染前 N 个（一键展开/收起，不用分页——切换服务不该翻页找）；客户端未安装项默认折叠
  var SVC_COLLAPSE_N = 8
  var svcExpanded = false
  var cliShowUninstalled = false
  // 正在自动安装的客户端（harness id → true）。做模块级标记而非按钮临时状态：5s 轮询整页重绘时会
  // 重建客户端列表，仅靠按钮上的「正在安装…」会被冲掉，导致安装未完成按钮就变回「安装并接入」，
  // 让人误以为点击没生效。标记由 renderClients 消费，跨重绘保持，安装完成/失败后才解除。
  var cliInstalling = {}

  // i18n：动态文案用 t(中文, English)；静态节点用 data-i18n(-ph/-title)="中文||English"，applyLang 统一切换
  var LANG = localStorage.getItem('mdk_lang') || 'zh'
  function t(zh, en) { return LANG === 'en' && en != null ? en : zh }
  function i18nPick(pairAttr) {
    var pair = pairAttr.split('||')
    return LANG === 'en' && pair[1] != null ? pair[1] : pair[0]
  }
  // 只替换元素里第一个非空文本节点：label 内嵌 input、h2 内嵌按钮等混合内容不会被清掉
  function setI18nText(el, txt) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = txt; return }
    }
    el.insertBefore(document.createTextNode(txt), el.firstChild)
  }
  function applyLang() {
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'
    // 静态节点文案扫描与 applyI18nTree 同源：全树委托，避免整页逐节点遍历写两遍（见 DUP-06）
    applyI18nTree(document)
    Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) { b.className = b.getAttribute('data-lang') === LANG ? 'on' : '' })
    renderThemeBtn()
    pollHealth() // 横幅健康文案也是动态的，切语言后立即重取
    if (view) render()
    // 状态行 pill 的文案在组件内自绘（render() 不一定逐个 set）：惰性 label 依赖这次重绘才换语言，根 title 同步跟上
    Array.prototype.forEach.call([autoRouteApi, errApi, fbApi, asApi, lanApi, schedApi], function (p) { if (p) p.render() })
  }

  // 主题：auto（跟随系统）/ dark / light，localStorage 持久化（head 早脚本已按存储值预设 data-theme）
  var THEME_LABELS = { auto: ['🎨 自动', '🎨 Auto'], dark: ['🌙 暗色', '🌙 Dark'], light: ['☀️ 亮色', '☀️ Light'] }
  function renderThemeBtn() {
    var btn = document.getElementById('themeBtn')
    if (!btn) return
    var cur = localStorage.getItem('mdk_theme')
    if (cur !== 'dark' && cur !== 'light') cur = 'auto'
    var labels = THEME_LABELS[cur]
    btn.textContent = LANG === 'en' ? labels[1] : labels[0]
  }
  document.getElementById('themeBtn').onclick = function () {
    var order = ['auto', 'dark', 'light']
    var cur = localStorage.getItem('mdk_theme')
    if (cur !== 'dark' && cur !== 'light') cur = 'auto'
    var next = order[(order.indexOf(cur) + 1) % order.length]
    localStorage.setItem('mdk_theme', next)
    document.documentElement.setAttribute('data-theme', next)
    renderThemeBtn()
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // 与手机同步页（lan.ts）同源的共用逻辑（parseTarget/impWarnList/routeSelectHtml）：注入单份共享片段，trT=本页翻译函数
  var trT = t
  ${CONSOLE_SHARED_JS}
  function toast(msg, ok) {
    var wrap = document.getElementById('toastWrap')
    if (!wrap) return
    // 消息用 textContent 填充（上游错误文本不可信）；复制按钮把完整报错一键进剪贴板，✕ 可手动关
    var el = document.createElement('div')
    el.className = 'toast ' + (ok === false ? 'err' : 'ok')
    var span = document.createElement('span')
    span.className = 'tmsg'
    span.textContent = msg
    el.appendChild(span)
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tcopy'
    btn.title = t('复制完整内容', 'Copy full text')
    btn.innerHTML = icon('copy', 14)
    btn.onclick = function () {
      copyText(msg, function () {
        btn.innerHTML = icon('check', 12)
        setTimeout(function () { btn.innerHTML = icon('copy', 14) }, 1200)
      })
    }
    el.appendChild(btn)
    var x = document.createElement('button')
    x.type = 'button'
    x.className = 'tx'
    x.title = t('关闭', 'Close')
    x.innerHTML = icon('close', 13)
    x.onclick = function () { el.remove() }
    el.appendChild(x)
    wrap.appendChild(el)
    // 错误停留更久（且不与成功提示互相挤掉彼此该有的可读时间）
    setTimeout(function () { el.remove() }, ok === false ? 8000 : 4200)
  }
  // 剪贴板 API 不可用时的兜底（非安全上下文/老 webview）
  function fallbackCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch (e) { /* 尽力而为 */ }
    ta.remove()
  }

  function api(path, opts) {
    opts = opts || {}
    // 请求级语言：服务端为本请求生成的文案（报错/卡片描述/审计条目）跟随控制台界面语言
    opts.headers = Object.assign({ 'content-type': 'application/json', 'x-modeldock-lang': LANG }, opts.headers || {})
    // 默认 15s 超时；install/fetch-models 等慢端点由调用方传 timeoutMs 放宽
    opts.signal = AbortSignal.timeout(opts.timeoutMs || 15000)
    return fetch('/_modeldock' + path, opts).then(
      function (res) {
        return res.text().then(function (text) {
          var j = null
          try { j = text ? JSON.parse(text) : null } catch (e) { /* 非 JSON 响应 */ }
          if (!res.ok) {
            var m = (j && j.error && j.error.message) || ('HTTP ' + res.status + (text ? '：' + text.slice(0, 120) : ''))
            if (j && j.modeldock && j.modeldock.hint) m = m + '（' + j.modeldock.hint + '）'
            var err = new Error(m)
            err.status = res.status
            throw err
          }
          if (j === null) throw new Error(t('网关返回了非 JSON 响应，请刷新页面重试', 'The gateway returned a non-JSON response; refresh the page and retry'))
          return j
        })
      },
      function (e) {
        if (e && e.name === 'TimeoutError') throw new Error(t('请求超时：', 'Request timed out: the gateway did not respond in ') + Math.round((opts.timeoutMs || 15000) / 1000) + t('s 内未响应', 's'))
        if (e && e.name === 'AbortError') throw new Error(t('请求已取消', 'Request cancelled'))
        throw new Error(t('无法连接本地网关（', 'Cannot reach the local gateway (') + (e && e.message) + t('）。请确认网关在运行：modeldock gateway start', '). Make sure it is running: modeldock gateway start'))
      }
    )
  }

  function load() {
    return api('/overview').then(function (v) {
      view = v
      knownModels = Object.assign({}, catalogTable, (v && v.knownModels) || {})
      loadCatalog()
      render()
      // 首次加载即刷新沙箱徽标与配置路径显示（pollOverview 只管后续轮询）
      $('#health').innerHTML = healthHtml()
      var cp = document.getElementById('cfgPath')
      if (cp && v.gateway && v.gateway.home) cp.textContent = v.gateway.home
      return checkMigrate()
    })
  }

  // models.dev 目录大表懒加载（只拉一次）：失败静默，自动补值仍有 overview 内置小表兜底
  function loadCatalog() {
    if (loadCatalog.done) return
    loadCatalog.done = true
    fetch('/_modeldock/model-catalog', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (v) {
      if (!v || !v.models) return
      catalogTable = v.models
      knownModels = Object.assign({}, catalogTable, (view && view.knownModels) || {})
    }).catch(function () {})
  }

  // 管理面已全面要求 admin 凭据：未登录（无 ?token= / cookie）打开时给出可操作的恢复路径。
  // 优先「重新登录」按钮：凭 1 年期设备记忆 cookie（首次 ?token= 登录时种下）一键恢复；
  // 无设备记忆（新浏览器/清理过 cookie）→ 按钮自动换成令牌粘贴输入框，Web 用户全流程不碰终端。
  function showLoginRequired() {
    var w = document.querySelector('.wrap')
    if (!w) return
    w.innerHTML = '<div class="loginbox"><span class="name">' + iconInline('lock', 15) + ' ' +
      t('需要登录', 'Login required') + '</span>' +
      '<p class="desc">' + t('控制台已开启令牌保护。本浏览器登录过的话，点「重新登录」即可恢复；新浏览器请粘贴网关令牌。', 'The console is token-protected. If this browser has logged in before, click Re-login to restore; on a new browser, paste the gateway token.') + '</p>' +
      '<p class="desc">' + t('本机菜单栏 / 系统托盘有 ModelDock 图标的话，点它选「打开控制台」或「在浏览器打开」，一键登录，无需粘贴令牌。', 'If the ModelDock icon is in the menu bar / system tray, click it and choose "Open Console" or "Open in Browser" to sign in with one click — no pasting needed.') + '</p>' +
      '<p><button class="btn" id="reloginBtn">' + t('重新登录', 'Re-login') + '</button></p>' +
      '<p id="tokenRow" hidden><input type="text" class="linput" id="tokenInput" placeholder="' + esc(t('粘贴网关令牌（mdkadm_…）', 'Paste the gateway token (mdkadm_…)')) + '"> <button class="btn small" id="tokenBtn">' + t('登录', 'Log in') + '</button></p>' +
      '<p class="desc" id="loginMsg" hidden></p></div>'
    var msg = document.getElementById('loginMsg')
    function fail(m) {
      if (!msg) return
      msg.textContent = m
      msg.hidden = false
    }
    var rb = document.getElementById('reloginBtn')
    if (rb) rb.onclick = function () {
      rb.disabled = true
      fetch('/_modeldock/auth/relogin', { method: 'POST', headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
        if (r.ok) { location.reload(); return }
        var row = document.getElementById('tokenRow')
        if (row) row.hidden = false
        rb.hidden = true
        fail(t('本浏览器没有设备记忆，请粘贴网关令牌登录（令牌见 __MD_GATEWAY_STATE__ 的 admin_token）。', 'No device memory in this browser; paste the gateway token (admin_token in __MD_GATEWAY_STATE__).'))
      }).catch(function (e) {
        rb.disabled = false
        fail(String((e && e.message) || e))
      })
    }
    var tb = document.getElementById('tokenBtn')
    if (tb) tb.onclick = function () {
      var input = document.getElementById('tokenInput')
      var v = input && input.value ? input.value.trim() : ''
      if (!v) return
      location.href = '/_modeldock/ui?token=' + encodeURIComponent(v)
    }
    var ti = document.getElementById('tokenInput')
    if (ti) ti.onkeydown = function (e) { if (e && e.key === 'Enter' && tb) tb.onclick() }
  }

  // 旧配置一键迁移（cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo / WorkBuddy / CCR / Crush / Gemini CLI）
  var SRC_LABEL = {
    'cc-switch': 'cc-switch',
    claude: 'Claude Code',
    dsh: 'dsh',
    zcode: 'ZCode',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    mimocode: 'MiMo Code',
    workbuddy: 'WorkBuddy',
    ccr: 'Claude Code Router',
    crush: 'Crush',
    gemini: 'Gemini CLI',
  }

  function checkMigrate() {
    return api('/import/detect')
      .then(function (r) {
        var cands = (r.candidates || []).filter(function (c) { return !c.skipReason && c.base_url })
        var card = $('#migrateCard')
        if (cands.length === 0) { card.hidden = true; return }
        var sig = cands.map(function (c) { return c.id }).sort().join(',')
        if (localStorage.getItem('mdk_mig_skip') === sig) { card.hidden = true; return }
        var names = cands.map(function (c) {
          return c.name + (c.isCurrent ? t('（使用中）', ' (in use)') : '')
        }).join('、')
        var srcs = []
        cands.forEach(function (c) {
          var label = SRC_LABEL[c.source] || c.source
          if (srcs.indexOf(label) < 0) srcs.push(label)
        })
        $('#migDesc').innerHTML = t('在 <b>', 'Found ') + esc(srcs.join('、')) + t('</b> 里发现 ', ' model services in <b>') + cands.length + t(' 个模型服务：<b>', '</b>: <b>') +
          esc(names) + t('</b>。导入后它们的 Key 会一并安全搬进 ModelDock，原软件不受任何影响。', '</b>. Importing moves their keys safely into ModelDock; the original apps are untouched.')
        card.hidden = false
        $('#migGo').onclick = function () {
          $('#migGo').disabled = true
          $('#migMsg').textContent = t('导入中…', 'Importing…')
          $('#migMsg').className = 'testline'
          api('/import/apply', { method: 'POST', body: JSON.stringify({ ids: cands.map(function (c) { return c.id }) }) })
            .then(function (r) {
              var n = (r.imported || []).length
              toast('✓ ' + t('已导入 ', 'Imported ') + n + t(' 个服务，下方「我的服务」里可以查看和切换', ' services. See and switch them under "My services" below'), true)
              card.hidden = true
              return load()
            })
            .catch(function (e) {
              $('#migMsg').textContent = t('导入失败：', 'Import failed: ') + e.message
              $('#migMsg').className = 'testline err'
              $('#migGo').disabled = false
            })
        }
        $('#migSkip').onclick = function () {
          localStorage.setItem('mdk_mig_skip', sig)
          card.hidden = true
        }
      })
      .catch(function () {})
  }

  function healthHtml() {
    var sandbox = view && view.gateway && view.gateway.sandbox
    return '<span class="dot"></span> ' + t('本地网关运行中 · 端口 ', 'Local gateway running · port ') + esc(location.port) +
      (sandbox ? ' <span class="pill warn" title="' + t('dev 沙箱实例：配置、日志与客户端写入均在沙箱目录内，不影响生产', 'dev sandbox instance: config, logs and client writes stay in the sandbox dir; production is untouched') + '">' + t('dev 沙箱', 'dev sandbox') + '</span>' : '')
  }

  function pollHealth() {
    fetch('/_modeldock/health', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.json() }).then(function (j) {
      $('#health').innerHTML = healthHtml()
    }).catch(function () {
      $('#health').innerHTML = t('网关未响应', 'Gateway not responding')
    })
  }

  // 状态自动刷新：定时切换窗口翻转、熔断、其他端改配置等发生时页面自动跟上，无需手动刷新。
  // diff 门控——数据没变就不动 DOM（不干扰正在编辑的弹窗/表单），变了才整页重绘一次；失败静默（健康横幅另有提示）
  function pollOverview() {
    if (!view) return
    fetch('/_modeldock/overview', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (v) {
      if (!v || JSON.stringify(v) === JSON.stringify(view)) return
      view = v
      knownModels = Object.assign({}, catalogTable, (v && v.knownModels) || {})
      render()
      // 沙箱徽标挂在健康横幅上：view 就绪后（含首次 load）补一次，避免徽标晚到下一个轮询周期
      $('#health').innerHTML = healthHtml()
      var cp = document.getElementById('cfgPath')
      if (cp && v.gateway && v.gateway.home) cp.textContent = v.gateway.home
    }).catch(function () {})
  }

  function render() {
    layoutAddSection()
    renderChips()
    renderSyncBadge()
    renderServices()
    renderAutoRoute()
    refreshSchedSvcOptions()
    renderClients()
    renderShareRequest()
  }

  // 附近电脑的待确认拉取请求（sync-nearby）：顶部确认卡，随 2s overview 轮询出现/消失
  function renderShareRequest() {
    var card = document.getElementById('shareReqCard')
    if (!card) return
    var req = view ? view.syncRequest : null
    card.hidden = !req
    if (!req) return
    document.getElementById('shareReqDesc').textContent =
      t('电脑「', 'Computer "') + (req.from || '?') + t(
        '」请求拉取你的配置（服务 / 路由 / 预设 / 定时，含 Key）。允许后生成 10 分钟内有效的一次性直拉链接，仅该请求可取走一次。',
        '" requests to pull your config (providers, routes, presets, schedules — including keys). Approving creates a one-time pull link valid for 10 minutes, retrievable only by this request.'
      )
  }

  // 多机同步徽标（顶栏）：正常态一枚安静的灰 pill，冲突/错误/暂停才变色提醒；
  // 长路径、版本号、CLI 指引全部收进悬浮详情——控制台不做同步配置，管理在电脑端命令行
  function renderSyncBadge() {
    var el = document.getElementById('syncBadge')
    if (!el) return
    var s = view && view.sync
    if (!s || s.mode === 'off') { el.hidden = true; return }
    var cls = 'pill', txt
    if (s.paused) { txt = t('同步已暂停', 'Sync paused'); cls += ' dim' }
    else if (s.lastConflictTs) { txt = t('同步冲突待处理', 'Sync conflict pending'); cls += ' warn' }
    else if (s.lastError) { txt = t('同步错误', 'Sync error'); cls += ' err' }
    else { txt = t('多机同步 · 已开启', 'Device sync · on') }
    var tip = []
    if (s.targetLabel) tip.push(t('目标：', 'Target: ') + s.targetLabel)
    if (typeof s.lastAppliedRev === 'number' && s.lastAppliedRev > 0) tip.push(t('已同步到第 ', 'Synced to rev ') + s.lastAppliedRev + t(' 版', ''))
    if (s.lastPushTs) tip.push(t('最近推送：', 'Last push: ') + fmtLocal(s.lastPushTs))
    if (s.lastPullTs) tip.push(t('最近拉取：', 'Last pull: ') + fmtLocal(s.lastPullTs))
    if (s.lastConflictTs) tip.push(t('最近冲突：', 'Last conflict: ') + fmtLocal(s.lastConflictTs) + t('（本机当时改动已快照到 backups/ 目录）', ' (local changes then were snapshotted to the backups/ folder)'))
    if (s.lastError) tip.push(t('最近错误：', 'Last error: ') + s.lastError)
    tip.push(t('管理：modeldock sync --help', 'Manage with: modeldock sync --help'))
    el.className = cls
    el.textContent = txt
    el.title = tip.join('\\n')
    el.hidden = false
  }

  // ISO 时间转本地可读；解析失败原样返回
  function fmtLocal(iso) {
    var d = new Date(iso)
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
  }

  // 一键更新（顶栏徽标 + 居中模态）：安静模式——有新版才徽标 + toast 提醒一次，无新版零打扰；
  // 「此版本不再提醒」记忆在 localStorage（同版本不再提醒，更新到该版本后自动清除）；
  // 手动检查走命令行 modeldock update --check 或托盘「检查更新」，网页端不做检查入口
  var upd = null // 最近一次 /admin/update/status
  var updAnnounced = false // 本次页面会话只 toast 提醒一次
  var updApplying = false // 已点更新、等待网关重启重连（按钮态机：更新到 vX → 更新中…）

  function updDismissedVersion() {
    try { return localStorage.getItem('mdk_upd_dismissed') } catch (e) { return null }
  }

  function renderUpdBadge() {
    var el = document.getElementById('updBadge')
    if (!el) return
    if (!upd || !upd.available || updDismissedVersion() === upd.latest) { el.hidden = true; return }
    el.className = 'pill warn'
    el.textContent = t('可更新 ', 'Update: ') + upd.latest
    el.title = t('发现新版本，点击查看更新内容并一键升级', 'New version found — click to review and update')
    el.hidden = false
  }

  function refreshUpdStatus(cb) {
    api('/admin/update/status').then(function (s) {
      upd = s
      // 已更新到被跳过的版本：清掉记忆（字符串比较足够——dismissed 一定晚于写入时的 current）
      var dismissed = updDismissedVersion()
      if (dismissed && s.current >= dismissed) {
        try { localStorage.removeItem('mdk_upd_dismissed') } catch (e) { /* 隐私模式等 */ }
        dismissed = null
      }
      renderUpdBadge()
      // 发现新版：按全站标准 toast 形态提醒一次（左下角、可复制）；持续入口是顶栏徽标
      if (s.available && !updAnnounced && dismissed !== s.latest) {
        updAnnounced = true
        toast(t('发现新版本 v' + s.latest + '：点击顶栏「可更新」查看说明并一键升级（或命令行 modeldock update）', 'New version v' + s.latest + ' available: click "Update" in the top bar to review and install (or run modeldock update)'))
      }
      if (cb) cb(s)
    }).catch(function () {})
  }

  function updModalRender() {
    var title = document.getElementById('updTitle'),
      sub = document.getElementById('updSub'),
      notes = document.getElementById('updNotes'),
      more = document.getElementById('updMore'),
      go = document.getElementById('updGo'),
      copy = document.getElementById('updCopy'),
      dismiss = document.getElementById('updDismiss')
    if (!title || !upd) return
    setUpdMsg('')
    title.textContent = t('可更新到 ', 'Update to ') + upd.latest
    var subText = t('发现新版本 · 当前 v' + upd.current, 'New version · current v' + upd.current)
    if (upd.sizeBytes > 0) subText += t(' · 安装包 ', ' · package ') + (upd.sizeBytes / 1048576).toFixed(1) + ' MB'
    sub.textContent = subText
    // 说明是纯文本（服务端已去 markdown 标记）：弹层不渲染富文本，只给「去发布页看全文」的外链
    notes.hidden = !upd.notes
    notes.textContent = upd.notes || ''
    more.hidden = !upd.htmlUrl
    more.innerHTML = more.hidden ? '' : docLinkA(t('在 GitHub 查看完整说明', 'View full notes on GitHub'), upd.htmlUrl)
    go.textContent = updApplying ? t('更新中…', 'Updating…') : t('更新到 ', 'Update to ') + upd.latest
    go.disabled = updApplying
    copy.disabled = updApplying
    dismiss.disabled = updApplying
    updProgressRender(upd)
  }

  function updModalToggle(forceHide) {
    if (forceHide) { updM.close(); return }
    if (updM.isOpen()) { updM.close(); return } // toggle 语义保留：已开再调即收起
    refreshUpdStatus()
    updM.open()
    updModalRender()
  }

  // 更新弹窗底栏提示槽（updMsg）：弹层开着时错误/进度写槽位——磨砂遮罩会糊掉全局 toast；
  // 弹层已关（用户中途关掉后在等轮询）才回落主页面 toast（AGENTS 弹层提示归宿约定）
  function setUpdMsg(text, cls) {
    var el = document.getElementById('updMsg')
    if (el) { el.textContent = text || ''; el.className = cls === 'err' || cls === 'ok' ? 'testline ' + cls : 'testline' }
  }
  function updFail(text) {
    if (updM.isOpen()) setUpdMsg(text, 'err')
    else toast(text, false)
  }
  // 更新进度渲染：s.progress 来自 update --yes 子进程写的 update-progress.json（stale 过期时载荷为 null）。
  // 仅在本页发起的一键更新（updApplying）时展示；非确定态（下载总量未知）用 .indet 往复动画兜底
  function updProgressRender(s) {
    var box = document.getElementById('updProgress')
    if (!box) return
    var p = s && s.progress
    var show = !!(updApplying && p && p.stage !== 'failed')
    box.hidden = !show
    if (!show) return
    var fill = document.getElementById('updProgressFill')
    var txt = document.getElementById('updProgressText')
    var names = { downloading: t('下载中', 'Downloading'), verifying: t('校验安装包', 'Verifying package'), swapping: t('停止网关并替换安装', 'Stopping gateway and swapping'), restarting: t('重启服务', 'Restarting'), done: t('更新完成', 'Update complete') }
    var stageText = names[p.stage] || p.stage
    var indet = !(p.total > 0) && p.stage !== 'done'
    if (fill) {
      fill.parentNode.className = 'progress' + (indet ? ' indet' : '')
      fill.style.width = indet ? '' : (p.stage === 'done' ? '100%' : p.percent + '%')
    }
    if (txt) {
      var mbInfo = p.total > 0 ? '（' + (p.received / 1048576).toFixed(1) + ' / ' + (p.total / 1048576).toFixed(1) + ' MB）' : ''
      txt.textContent = stageText + (p.stage === 'downloading' && p.total > 0 ? ' ' + p.percent + '%' + mbInfo : '')
    }
  }

  function updApply() {
    if (updApplying) return
    updApplying = true
    updModalRender()
    api('/admin/update/apply', { method: 'POST' }).then(function (r) {
      if (r && r.started) {
        try { sessionStorage.setItem('mdk_upd_to', String(r.latest || '')) } catch (e) { /* 隐私模式等 */ }
        setUpdMsg(t('开始更新到 v' + r.latest + '，完成后本页自动重连', 'Updating to v' + r.latest + '; this page reconnects when done'))
        pollApplyAndGateway(0, false)
      } else {
        updApplying = false
        updModalRender()
        updFail(r && r.reason === 'in_progress' ? t('更新已在进行中，请稍候', 'An update is already in progress') : t('当前没有可安装的新版本', 'No new version to install'))
      }
    }).catch(function (e) {
      updApplying = false
      updModalRender()
      updFail(e.message)
    })
  }



  // 更新等待循环（2s）：同时盯 status 与 health——
  // 失败=子进程退出而网关一直活着（status.applyError 带出原因，立即提示并恢复按钮）；
  // 成功=网关先被停掉（health 出现过失败）再恢复 → 重载进新版；
  // 下载阶段网关活着是预期，不触发重载（修复点：此前 health 正常即重载，失败时秒重载假完成）。
  // 极端竞态（网关在两次轮询间完成下线+恢复）：current 已到目标版本也视为成功。
  function pollApplyAndGateway(n, sawDown) {
    if (n > 150) {
      updApplying = false
      updFail(t('等待更新完成超时。网关可能仍在更新中；若长时间无响应，请查看 __MD_LOGS_DIR__ 下的 update 日志或重跑 modeldock update', 'Timed out waiting for the update. The gateway may still be updating; if it stays unreachable, check the update log under __MD_LOGS_DIR__/ or rerun modeldock update'))
      return
    }
    setTimeout(function () {
      var proceed = function (down) {
        api('/admin/update/status').then(function (s) {
          updProgressRender(s)
          if (updApplying && s.applyError) {
            updApplying = false
            updModalRender()
            updFail(s.applyError)
            return
          }
          var wanted = String(sessionStorage.getItem('mdk_upd_to') || '')
          if (down || (wanted && s.current >= wanted)) { location.reload(); return }
          pollApplyAndGateway(n + 1, down)
        }).catch(function () { pollApplyAndGateway(n + 1, true) })
      }
      api('/health').then(function () { proceed(sawDown) }, function () { proceed(true) })
    }, 2000)
  }

  var updBadge = document.getElementById('updBadge')
  if (updBadge) updBadge.onclick = function () { updModalToggle() }
  var updGo = document.getElementById('updGo')
  if (updGo) updGo.onclick = updApply
  var updCopy = document.getElementById('updCopy')
  if (updCopy) updCopy.onclick = function () {
    if (!upd) return
    // 模板串内换行必须写 \\n（见 ui.ts 模板串转义坑）
    var text = t('可更新到 ', 'Update to ') + upd.latest + t('（当前 v' + upd.current + '）', ' (current v' + upd.current + ')') + (upd.notes ? '\\n\\n' + upd.notes : '') + (upd.htmlUrl ? '\\n\\n' + upd.htmlUrl : '')
    // 复制成功的即时反馈用 SVG 对号（与 toast 的复制按钮同一套），不写字符字形
    copyText(text, function () { updCopy.innerHTML = icon('check', 14); setTimeout(function () { updCopy.textContent = t('复制说明', 'Copy notes') }, 1200) })
  }
  var updDismiss = document.getElementById('updDismiss')
  if (updDismiss) updDismiss.onclick = function () {
    if (!upd) return
    try { localStorage.setItem('mdk_upd_dismissed', String(upd.latest)) } catch (e) { /* 隐私模式等 */ }
    updModalToggle(true)
    renderUpdBadge()
    toast(t('已隐藏 v' + upd.latest + ' 的更新提醒；下个新版本会再次提醒', 'Muted update reminders for v' + upd.latest + '; you will be notified again for the next release'))
  }

  function renderAutoRoute() {
    var sel = document.getElementById('autoRouteSel')
    if (!autoRouteApi || !view) return
    // 无服务时路由控件无意义：路由上行整块隐藏；开关行保留（手机远程是新机扫码导入的入口，开机自启也与服务无关），
    // 仅藏走路由语义的 429 备用开关、自动备用链与「导出配置包」（空配置无可导出），routebox 加 solo 去掉行间分隔线
    var noSvc = view.services.length === 0
    var rrow1 = document.getElementById('rrow1')
    if (rrow1) rrow1.hidden = noSvc
    var routebox = document.getElementById('routebox')
    if (routebox) routebox.classList.toggle('solo', noSvc)
    var errPillEl = document.getElementById('errPill')
    if (errPillEl) errPillEl.hidden = noSvc
    var fbPillEl = document.getElementById('fbPill')
    if (fbPillEl) fbPillEl.hidden = noSvc
    var pkgPillEl = document.getElementById('pkgPill')
    if (pkgPillEl) pkgPillEl.hidden = noSvc
    if (noSvc) {
      applyAsPill(!!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed))
      applyLanPill(lanOn)
      return
    }
    var ar = view.gateway && view.gateway.autoRoute ? view.gateway.autoRoute : null
    var on = !!(ar && ar.on)
    autoRouteApi.set({ on: on })
    errApi.set({ on: !!(ar && ar.failoverOn429) })
    fbApi.set({ on: !!(ar && ar.autoFallback) })
    applyAsPill(!!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed))
    applyLanPill(lanOn) // 轮询重绘走共享 setter：开关态与 caret 朝向都由它统一维护
    {
      var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
      var n = (sch.windows || []).length
      var act = sch.active
      var avoidAct = sch.activeAvoids || []
      var enabled = sch.enabled !== false
      var targetLabel = function (t) {
        var p = parseTarget(t)
        var svc = null
        view.services.forEach(function (x) { if (x.id === p.p) svc = x })
        return (svc ? svc.label : p.p) + (p.m ? ' · ' + p.m : '')
      }
      // pill 只显示时间不显示目标：命中哪个服务看「当前路由」；详情进 tooltip，箭头展开面板编辑。
      // 文案/绿色态由组件读取 schedStatus（轮询重绘只更新这份状态，再让组件重渲染）
      schedWindowsSnapshot = (sch.windows || []).map(function (w) { return Object.assign({}, w) })
      schedStatus.windows = n
      schedStatus.autoOn = on
      schedStatus.active = act || null
      schedStatus.activeAvoids = avoidAct
      schedEnabledState = enabled
      if (!schedToggleBusy) schedApi.set({ on: enabled })
      var tips = []
      if (on && act) tips.push(t('优先 ', 'prefer ') + targetLabel(act.target) + ' ' + act.start + '–' + act.end)
      if (on) avoidAct.forEach(function (w) { tips.push(t('避开 ', 'avoid ') + targetLabel(w.target) + ' ' + w.start + '–' + w.end) })
      if (!on && n) tips.push(t('开启自动选主后时段生效', 'Windows apply once auto primary selection is on'))
      if (ar && ar.forced) tips.push(t('已人工钉定主服务，定时窗口暂停；「当前」选回「自动」即恢复', 'Primary is pinned manually; schedule windows are paused. Pick "Auto" in Current to resume'))
      schedApi.setTip(tips.length ? tips.join(t('；', '; ')) : t('按时间段自动切换主服务/模型；主体开关=启用/停用，右侧箭头=编辑时段', 'Switch primary service/model by time of day; body = enable/disable, arrow = edit windows'))
    }
    if (sel) {
      // 「下一个切换」槽：主服务不可达时切到它。自动态显示程序会选的备用（自动 · B），人工选服务=钉定该槽。
      // 候选链里没有第二个服务（未配故障切换顺序）时写明「无备用服务」——静默显示「自动」会被当成名字没渲染出来，
      // 也掩盖了「主服务不可达时无处可切」这一事实（名字来自服务端 autoNextLabel）
      var routeNext = ar ? ar.routeNext : null
      var nextAutoLabel = ar ? ar.autoNextLabel : null
      var autoNextOpt = nextAutoLabel ? t('自动 · ', 'Auto · ') + nextAutoLabel : t('自动 · 无备用服务', 'Auto · no fallback')
      // 选项由共用 routeSelectHtml 构建（与手机同步页同源）：自动态占位 + enabled 服务 + 钉定项兜底（被下线也保留一项显示）
      sel.innerHTML = routeSelectHtml(view.services || [], autoNextOpt, routeNext, ar.nextLabel || routeNext)
      sel.value = routeNext || ''
    }
    // 「当前」槽 = 实际使用中的主服务：自动态显示「自动 · X」（X=程序会选的：定时窗口/默认路由），人工选服务=钉定（优先于定时窗口，
    // 持续到选回「自动」）。与「下一个切换」槽各自独立，人工修改优先于程序自动
    var curSel = document.getElementById('curSvcSel')
    if (curSel) {
      var forced = ar ? ar.forced : null
      var autoCurOpt = !forced && ar && ar.autoPrimaryLabel ? t('自动 · ', 'Auto · ') + ar.autoPrimaryLabel : t('自动', 'Auto')
      curSel.innerHTML = routeSelectHtml(view.services || [], autoCurOpt, forced, ar.providerLabel || forced)
      curSel.value = forced || ''
    }
  }

  // 添加模型服务：已有服务时收起为右下角 + 号，点击浮层展示
  var addOpen = false

  function layoutAddSection() {
    var has = view.services.length > 0
    $('#fabAdd').hidden = !has || addOpen
    document.getElementById('svcH').textContent = has ? t('我的服务', 'My services') : t('② 我的服务', '② My services')
    document.getElementById('cliHText').textContent = has ? t('接入你的 AI 客户端', 'Attach your AI clients') : t('③ 接入你的 AI 客户端', '③ Attach your AI clients')
    document.getElementById('addH').textContent = has ? t('添加模型服务', 'Add a model service') : t('① 添加模型服务', '① Add a model service')
    if (!has) {
      closeAddOverlay()
      document.getElementById('addCard').hidden = false // 首次使用：内联展示引导
    } else if (!addOpen) {
      document.getElementById('addCard').hidden = true // 已有服务：仅保留右下角 + 号入口
    }
  }

  function openAddOverlay() {
    if (view.services.length === 0) return // 空状态直接内联展示
    document.getElementById('addModalBody').appendChild(document.getElementById('addCard'))
    document.getElementById('addCard').hidden = false
    document.getElementById('addFoot').appendChild(document.getElementById('afActions')) // 动作区提为常驻底栏
    document.getElementById('addFoot').hidden = $('#addform').hidden // 选好服务商展开表单后才亮出
    addOpen = true
    $('#fabAdd').hidden = true
    addM.open()
    renderChips()
  }

  function closeAddOverlay() {
    if (!addOpen) return
    addM.close() // 动作区/卡片还原在 onClose 钩子（✕/遮罩/Esc 同一条路径）
  }

  document.getElementById('fabAdd').onclick = openAddOverlay

  var picked = null

  // 添加壳的三块实例（块实现见编辑区「服务表单公共块」）
  var afEp = createEndpointBlock('afEpHost', 'af')
  var afModelB = createModelBlock('afModelHost', 'af', {
    msg: testlineWriter('afMsg'),
    fetchCtx: function () {
      var ep = afEp.collect()
      return { baseUrl: ep.url, protocol: ep.protocol, key: $('#afKey').value.trim(), serviceId: null }
    },
  })
  var afFbB = createFallbackBlock('afFbHost', 'af', {
    msg: testlineWriter('afMsg'),
    getServices: function () { return view.services || [] },
    getSelfId: function () { return null }, // 新服务尚未进列表，没有“自身”可排除
  })
  // 预设自带目录 → 模型表初始行（★ 默认 = 第一行 = 服务端将采用的默认模型）
  function presetModelList(p) {
    var arr = []
    var pm = p.models || {}
    for (var mid in pm) arr.push({ id: mid, display_name: pm[mid].display_name || '', context_window: pm[mid].context_window, max_output: pm[mid].max_output, capabilities: pm[mid].capabilities || [] })
    return arr
  }

  function renderChips() {
    var byId = {}
    view.presets.forEach(function (p) { byId[p.id] = p })
    var ids = COMMON.filter(function (id) { return byId[id] })
    var moreIds = MORE_TOP.filter(function (id) { return byId[id] && ids.indexOf(id) < 0 })

    // 首屏放「自定义 / DeepSeek / OpenAI / Anthropic」四个常用按钮，「更多服务…」下拉只列 MORE_TOP 白名单：
    // 整行只占一行不换行，放不下时先收窄「更多服务」框（下拉在 innerHTML 之后绑定，此刻 #moreSel 才存在于 DOM）
    var html = ids.slice(0, 4).map(function (id) {
      // 按钮上用简称：「Anthropic 官方」→「Anthropic」，下拉里仍显示完整名
      // 英文标签用半角括号（如 "Anthropic (official)"），一并截掉括号段与 official 字样
      return '<button class="chip" data-preset="' + esc(id) + '">' + esc(byId[id].label.split('（')[0].split(' (')[0].replace('官方', '').replace(' (official)', '').trim()) + '</button>'
    }).join('')
    html += '<select class="chip" id="moreSel"><option value="">' + t('更多服务…', 'More services…') + '</option>' +
      moreIds.map(function (id) { return '<option value="' + esc(id) + '">' + esc(byId[id].label) + '</option>' }).join('') +
      '</select>'
    $('#chips').innerHTML = html

    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (b) {
      b.onclick = function () { pickPreset(b.getAttribute('data-preset')) }
    })
    $('#moreSel').onchange = function () { if (this.value) pickPreset(this.value) }
  }

  function pickPreset(id) {
    picked = id
    var p = null
    view.presets.forEach(function (x) { if (x.id === id) p = x })
    if (!p) return
    document.querySelectorAll('.chip[data-preset]').forEach(function (b) {
      b.className = 'chip' + (b.getAttribute('data-preset') === id ? ' active' : '')
    })
    $('#addform').hidden = false
    document.getElementById('addFoot').hidden = false // 动作区随表单亮出（弹窗宿主=常驻底栏；内联宿主此脚在壳里不可见，无副作用）
    $('#afTitle').textContent = t('添加「', 'Add "') + p.label + t('」', '"')
    // 名称/协议地址按预设填好（自定义=全空白）；说明收进地址块下的小字
    var isCustom = !p.base_url
    afEp.load({
      name: isCustom ? '' : p.label,
      namePlaceholder: isCustom
        ? '给服务起个名字，如：我的中转站||Name it, e.g. my relay'
        : '留空=用厂商默认名||empty = use vendor default name',
      baseUrl: p.base_url || '',
      protocol: p.protocol || 'openai',
      endpoints: p.endpoints,
      docsHtml: isCustom
        ? docLinkA(t('参考：OpenAI 接口文档', 'Reference: OpenAI API docs'), 'https://platform.openai.com/docs')
        : docLinkA(t('不知道去哪拿 Key？点这里', 'Where to get a key? Click here'), p.docs_url),
    })
    // 模型：预设自带目录直接展示，★ 可改；动过才随保存提交（未动留给服务端做预设合并+在线拉取）
    var pm = presetModelList(p)
    afModelB.load(pm, pm.length ? pm[0].id : '')
    // 故障切换顺序：已有其他服务才显示（首次添加没有可备用对象），初始为空
    afFbB.load([])
    document.getElementById('afFbHost').hidden = !(view.services && view.services.length)
    $('#afKey').value = ''
    $('#afMsg').textContent = ''
    $('#afMsg').className = 'testline'
    $('#afKey').focus()
    $('#addform').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  // 外链图标由这里统一追加（文案里不再写 ↗ 字形）——图标随 <a> 一起打开新窗口
  function docLinkA(txt, url) {
    return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + txt + ' ' + iconInline('arrow-up-right', 12) + '</a>' : ''
  }
  // 纯文本行里的网址自动变可点（安装指引等整段文案里的 URL 不必逐条改数据结构）：
  // 按原文切链接以便剔掉句尾标点，展示文本与 href 各自转义；href 只可能以 http(s):// 开头，
  // 没有 javascript: 之类的注入面（文本可能来自上游错误，先切后转义、不解析其中标签）
  function linkifyText(s) {
    var text = String(s == null ? '' : s)
    var out = ''
    var last = 0
    // 句尾标点一般不属于网址（英文文案里 URL 常直接接句号、右括号）
    var trail = '.,;:!?)]}>。，；：！？）】》'
    var re = /https?:\\/\\/\\S+/g
    var m
    while ((m = re.exec(text)) !== null) {
      var url = m[0]
      while (url.length > 8 && trail.indexOf(url.slice(-1)) >= 0) url = url.slice(0, -1)
      if (url.length <= 8) continue
      out += esc(text.slice(last, m.index)) + docLinkA(esc(url), url)
      last = m.index + url.length
    }
    return out + esc(text.slice(last))
  }

  $('#afCancel').onclick = function () {
    $('#addform').hidden = true
    picked = null
    document.querySelectorAll('.chip').forEach(function (b) { b.className = 'chip' })
    closeAddOverlay()
  }

  $('#afSave').onclick = function () {
    if (!picked) return
    var key = $('#afKey').value.trim()
    if (!key) { $('#afMsg').textContent = t('请先粘贴 Key', 'Paste your key first'); $('#afMsg').className = 'testline err'; return }
    var ep = afEp.collect()
    if (!ep.url) { $('#afMsg').textContent = t('请至少填写一个协议接口地址（照抄厂商文档）', 'Fill in at least one protocol endpoint (copy from the vendor docs)'); $('#afMsg').className = 'testline err'; return }
    for (var pk in ep.urls) {
      if (ep.urls[pk] && !/^https?:\\/\\//i.test(ep.urls[pk])) { $('#afMsg').textContent = t('{proto} 接口地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: pk }); $('#afMsg').className = 'testline err'; return }
    }
    var collected = afModelB.collect()
    var modelErr = validateModelCollect(collected, afModelB.el)
    if (modelErr) { $('#afMsg').textContent = modelErr; $('#afMsg').className = 'testline err'; return }
    var btn = $('#afSave')
    if (btn.disabled) return // 防重复提交：双击会真的创建两个同地址服务
    btn.disabled = true
    $('#afMsg').textContent = t('保存中…', 'Saving…')
    $('#afMsg').className = 'testline'
    var body = { presetId: picked, key: key, protocol: ep.protocol, base_url: ep.url, name: ep.name }
    if (Object.keys(ep.endpoints).length) body.endpoints = ep.endpoints
    // 动过模型目录才提交 models；新模型框手填的行（没点「添加」也在 collect 里）含预设外条目时同样提交——
    // 否则用户输入被丢、服务端还会误触自动拉取。同时把 ★ 默认模型带给服务端
    var presetCatalog = {}
    ;(view.presets || []).forEach(function (p) { if (p.id === picked) { var pm = p.models || {}; for (var k in pm) presetCatalog[k] = 1 } })
    var hasExtra = Object.keys(collected.models).some(function (k) { return !presetCatalog[k] })
    if ((afModelB.isDirty() || hasExtra) && Object.keys(collected.models).length) {
      body.models = collected.models
      var dm = afModelB.getDefault()
      if (dm && collected.models[dm]) body.default_model = dm
    }
    var fb = afFbB.collect()
    if (fb.length) body.fallback = fb
    api('/service', { method: 'POST', body: JSON.stringify(body), timeoutMs: 120000 })
      .then(function (r) {
        var msg = '✓ ' + t('已添加「', 'Added "') + r.providerId + t('」', '"')
        if (r.fetched > 0) msg += t('，自动拉取到 ', ', fetched ') + r.fetched + t(' 个模型', ' models')
        if (r.fetchError) msg += t('（模型列表没拉到：', ' (model list not fetched: ') + r.fetchError.slice(0, 60) + t('，不影响使用，稍后可重试）', '; harmless, retry later)')
        toast(msg, true)
        $('#addform').hidden = true
        picked = null
        closeAddOverlay()
        btn.disabled = false
        return load()
      })
      .catch(function (e) {
        btn.disabled = false
        $('#afMsg').textContent = t('失败：', 'Failed: ') + e.message
        $('#afMsg').className = 'testline err'
      })
  }

  function visibleServices() {
    var list = view.services.filter(function (s) {
      if (svcFilter === 'key') return s.hasKey
      if (svcFilter === 'nokey') return !s.hasKey
      if (svcFilter === 'current') return s.isCurrent
      return true
    })
    var q = svcQ.trim().toLowerCase()
    if (q) {
      list = list.filter(function (s) {
        if (String(s.label).toLowerCase().indexOf(q) >= 0) return true
        if (String(s.base_url).toLowerCase().indexOf(q) >= 0) return true
        return (s.models || []).some(function (m) { return String(m.id).toLowerCase().indexOf(q) >= 0 })
      })
    }
    var byName = function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh') }
    if (svcSort === 'name-az') {
      list = list.slice().sort(byName)
    } else if (svcSort === 'name-za') {
      list = list.slice().sort(function (a, b) { return byName(b, a) })
    } else if (svcSort === 'cnt-desc') {
      list = list.slice().sort(function (a, b) { return (b.modelsCount || 0) - (a.modelsCount || 0) || byName(a, b) })
    } else if (svcSort === 'cnt-asc') {
      list = list.slice().sort(function (a, b) { return (a.modelsCount || 0) - (b.modelsCount || 0) || byName(a, b) })
    } else {
      list = list.slice().sort(function (a, b) {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        return byName(a, b)
      })
    }
    return list
  }

  function renderServices() {
    var el = $('#services')
    if (!view.services.length) {
      el.innerHTML = '<div class="empty">' + t('还没有服务。先在上方 ① 选一个服务商，粘贴 Key。', 'No services yet. Pick a provider in step ① above and paste your key.') +
        '<br><button class="btn small" id="svcImportBtn" style="margin-top:10px">' + t('从其他电脑导入…', 'Import from another computer…') + '</button></div>'
      var ib = document.getElementById('svcImportBtn')
      if (ib) ib.onclick = openImportOverlay
      return
    }
    var list = visibleServices()
    if (!list.length) {
      el.innerHTML = '<div class="empty">' + t('没有匹配的服务。试试清空搜索或换一个过滤条件。', 'No matching services. Try clearing the search or changing the filter.') + '</div>'
      return
    }
    var arOn = !!(view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.on)
    // 折叠切片：默认只渲染前 N 个；使用中的服务即便排序靠后也强制保留（收起视图必须能切换当前服务）
    var slice = list, moreHtml = ''
    if (list.length > SVC_COLLAPSE_N) {
      if (svcExpanded) {
        moreHtml = '<div class="listmore"><button class="btn small" id="svcMore">' + t('收起', 'Collapse') + '</button></div>'
      } else {
        slice = list.slice(0, SVC_COLLAPSE_N)
        var curSvc = null
        list.forEach(function (s) { if (s.isCurrent) curSvc = s })
        if (curSvc && slice.indexOf(curSvc) < 0) slice = slice.concat([curSvc])
        moreHtml = '<div class="listmore"><button class="btn small" id="svcMore">' + t('显示全部 ', 'Show all ') + list.length + t(' 个服务', ' services') + '</button></div>'
      }
    }
    el.innerHTML = slice.map(function (s) {
      var useBtn = s.isCurrent
        ? '<span class="pill ok">' + t('正在使用', 'In use') + '</span>'
        : '<button class="btn small primary" data-use="' + esc(s.id) + '">' + t('应用', 'Apply') + '</button>'
      return '<div class="service' + (s.isCurrent ? ' cur' : '') + '">' +
        '<div class="info"><span class="name" title="' + esc(s.base_url) + '">' + esc(s.label) + '</span><br>' +
        '<span class="meta">' + t('默认 ', 'Default ') + esc(s.defaultModel || t('未设置', 'not set')) +
        (s.lastMs != null ? t(' · 延迟 ', ' · latency ') + s.lastMs + 'ms' : '') + ' · ' + s.modelsCount + t(' 个模型', ' models') +
        (s.hasKey ? '' : ' · <b class="hint-warn">' + t('Key 未设置', 'key not set') + '</b>') + (s.usedBy && s.usedBy.length ? t(' · 被 <b>', ' · used by <b>') + s.usedBy.length + t('</b> 个客户端使用', '</b> clients') : '') +
        (s.down && arOn ? ' <span class="pill err" title="' + t('故障熔断中，自动路由会避开该服务，探活恢复后自动回归', 'Down (circuit open); auto route avoids it and brings it back once probes recover') + '">' + t('熔断中', 'down') + '</span>' : '') +
        (s.enabled === false ? ' <span class="pill dim" title="' + t('手动下线，不参与自动路由', 'Manually disabled; excluded from auto route') + '">' + t('已下线', 'offline') + '</span>' : '') +
        '</span></div>' +
        '<span class="testres" id="pingres-' + esc(s.id) + '" hidden></span>' +
        '<button class="btn small" data-ping="' + esc(s.id) + '" data-i18n-title="纯网络延迟（不做模型请求）||Pure network latency (no model request)" title="纯网络延迟（不做模型请求）">' + t('延迟', 'Ping') + '</button>' +
        '<button class="btn small" data-edit="' + esc(s.id) + '">' + t('编辑', 'Edit') + '</button>' +
        '<button class="btn small ghost-danger" data-del="' + esc(s.id) + '">' + t('删除', 'Delete') + '</button>' +
        '<span class="rt">' + useBtn + '</span></div>'
    }).join('') + moreHtml

    var moreBtn = document.getElementById('svcMore')
    if (moreBtn) moreBtn.onclick = function () { svcExpanded = !svcExpanded; renderServices() }
    document.querySelectorAll('[data-use]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-use')
        var affected = view.clients.filter(function (c) { return c.attached && c.followsActive })
        var pinnedN = view.clients.filter(function (c) { return c.attached && !c.followsActive }).length
        var doSwitch = function () {
          b.disabled = true
          api('/switch', { method: 'POST', body: JSON.stringify({ service: id }) })
            .then(function (r) {
              var extra = (r && r.refreshed && r.refreshed.length)
                ? t('（dsh 等客户端的模型列表已同步重写，重启对应客户端生效）', ' (model lists of dsh-like clients rewritten; restart them to take effect)')
                : ''
              toast('✓ ' + t('已切换，新请求立即生效', 'Switched; new requests take effect immediately') + extra, true)
              return load()
            })
            .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false); b.disabled = false })
        }
        if (affected.length) {
          var lines = [t('以下已接入的客户端会随之改用这个新服务：', 'These attached clients will switch to the new service as well:')].concat(affected.map(function (c) { return c.label }))
          if (pinnedN) lines.push(t('另有 ', 'Plus ') + pinnedN + t(' 个客户端已钉定固定路由，不受影响', ' pinned client(s) keep their fixed route'))
          confirmModal(t('切换当前服务', 'Switch current service'), lines, t('切换', 'Switch'), doSwitch)
        } else {
          doSwitch()
        }
      }
    })
    document.querySelectorAll('[data-ping]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-ping')
        var lbl = document.getElementById('pingres-' + id)
        if (!lbl) return
        b.disabled = true
        b.textContent = t('测中…', 'Pinging…')
        lbl.hidden = false
        lbl.className = 'testres'
        lbl.textContent = t('检测中…', 'Checking…')
        api('/test', { method: 'POST', body: JSON.stringify({ provider: id, mode: 'ping' }) })
          .then(function (r) {
            lbl.hidden = false
            lbl.className = 'testres ' + (r.ok ? 'ok' : 'err')
            lbl.textContent = r.ok
              ? '✓ ' + t('延迟 ', 'latency ') + (r.ms ?? '?') + 'ms'
              : '✗ ' + t('网络不通 ', 'unreachable ') + (r.err || '') + (r.hint ? ' → ' + r.hint : '')
          })
          .catch(function (e) { lbl.hidden = false; lbl.className = 'testres err'; lbl.textContent = '✗ ' + t('探测失败：', 'Ping failed: ') + e.message })
          .then(function () { b.disabled = false; b.textContent = t('延迟', 'Ping') })
      }
    })
    document.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { openEdit(b.getAttribute('data-edit')) }
    })
    document.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-del')
        var row = b.closest('.service')
        var name = row ? row.querySelector('.name').textContent : id
        confirmModal(t('删除服务', 'Delete service'), [t('将删除「', 'This deletes "') + name + t('」及其引用的路由、已保存的 Key，不可撤销。', '" plus its routes and saved key. Cannot be undone.')], t('删除', 'Delete'), function () {
          api('/service/delete', { method: 'POST', body: JSON.stringify({ provider: id }) })
            .then(function () { toast('✓ ' + t('已删除服务', 'Service deleted'), true); return load() })
            .catch(function (e) { toast(t('删除失败：', 'Delete failed: ') + e.message, false) })
        })
      }
    })
  }

  $('#svcQ').addEventListener('input', function () { svcQ = this.value; renderServices() })
  // 状态行开关（pillSwitch；视觉=原 pill，布局/顺序不变）
  // 自动路由：主体点击切换；失败回弹并提示（busy 期组件防连点）
  var autoRouteApi = pillSwitch('autoRoutePill', {
    label: function () { return t('自动路由', 'Auto route') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换自动路由失败：', 'Failed to toggle auto route: ') + e.message, false) })
    },
  })
  // 临时故障切备用（原「限流(429)/网关错误(503) 切备用」勾选收编；429 限流 / 503 服务不可用同属瞬时故障）
  var errApi = pillSwitch('errPill', {
    label: function () { return t('临时故障切备用', 'Failover on transient errors') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ failoverOn429: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
    },
  })
  // 自动备用链：手动链优先，没配/不够时自动把已启用服务补进切换候选（模型名透传，网关不改模型）
  var fbApi = pillSwitch('fbPill', {
    label: function () { return t('自动备用链', 'Auto fallback chain') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ autoFallback: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
    },
  })
  // 开机自启：轮询重绘与回调共用同一 setter（只等 load() 会让开关在 toast 之后回灌旧值）
  function applyAsPill(on) { if (asApi) asApi.set({ on: !!on }) }
  var asApi = pillSwitch('asPill', {
    label: function () { return t('开机自启', 'Autostart') },
    onToggle: function (next, pill) {
      var asOn = !!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed)
      pill.set({ busy: true })
      api('/autostart', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function (r) {
          // 用 POST 响应即时更新（与手机远程同款）；overview 有 2s TTL 缓存
          pill.set({ busy: false, on: !!r.installed })
          toast(r.installed ? t('已开启开机自启：下次登录自动启动网关', 'Autostart enabled: the gateway starts at next login') : t('已关闭开机自启', 'Autostart disabled'), true)
          return load()
        })
        .catch(function (e) {
          pill.set({ busy: false, on: asOn })
          toast(t('设置开机自启失败：', 'Failed to set autostart: ') + e.message, false)
        })
    },
  })

  // 手机远程（LAN 简版控制台）：主体=开关，caret=收起/展开二维码面板（不停服务）
  var lanPanel = document.getElementById('lanPanel')
  var lanOn = false // 当前 LAN 开关态（render 轮询重绘与 loadLanStatus、开关回调共用一份）
  function applyLanPill(on) { lanOn = !!on; if (lanApi) lanApi.set({ on: lanOn }) }
  var lanApi = pillSwitch('lanPill', {
    label: function () { return t('手机远程', 'Mobile console') },
    panel: function () { return lanPanel },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/lan', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '')
          lanPanel.hidden = !r.enabled // 先定面板再刷开关，caret 朝向才与面板一致
          lanOn = !!r.enabled
          pill.set({ busy: false, on: !!r.enabled, open: !!r.enabled })
          if (r.enabled) loadLanStatus()
          toast(r.enabled ? t('已开启：手机连同一 Wi-Fi 后扫码进入', 'Enabled: phone on the same Wi-Fi, scan the QR to enter') : t('已关闭：手机端页面立即失效', 'Disabled: the mobile page stops immediately'), true)
          return load()
        })
        .catch(function (e) {
          pill.set({ busy: false, on: lanOn })
          toast(t('设置手机远程失败：', 'Failed to set mobile console: ') + e.message, false)
          loadLanStatus()
        })
    },
  })
  function loadLanStatus() {
    api('/lan').then(function (r) {
      var qr = document.getElementById('lanQr')
      var url = document.getElementById('lanUrl')
      var alt = document.getElementById('lanAlt')
      var altUrls = document.getElementById('lanAltUrls')
      var winHint = document.getElementById('lanWinHint')
      applyLanPill(r.enabled)
      if (winHint) winHint.hidden = r.platform !== 'win32'
      if (r.enabled && r.qrcode) {
        qr.innerHTML = r.qrcode
        url.textContent = (r.urls && r.urls[0]) || ''
        url.onclick = function () { if (url.textContent) copyText(url.textContent, function () { toast(t('已复制', 'Copied'), true) }) }
        // 其余候选地址（服务器已按「手机最可能连上」排序）：主地址不通就换一条，省得用户去猜哪块网卡是物理网卡
        var rest = (r.urls || []).slice(1)
        altUrls.innerHTML = rest.map(function (u) { return '<p class="sharealt">' + esc(u) + '</p>' }).join('')
        Array.prototype.forEach.call(altUrls.querySelectorAll('.sharealt'), function (el) {
          el.onclick = function () { copyText(el.textContent, function () { toast(t('已复制', 'Copied'), true) }) }
        })
        alt.hidden = !rest.length
      } else {
        alt.hidden = true
        altUrls.innerHTML = ''
        qr.innerHTML = '<p class="empty">' + t('未开启', 'Off') + '</p>'
        url.textContent = ''
        url.onclick = null
      }
    }).catch(function (e) { toast(t('获取手机远程状态失败：', 'Failed to load mobile console status: ') + e.message, false) })
  }
  loadLanStatus() // 初始开关状态（开/关一眼可见）

  // 定时：主体=启用定时切换（原面板内勾选提到 pill），caret=展开/收起时段面板
  var schedStatus = { windows: 0, autoOn: false, active: null, activeAvoids: [] }
  // 启用态的唯一事实来源：切换即时落盘（不走防抖），切换在飞期间轮询重绘不回灌开关态——
  // 否则 5s 轮询会在防抖窗口内把服务端旧值写回，POST 就带回了旧值（实测复现过的竞态）
  var schedEnabledState = true
  var schedToggleBusy = false
  // 时段行的权威来源：面板未打开时按 DOM 抓行会得到空数组，POST 出去就把已存时段清掉了（实测过的数据丢失），
  // 故未渲染时用服务端快照；只有面板真实渲染过（用户在编辑）才以 DOM 为准
  var schedWindowsSnapshot = []
  var schedRowsRendered = false
  var schedApi = pillSwitch('schedPill', {
    label: function () { return t('定时', 'Schedule') },
    // 文案是「状态」不是「开/关」：命中时段=时间区间（绿）/ 开启未命中=N 个时段（灰）/ 关=已停用（灰）
    text: function (on) {
      var n = schedStatus.windows
      if (!on) return t('定时 · 已停用', 'Schedule · off')
      if (!n) return t('定时 · 开', 'Schedule · on') // 无时段时也明示开关态（原 pill 无开关，故为新增文案）
      if (schedStatus.autoOn && schedStatus.active) return t('定时 · ', 'Schedule · ') + schedStatus.active.start + '–' + schedStatus.active.end
      if (schedStatus.autoOn && schedStatus.activeAvoids.length) return t('定时 · ', 'Schedule · ') + schedStatus.activeAvoids[0].start + '–' + schedStatus.activeAvoids[0].end + (schedStatus.activeAvoids.length > 1 ? t(' 等', ' etc.') : '')
      return t('定时 · ', 'Schedule · ') + n + t(' 个时段', ' windows')
    },
    okOn: function (on) { return !!on && schedStatus.autoOn && (!!schedStatus.active || schedStatus.activeAvoids.length > 0) },
    panel: function () { return document.getElementById('schedPanel') },
    onToggle: function (next, pill) {
      pill.set({ on: next })
      if (!next) { pill.set({ open: false }); document.getElementById('schedPanel').hidden = true; schedRowsRendered = false }
      schedEnabledState = next
      schedToggleBusy = true
      schedPersistNow() // 开关切换即时落盘；保存链结束再放开回灌保护
    },
    onExpand: function (open) { schedOpen = open; if (open) renderSchedPanel(); else schedRowsRendered = false },
  })

  // 同网直拉迁移（sync-lan-pull）：A 侧「导出链接/让对方来拉」/ B 侧「导入 → 附近的电脑/粘贴链接」
  // 链接含口令（#p= fragment，不出本机也不进审计）；附近直拉链路凭对方放行的一次性 ticket 应用
  // shareM/importM 已并入 pkgM 统一弹层：两个旧开关名保留为薄封装，调用方（createOffer/impApplyResult 等）零改动
  function shareToggle(show) { if (show) pkgM.open(); else pkgM.close() }
  function importToggle(show) { if (show) pkgM.open(); else { stopNearbyPoll(); pkgM.close() } }
  // 仅分享弹窗内使用（点击复制链接/备选地址）：成功反馈一律走元素翻转（shareCopyFlip / 条目文案翻转）——
  // 弹窗磨砂遮罩会糊掉全局 toast，toast 在这里属遮挡死文案（AGENTS 弹层提示归宿）
  // 全站剪贴板收敛点（DUP-06）：写 + fallback + 成功反馈一份实现，各调用方只传 feedback。
  // 剪贴板 API 不可用（非安全上下文/老 webview）时回落 fallbackCopy 并同样触发 feedback。
  function copyText(text, feedback) {
    var done = function () { if (feedback) feedback() }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done() })
    } else { fallbackCopy(text); done() }
  }
  var shareFirstUrl = '' // 底栏「复制链接」按钮复制的对象（=urls[0]）
  var copyFlipTimer = null
  function shareCopyFlip() {
    var ic = document.getElementById('shareCopyIc')
    var tx = document.getElementById('shareCopyTxt')
    if (!ic || !tx) return
    ic.innerHTML = icon('check', 14)
    tx.textContent = t('已复制', 'Copied')
    if (copyFlipTimer) clearTimeout(copyFlipTimer)
    copyFlipTimer = setTimeout(function () {
      ic.innerHTML = icon('copy', 14)
      tx.textContent = t('复制链接', 'Copy link')
      copyFlipTimer = null
    }, 1600)
  }
  function renderShareUrls(urls) {
    var box = document.getElementById('shareUrls')
    if (!box) return
    var list = urls || []
    var toggle = document.getElementById('shareAltToggle')
    var altsWrap = document.getElementById('shareAlts')
    shareFirstUrl = list[0] || ''
    if (!list.length) { box.innerHTML = ''; if (toggle) toggle.hidden = true; if (altsWrap) altsWrap.hidden = true; return }
    box.innerHTML = '<div class="shareurl" data-i18n-title="对方在新电脑浏览器打开即可导入 · 点击复制||The recipient opens this in a browser on the new computer to import · click to copy" title="对方在新电脑浏览器打开即可导入 · 点击复制"><span class="u">' + esc(list[0]) + '</span></div>'
    applyI18nTree(box)
    var first = box.querySelector('.shareurl')
    if (first) first.onclick = function () { copyText(shareFirstUrl); shareCopyFlip() }
    var alts = list.slice(1)
    if (toggle) {
      toggle.hidden = !alts.length
      toggle.textContent = t('其他网卡地址（' + alts.length + '）', 'Other NIC addresses (' + alts.length + ')')
      toggle.classList.remove('open')
    }
    if (altsWrap) {
      altsWrap.hidden = !alts.length
      altsWrap.classList.remove('open')
      altsWrap.innerHTML = alts.map(function (u) { return '<p class="sharealt">' + esc(u) + '</p>' }).join('')
      Array.prototype.forEach.call(altsWrap.querySelectorAll('.sharealt'), function (el2, i2) {
        el2.onclick = function () {
          copyText(alts[i2])
          // 复制成功反馈 = 条目文案翻转（与「复制链接」按钮同款，1.6s 后还原）
          if (el2._flipT) clearTimeout(el2._flipT)
          el2.textContent = '✓ ' + t('已复制', 'Copied')
          el2._flipT = setTimeout(function () { el2.textContent = alts[i2]; el2._flipT = null }, 1600)
        }
      })
    }
  }
  function setShareErr(msg) {
    // shareM/importM 并入 pkgM 后三套错误归一到底栏同一个 msg 槽位
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function createOffer() {
    var btn = document.getElementById('shareRegen')
    if (btn) btn.disabled = true
    api('/sync/offer', { method: 'POST' })
      .then(function (j) {
        if (btn) btn.disabled = false
        setShareErr('')
        renderShareUrls(j.urls || [])
      })
      .catch(function (e) {
        if (btn) btn.disabled = false
        // 只在配置包弹层的「导出链接」tab 内触发（切 tab 自动生成 / 重新生成），错误一律写底栏槽位
        setShareErr(t('生成分享链接失败：', 'Failed to create the share link: ') + e.message)
      })
  }
  var shareAltToggle = document.getElementById('shareAltToggle')
  if (shareAltToggle) shareAltToggle.onclick = function () {
    shareAltToggle.classList.toggle('open')
    var w = document.getElementById('shareAlts')
    if (w) w.classList.toggle('open')
  }
  var shareCopyBtn = document.getElementById('shareCopyBtn')
  if (shareCopyBtn) shareCopyBtn.onclick = function () {
    if (!shareFirstUrl) return
    copyText(shareFirstUrl)
    shareCopyFlip()
  }
  var shareRegen = document.getElementById('shareRegen')
  if (shareRegen) shareRegen.onclick = createOffer

  // 导入弹层选项卡（互斥三来源）：nearby=自动搜索点选 / link=粘贴链接 / file=配置包文件。
  // 「导入」一键直达（apply 单请求）；错误写底栏左侧内联槽（弹层开着时 toast 会被磨砂遮罩糊住）
  var impTab = 'nearby'
  // 配置包统一弹层状态：pkgDirCur=一级方向（导出|导入），pkgExpTab=导出面板三方式
  var pkgDirCur = 'export'
  var pkgExpTab = 'file'
  var IMP_SEGS = { nearby: 'segNearby', link: 'segLink', file: 'segFile' }
  var IMP_PANELS = { nearby: 'panelNearby', link: 'panelLink', file: 'panelFile' }
  function setImpErr(msg) {
    // 与 setShareErr/setPkgErr 同槽：统一弹层只有一个底栏 msg 位
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function switchImpTab(tab) {
    impTab = tab
    setImpErr('')
    Object.keys(IMP_PANELS).forEach(function (k) {
      var seg = document.getElementById(IMP_SEGS[k])
      var panel = document.getElementById(IMP_PANELS[k])
      if (seg) seg.className = k === tab ? 'on' : ''
      if (panel) panel.hidden = k !== tab
    })
    updateImpPrimary()
    if (tab === 'nearby') searchNearbyPeers()
  }
  function updateImpPrimary() {
    var btn = document.getElementById('impImportBtn')
    if (!btn) return
    // 只在导入方向显示；附近 tab 无需按钮（对方授权即确认门）
    btn.hidden = pkgDirCur !== 'import' || impTab === 'nearby'
    if (btn.hidden) return
    if (impTab === 'link') {
      var u = document.getElementById('impUrl')
      btn.disabled = !(u && u.value.trim())
    } else {
      var f = document.getElementById('impFile2')
      btn.disabled = !(f && f.files.length)
    }
  }
  function showImpFileChip(file) {
    var chip = document.getElementById('impFileChip')
    if (!chip) return
    if (!file) { chip.hidden = true; chip.innerHTML = ''; return }
    chip.innerHTML = ''
    var nm = document.createElement('span')
    nm.className = 'fname'
    nm.textContent = file.name
    var rm = document.createElement('button')
    rm.type = 'button'
    rm.title = t('移除', 'Remove')
    rm.innerHTML = icon('close', 11)
    rm.onclick = function () {
      var f = document.getElementById('impFile2')
      if (f) f.value = ''
      showImpFileChip(null)
      updateImpPrimary()
    }
    chip.appendChild(nm)
    chip.appendChild(rm)
    chip.hidden = false
  }
  function openImportOverlay() {
    openPkgOverlay('import') // 空态入口固定落在导入方向（附近电脑默认 tab）
  }
  var segNearby = document.getElementById('segNearby')
  if (segNearby) segNearby.onclick = function () { switchImpTab('nearby') }
  var segLink = document.getElementById('segLink')
  if (segLink) segLink.onclick = function () { switchImpTab('link') }
  var segFile = document.getElementById('segFile')
  if (segFile) segFile.onclick = function () { switchImpTab('file') }
  var impFileBtn = document.getElementById('impFileBtn')
  if (impFileBtn) impFileBtn.onclick = function () { var f = document.getElementById('impFile2'); if (f) f.click() }
  var impFile2 = document.getElementById('impFile2')
  if (impFile2) impFile2.addEventListener('change', function () { showImpFileChip(this.files[0]); setImpErr(''); updateImpPrimary() })
  var impUrlInput = document.getElementById('impUrl')
  if (impUrlInput) impUrlInput.addEventListener('input', function () { setImpErr(''); updateImpPrimary() })
  var impPw2Input = document.getElementById('impPw2')
  if (impPw2Input) impPw2Input.addEventListener('input', function () { setImpErr('') })
  var impImportBtn = document.getElementById('impImportBtn')
  if (impImportBtn) {
    impImportBtn.onclick = function () {
      var btn = this
      var bodyP
      if (impTab === 'link') {
        var link = (document.getElementById('impUrl').value || '').trim()
        var i = link.indexOf('#p=')
        if (i < 0) { setImpErr(t('链接缺口号段（#p=…）：请回旧电脑复制完整链接', 'The link lacks the passphrase part (#p=…): copy the full link on the old computer')); return }
        bodyP = Promise.resolve({ kind: 'url', url: link.slice(0, i), passphrase: link.slice(i + 3) })
      } else {
        var f = document.getElementById('impFile2').files[0]
        var pw = document.getElementById('impPw2').value || ''
        if (!pw) { setImpErr(t('请输入导出时设置的口令', 'Enter the passphrase set at export')); return }
        bodyP = f.text().then(function (txt) { return { kind: 'file', file: txt, passphrase: pw } })
      }
      btn.disabled = true
      setImpErr('')
      hideImpPreview()
      // 先预览（服务端解包出 report，包不入库）再确认：对齐 CLI 的「将被替换/不受影响」确认步
      bodyP
        .then(function (src) { return api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'preview', source: src }) }) })
        .then(function (j) {
          impPendingTicket = j.ticket || ''
          var rep = j.report || {}
          var meta = j.meta || {}
          var line = document.getElementById('impPreviewLine')
          if (line) {
            line.textContent = t('将导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Will import: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules')
              .replace('{n}', (rep.providers || []).length).replace('{n2}', (rep.profiles || []).length).replace('{n3}', rep.presetCount || 0).replace('{n4}', rep.scheduleRules || 0)
              + (meta.createdBy ? t('（配置包来自 ', ' (package from ') + meta.createdBy + t('）', ')') : '')
              + t('。导入会整体替换现有配置（自动快照）。', '. This replaces the whole current config (snapshot taken first).')
          }
          var pv = document.getElementById('impPreview')
          if (pv) pv.hidden = false
          btn.disabled = false
        })
        .catch(function (e) { setImpErr(t('读取配置包失败：', 'Failed to read the package: ') + e.message); btn.disabled = false })
    }
  }
  // 预览 → 确认：确认时凭 preview 发放的一次性 ticket 直发 apply（与附近直拉链路同一形态）
  var impPendingTicket = ''
  function hideImpPreview() {
    impPendingTicket = ''
    var pv = document.getElementById('impPreview')
    if (pv) pv.hidden = true
  }
  var impConfirmBtn = document.getElementById('impConfirmBtn')
  if (impConfirmBtn) {
    impConfirmBtn.onclick = function () {
      impConfirmBtn.disabled = true
      setImpErr('')
      api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: impPendingTicket } }) })
        .then(impApplyResult)
        .catch(function (e) { setImpErr(t('导入失败：', 'Import failed: ') + e.message); impConfirmBtn.disabled = false })
    }
  }
  var impBackBtn = document.getElementById('impBackBtn')
  if (impBackBtn) impBackBtn.onclick = hideImpPreview
  // 成功收尾（link/file/nearby 共用）：关弹层 → 主页面 toast 报数量（有需补填的 key 再追一条警告，
  // 并多留几秒看清再刷新）→ 整页刷新拿全新视图
  function impApplyResult(j) {
    var rep = j.report || {}
    var warns = impWarnList(rep)
    importToggle(false)
    toast(t('已导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Imported: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules')
      .replace('{n}', (rep.providers || []).length).replace('{n2}', (rep.profiles || []).length).replace('{n3}', rep.presetCount || 0).replace('{n4}', rep.scheduleRules || 0), true)
    if (warns.length) toast(warns.join(t('；', '; ')), false)
    setTimeout(function () { location.reload() }, warns.length ? 3000 : 600)
  }
  // 分享/导出/导入/确认/更新弹层的遮罩点击与 Esc 已全部由工厂壳承接，此处不再有手写监听

  // 配置包统一弹层：方向（导出|导入）与导出三方式（附近的电脑/链接/文件）的切换、
  // 底栏按钮随 tab 显隐（一个 msg 槽 + 各方向自己的主按钮）、LAN 前置状态、入口分发
  function setPkgErr(msg) {
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function updatePkgFoot() {
    var show = { shareRegen: false, shareCopyBtn: false, impImportBtn: false, pkgSaveBtn: false }
    if (pkgDirCur === 'export') {
      if (pkgExpTab === 'link') { show.shareRegen = true; show.shareCopyBtn = true }
      if (pkgExpTab === 'file') show.pkgSaveBtn = true
    } else {
      show.impImportBtn = true
    }
    Object.keys(show).forEach(function (id) {
      var b = document.getElementById(id)
      if (b) b.hidden = !show[id]
    })
    updateImpPrimary()
  }
  function setPkgDir(dir) {
    pkgDirCur = dir
    var de = document.getElementById('pkgDirExport')
    var di = document.getElementById('pkgDirImport')
    if (de) de.className = dir === 'export' ? 'on' : ''
    if (di) di.className = dir === 'import' ? 'on' : ''
    var ep = document.getElementById('pkgExportPane')
    var ip = document.getElementById('pkgImportPane')
    if (ep) ep.hidden = dir !== 'export'
    if (ip) ip.hidden = dir !== 'import'
    if (dir === 'export') switchExpTab(pkgExpTab || 'file')
    else switchImpTab(impTab || 'nearby')
    updatePkgFoot()
  }
  var EXP_SEGS = { nearby: 'segExpNearby', link: 'segExpLink', file: 'segExpFile' }
  var EXP_PANELS = { nearby: 'panelExpNearby', link: 'panelExpLink', file: 'panelExpFile' }
  function switchExpTab(tab) {
    pkgExpTab = tab
    setPkgErr('')
    hideImpPreview()
    Object.keys(EXP_PANELS).forEach(function (k) {
      var seg = document.getElementById(EXP_SEGS[k])
      var panel = document.getElementById(EXP_PANELS[k])
      if (seg) seg.className = k === tab ? 'on' : ''
      if (panel) panel.hidden = k !== tab
    })
    if (tab === 'nearby') renderExpNearby()
    if (tab === 'link' && !shareFirstUrl) createOffer() // 首次切到链接 tab 自动生成，无需先找按钮
    updatePkgFoot()
  }
  function renderExpNearby() {
    var st = document.getElementById('expNearbyState')
    var on = document.getElementById('expLanOn')
    if (!st) return
    if (lanOn) {
      st.textContent = t('✓ 局域网可达：手机远程已开启，附近电脑可以搜索到这台电脑。', '✓ On the LAN: mobile console is on — nearby computers can find this machine.')
      st.className = 'testline ok'
      if (on) on.hidden = true
    } else {
      st.textContent = t('手机远程未开启：附近电脑暂时搜不到这台电脑。', 'Mobile console is off — nearby computers cannot find this machine yet.')
      st.className = 'testline'
      if (on) on.hidden = false
    }
  }
  function openPkgOverlay(dir) {
    stopNearbyPoll()
    var pw = document.getElementById('pkgPw')
    var u = document.getElementById('impUrl')
    var f = document.getElementById('impFile2')
    var pw2 = document.getElementById('impPw2')
    if (pw) pw.value = ''
    if (u) u.value = ''
    if (f) f.value = ''
    if (pw2) pw2.value = ''
    showImpFileChip(null)
    setPkgErr('')
    hideImpPreview()
    renderShareUrls([])
    // 方向按配置状态推断：空配置=新电脑要导入；有配置=多半是分享/迁移出去
    setPkgDir(dir || (view && view.services && view.services.length ? 'export' : 'import'))
    pkgM.open()
  }
  var pkgPill = document.getElementById('pkgPill')
  if (pkgPill) pkgPill.onclick = function () { openPkgOverlay() }
  var pkgDirExport = document.getElementById('pkgDirExport')
  if (pkgDirExport) pkgDirExport.onclick = function () { setPkgDir('export') }
  var pkgDirImport = document.getElementById('pkgDirImport')
  if (pkgDirImport) pkgDirImport.onclick = function () { setPkgDir('import') }
  var segExpNearby = document.getElementById('segExpNearby')
  if (segExpNearby) segExpNearby.onclick = function () { switchExpTab('nearby') }
  var segExpLink = document.getElementById('segExpLink')
  if (segExpLink) segExpLink.onclick = function () { switchExpTab('link') }
  var segExpFile = document.getElementById('segExpFile')
  if (segExpFile) segExpFile.onclick = function () { switchExpTab('file') }
  var expLanOn = document.getElementById('expLanOn')
  if (expLanOn) {
    expLanOn.onclick = function () {
      expLanOn.disabled = true
      api('/lan', { method: 'POST', body: JSON.stringify({ enabled: true }) })
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '')
          lanOn = true
          applyLanPill(true) // 与状态行 pill 共用同一份开关状态，别处轮询重绘不回灌
          setPkgErr('')
          renderExpNearby()
          loadLanStatus()
        })
        .catch(function (e) { setPkgErr(t('开启手机远程失败：', 'Failed to enable mobile console: ') + e.message) })
        .then(function () { expLanOn.disabled = false })
    }
  }
  var pkgSaveBtn = document.getElementById('pkgSaveBtn')
  if (pkgSaveBtn) {
    pkgSaveBtn.onclick = function () {
      var pw = (document.getElementById('pkgPw').value || '')
      if (!pw) { setPkgErr(t('请设置导出口令', 'Set an export passphrase')); return }
      pkgSaveBtn.disabled = true
      api('/config/export', { method: 'POST', body: JSON.stringify({ passphrase: pw }) })
        .then(function (j) {
          var blob = new Blob([JSON.stringify(j.envelope, null, 2)], { type: 'application/octet-stream' })
          var a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = j.filename || 'modeldock-config.msync'
          document.body.appendChild(a)
          a.click()
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 0)
          pkgM.close()
          toast(t('配置包已生成，浏览器开始下载', 'Package created; your browser is downloading it'), true)
        })
        .catch(function (e) { setPkgErr(t('导出失败：', 'Export failed: ') + e.message) })
        .then(function () { pkgSaveBtn.disabled = false })
    }
  }

  // 存量收编重开入口（添加服务弹层 → 勾选导入）：/import/detect 候选可勾选，/import/apply 按 ids 应用；
  // 收编与配置包导入是两个概念（收编=本机客户端配置；配置包=.msync 文件/链接/附近）
  var legacyCands = []
  var legacyChecked = []
  function setLegacyErr(msg) {
    var el = document.getElementById('legacyErr')
    if (el) el.textContent = msg || ''
  }
  function updateLegacyGo() {
    var go = document.getElementById('legacyGo')
    if (!go) return
    var n = legacyChecked.filter(function (x) { return x }).length
    go.disabled = n === 0
    // 浏览器内嵌 t() 只有两参（不支持 params 占位），占位符手动 replace（与 impApplyResult 同法）
    go.textContent = t('导入所选（{n}）', 'Import selected ({n})').replace('{n}', String(n))
  }
  function renderLegacy() {
    var list = document.getElementById('legacyList')
    var desc = document.getElementById('legacyDesc')
    legacyCands = []
    legacyChecked = []
    if (list) list.innerHTML = ''
    if (desc) desc.textContent = t('正在检测本机客户端的存量配置…', 'Scanning local apps for existing configs…')
    setLegacyErr('')
    api('/import/detect', { timeoutMs: 20000 })
      .then(function (r) {
        var cands = (r.candidates || []).filter(function (c) { return !c.skipReason && c.base_url })
        legacyCands = cands
        legacyChecked = cands.map(function () { return true })
        if (desc) desc.textContent = cands.length
          ? t('检测到 {n} 个模型服务，勾选要搬进来的：', 'Found {n} model services. Pick the ones to bring in:').replace('{n}', String(cands.length))
          : t('没有检测到可导入的存量配置。', 'No importable legacy configs found.')
        if (list) {
          list.innerHTML = ''
          cands.forEach(function (c, i) {
            var row = document.createElement('label')
            row.className = 'legacyrow'
            var cb = document.createElement('input')
            cb.type = 'checkbox'
            cb.checked = true
            cb.onchange = function () { legacyChecked[i] = cb.checked; updateLegacyGo() }
            var nm = document.createElement('span')
            nm.className = 'lname'
            nm.textContent = c.name + (c.isCurrent ? t('（使用中）', ' (in use)') : '')
            var src = document.createElement('span')
            src.className = 'lsrc'
            src.textContent = SRC_LABEL[c.source] || c.source
            row.appendChild(cb)
            row.appendChild(nm)
            row.appendChild(src)
            list.appendChild(row)
          })
        }
        updateLegacyGo()
      })
      .catch(function (e) {
        if (desc) desc.textContent = ''
        setLegacyErr(t('检测失败：', 'Detection failed: ') + e.message)
      })
  }
  var legacyImportLink = document.getElementById('legacyImportLink')
  if (legacyImportLink) legacyImportLink.onclick = function () {
    // 切换弹层而非叠加：addM 的壳在 DOM 里更靠后，同 z-index 会盖住 legacyM（实测点击被其遮罩吃掉）
    addM.close()
    legacyM.open()
    renderLegacy()
  }
  var legacyGo = document.getElementById('legacyGo')
  if (legacyGo) {
    legacyGo.onclick = function () {
      var ids = legacyCands.filter(function (_, i) { return legacyChecked[i] }).map(function (c) { return c.id })
      if (!ids.length) return
      legacyGo.disabled = true
      api('/import/apply', { method: 'POST', body: JSON.stringify({ ids: ids }) })
        .then(function (r) {
          var n = (r.imported || []).length
          legacyM.close()
          toast('✓ ' + t('已导入 ', 'Imported ') + n + t(' 个服务，下方「我的服务」里可以查看和切换', ' services. See and switch them under "My services" below'), true)
          return load()
        })
        .catch(function (e) { setLegacyErr(t('导入失败：', 'Import failed: ') + e.message); legacyGo.disabled = false })
    }
  }

  // 附近电脑确认式直拉（sync-nearby）
  // B 侧：切到「附近的电脑」标签即自动搜索 → 点卡片「导入」→ 敲门 → 轮询对方裁决 →
  // granted 直接凭 ticket 应用（A 侧确认卡就是安全门，B 侧不再二次确认）；A 侧：确认卡 [允许][拒绝]（overview 轮询驱动）
  var nearPoll = null
  function stopNearbyPoll() {
    if (nearPoll) { clearInterval(nearPoll); nearPoll = null }
    // 恢复所有电脑卡片可点（等待期间它们被置灰防并发）
    Array.prototype.forEach.call(document.querySelectorAll('#impPeers .peercard button'), function (b) { b.disabled = false })
  }
  function setNearbyStatus(text) {
    var st = document.getElementById('nearbyStatus')
    if (st) st.textContent = text || ''
  }
  function addRescanLink(box) {
    if (!box) return
    box.innerHTML = ''
    var link = document.createElement('button')
    link.type = 'button'
    link.className = 'btn small'
    link.textContent = t('重新搜索', 'Search again')
    link.onclick = function () { link.disabled = true; searchNearbyPeers() }
    box.appendChild(link)
  }
  function searchNearbyPeers() {
    var box = document.getElementById('impPeers')
    stopNearbyPoll()
    setNearbyStatus(t('正在搜索附近运行 ModelDock 的电脑…', 'Searching for computers running ModelDock nearby…'))
    if (box) box.innerHTML = ''
    api('/sync/discover', { method: 'POST', timeoutMs: 8000 })
      .then(function (j) {
        var peers = j.peers || []
        if (!peers.length) {
          setNearbyStatus(t('附近没找到电脑：两台电脑需连同一 Wi-Fi，且旧电脑已开启「手机远程」。', 'No nearby computers found: both computers need the same Wi-Fi, and the old computer needs "Mobile console" on.'))
          addRescanLink(box)
          return
        }
        setNearbyStatus('')
        if (box) {
          box.innerHTML = ''
          peers.forEach(function (p) {
            var card = document.createElement('div')
            card.className = 'peercard'
            var nm = document.createElement('span')
            nm.className = 'pname'
            nm.textContent = p.name || (p.ips && p.ips[0]) || '?'
            var go = document.createElement('button')
            go.type = 'button'
            go.className = 'btn small primary'
            go.textContent = t('导入', 'Import')
            go.onclick = function () { requestNearby(p.ips || [p.ip], p.port, p.name || nm.textContent, card, go) }
            card.appendChild(nm)
            card.appendChild(go)
            box.appendChild(card)
          })
        }
      })
      .catch(function (e) {
        setNearbyStatus(t('搜索失败：', 'Search failed: ') + e.message)
        addRescanLink(box)
      })
  }
  function requestNearby(ips, port, name, card, goBtn) {
    // 等待期间置灰全部卡片防并发；就地提示而非 toast（结果要等几十秒）
    Array.prototype.forEach.call(document.querySelectorAll('#impPeers .peercard button'), function (b) { b.disabled = true })
    api('/sync/request-remote', { method: 'POST', body: JSON.stringify({ ips: ips, port: port }), timeoutMs: 10000 })
      .then(function (j) {
        setNearbyStatus(t('已向「', 'Request sent to "') + (name || '?') + t('」发送请求，等待允许…（最多 60 秒）', '" — waiting for approval… (up to 60s)'))
        var deadline = Date.now() + 65000
        nearPoll = setInterval(function () {
          if (Date.now() > deadline) {
            stopNearbyPoll()
            setNearbyStatus(t('对方未响应（超时）。可改用「粘贴链接」或「配置包文件」。', 'No response (timed out). Try "Paste a link" or "Package file" instead.'))
            return
          }
          api('/sync/remote-status?id=' + encodeURIComponent(j.requestId))
            .then(function (st) {
              if (st.status === 'granted') {
                stopNearbyPoll()
                setNearbyStatus(t('对方已允许，正在导入…', 'Approved — importing…'))
                api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: st.ticket } }) })
                  .then(impApplyResult)
                  .catch(function (e) {
                    stopNearbyPoll()
                    setNearbyStatus(t('导入失败：', 'Import failed: ') + e.message)
                  })
              } else if (st.status === 'denied') {
                stopNearbyPoll()
                setNearbyStatus(t('对方已拒绝本次请求。', 'The other computer declined this request.'))
              } else if (st.status === 'failed' || st.status === 'timeout') {
                stopNearbyPoll()
                setNearbyStatus(t('拉取失败：', 'Pull failed: ') + (st.error || t('超时', 'timed out')))
              }
            })
            .catch(function () { /* 单次轮询失败忽略，下一轮再试 */ })
        }, 1000)
      })
      .catch(function (e) {
        stopNearbyPoll()
        setNearbyStatus(t('请求失败：', 'Request failed: ') + e.message)
      })
  }
  // A 侧确认卡按钮（卡片显隐由 renderShareRequest 随 overview 轮询驱动）
  var shareReqAllow = document.getElementById('shareReqAllow')
  if (shareReqAllow) {
    shareReqAllow.onclick = function () {
      var req = view ? view.syncRequest : null
      if (!req) return
      api('/sync/offer-approve', { method: 'POST', body: JSON.stringify({ nonce: req.nonce, approve: true }) })
        .then(function () { toast(t('已允许：一次性直拉链接已生成（10 分钟内有效），对方将自动拉取', 'Approved: one-time pull link created (valid 10 min); the other computer will pull automatically'), true) })
        .catch(function (e) { toast(t('操作失败：', 'Failed: ') + e.message, false) })
    }
  }
  var shareReqDeny = document.getElementById('shareReqDeny')
  if (shareReqDeny) {
    shareReqDeny.onclick = function () {
      var req = view ? view.syncRequest : null
      if (!req) return
      api('/sync/offer-approve', { method: 'POST', body: JSON.stringify({ nonce: req.nonce, approve: false }) })
        .then(function () { toast(t('已拒绝', 'Denied'), true) })
        .catch(function (e) { toast(t('操作失败：', 'Failed: ') + e.message, false) })
    }
  }

  // 定时切换：面板与编辑（窗口按顺序取首个命中；节假日名单日整体跳过）
  var schedOpen = false
  var schedSeedDismissed = false // 用户保存过空时段后不再预填默认时段
  function schedSvcOptions(sel) {
    var opts = '<option value="">' + t('选择服务…', 'Pick a service…') + '</option>'
    view.services.forEach(function (x) {
      opts += '<option value="' + esc(x.id) + '"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.label) + '</option>'
    })
    return opts
  }
  function schedModelOptions(svcId, model) {
    var opts = '<option value="">' + t('透传原模型名', 'Pass through original model') + '</option>'
    view.services.forEach(function (x) {
      if (x.id !== svcId) return
      ;(x.models || []).forEach(function (m) {
        opts += '<option value="' + esc(m.id) + '"' + (m.id === model ? ' selected' : '') + '>' + esc(m.id) + '</option>'
      })
    })
    return opts
  }
  // 服务列表指纹（id+名+模型表拼接）：定时面板下拉只在列表真变时重建选项，2s 轮询零开销
  function viewServicesSig() {
    return (view.services || []).map(function (s) {
      return s.id + '\\u0001' + s.label + '\\u0001' + (s.models || []).map(function (m) { return m.id }).join(',')
    }).join('\\u0002')
  }
  var schedSvcSig = ''
  // 服务增删/改名/改模型表后只重建定时面板的 <option>，不动行结构与未保存输入——整体重渲染会冲掉
  // 正在编辑的时段时间、把预填时段灌回来（见 schedRowsEl click 处注释）；已选值原样带回，
  // 行内服务/模型已被删除时补一项原值兜底（与 routeSelectHtml 钉定兜底同口径），不静默清空已保存配置
  function refreshSchedSvcOptions() {
    if (!schedRowsRendered || !view) return
    var sig = viewServicesSig()
    if (sig === schedSvcSig) return
    schedSvcSig = sig
    var ns = document.getElementById('schedNewSvc'), nm = document.getElementById('schedNewModel')
    if (ns) {
      var curSvc = ns.value
      ns.innerHTML = schedSvcOptions(curSvc)
      if (nm) nm.innerHTML = schedModelOptions(ns.value, nm.value)
    }
    Array.prototype.forEach.call(document.querySelectorAll('#schedRows .srow'), function (r) {
      var svcSel = r.querySelector('.ssvc'), modSel = r.querySelector('.smod')
      if (!svcSel) return
      var keepSvc = svcSel.value
      svcSel.innerHTML = schedSvcOptions(keepSvc)
      // 先赋值再判断：选项列表里已无原值（服务被删）时补一项原值兜底，行不静默变成“未选服务”
      if (keepSvc && svcSel.value !== keepSvc) {
        svcSel.innerHTML += '<option value="' + esc(keepSvc) + '" selected>' + esc(keepSvc) + '</option>'
      }
      if (modSel && !modSel.disabled) {
        var keepModel = modSel.value
        modSel.innerHTML = schedModelOptions(svcSel.value, keepModel)
        if (keepModel && modSel.value !== keepModel) {
          modSel.innerHTML += '<option value="' + esc(keepModel) + '" selected>' + esc(keepModel) + '</option>'
        }
      }
    })
  }
  // 生效日下拉：''=每天；wd/we/hol=日类型过滤（工作日/周末/法定节假日）；自定义星期几回显为 custom（原值以逗号串存 data-days，保存时沿用）
  function daysSelectHtml(cls, days, dayFilter, title) {
    var key = (days || []).slice().sort().join(',')
    var val = dayFilter === 'workday' ? 'wd' : dayFilter === 'weekend' ? 'we' : dayFilter === 'holiday' ? 'hol' : key === '' ? '' : 'custom'
    return '<select class="' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + (val === 'custom' ? ' data-days="' + key + '"' : '') + '>' +
      '<option value=""' + (val === '' ? ' selected' : '') + '>' + t('每天', 'Every day') + '</option>' +
      '<option value="wd"' + (val === 'wd' ? ' selected' : '') + '>' + t('工作日', 'Weekdays') + '</option>' +
      '<option value="we"' + (val === 'we' ? ' selected' : '') + '>' + t('周末', 'Weekend') + '</option>' +
      '<option value="hol"' + (val === 'hol' ? ' selected' : '') + '>' + t('法定节假日', 'Holidays') + '</option>' +
      (val === 'custom' ? '<option value="custom" selected>' + t('自定义', 'Custom') + '</option>' : '') +
      '</select>'
  }
  function daysValueOf(sel) {
    if (sel.value === 'wd') return { dayFilter: 'workday' }
    if (sel.value === 'we') return { dayFilter: 'weekend' }
    if (sel.value === 'hol') return { dayFilter: 'holiday' }
    if (sel.value === 'custom') {
      var arr = String(sel.getAttribute('data-days') || '').split(',').map(Number).filter(function (n) { return n >= 1 && n <= 7 })
      if (arr.length) return { days: arr }
    }
    return {}
  }
  function schedRowHtml(mode, days, dayFilter, start, end, target) {
    var p = parseTarget(target)
    var avoid = mode === 'avoid'
    var tTitle = t('点击选择时间，也可直接键入 HH:mm', 'Click to pick a time, or type HH:mm')
    var modeTitle = t('优先走=时段内优先使用该服务/模型；避开=时段内不使用该服务，其余服务照常优先级', 'Prefer = use this service/model first inside the window; Avoid = skip this service inside the window, others apply as usual')
    var daysTitle = t('工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日', 'Weekdays = Mon–Fri plus makeup workdays, excluding statutory holidays; Weekend = Sat & Sun; Holidays = statutory off days per State Council announcements')
    return '<div class="srow">' +
      '<select class="smode" title="' + modeTitle + '">' +
      '<option value=""' + (!avoid ? ' selected' : '') + '>' + t('优先走', 'Prefer') + '</option>' +
      '<option value="avoid"' + (avoid ? ' selected' : '') + '>' + t('避开', 'Avoid') + '</option></select>' +
      daysSelectHtml('sdays', days, dayFilter, daysTitle) +
      '<span class="tfield"><input type="text" class="tinput" inputmode="numeric" maxlength="5" placeholder="--:--" value="' + esc(start) + '" title="' + tTitle + '"></span>' +
      '<span class="tfield"><input type="text" class="tinput" inputmode="numeric" maxlength="5" placeholder="--:--" value="' + esc(end) + '" title="' + tTitle + '"></span>' +
      '<select class="ssvc">' + schedSvcOptions(p.p) + '</select>' +
      '<select class="smod"' + (avoid ? ' disabled' : '') + '>' + (avoid ? '<option value="">' + t('按整个服务避开', 'Whole service avoided') + '</option>' : schedModelOptions(p.p, p.m || '')) + '</select>' +
      '<button type="button" class="sdel" title="' + t('删除时段', 'Delete window') + '">' + icon('close', 12) + '</button></div>'
  }
  function renderSchedPanel() {
    var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
    var wins = (sch.windows || []).slice()
    var seeded = false
    // 首次使用且未配置过任何时段时，按 DeepSeek 低谷半价时段预填（00:30–08:30 半价走 DeepSeek，其余时间走 Coding Plan）；仅预填不落盘，保存后以用户修改为准
    if (!wins.length && !schedSeedDismissed) {
      var seed = defaultScheduleSeed()
      if (seed.length) {
        wins = seed
        seeded = true
        $('#schedMsg').textContent = t('已按 DeepSeek 低谷半价时段（00:30–08:30）预填，其余时间走 Coding Plan——可直接修改后保存，不需要就清空时段再保存', 'Pre-filled with DeepSeek off-peak half-price windows (00:30–08:30), Coding Plan the rest of the time — edit then save, or clear the windows and save to dismiss')
        $('#schedMsg').className = 'testline'
      }
    }
    schedEnabledState = sch.enabled !== false
    if (schedApi && !schedToggleBusy) schedApi.set({ on: schedEnabledState })
    schedRowsRendered = true
    document.getElementById('schedRows').innerHTML = wins
      .map(function (w) { return schedRowHtml(w.mode, w.days, w.dayFilter, w.start, w.end, w.target) }).join('') ||
      '<div class="mempty">' + t('暂无时段。添加后，命中时段的请求优先走指定服务/模型。', 'No windows yet. Once added, requests inside a window prefer the specified service/model.') + '</div>'
    // 今天的日类型：只在需要解释窗口生效情况的日子显示（普通工作日无信息量，整行隐藏）
    var todayType = sch.today || 'workday'
    document.getElementById('schedToday').textContent =
      todayType === 'holiday' ? t('今日法定节假日：「工作日」时段不生效，「法定节假日」时段生效', 'Statutory holiday today: "Weekday" windows are off; "Holiday" windows apply')
      : todayType === 'makeup' ? t('今日调休补班（周末上班）：视同工作日', 'Makeup workday today (weekend shift): treated as a weekday')
      : todayType === 'weekend' ? t('今日周末：「工作日」时段不生效，「周末」时段生效', 'Weekend today: "Weekday" windows are off; "Weekend" windows apply')
      : ''
    document.getElementById('schedNewStart').value = ''
    document.getElementById('schedNewEnd').value = ''
    document.getElementById('schedNewMode').value = ''
    document.getElementById('schedNewDays').value = ''
    document.getElementById('schedNewSvc').innerHTML = schedSvcOptions('')
    document.getElementById('schedNewModel').innerHTML = schedModelOptions('', '')
    schedSvcSig = viewServicesSig()
    if (!seeded) $('#schedMsg').textContent = ''
    renderSchedUpcoming()
  }
  var schedRowsEl = document.getElementById('schedRows')
  // 即时保存：面板内任何增删改（含时间选择器的 change 冒泡）都触发防抖保存，不再有独立「保存」按钮
  function schedPersist() {
    if (!schedOpen) return
    clearTimeout(schedPersistTimer)
    schedPersistTimer = setTimeout(schedPersistNow, 600)
  }
  var schedPersistTimer = null
  function schedPersistNow() {
    var windows = [], bad = ''
    if (!schedRowsRendered) {
      // 面板未打开（如直接在 pill 上启用/停用）：原样带服务端时段，只改 enabled，避免误清时段
      windows = schedWindowsSnapshot.map(function (w) { return Object.assign({}, w) })
    } else {
    Array.prototype.forEach.call(document.querySelectorAll('#schedRows .srow'), function (r) {
      if (bad) return
      var times = r.querySelectorAll('.tinput')
      var start = parseTimeInput(times[0] ? times[0].value : ''), end = parseTimeInput(times[1] ? times[1].value : '')
      var svc = r.querySelector('.ssvc').value
      if (!start || !end || !svc) { bad = (!start || !end) ? t('时段时间格式应为 HH:mm（如 09:30），点时间框即可选择，请补全或删除该行', 'Window times must be HH:mm (e.g. 09:30); click the time box to pick, or fix/delete the row') : t('有时段未选服务，请补全或删除该行', 'A window has no service; fix or delete the row'); return }
      var mode = r.querySelector('.smode').value
      var model = r.querySelector('.smod').value
      var dv = daysValueOf(r.querySelector('.sdays'))
      // 避开窗口按整个服务生效：target 不带模型部分（服务端同样剥掉，双保险）
      var base = mode === 'avoid' ? { start: start, end: end, target: svc, mode: 'avoid' } : { start: start, end: end, target: model ? svc + ':' + model : svc }
      windows.push(Object.assign({}, base, dv.days ? { days: dv.days } : {}, dv.dayFilter ? { dayFilter: dv.dayFilter } : {}))
    })
    }
    if (bad) { $('#schedMsg').textContent = bad; $('#schedMsg').className = 'testline err'; return }
    if (schedRowsRendered && !windows.length) schedSeedDismissed = true // 用户明确删空时段：不再预填默认时段
    api('/auto-route/schedule', {
      method: 'POST',
      body: JSON.stringify({ enabled: schedEnabledState, windows: windows }),
    })
      .then(function () {
        $('#schedMsg').textContent = '✓ ' + t('已保存', 'Saved')
        $('#schedMsg').className = 'testline ok'
        return load()
      })
      .catch(function (e) { $('#schedMsg').textContent = t('保存失败：', 'Save failed: ') + e.message; $('#schedMsg').className = 'testline err' })
      .then(function () { schedToggleBusy = false })
  }
  schedRowsEl.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.classList || !t.classList.contains('sdel')) return
    t.closest('.srow').remove()
    // 删光只放占位行、不整体重渲染：重新 render 会把预填时段灌回来（导致无法清空保存），还会丢掉未保存的节假日输入
    if (!schedRowsEl.querySelector('.srow')) {
      schedRowsEl.innerHTML = '<div class="mempty">' + t('暂无时段。添加后，命中时段的请求优先走指定服务/模型。', 'No windows yet. Once added, requests inside a window prefer the specified service/model.') + '</div>'
    }
    schedPersist()
  })
  schedRowsEl.addEventListener('change', function (e) {
    var el = e.target
    if (!el || !el.classList) return
    // 避开按整个服务生效：切到避开时模型下拉禁用，切回优先走时按当前服务恢复
    if (el.classList.contains('smode')) {
      var row = el.closest('.srow'), mod = row.querySelector('.smod')
      if (el.value === 'avoid') {
        mod.innerHTML = '<option value="">' + t('按整个服务避开', 'Whole service avoided') + '</option>'
        mod.disabled = true
      } else {
        mod.innerHTML = schedModelOptions(row.querySelector('.ssvc').value, '')
        mod.disabled = false
      }
    } else if (el.classList.contains('ssvc')) {
      el.closest('.srow').querySelector('.smod').innerHTML = schedModelOptions(el.value, '')
    }
    schedPersist()
  })
  document.getElementById('schedNewSvc').addEventListener('change', function () {
    document.getElementById('schedNewModel').innerHTML = schedModelOptions(this.value, '')
  })
  document.getElementById('schedAdd').onclick = function () {
    var start = parseTimeInput($('#schedNewStart').value), end = parseTimeInput($('#schedNewEnd').value)
    var svc = $('#schedNewSvc').value
    if (!start || !end || !svc) { $('#schedMsg').textContent = !start || !end ? t('请填好起止时间（HH:mm，如 09:30），点时间框可弹出选择', 'Fill in start/end times (HH:mm, e.g. 09:30); click the time box to pick') : t('请先选择服务', 'Pick a service first'); $('#schedMsg').className = 'testline err'; return }
    var mode = document.getElementById('schedNewMode').value
    var dv = daysValueOf(document.getElementById('schedNewDays'))
    var model = $('#schedNewModel').value
    var el = document.getElementById('schedRows')
    if (el.querySelector('.mempty')) el.innerHTML = ''
    el.insertAdjacentHTML('beforeend', schedRowHtml(mode, dv.days, dv.dayFilter, start, end, mode !== 'avoid' && model ? svc + ':' + model : svc))
    $('#schedNewStart').value = ''
    $('#schedNewEnd').value = ''
    // 模式/生效日保留：连续添加多个同配置的避开时段（如上午、下午各一条）不用每次重选
    $('#schedNewSvc').innerHTML = schedSvcOptions('')
    $('#schedNewModel').innerHTML = schedModelOptions('', '')
    $('#schedMsg').textContent = ''
    schedPersist()
  }
  // 「最近节假日」：overview 随载荷下发（网关每日自动更新日历，无需手动刷新），面板打开时被动展示
  function renderSchedUpcoming() {
    var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
    var up = sch.upcomingHolidays || []
    var row = document.getElementById('schedUpcomingRow')
    var el = document.getElementById('schedUpcoming')
    if (!row || !el) return
    row.hidden = !up.length
    if (!up.length) { el.textContent = ''; return }
    var md = function (d) { return String(d || '').slice(5) } // YYYY-MM-DD → MM-DD
    el.textContent = t('最近节假日：', 'Upcoming holidays: ') + up.map(function (h) {
      var mk = (h.makeup || []).length ? t('（', ' (') + h.makeup.map(md).join(t('、', ', ')) + t(' 调休上班', ' makeup workday') + t('）', ')') : ''
      return h.name + ' ' + md(h.start) + '～' + md(h.end) + mk
    }).join(t(' · ', ' · '))
  }

  // 时段选择（Ant Design TimePicker 式交互）：点击输入框直接弹出「时/分」两列滚动面板，
  //    点选即生效、面板保持打开便于连续微调；输入框同时可键入（宽容解析，键入时两列实时联动高亮）；
  //    点外部 / Esc / Enter / 滚动页面 关闭
  function parseTimeInput(v) {
    var s = String(v || '').trim()
    var m = /^(\\d{1,2}):(\\d{1,2})$/.exec(s)
    if (m) {
      var h = +m[1], mi = +m[2]
      if (h > 23 || mi > 59) return null
      return pad2(h) + ':' + pad2(mi)
    }
    // 纯数字 3~4 位：末两位为分钟，其余为小时（0930 → 09:30，930 → 09:30）
    if (/^\\d{3,4}$/.test(s)) {
      var h2 = +s.slice(0, s.length - 2), mi2 = +s.slice(-2)
      if (h2 > 23 || mi2 > 59) return null
      return pad2(h2) + ':' + pad2(mi2)
    }
    return null
  }
  function normalizeTimeInput(el) {
    var v = parseTimeInput(el.value)
    if (v) { el.value = v; el.classList.remove('bad') }
    else if (el.value.trim()) el.classList.add('bad')
    else el.classList.remove('bad')
    return v
  }
  function defaultScheduleSeed() {
    // 按服务 id/名称匹配低谷服务商（DeepSeek）与高峰套餐（Coding Plan）；找不到对应服务就不预填
    var find = function (re) {
      var hit = null
      ;(view.services || []).forEach(function (s) { if (!hit && re.test((s.id || '') + ' ' + (s.label || ''))) hit = s })
      return hit
    }
    var off = find(/deepseek/i), peak = find(/coding[-_. ]?plan/i)
    if (!off || !peak || off.id === peak.id) return []
    return [
      { start: '00:30', end: '08:30', target: off.id },
      { start: '08:30', end: '00:30', target: peak.id },
    ]
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n }
  var timePop = null, timePopFor = null, timeSel = { h: -1, m: -1 }
  function closeTimePop() { if (timePop) { timePop.remove(); timePop = null; timePopFor = null } }
  function tpHighlight(input, scroll) {
    if (!timePop) return
    var v = parseTimeInput(input.value)
    timeSel.h = v ? +v.slice(0, 2) : -1
    timeSel.m = v ? +v.slice(3) : -1
    var cols = timePop.querySelectorAll('.tpcol')
    if (cols.length < 2) return
    Array.prototype.forEach.call(cols[0].querySelectorAll('.tpcell'), function (c) { c.classList.toggle('on', +c.dataset.v === timeSel.h) })
    Array.prototype.forEach.call(cols[1].querySelectorAll('.tpcell'), function (c) { c.classList.toggle('on', +c.dataset.v === timeSel.m) })
    if (scroll) {
      var on1 = cols[0].querySelector('.tpcell.on'), on2 = cols[1].querySelector('.tpcell.on')
      if (on1) on1.scrollIntoView({ block: 'center' })
      if (on2) on2.scrollIntoView({ block: 'center' })
    }
  }
  function tpApply(input) {
    if (timeSel.h < 0 || timeSel.m < 0) return
    input.value = pad2(timeSel.h) + ':' + pad2(timeSel.m)
    input.classList.remove('bad')
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function openTimePop(input) {
    if (timePop && timePopFor === input) return
    closeTimePop()
    var v = parseTimeInput(input.value)
    timeSel.h = v ? +v.slice(0, 2) : -1
    timeSel.m = v ? +v.slice(3) : -1
    timePopFor = input
    timePop = document.createElement('div')
    timePop.id = 'timePickPop'
    var title = document.createElement('div')
    title.className = 'tptitle'
    title.textContent = t('选择时间（也可直接键入）', 'Pick a time (or type it)')
    timePop.appendChild(title)
    var cols = document.createElement('div')
    cols.className = 'tpcols'
    // 一列缺省时点另一列的兜底值：点小时没定分钟 → 分钟取 0；点分钟没定小时 → 小时取 0
    var defs = [timeSel.m < 0 ? 0 : timeSel.m, timeSel.h < 0 ? 0 : timeSel.h]
    ;[0, 1].forEach(function (ci) {
      var col = document.createElement('div')
      col.className = 'tpcol'
      var n = ci === 0 ? 24 : 60
      for (var i = 0; i < n; i++) {
        (function (i2) {
          var c = document.createElement('button')
          c.type = 'button'
          c.className = 'tpcell'
          c.dataset.v = i2
          c.textContent = pad2(i2)
          c.onclick = function () {
            if (ci === 0) { timeSel.h = i2; if (timeSel.m < 0) timeSel.m = defs[0] }
            else { timeSel.m = i2; if (timeSel.h < 0) timeSel.h = defs[1] }
            tpApply(input)
            tpHighlight(input, false)
          }
          col.appendChild(c)
        })(i)
      }
      cols.appendChild(col)
    })
    timePop.appendChild(cols)
    document.body.appendChild(timePop)
    var r = input.getBoundingClientRect()
    timePop.style.visibility = 'hidden'
    timePop.style.display = 'block'
    requestAnimationFrame(function () {
      if (!timePop) return
      var w = timePop.offsetWidth, ph = timePop.offsetHeight
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
      var top = r.bottom + 6
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6)
      timePop.style.left = left + 'px'
      timePop.style.top = top + 'px'
      timePop.style.visibility = 'visible'
      tpHighlight(input, true) // 打开时滚到当前值
    })
  }
  document.addEventListener('focusin', function (e) {
    var t = e.target
    if (t && t.classList && t.classList.contains('tinput')) { openTimePop(t); return }
    // 焦点落到面板以外（含点面板单元格获焦）之外的地方时收起
    if (timePop && !(t && timePop.contains(t))) closeTimePop()
  }, true)
  document.addEventListener('input', function (e) {
    if (timePop && e.target && e.target.classList && e.target.classList.contains('tinput') && timePopFor === e.target) {
      tpHighlight(e.target, false) // 键入时两列实时联动高亮（不滚动，避免与手动滚动打架）
    }
  }, true)
  document.addEventListener('click', function (e) {
    var t = e.target
    if (timePop && !(t && timePop.contains(t)) && !(t && t.classList && t.classList.contains('tinput'))) closeTimePop()
  }, true)
  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('tinput')) normalizeTimeInput(e.target)
  }, true)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeTimePop(); return }
    if (e.key === 'Enter' && timePop && e.target && e.target.classList && e.target.classList.contains('tinput')) {
      normalizeTimeInput(e.target)
      closeTimePop()
    }
  }, true)
  window.addEventListener('scroll', function (e) {
    if (timePop && !(e.target && timePop.contains(e.target))) closeTimePop()
  }, true)
  // 「当前」下拉：人工钉定实际使用的主服务（选服务 → /switch 写钉定+默认路由，优先于定时窗口；
  // 选「自动 · X」→ 清除钉定交还程序自动）。快捷路径不弹确认；toast 反馈，失败经 load() 用服务端真相回滚选中值
  $('#curSvcSel').onchange = function () {
    var id = this.value
    if (!id) {
      // 选回「自动」：清除钉定，定时窗口/自动选路接管
      api('/auto-route', { method: 'POST', body: JSON.stringify({ provider: null }) })
        .then(function () { toast('✓ ' + t('已恢复自动选路', 'Back to auto selection'), true); return load() })
        .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false); return load() })
      return
    }
    api('/switch', { method: 'POST', body: JSON.stringify({ service: id }) })
      .then(function (r) {
        var extra = (r && r.refreshed && r.refreshed.length)
          ? t('（dsh 等客户端的模型列表已同步重写，重启对应客户端生效）', ' (model lists of dsh-like clients rewritten; restart them to take effect)')
          : ''
        // 人工钉定压过定时窗口：窗口命中期间如实说明钉定效果，避免「定时怎么不动了」的误读
        var sch = view.gateway && view.gateway.autoRoute ? view.gateway.autoRoute.schedule : null
        if (sch && sch.active) {
          extra += t('（已人工钉定，定时时段内也走该服务；「当前」选回「自动」恢复定时）', ' (pinned manually — applies during schedule windows too; pick "Auto" in Current to resume the schedule)')
        }
        toast('✓ ' + t('已切换，新请求立即生效', 'Switched; new requests take effect immediately') + extra, true)
        return load()
      })
      .catch(function (e) {
        toast(t('切换失败：', 'Switch failed: ') + e.message, false)
        return load()
      })
  }
  // 「下一个切换」下拉：主服务不可达时切到谁。选服务=钉定该槽（插备用链首位）；选「自动」=恢复按优先级/实测耗时排序
  $('#autoRouteSel').onchange = function () {
    var v = this.value || null
    api('/auto-route', { method: 'POST', body: JSON.stringify({ next: v }) })
      .then(function () {
        toast(v ? '✓ ' + t('已钉定下一个切换目标', 'Next failover target pinned') : '✓ ' + t('下一个切换已恢复自动排序', 'Next failover target back to auto'), true)
        return load()
      })
      .catch(function (e) { toast(t('切换路由服务商失败：', 'Failed to switch routed service: ') + e.message, false); return load() })
  }
  $('#svcSort').addEventListener('change', function () { svcSort = this.value; renderServices() })
  $('#svcFilter').addEventListener('change', function () { svcFilter = this.value; renderServices() })

  function renderClients() {
    var el = $('#clients')
    var cnt = document.getElementById('cliCount')
    if (cnt) {
      var attachedN = view.clients.filter(function (c) { return c.attached }).length
      cnt.textContent = attachedN + '/' + view.clients.length + ' ' + t('已接入', 'attached')
      cnt.hidden = view.clients.length === 0
      cnt.className = 'pill' + (attachedN ? ' ok' : '')
    }
    // 重要在前：已接入 → 已安装未接入 → 未安装（同档保持原顺序）；未安装的默认折叠，冷门客户端不占页面高度
    var rank = function (c) { return c.attached ? 0 : (c.installed ? 1 : 2) }
    var sorted = view.clients.slice().sort(function (a, b) { return rank(a) - rank(b) })
    var uninstalled = sorted.filter(function (c) { return !c.attached && !c.installed })
    var rows = cliShowUninstalled ? sorted : sorted.filter(function (c) { return rank(c) < 2 })
    el.innerHTML = rows.map(function (c) {
      var pill, btn
      var isDirect = c.mode === 'direct'
      if (c.attached) {
        pill = '<span class="pill ok">' + (isDirect ? iconInline('link', 12) + ' ' : c.route ? iconInline('lock', 12) + ' ' : '') + iconInline('check', 12) + ' ' + t('已接入', 'Attached') +
          (isDirect ? ' · ' + t('独立直连', 'direct') : '') + '</span>'
        var modeBtn = isDirect
          ? '<button class="btn small" data-toGateway="' + esc(c.id) + '" title="' +
            t('重新纳入网关统一管理（只改本地文件，不要求网关存活）', 'Back to gateway management (local files only; the gateway need not be running)') + '">' + t('切回网关', 'To gateway') + '</button>'
          : c.directSupported
            ? '<button class="btn small direct" data-direct="' + esc(c.id) + '" title="' +
              t('客户端配置直接写上游 url+真实 Key，网关挂掉后照常可用（作救援通道）', 'Writes the upstream URL and real key into the client config; keeps working if the gateway dies (rescue channel)') + '">' + t('独立直连', 'Go direct') + '</button>'
            : ''
        var envBtn = c.id === 'generic-env'
          ? '<button class="btn small" data-env="' + esc(c.id) + '" title="' +
            t('复制接入本网关用的环境变量，填给其他客户端用', 'Copy the env vars for this gateway, to fill into other clients') + '">' +
            t('复制环境变量', 'Copy env vars') + '</button> '
          : ''
        // 网关模式已接入但客户端文件指向别处（可能由其他端口的 ModelDock 实例写入，或手动修改）：
        // 明示不一致并提供一键抢回——按本网关端口 + 当前路由（钉定优先）重写
        var portMismatch = c.attached && c.mode === 'gateway' && c.pointing === 'other'
        var rewriteBtn = portMismatch
          ? '<button class="btn small" data-rewrite="' + esc(c.id) + '" title="' +
            t('该客户端配置文件被其他端口的 ModelDock 实例（或手动修改）指向了别的地址；点此按本网关端口与当前路由重写（自动快照）', 'The client config was pointed elsewhere by another ModelDock instance (or edited manually); this rewrites it for this gateway and the current route (snapshot taken)') + '">' +
            t('按本网关重写', 'Rewrite for this gateway') + '</button> '
          : ''
        btn = rewriteBtn + envBtn + (modeBtn ? modeBtn + ' ' : '') + '<button class="btn small danger" data-detach="' + esc(c.id) + '">' + t('断开并还原', 'Detach & restore') + '</button>'
      } else if (!c.installed) {
        pill = '<span class="pill dim">' + t('未安装', 'Not installed') + '</span>'
        if (cliInstalling[c.id]) {
          // 安装进行中：渲染未绑定动作的禁用按钮，跨轮询重绘保持「正在安装…」，安装完成才切换（见 setInstalling）
          btn = '<button class="btn small primary" disabled><span class="spin"></span>' + t('正在安装…', 'Installing…') + '</button>'
        } else if (c.install && c.install.auto && c.install.sandboxInstall !== 'unsupported') {
          // 沙箱内 npm 全局安装可重定向进沙箱，自动安装照常可用；脚本类安装降级为指引
          btn = '<button class="btn small primary" data-install="' + esc(c.id) + '">' + t('安装并接入', 'Install & attach') + '</button>'
        } else if (c.install) {
          btn = '<button class="btn small primary" data-install-guide="' + esc(c.id) + '">' + t('安装并接入', 'Install & attach') + '</button>'
        } else {
          btn = ''
        }
      } else {
        pill = '<span class="pill">' + t('未接入', 'Not attached') + '</span>'
        // dsh 等多 profile 客户端：接入前可选只写某些端（桌面版/网页版各自独立配置），默认全部
        var scopeSel = ''
        if (c.clientProfiles && c.clientProfiles.length) {
          var sopts = ['<option value="">' + t('全部端', 'All variants') + '（' + esc(c.clientProfiles.join('、')) + '）</option>']
          c.clientProfiles.forEach(function (n) {
            sopts.push('<option value="' + esc(n) + '">' + t('仅', 'Only ') + esc(n) + '</option>')
          })
          scopeSel = '<select class="routesel" data-cliscope="' + esc(c.id) + '" title="' +
            t('选择接入写入哪些端；桌面版与网页版配置相互独立', 'Choose which variants to write; desktop and web have independent configs') + '">' + sopts.join('') + '</select> '
        }
        // 卸载按钮：仅声明了自动卸载的客户端（npm 类）提供；断开 ≠ 卸载——这里补上生命周期最后一环
        var uninstallBtn = c.install && c.install.uninstall
          ? '<button class="btn small ghost-danger" data-uninstall="' + esc(c.id) + '">' + t('卸载', 'Uninstall') + '</button>'
          : ''
        btn = scopeSel + '<button class="btn small primary" data-attach="' + esc(c.id) + '">' + t('一键接入', 'Attach') + '</button> ' + uninstallBtn
      }
      // 钉定路由下拉（仅已接入）：gateway 模式 = 跟随全局/钉服务（只改服务端内存，即时生效）；
      // direct 模式 = 更换直连目标（重写客户端配置文件，走快照 + 确认）
      var routeSel = ''
      if (c.attached) {
        var opts = []
        if (!isDirect) {
          opts.push('<option value="default"' + (!c.route ? ' selected' : '') + '>' +
            t('跟随全局', 'Follow global') + (view.current ? '（' + esc(view.current.label) + '）' : '') + '</option>')
        }
        view.services.forEach(function (s) {
          opts.push('<option value="' + esc(s.id) + '"' + (c.pinnedProvider === s.id ? ' selected' : '') + '>' +
            esc(s.label) + (s.enabled === false ? t('（已下线）', ' (offline)') : '') + '</option>')
        })
        routeSel = '<select class="routesel" data-route="' + esc(c.id) + '" title="' +
          (isDirect
            ? t('更换直连目标（重写客户端配置，自动快照）', 'Change direct target (rewrites client config; snapshot taken)')
            : t('钉定后该客户端固定走所选服务，不受全局切换影响', 'When pinned, this client always uses the selected service regardless of global switching')) +
          '">' + opts.join('') + '</select>'
      }
      // 网关模式已接入但客户端文件指向别处（可能是另一实例的端口）：明示不一致，重写入口就是「接入」
      var portMismatch = c.attached && c.mode === 'gateway' && c.pointing === 'other'
      return '<div class="service"><div class="info"><span class="name">' + esc(c.label) + '</span> ' + pill +
        (routeSel ? ' ' + routeSel : '') +
        '<br><span class="meta">' + (c.attached && c.service ? ((isDirect ? t('独立直连：', 'Direct: ') : c.route ? t('已钉定：', 'Pinned: ') : t('当前服务：', 'Current service: ')) + '<b>' + esc(c.service) + '</b>' + (c.detail ? ' · ' + esc(c.detail) : '')) : esc(c.detail || '')) +
        (portMismatch ? ' · <span class="hint-warn">⚠ ' + t('客户端文件指向其他地址（可能由其他端口的 ModelDock 实例写入），点「按本网关重写」修复', 'Client file points elsewhere (likely written by another ModelDock instance); click Rewrite for this gateway to fix') + '</span>' : '') +
        (c.attached && c.clientScope && c.clientScope.length ? ' · ' + t('写入端: ', 'writes: ') + esc(c.clientScope.join('、')) : '') + '</span></div>' + btn + '</div>'
    }).join('') + (uninstalled.length ? '<div class="listmore"><button class="btn small" id="cliMore">' +
      (cliShowUninstalled
        ? t('收起未安装的客户端', 'Hide not-installed clients')
        : t('展开未安装的客户端（', 'Show not-installed clients (') + uninstalled.length + t('）', ')')) +
      '</button></div>' : '')

    var cliMoreBtn = document.getElementById('cliMore')
    if (cliMoreBtn) cliMoreBtn.onclick = function () { cliShowUninstalled = !cliShowUninstalled; renderClients() }
    document.querySelectorAll('[data-attach]').forEach(function (b) {
      b.onclick = function () { doAttach(b.getAttribute('data-attach')) }
    })
    document.querySelectorAll('[data-rewrite]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rewrite')
        var c = clientOf(id)
        // 钉定路由的客户端按钉定 profile 重写；跟随全局的按当前 active_profile
        doRewrite(id, (c && c.route) || '')
      }
    })
    document.querySelectorAll('[data-env]').forEach(function (b) {
      b.onclick = function () { showEnvVars(b.getAttribute('data-env')) }
    })
    document.querySelectorAll('[data-install]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-install')
        var c = clientOf(id)
        if (!c || !c.install) return
        confirmModal(
          t('安装并接入「', 'Install & attach "') + labelOf(id) + t('」？', '"?'),
          [
            t('将执行安装命令：', 'Will run install command: ') + c.install.command,
            // 沙箱实例：npm 全局安装落点被重定向进沙箱（真机全局环境零改动），提前讲明
            c.install.sandboxInstall === 'redirect'
              ? t('沙箱模式：程序将安装进沙箱内，不改动真机的全局环境与已装客户端', 'Sandbox mode: the client is installed inside the sandbox; the global environment and installed clients on the real machine are untouched')
              : null,
            t('安装成功后自动写入客户端的空配置文件，再进入接入流程', 'After install, an initial config file is written automatically, then the attach flow starts'),
            t('只安装客户端并写入其初始配置，不影响 ModelDock 其余设置', 'Only installs the client and writes its initial config; other ModelDock settings are untouched')
          ].filter(Boolean),
          t('安装并接入', 'Install & attach'),
          function () {
            setInstalling(id, true)
            api('/install', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 600000 })
              .then(function (r) {
                if (!r.ok) throw new Error(r.output || t('安装失败，请手动安装', 'Install failed; please install manually'))
                toast('✓ ' + (r.skipped
                  ? t('已检测到客户端命令，跳过安装，正在接入', 'Client command already present; skipping install and attaching')
                  : t('已安装，正在接入', 'Installed; attaching')), true)
                // 安装完成：解除「正在安装」，让 load() 重绘为「一键接入」；随后进入接入确认
                setInstalling(id, false)
                return load().then(function () { doAttach(id) })
              })
              .catch(function (e) { setInstalling(id, false); toast(t('安装失败：', 'Install failed: ') + e.message, false) })
          }
        )
      }
    })
    document.querySelectorAll('[data-install-guide]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-install-guide')
        var c = clientOf(id)
        if (!c || !c.install) return
        confirmModal(
          t('安装「', 'Install "') + labelOf(id) + t('」', '"'),
          [
            // 沙箱内脚本类安装（curl|bash 等）会写真机、落点无法重定向：明确说不支持自动安装
            c.install.sandboxInstall === 'unsupported'
              ? t('沙箱环境不支持自动安装该客户端（其安装方式会写进真机，无法重定向）；请按下方指引手动安装，装好后回到这里重新检测', 'Sandbox cannot auto-install this client (its install method writes to the real machine and cannot be redirected); install manually per the guide below, then come back and re-detect')
              : null,
            c.install.guide,
            c.install.homepage ? t('官方安装页：', 'Official install page: ') + c.install.homepage : null,
            t('装好后点下方按钮重新检测', 'Once installed, click the button below to re-detect')
          ].filter(Boolean),
          t('我装好了，重新检测', 'Installed — re-detect'),
          function () { load() }
        )
      }
    })
    document.querySelectorAll('[data-uninstall]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-uninstall')
        var c = clientOf(id)
        if (!c || !c.install || !c.install.uninstall) return
        confirmModal(
          t('卸载「', 'Uninstall "') + labelOf(id) + t('」？', '"?'),
          [
            t('将执行卸载命令：', 'Will run uninstall command: ') + c.install.uninstall.command,
            c.install.uninstall.sandbox
              ? t('沙箱模式：只卸载装进沙箱内的程序，真机全局环境与已装客户端不受影响', 'Sandbox mode: only the copy inside the sandbox is removed; the real machine global environment and installed clients are untouched')
              : t('将从本机全局环境卸载该客户端（其他程序不受影响）', 'The client will be removed from this machine global environment (other programs are untouched)'),
            t('客户端配置文件保留；若仍是安装时写入的空配置会一并删除', 'Client config files are kept; the empty bootstrap config written at install time is removed along with the program')
          ].filter(Boolean),
          t('卸载', 'Uninstall'),
          function () {
            api('/uninstall', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 120000 })
              .then(function (r) {
                toast('✓ ' + (r.skipped
                  ? t('命令已不在 PATH 上，无需卸载', 'Command already absent from PATH; nothing to uninstall')
                  : t('已卸载', 'Uninstalled')), true)
                return load()
              })
              .catch(function (e) { toast(t('卸载失败：', 'Uninstall failed: ') + e.message, false) })
          }
        )
      }
    })
    document.querySelectorAll('[data-detach]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-detach')
        confirmModal(t('断开「', 'Detach "') + labelOf(id) + t('」？', '"?'), [t('配置将还原到接入前的样子，该客户端不再经过 ModelDock', 'Config will be restored to its pre-attach state; the client no longer goes through ModelDock')], t('断开并还原', 'Detach & restore'), function () {
          api('/detach', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 60000 })
            .then(function (r) {
              var msg = '✓ ' + t('已断开并还原原配置', 'Detached and original config restored')
              if (r.restored && r.consistent === false) msg = t('已还原（部分文件与备份不完全一致）', 'Restored (some files differ slightly from the backup)')
              if ((r.notes || []).length) msg += '：' + r.notes.join('；')
              toast(msg, true)
              return load()
            })
            .catch(function (e) { toast(t('断开失败：', 'Detach failed: ') + e.message, false) })
        })
      }
    })
    // 钉定路由：gateway 模式选「跟随全局」= default，选某服务 = 钉定（服务端内存，立即生效）；
    // direct 模式选某服务 = 更换直连目标（重写客户端配置，快照 + 确认）
    document.querySelectorAll('[data-route]').forEach(function (sel) {
      sel.onchange = function () {
        var id = sel.getAttribute('data-route')
        var v = sel.value
        var c = clientOf(id)
        if (c && c.mode === 'direct') {
          confirmModal(t('更换直连目标？', 'Change direct target?'), [
            t('将把服务「', 'This rewrites the client config with service "') + serviceLabel(v) +
              t('」的地址与真实 Key 写入该客户端配置（明文；自动快照）', '" and its real key in plaintext (snapshot taken automatically)'),
            t('重启该客户端后生效', 'Restart the client to take effect')
          ], t('确认更换', 'Change'), function () {
            api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'direct', provider: v }) })
              .then(function () {
                toast('✓ ' + t('直连目标已更换，重启客户端后生效', 'Direct target changed; restart the client'), true)
                return load()
              })
              .catch(function (e) { toast(t('更换失败：', 'Change failed: ') + e.message, false); load() })
          })
          return
        }
        var body = v === 'default' ? { harness: id, default: true } : { harness: id, provider: v }
        api('/harness/route', { method: 'POST', body: JSON.stringify(body) })
          .then(function (r) {
            toast('✓ ' + (v === 'default'
              ? t('已恢复跟随全局', 'Now follows the global service')
              : t('已钉定到 ', 'Pinned to ') + serviceLabel(v)), true)
            return load()
          })
          .catch(function (e) {
            toast(t('设置路由失败：', 'Failed to set route: ') + e.message, false)
            load() // 回滚下拉显示（服务端未改，重取 overview 即恢复原状）
          })
      }
    })
    // 切独立直连 / 切回网关：都重写客户端配置文件（服务端走 switchHarnessMode：快照 + 原子写 + 登记）
    document.querySelectorAll('[data-direct]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-direct')
        var c = clientOf(id)
        var svc = (c && c.service) || (view.current && view.current.label) || ''
        confirmModal(t('把「', 'Switch "') + labelOf(id) + t('」切换为独立直连？', '" to direct mode?'), [
          t('将把服务「', 'This writes service "') + esc(svc) +
            t('」的地址与真实 Key 明文写入该客户端的配置文件（改前自动快照，可一键切回）', '" and its real key in plaintext into the client config (snapshot first; switch back anytime)'),
          t('此后不经过网关：无请求日志、无熔断切换；模型映射按当前路由尽量还原', 'No longer goes through the gateway: no logs or failover; model mappings are restored from the current route'),
          t('重启该客户端后生效', 'Restart the client to take effect')
        ], t('切换为独立直连', 'Go direct'), function () {
          api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'direct' }) })
            .then(function () {
              toast('✓ ' + t('已切换为独立直连，重启客户端后生效', 'Now in direct mode; restart the client'), true)
              return load()
            })
            .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
        })
      }
    })
    document.querySelectorAll('[data-toGateway]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-toGateway')
        confirmModal(t('把「', 'Switch "') + labelOf(id) + t('」切回网关接入？', '" back to gateway mode?'), [
          t('客户端配置将改回指向本地网关（写入的是本地网关 token，非上游真实 Key）', 'The client config points back to the local gateway (local gateway token, not the upstream key)'),
          t('重启该客户端后生效', 'Restart the client to take effect')
        ], t('切回网关', 'To gateway'), function () {
          api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'gateway' }) })
            .then(function () {
              toast('✓ ' + t('已切回网关接入，重启客户端后生效', 'Back to gateway mode; restart the client'), true)
              return load()
            })
            .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
        })
      }
    })
  }

  function serviceLabel(id) {
    if (view) {
      for (var i = 0; i < view.services.length; i++) if (view.services[i].id === id) return view.services[i].label
    }
    return id
  }

  function labelOf(id) {
    if (view) {
      for (var i = 0; i < view.clients.length; i++) if (view.clients[i].id === id) return view.clients[i].label
    }
    return id
  }

  function clientOf(id) {
    if (view) {
      for (var i = 0; i < view.clients.length; i++) if (view.clients[i].id === id) return view.clients[i]
    }
    return null
  }

  // 安装进行中：先写模块级标记让 renderClients 在轮询重绘后仍保持「正在安装…」，再就地更新当前按钮以便即时反馈；
  // 安装完成或失败后由调用方 setInstalling(id,false) 解除标记，重绘为对应的下一种状态（一键接入 / 安装并接入）
  function setInstalling(id, on) {
    if (on) cliInstalling[id] = true; else delete cliInstalling[id]
    var el = document.querySelector('[data-install="' + id + '"]')
    if (el) {
      if (on) {
        if (el.dataset.label === undefined) el.dataset.label = el.textContent.trim()
        el.disabled = true
        el.innerHTML = '<span class="spin"></span>' + t('正在安装…', 'Installing…')
      } else {
        el.disabled = false
        el.textContent = el.dataset.label || t('安装并接入', 'Install & attach')
        delete el.dataset.label
      }
      return
    }
    // 按钮已被重绘（5s 轮询）覆盖而不再带 data-install：按模块级标记重建一次客户端列表
    renderClients()
  }

  // generic-env：取网关地址 + token，弹窗展示标准环境变量，一键复制给其他客户端用
  function showEnvVars(id) {
    api('/harness/env', { method: 'POST', body: JSON.stringify({ harness: id }) })
      .then(function (r) {
        var lines = r.lines || []
        if (!lines.length) throw new Error(t('未返回环境变量', 'No env vars returned'))
        var text = lines.join('\\n')
        confirmModal(
          t('环境变量 — ', 'Env vars — ') + labelOf(id),
          [t('写进客户端或 shell 后，即可经本机网关调用所有已配置服务：', 'Write these into the client (or your shell) to reach every configured service through this gateway:')]
            .concat(lines),
          t('复制全部', 'Copy all'),
          function () {
            copyText(text, function () { toast('✓ ' + t('已复制到剪贴板', 'Copied to clipboard'), true) })
          }
        )
      })
      .catch(function (e) { toast(t('获取环境变量失败：', 'Failed to get env vars: ') + e.message, false) })
  }

  function doAttach(id) {
    var b = document.querySelector('[data-attach="' + id + '"]')
    if (b) b.disabled = true
    // 接入范围（dsh 多 profile）：下拉选了「仅 desktop」等就带上 client_profiles；空值 = 全部端
    var scopeSel = document.querySelector('[data-cliscope="' + id + '"]')
    var body = { harness: id, setDefault: true }
    if (scopeSel && scopeSel.value) {
      body.client_profiles = scopeSel.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    }
    api('/attach/plan', { method: 'POST', body: JSON.stringify(body) })
      .then(function (p) {
        if (b) b.disabled = false
        confirmModal(
          t('接入「', 'Attach "') + labelOf(id) + t('」？', '"?'),
          [
            t('将修改：', 'Will modify: ') + (p.files.map(function (f) { return f.path }).join('、') || t('（无文件改动）', '(no file changes)')),
            t('只改接口地址和本地密钥，其他内容不动', 'Only the base URL and local credentials change; everything else is untouched'),
            t('修改前自动备份，随时可断开还原', 'An automatic backup is made first; detach anytime to restore')
          ].concat(p.notes || []),
          t('确认接入', 'Attach'),
          function () {
            api('/attach/apply', { method: 'POST', body: JSON.stringify(body) })
              .then(function () {
                if (id === 'generic-env') {
                  // 不写文件、没有"重启客户端生效"的概念：接入即登记，直接把环境变量递到用户面前
                  return load().then(function () { showEnvVars(id) })
                }
                toast('✓ ' + t('已接入，重启 ', 'Attached. Restart ') + labelOf(id) + t(' 后生效', ' to take effect'), true)
                return load()
              })
              .catch(function (e) { toast(t('接入失败：', 'Attach failed: ') + e.message, false) })
          }
        )
      })
      .catch(function (e) { if (b) b.disabled = false; toast(t('读取接入方案失败：', 'Failed to read attach plan: ') + e.message, false) })
  }

  var mCb = null
  function confirmModal(title, lines, okText, cb) {
    // dev 沙箱实例：所有写操作确认弹窗首行明示"只影响沙箱"，生产零接触；
    // 沙箱目录路径取服务端下发的 gateway.home（缺省时不含括号，避免展示写死的默认路径）
    var sandbox = view && view.gateway && view.gateway.sandbox
    var gwHome = (view.gateway && view.gateway.home) || ''
    var prefix = sandbox
      ? [gwHome
          ? '⚠ ' + t('dev 沙箱实例：以下写入只影响沙箱目录（', '⚠ dev sandbox: the writes below only affect the sandbox dir (') + gwHome + t('），生产客户端与配置不受影响', '); production clients and config are untouched')
          : '⚠ ' + t('dev 沙箱实例：以下写入只影响沙箱目录，生产客户端与配置不受影响', '⚠ dev sandbox: the writes below only affect the sandbox dir; production clients and config are untouched')]
      : []
    $('#mTitle').textContent = title
    $('#mList').innerHTML = prefix.concat(lines.filter(Boolean)).map(function (l) { return '<li class="mono">' + linkifyText(l) + '</li>' }).join('')
    $('#mOk').textContent = okText
    mCb = cb
    confirmM.open()
  }

  // 指向不一致修复：客户端文件被其他实例（或手动）改到别的地址，按本网关端口 + 当前路由重写。
  // 复用 attach/plan + attach/apply 管线（快照 + 原子写 + 登记）；不带 setDefault，不改动路由与全局默认。
  function doRewrite(id, route) {
    var b = document.querySelector('[data-rewrite="' + id + '"]')
    if (b) b.disabled = true
    var body = { harness: id }
    if (route) body.profile = route
    api('/attach/plan', { method: 'POST', body: JSON.stringify(body) })
      .then(function (p) {
        if (b) b.disabled = false
        confirmModal(
          t('按本网关重写「', 'Rewrite "') + labelOf(id) + t('」？', '" for this gateway?'),
          [
            t('将把客户端配置的接口地址改回本网关（', 'This points the client config back to this gateway (') + p.port + t('）并按当前路由同步模型列表', ') and syncs the model list with the current route'),
            t('修改前自动备份，随时可断开还原', 'An automatic backup is made first; detach anytime to restore')
          ].concat(p.notes || []),
          t('确认重写', 'Rewrite'),
          function () {
            api('/attach/apply', { method: 'POST', body: JSON.stringify(body) })
              .then(function () {
                toast('✓ ' + t('已按本网关重写，重启 ', 'Rewritten for this gateway. Restart ') + labelOf(id) + t(' 后生效', ' to take effect'), true)
                return load()
              })
              .catch(function (e) { toast(t('重写失败：', 'Rewrite failed: ') + e.message, false) })
          }
        )
      })
      .catch(function (e) { if (b) b.disabled = false; toast(t('读取重写方案失败：', 'Failed to read rewrite plan: ') + e.message, false) })
  }

  // mCancel/mOk/Esc 由工厂底栏与 closeOnEsc 承接（onClose 清 mCb = 放弃回调，与旧语义一致）
  // Enter 确认（焦点在按钮上时交给浏览器默认行为，避免双触发）
  document.addEventListener('keydown', function (e) {
    var ov = document.getElementById('overlay')
    if (!ov || ov.hidden) return
    if (e.key === 'Enter' && (!document.activeElement || document.activeElement.tagName !== 'BUTTON')) {
      $('#mOk').click()
    }
  })

  // 编辑模型服务：壳只留 Key 语义与提交动作；字段块见下方「服务表单公共块」
  var editing = null
  var knownModels = {} // 填模型名时自动补上下文/输出的兜底总表（内置小表 ∪ models.dev 目录懒加载）
  var catalogTable = {} // models.dev 目录大表（/_modeldock/model-catalog 懒加载一次，不进 overview 轮询）

  function bindKeyToggle(inputId, btnId, revealSaved) {
    var input = document.getElementById(inputId)
    var btn = document.getElementById(btnId)
    if (!input || !btn) return
    var setShown = function (shown) {
      input.type = shown ? 'text' : 'password'
      btn.innerHTML = icon(shown ? 'eye-off' : 'eye', 14)
      btn.title = shown ? t('隐藏明文', 'Hide plaintext') : t('显示明文', 'Show plaintext')
    }
    btn.onclick = function () {
      var show = input.type === 'password'
      if (show && revealSaved && input.value === '') {
        // 字段为空 = 服务端没有回传已保存的 Key：点眼睛按需取一次明文填入，供查看/拷贝
        btn.disabled = true
        revealSaved(function (ok) {
          btn.disabled = false
          if (!ok) return
          setShown(true)
          try { input.select() } catch (e) { /* 选中失败不影响显示 */ }
        })
        return
      }
      setShown(show)
    }
  }
  bindKeyToggle('efKey', 'efKeyToggle', function (done) {
    // 编辑壳的提示槽就在左下角：可见 Key 失败别用 toast（会被弹层磨砂遮罩糊住）
    var msg = testlineWriter('efMsg')
    api('/service/reveal-key', { method: 'POST', body: JSON.stringify({ id: editing }) })
      .then(function (r) {
        if (r && r.key) { $('#efKey').value = r.key; done(true) }
        else { msg(t('未能读取已保存的 Key（可能未设置，或系统安全后端拒绝访问）', 'Could not read the saved key (not set, or the OS secure backend refused)'), 'err'); done(false) }
      })
      .catch(function (e) { msg(t('读取 Key 失败：', 'Failed to read key: ') + e.message, 'err'); done(false) })
  })
  bindKeyToggle('afKey', 'afKeyToggle')
  bindKeyToggle('pkgPw', 'pkgPwToggle')

  // 服务表单公共块（添加/编辑两壳共用的一份实现）
  // 三个块：端点(EndpointBlock) / 模型目录+拉取面板(ModelBlock) / 故障切换顺序(FallbackBlock)。
  // HTML 由块生成：文案带 data-i18n（applyLang 的全局扫描会随语言切换刷新），生成时 applyI18nTree 立即生效；
  // 事件全部委托在块根上，load() 重写 innerHTML 不丢监听。两壳各自实例化（id 前缀 ef*/af*），
  // 壳只保留真正差异：装载来源（预设/已有服务）、Key 语义、提交端点。
  function applyI18nTree(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n]'), function (el) { setI18nText(el, i18nPick(el.getAttribute('data-i18n'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-ph]'), function (el) { el.setAttribute('placeholder', i18nPick(el.getAttribute('data-i18n-ph'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-title]'), function (el) { el.setAttribute('title', i18nPick(el.getAttribute('data-i18n-title'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-tip]'), function (el) { el.setAttribute('data-tip', i18nPick(el.getAttribute('data-i18n-tip'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-aria]'), function (el) { el.setAttribute('aria-label', i18nPick(el.getAttribute('data-i18n-aria'))) })
  }
  // tokens 输入解析：容忍千分位逗号 / 空格 / 下划线（如 200,000 或 128 000），
  // 仍为数字则返回 number，空返回 null，含非数字字符返回 NaN（保存时提示）
  // 注意：UI_HTML 是 JS 模板字符串，正则里的反斜杠必须双写（\\d、\\s），
  // 否则会被当转义序列吞掉（\d→d、\s→s），导致前端校验静默失效。
  function parseTokens(s) {
    s = String(s == null ? '' : s).trim().replace(/[,\\s_]/g, '')
    return s === '' ? null : (/^\\d+$/.test(s) ? Number(s) : NaN)
  }

  function createEndpointBlock(hostId, prefix) {
    var root = document.getElementById(hostId)
    var st = { docsHtml: '' }
    var gid = function (s) { return prefix + s }
    function html() {
      // 三协议各一行、预设与自定义同构：厂商支持哪个就填哪行，不再有「默认协议」下拉；
      // 哪行落 base_url 由 collect 推导（anthropic > openai > responses），对用户不可见
      return '<div class="egrid">' +
        '<label><span data-i18n="显示名称||Display name">显示名称</span><input type="text" id="' + gid('Name') + '"></label>' +
        '<label><span data-i18n="Anthropic 接口||Anthropic endpoint">Anthropic 接口</span><input type="text" id="' + gid('EndAnthropic') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '</div>' +
        '<div class="egrid">' +
        '<label><span data-i18n="OpenAI 接口 (/v1)||OpenAI endpoint (/v1)">OpenAI 接口 (/v1)</span><input type="text" id="' + gid('EndOpenai') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '<label><span data-i18n="Responses 接口 (/responses)||Responses endpoint (/responses)">Responses 接口 (/responses)</span><input type="text" id="' + gid('EndResponses') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '</div>' +
        '<p class="desc-sm"><span data-i18n="厂商支持哪个协议就填哪行（至少一行）；地址末尾的 /v1、/v3 是厂商自定的版本号，照抄厂商文档即可；Codex 只认 Responses。||Fill in the rows for the protocols your vendor supports (at least one); /v1 and /v3 suffixes are vendor-defined API versions — copy from the docs; Codex speaks Responses only.">厂商支持哪个协议就填哪行（至少一行）；地址末尾的 /v1、/v3 是厂商自定的版本号，照抄厂商文档即可；Codex 只认 Responses。</span>' + (st.docsHtml ? ' ' + st.docsHtml : '') + '</p>'
    }
    function load(o) {
      // o = { name, namePlaceholder, baseUrl, protocol, endpoints, docsHtml }
      st.docsHtml = o.docsHtml || ''
      root.innerHTML = html()
      var nameEl = $('#' + gid('Name'))
      nameEl.value = o.name || ''
      // 占位符随场景变化（预设=留空用厂商默认名；自定义=起名示例），带 data-i18n-ph 让语言切换跟随
      if (o.namePlaceholder) { nameEl.setAttribute('placeholder', i18nPick(o.namePlaceholder)); nameEl.setAttribute('data-i18n-ph', o.namePlaceholder) }
      // 三行协议地址：endpoints 优先，默认协议那行回落 base_url（base_url 即默认协议端点）。
      // 刻意不做厂商预设回填：空行 = 用户显式不用该协议（尤其编辑场景，回填会让删掉的地址复活）
      var proto = o.protocol || 'openai'
      var ep = o.endpoints || {}
      var rows = {
        anthropic: ep.anthropic || (proto === 'anthropic' ? o.baseUrl || '' : ''),
        openai: ep.openai || (proto === 'openai' ? o.baseUrl || '' : ''),
        responses: ep.responses || (proto === 'responses' ? o.baseUrl || '' : ''),
      }
      $('#' + gid('EndAnthropic')).value = rows.anthropic
      $('#' + gid('EndOpenai')).value = rows.openai
      $('#' + gid('EndResponses')).value = rows.responses
      applyI18nTree(root)
    }
    function collect() {
      // 至少一行有值 → 默认协议取 anthropic > openai > responses 里第一个填写的（与本网关主力客户端同序）；
      // 默认协议那行落 base_url，其余填写的行进 endpoints（同一地址不重复存）
      var urls = {
        anthropic: $('#' + gid('EndAnthropic')).value.trim(),
        openai: $('#' + gid('EndOpenai')).value.trim(),
        responses: $('#' + gid('EndResponses')).value.trim(),
      }
      var protocol = urls.anthropic ? 'anthropic' : urls.openai ? 'openai' : 'responses'
      var endpoints = {}
      for (var k in urls) if (urls[k] && k !== protocol) endpoints[k] = urls[k]
      return { name: $('#' + gid('Name')).value.trim(), url: urls[protocol], protocol: protocol, endpoints: endpoints, urls: urls }
    }
    return { load: load, collect: collect, el: root }
  }

  function createModelBlock(hostId, prefix, opts) {
    var root = document.getElementById(hostId)
    // dirty=用户动过模型目录（增删/改数/拉取填入）；defaultDirty=点过 ★ 或默认行被删。
    // 编辑保存只认 defaultDirty（旧行为）；添加保存认 dirty（未动过就不带 models，保留服务端预设合并+在线拉取）。
    var st = { defaultModel: '', defaultDirty: false, dirty: false }
    var gid = function (s) { return prefix + s }
    function rowsHost() { return document.getElementById(gid('ModelRows')) }
    function rowHtml(m) {
      var vision = (m.capabilities || []).indexOf('vision') >= 0
      // 显示名副行：仅当存在且与 ID 不同（忽略大小写/空格）才渲染，避免同一字符串出现两遍
      var dn = m.display_name && String(m.display_name).trim().toLowerCase() !== String(m.id).trim().toLowerCase() ? String(m.display_name).trim() : ''
      return '<div class="mrow">' +
        '<button class="def' + (m.id === st.defaultModel ? ' on' : '') + '" type="button" title="' + t('设为默认', 'Set as default') + '" data-mid="' + esc(m.id) + '">' + icon('star', 13) + '</button>' +
        '<div class="midwrap"><span class="mid" title="' + esc(m.id) + '">' + esc(m.id) + '</span>' + (dn ? '<span class="msub" title="' + esc(dn) + '">' + esc(dn) + '</span>' : '') + '</div>' +
        '<input type="text" inputmode="numeric" data-f="context_window" value="' + (m.context_window == null ? '' : esc(m.context_window)) + '" placeholder="' + t('未知', 'unknown') + '">' +
        '<input type="text" inputmode="numeric" data-f="max_output" value="' + (m.max_output == null ? '' : esc(m.max_output)) + '" placeholder="' + t('未知', 'unknown') + '">' +
        '<input type="checkbox" class="vpick" data-f="vision"' + (vision ? ' checked' : '') + ' title="' + t('该模型支持图片输入（接入客户端会据此声明）', 'This model accepts image input (attached clients are told so)') + '">' +
        '<button class="del" type="button" title="' + t('删除该模型', 'Delete this model') + '">' + icon('close', 12) + '</button></div>'
    }
    function renderRows(models) {
      var el = rowsHost()
      if (!models.length) {
        el.innerHTML = '<div class="mempty">' + t('暂无模型。在下方输入模型 ID 添加；保存后即可在「测速」和新建路由时使用。', 'No models yet. Add a model ID below; saved models appear in speed tests and new routes.') + '</div>'
        return
      }
      el.innerHTML = models.map(rowHtml).join('')
    }
    function load(models, defaultModel) {
      st.defaultModel = defaultModel || ''
      st.defaultDirty = false
      st.dirty = false
      root.innerHTML = html()
      renderRows(models || [])
      applyI18nTree(root)
    }
    function rowsArray() {
      var arr = []
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mrow'), function (row) {
        var mid = row.querySelector('.mid').textContent.trim()
        if (!mid) return
        // 上下文/输出保留输入框原文（可为空字符串），回显原样、保存时才统一解析校验
        // 显示名随行携带：拉取填入等重绘路径把 arr 回传 rowHtml 时副行不丢
        // row 一并带出：拉取面板比差异时要读同行的视觉勾选态
        var sub = row.querySelector('.msub')
        arr.push({
          id: mid,
          context_window: row.querySelector('[data-f="context_window"]').value.trim(),
          max_output: row.querySelector('[data-f="max_output"]').value.trim(),
          display_name: sub ? sub.textContent.trim() : '',
          row: row,
        })
      })
      return arr
    }
    function collect() {
      var out = {}
      var dup = false
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mrow'), function (row) {
        var mid = row.querySelector('.mid').textContent.trim()
        if (!mid) return
        if (out[mid]) { dup = true; return }
        var rec = {}
        var ctx = parseTokens(row.querySelector('[data-f="context_window"]').value)
        var mo = parseTokens(row.querySelector('[data-f="max_output"]').value)
        if (ctx !== null) rec.context_window = ctx
        if (mo !== null) rec.max_output = mo
        // 视觉是可选能力：整列勾选状态即权威值（未勾=空数组，服务端据此清掉旧标记）
        var vp = row.querySelector('[data-f="vision"]')
        rec.capabilities = vp && vp.checked ? ['vision'] : []
        // 显示名只随副行走（渲染时已按「与 ID 不同」去重）；缺失不提交，服务端保留既有
        var dnEl = row.querySelector('.msub')
        if (dnEl && dnEl.textContent.trim()) rec.display_name = dnEl.textContent.trim()
        out[mid] = rec
      })
      // 新增行：仅当输入框里的 id 尚未在列表中时才算新增；
      // 若已存在（含刚点“添加”后输入框残留同一 id 的情况）则跳过，避免误判重复
      var nid = $('#' + gid('NewId')).value.trim()
      if (nid && !out[nid]) {
        var rec2 = {}
        var ctx2 = parseTokens($('#' + gid('NewCtx')).value)
        var mo2 = parseTokens($('#' + gid('NewOut')).value)
        if (ctx2 !== null) rec2.context_window = ctx2
        if (mo2 !== null) rec2.max_output = mo2
        var nv = $('#' + gid('NewVision'))
        rec2.capabilities = nv && nv.checked ? ['vision'] : []
        out[nid] = rec2
      }
      return { models: out, dup: dup }
    }
    function syncDefButtons(mid) {
      root.querySelectorAll('.def').forEach(function (b) {
        var on = b.getAttribute('data-mid') === mid
        b.classList.toggle('on', on)
        b.innerHTML = icon('star', 13)
      })
    }
    function visibleFetchRows() {
      return Array.prototype.filter.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        return row.style.display !== 'none'
      })
    }
    function syncFetchAll() {
      var rows = visibleFetchRows().filter(function (row) { return !row.querySelector('.fpick').disabled })
      var checked = rows.filter(function (row) { return row.querySelector('.fpick').checked })
      document.getElementById(gid('FetchAll')).checked = rows.length > 0 && checked.length === rows.length
    }
    function applyFetchFilter() {
      var q = document.getElementById(gid('FetchQ')).value.trim().toLowerCase()
      var visible = 0
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        var mid = row.getAttribute('data-id') || ''
        var show = !q || mid.toLowerCase().indexOf(q) >= 0
        row.style.display = show ? '' : 'none'
        if (show) visible++
      })
      document.getElementById(gid('FetchEmpty')).hidden = visible > 0
      var total = root.querySelectorAll('#' + gid('FetchRows') + ' .frow').length
      document.getElementById(gid('FetchCount')).textContent = q ? visible + ' / ' + total : ''
      syncFetchAll()
    }
    // 拉取行与列表已有行的差异判定（口径）：上下文 / 最大输出按值比（都空算相同），
    // 视觉只在「拉取侧有、列表侧没勾」时算差异——上游多数不报能力，不能反推要清空用户已勾的。
    function diffRow(ex, m, vision) {
      var cw = m.context_window == null ? '' : String(m.context_window)
      var mo = m.max_output == null ? '' : String(m.max_output)
      if (String(ex.context_window || '') !== cw || String(ex.max_output || '') !== mo) return true
      var vp = ex.row.querySelector('[data-f="vision"]')
      return !!vision && !(vp && vp.checked)
    }
    function renderFetch(models) {
      var have = {}
      rowsArray().forEach(function (m) { have[m.id] = m })
      var pickable = 0
      var rows = (models || []).map(function (m) {
        var ex = have[m.id]
        // 三态：新条目=默认勾选；已有且参数一致=「已有」禁用；已有但参数不同=「可更新」默认勾选
        var diff = ex ? diffRow(ex, m) : false
        var same = !!ex && !diff
        if (!same) pickable++
        var vision = (m.capabilities || []).indexOf('vision') >= 0
        // 去重规则同 rowHtml；名字存 data-display，「填入所选」随行带上
        var dn = m.display && String(m.display).trim().toLowerCase() !== String(m.id).trim().toLowerCase() ? String(m.display).trim() : ''
        var dis = same ? ' disabled' : ''
        return '<div class="mrow frow' + (same ? ' dis' : '') + '" data-id="' + esc(m.id) + '"' + (dn ? ' data-display="' + esc(dn) + '"' : '') + '>' +
          // title 文案经 esc() 且右引号不可省：英文文案含双引号，属性漏闭合会把整行后续标签吞进属性（曾致「已有」行 DOM 错乱）
          '<input type="checkbox" class="fpick"' + (same ? ' disabled title="' + esc(t('已在下方模型列表且参数一致，不重复填入', 'Already in the model list with the same numbers')) + '"' : ' checked' + (diff ? ' title="' + esc(t('点「填入所选」把拉取到的参数更新到下方该模型', 'Click "Fill selected" to update this model with the fetched numbers')) + '"' : '')) + '>' +
          '<div class="midwrap"><span class="mid" title="' + esc(m.id) + '">' + esc(m.id) + '</span>' + (dn ? '<span class="msub" title="' + esc(dn) + '">' + esc(dn) + '</span>' : '') + '</div>' +
          '<input type="text" inputmode="numeric" data-f="context_window" value="' + (m.context_window == null ? '' : esc(m.context_window)) + '" placeholder="' + t('未知', 'unknown') + '"' + dis + '>' +
          '<input type="text" inputmode="numeric" data-f="max_output" value="' + (m.max_output == null ? '' : esc(m.max_output)) + '" placeholder="' + t('未知', 'unknown') + '"' + dis + '>' +
          '<input type="checkbox" class="vpick" data-f="vision"' + (vision ? ' checked' : '') + dis + '>' +
          '<span class="ftag">' + (same ? t('已有', 'exists') : diff ? t('可更新', 'update') : '') + '</span></div>'
      }).join('')
      document.getElementById(gid('FetchRows')).innerHTML = rows || '<div class="mempty">' + t('未拉取到模型', 'No models fetched') + '</div>'
      document.getElementById(gid('FetchAll')).checked = pickable > 0 && pickable === (models || []).length
    }
    // 填入语义：列表里没有的模型追加；已有的按拉取到的参数就地更新（勾选行即权威值，
    // 视觉列在行内可改；留空表示不覆盖，避免上游没给值时清掉用户手填的数字）
    function fillSelected() {
      var arr = rowsArray()
      var at = {}
      arr.forEach(function (m) { at[m.id] = m })
      var added = 0, updated = 0
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        var cb = row.querySelector('.fpick')
        if (!cb || !cb.checked || cb.disabled) return
        var mid = row.getAttribute('data-id')
        if (!mid) return
        var cw = parseTokens(row.querySelector('[data-f="context_window"]').value)
        var mo = parseTokens(row.querySelector('[data-f="max_output"]').value)
        var vp = row.querySelector('[data-f="vision"]')
        var dn = row.getAttribute('data-display')
        var ex = at[mid]
        if (ex) {
          // 已有条目：拉取到的非空值覆盖，留空 = 保留既有值（不清空）；只有真的改了才计入「更新 N」
          var changed = false
          if (cw != null && !isNaN(cw) && String(cw) !== ex.context_window) { ex.context_window = cw; changed = true }
          if (mo != null && !isNaN(mo) && String(mo) !== ex.max_output) { ex.max_output = mo; changed = true }
          if (vp && vp.checked && (ex.capabilities || []).indexOf('vision') < 0) { ex.capabilities = ['vision']; changed = true }
          if (!ex.display_name && dn) ex.display_name = dn
          if (changed) updated++
          return
        }
        var rec = {
          id: mid,
          context_window: cw != null && !isNaN(cw) ? cw : null,
          max_output: mo != null && !isNaN(mo) ? mo : null,
          capabilities: vp && vp.checked ? ['vision'] : [],
        }
        if (dn) rec.display_name = dn
        arr.push(rec)
        at[mid] = rec
        added++
      })
      renderRows(arr)
      document.getElementById(gid('FetchPanel')).hidden = true
      st.dirty = true
      var parts = []
      if (added) parts.push(t('新增 ', 'Added ') + added + t(' 个', ''))
      if (updated) parts.push(t('更新 ', 'Updated ') + updated + t(' 个', ''))
      // 结果写弹层左下角的提示槽（.modal-foot 的 msg 槽）：弹层有毛玻璃遮罩，toast 会被糊住看不见
      if (parts.length) opts.msg(t('已 ', '') + parts.join(t('、', ', ')) + t('；点「保存」后生效', '; click "Save" to apply'), 'ok')
    }
    function doFetch(btn) {
      var ctx = opts.fetchCtx ? opts.fetchCtx() : null
      // 拉取面板/表单挂在弹层（或首用内联卡）里：失败一律写底栏就地提示槽——
      // 弹窗磨砂遮罩（z-modal）会糊掉全局 toast（z-toast），两个宿主的槽位都常驻可见（AGENTS 弹层提示归宿）
      var fail = function (text) { opts.msg(text, 'err') }
      if (!ctx || !ctx.baseUrl || !/^https?:\\/\\//i.test(ctx.baseUrl)) { fail(t('请先填写接口地址（http/https）再拉取模型', 'Fill in the base URL (http/https) before fetching models')); return }
      btn.disabled = true; btn.textContent = t('拉取中…', 'Fetching…')
      var body = { base_url: ctx.baseUrl, protocol: ctx.protocol || 'anthropic' }
      if (ctx.serviceId) body.id = ctx.serviceId
      if (ctx.key) body.key = ctx.key // 手输了 Key 就用手输的（可能正准备保存新 Key）
      api('/service/fetch-models', { method: 'POST', body: JSON.stringify(body), timeoutMs: 90000 })
        .then(function (r) {
          document.getElementById(gid('FetchQ')).value = '' // 重新拉取是新的列表，旧过滤词不再适用
          document.getElementById(gid('FetchCount')).textContent = ''
          renderFetch(r.models || [])
          var panel = document.getElementById(gid('FetchPanel'))
          panel.hidden = false
          opts.msg('') // 面板自带结果提示，清掉底栏上一次的报错
          $('#' + gid('FetchMsg')).textContent = r.from === 'known'
            ? t('在线拉取未成功，以下为该厂商已知模型；勾选需要的后点「填入所选」', 'Online fetch failed; these are known models for this vendor. Tick the ones you want, then click "Fill selected"')
            : t('共 ', 'Fetched ') + (r.models || []).length + t(' 个模型，勾选需要的后点「填入所选」（参数一致的自动跳过）', ' models. Tick the ones you want, then click "Fill selected" (entries with identical numbers are skipped)')
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
        .catch(function (e) { fail(t('拉取失败：', 'Fetch failed: ') + e.message) })
        .then(function () { btn.disabled = false; btn.textContent = t('拉取模型', 'Fetch models') })
    }
    function html() {
      return '<div class="fsec-row">' +
        '<label class="fsec" data-i18n="模型（上下文 / 最大输出，单位 tokens，可留空）||Models (context / max output in tokens; optional)">模型（上下文 / 最大输出，单位 tokens，可留空）</label>' +
        '<button class="btn small" type="button" id="' + gid('Fetch') + '" data-i18n-title="从上游拉取模型列表，勾选需要的填入下方||Fetch the model list from upstream, then tick the ones to add below" title="从上游拉取模型列表，勾选需要的填入下方" data-i18n="拉取模型||Fetch models">拉取模型</button>' +
        '</div>' +
        '<div class="mtable">' +
        '<div class="mhead"><span class="defcol" title="设为默认">' + icon('star', 11) + '</span><span data-i18n="模型 ID||Model ID">模型 ID</span><span data-i18n="上下文||Context">上下文</span><span data-i18n="最大输出||Max output">最大输出</span><span class="vcol" data-i18n="视觉||Vision">视觉</span><span></span></div>' +
        '<div id="' + gid('ModelRows') + '"></div>' +
        '<div class="addrow">' +
        '<span class="def-slot"></span>' +
        '<input type="text" id="' + gid('NewId') + '" data-i18n-ph="新模型 ID，如 deepseek-flash||new model ID, e.g. deepseek-flash" placeholder="新模型 ID，如 deepseek-flash">' +
        '<input type="text" class="num" id="' + gid('NewCtx') + '" data-i18n-ph="上下文||context" placeholder="上下文">' +
        '<input type="text" class="num" id="' + gid('NewOut') + '" data-i18n-ph="最大输出||max output" placeholder="最大输出">' +
        '<input type="checkbox" class="vpick" id="' + gid('NewVision') + '" data-i18n-title="该模型支持图片输入（接入客户端会据此声明）||This model accepts image input (attached clients are told so)" title="该模型支持图片输入（接入客户端会据此声明）">' +
        '<button class="btn small" type="button" id="' + gid('AddModel') + '" data-i18n="添加||Add">添加</button>' +
        '</div>' +
        '</div>' +
        '<div class="fetchpanel" id="' + gid('FetchPanel') + '" hidden>' +
        '<div class="fsearch">' +
        '<input type="text" class="fetchq" id="' + gid('FetchQ') + '" data-i18n-ph="搜索模型 ID，如 claude / deepseek…||Search model ID, e.g. claude / deepseek…" placeholder="搜索模型 ID，如 claude / deepseek…">' +
        '<span class="fetchcount" id="' + gid('FetchCount') + '"></span></div>' +
        '<div class="mhead"><input type="checkbox" id="' + gid('FetchAll') + '" data-i18n-title="全选 / 全不选（仅作用于当前可见行）||Select all / none (visible rows only)" title="全选 / 全不选（仅作用于当前可见行）"><span data-i18n="拉取到的模型（勾选后填入）||Fetched models (tick to fill in)">拉取到的模型（勾选后填入）</span><span data-i18n="上下文||Context">上下文</span><span data-i18n="最大输出||Max output">最大输出</span><span class="vcol" data-i18n="视觉||Vision">视觉</span><span></span></div>' +
        '<div id="' + gid('FetchRows') + '"></div>' +
        '<div class="mempty" id="' + gid('FetchEmpty') + '" data-i18n="没有匹配的模型||No matching models" hidden>没有匹配的模型</div>' +
        '<div class="factions">' +
        '<span class="fetchmsg" id="' + gid('FetchMsg') + '"></span>' +
        '<button class="btn small" type="button" id="' + gid('FetchHide') + '" data-i18n="收起||Hide">收起</button>' +
        '<button class="btn small primary" type="button" id="' + gid('FetchFill') + '" data-i18n="填入所选||Fill selected">填入所选</button>' +
        '</div></div>'
    }
    // 按钮内容是 SVG 图标：点击命中的可能是按钮内的 <svg>/<path> 子元素，须经 closest 找到按钮本体再判断
    root.addEventListener('click', function (e) {
      var tg = e.target
      if (!tg || !tg.closest) return
      var defBtn = tg.closest('.def')
      if (defBtn) {
        st.defaultModel = defBtn.getAttribute('data-mid')
        st.defaultDirty = true
        syncDefButtons(st.defaultModel)
        return
      }
      var delBtn = tg.closest('.del')
      if (delBtn) {
        var r = delBtn.closest('.mrow'); if (!r) return
        // 删除的是默认模型 → 默认自动改为剩余第一行
        var wasDefault = !!st.defaultModel && r.querySelector('.def') && r.querySelector('.def').getAttribute('data-mid') === st.defaultModel
        r.remove()
        if (wasDefault) {
          var firstMid = rowsHost().querySelector('.mrow .mid')
          st.defaultModel = firstMid ? firstMid.textContent.trim() : ''
          st.defaultDirty = true
          syncDefButtons(st.defaultModel)
        }
        st.dirty = true
        return
      }
      if (tg.id === gid('AddModel')) {
        var nid = $('#' + gid('NewId')).value.trim()
        if (!nid) { opts.msg(t('请先填写新模型的 ID', 'Enter the new model ID first'), 'err'); return }
        var exist = false
        Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mid'), function (el) {
          if (el.textContent.trim() === nid) exist = true
        })
        if (exist) { opts.msg(t('模型「', 'Model "') + nid + t('」已在列表里', '" is already in the list'), 'err'); return }
        var host = rowsHost()
        if (host.querySelector('.mempty')) host.innerHTML = ''
        var wrap = document.createElement('div')
        var nvBox = $('#' + gid('NewVision'))
        wrap.innerHTML = rowHtml({ id: nid, context_window: $('#' + gid('NewCtx')).value.trim(), max_output: $('#' + gid('NewOut')).value.trim(), capabilities: nvBox && nvBox.checked ? ['vision'] : [] })
        var row = wrap.firstChild
        host.appendChild(row)
        row.scrollIntoView({ block: 'nearest' })
        $('#' + gid('NewId')).value = ''
        $('#' + gid('NewCtx')).value = ''
        $('#' + gid('NewOut')).value = ''
        if (nvBox) nvBox.checked = false
        opts.msg('', '')
        st.dirty = true
        return
      }
      if (tg.id === gid('Fetch')) { doFetch(tg); return }
      if (tg.id === gid('FetchHide')) { document.getElementById(gid('FetchPanel')).hidden = true; return }
      if (tg.id === gid('FetchFill')) { fillSelected(); return }
    })
    // 输模型名：从已知模型表自动补上下文 / 输出（仅在对应框为空时填充，不覆盖手输）
    root.addEventListener('input', function (e) {
      var tg = e.target
      if (!tg || !tg.getAttribute) return
      if (tg.getAttribute('data-f')) st.dirty = true
      if (tg.id === gid('NewId')) {
        // 手填模型名即算动过目录：保存必带 models（服务端不再自动拉取），没点「添加」按钮也不丢用户输入
        st.dirty = true
        var km = knownModels[tg.value.trim()]
        if (km) {
          var ctx = $('#' + gid('NewCtx')), out = $('#' + gid('NewOut'))
          if (km.context_window != null && ctx.value === '') ctx.value = km.context_window
          if (km.max_output != null && out.value === '') out.value = km.max_output
          // 内置表已知该模型支持图片 → 顺手勾上视觉（用户仍可改；只在当前未勾时补）
          var nv = $('#' + gid('NewVision'))
          if (nv && !nv.checked && (km.capabilities || []).indexOf('vision') >= 0) nv.checked = true
        }
      }
      if (tg.id === gid('FetchQ')) applyFetchFilter()
    })
    root.addEventListener('change', function (e) {
      var tg = e.target
      if (!tg || !tg.classList) return
      // 搜索过滤只控制行显隐，勾选状态保留；全选仅作用于当前可见且可勾选的行
      //（否则搜索后点全选会把藏在过滤外的模型一并选进去），行勾选变化时回写表头状态
      if (tg.classList.contains('fpick')) { syncFetchAll(); return }
      if (tg.id === gid('FetchAll')) {
        var on = tg.checked
        visibleFetchRows().forEach(function (row) {
          var cb = row.querySelector('.fpick')
          if (cb && !cb.disabled) cb.checked = on
        })
      }
    })
    return {
      load: load, collect: collect,
      isDirty: function () { return st.dirty || st.defaultDirty },
      isDefaultDirty: function () { return st.defaultDirty },
      getDefault: function () { return st.defaultModel },
      el: root,
    }
  }

  function createFallbackBlock(hostId, prefix, opts) {
    var root = document.getElementById(hostId)
    var gid = function (s) { return prefix + s }
    function fbRowHtml(providerId, model) {
      var svc = null
      ;(opts.getServices() || []).forEach(function (x) { if (x.id === providerId) svc = x })
      var label = svc ? svc.label : providerId
      return '<div class="mrow fbrow" data-provider="' + esc(providerId) + '" data-model="' + esc(model || '') + '">' +
        '<span class="mid" title="' + esc(providerId) + '">' + esc(label) + '</span>' +
        '<span class="mid">' + esc(model || t('透传原模型名', 'Pass through original model')) + '</span>' +
        '<span class="fbops">' +
        '<button type="button" class="fbup" title="' + t('上移', 'Move up') + '">' + icon('arrow-up', 13) + '</button>' +
        '<button type="button" class="fbdown" title="' + t('下移', 'Move down') + '">' + icon('arrow-down', 13) + '</button>' +
        '<button type="button" class="del" title="' + t('移除', 'Remove') + '">' + icon('close', 12) + '</button></span></div>'
    }
    function html() {
      return '<div class="fsec-row">' +
        '<label class="fsec" data-i18n="故障切换顺序（主服务不可达时依次尝试）||Fallback order (tried in order when the primary is unreachable)">故障切换顺序（主服务不可达时依次尝试）</label>' +
        '<button class="btn small" type="button" id="' + gid('FbAuto') + '" data-i18n-title="把所有启用中的其他服务按优先级排入备用链，模型取各自的默认模型||Queue all other enabled services into the fallback chain by priority, each using its default model" title="把所有启用中的其他服务按优先级排入备用链，模型取各自的默认模型" data-i18n="按优先级自动生成||Auto-generate by priority">按优先级自动生成</button>' +
        '</div>' +
        '<div class="mtable fbtable">' +
        '<div class="mhead"><span data-i18n="备用服务||Fallback service">备用服务</span><span data-i18n="使用的模型||Model used">使用的模型</span><span></span></div>' +
        '<div id="' + gid('FbRows') + '"></div>' +
        '<div class="addrow">' +
        '<select id="' + gid('FbNewSvc') + '"></select>' +
        '<select id="' + gid('FbNewModel') + '"></select>' +
        '<button class="btn small" type="button" id="' + gid('FbAdd') + '" data-i18n="添加||Add">添加</button>' +
        '</div></div>'
    }
    function renderRows(rows) {
      document.getElementById(gid('FbRows')).innerHTML = (rows || []).map(function (f) { return fbRowHtml(f.provider, f.model || '') }).join('') ||
        '<div class="mempty">' + t('暂无备用服务——主服务不可达时将没有可切换的目标。', 'No fallback services yet — if the primary goes down there will be nothing to switch to.') + '</div>'
    }
    // 新增行下拉：排除自身与已在链中的服务；模型下拉随服务联动（默认=透传原模型名）
    function populateAdd() {
      var svcSel = document.getElementById(gid('FbNewSvc'))
      if (!svcSel) return
      var added = {}
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FbRows') + ' .fbrow'), function (r) {
        added[r.getAttribute('data-provider')] = true
      })
      var selfId = opts.getSelfId ? opts.getSelfId() : null
      var svcOpts = '<option value="">' + t('选择服务…', 'Pick a service…') + '</option>'
      ;(opts.getServices() || []).forEach(function (x) {
        if (x.id === selfId || added[x.id]) return
        svcOpts += '<option value="' + esc(x.id) + '">' + esc(x.label) + '</option>'
      })
      svcSel.innerHTML = svcOpts
      populateModels()
    }
    function populateModels() {
      var svcSel = document.getElementById(gid('FbNewSvc'))
      var modelSel = document.getElementById(gid('FbNewModel'))
      if (!svcSel || !modelSel) return
      var svc = null
      ;(opts.getServices() || []).forEach(function (x) { if (x.id === svcSel.value) svc = x })
      // 新增行默认「透传原模型名」（value=''），不自动选中服务的默认模型；具体模型由用户主动改选
      var modelOpts = '<option value="">' + t('透传原模型名', 'Pass through original model') + '</option>'
      if (svc) {
        (svc.models || []).forEach(function (m) {
          modelOpts += '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>'
        })
      }
      modelSel.innerHTML = modelOpts
    }
    function load(rows) {
      root.innerHTML = html()
      renderRows(rows || [])
      populateAdd()
      applyI18nTree(root)
    }
    function collect() {
      var out = []
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FbRows') + ' .fbrow'), function (r) {
        var p = r.getAttribute('data-provider')
        if (!p) return
        var m = r.getAttribute('data-model')
        out.push(m ? p + ':' + m : p)
      })
      return out
    }
    root.addEventListener('click', function (e) {
      var tg = e.target
      if (!tg || !tg.classList) return
      if (tg.id === gid('FbAuto')) {
        var selfId = opts.getSelfId ? opts.getSelfId() : null
        var rows = (opts.getServices() || [])
          .filter(function (x) { return x.id !== selfId && x.enabled !== false })
          .sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) })
        document.getElementById(gid('FbRows')).innerHTML = rows.map(function (x) { return fbRowHtml(x.id, x.defaultModel || '') }).join('') ||
          '<div class="mempty">' + t('没有其他可用服务。', 'No other enabled services.') + '</div>'
        populateAdd()
        opts.msg('', '')
        return
      }
      if (tg.id === gid('FbAdd')) {
        var svcId = document.getElementById(gid('FbNewSvc')).value
        if (!svcId) { opts.msg(t('请先选择要追加的备用服务', 'Pick a fallback service first'), 'err'); return }
        var model = document.getElementById(gid('FbNewModel')).value
        var el = document.getElementById(gid('FbRows'))
        if (el.querySelector('.mempty')) el.innerHTML = ''
        el.insertAdjacentHTML('beforeend', fbRowHtml(svcId, model))
        populateAdd()
        opts.msg('', '')
        return
      }
      var r = tg.closest('.fbrow')
      if (!r) return
      if (tg.closest('.del')) { r.remove(); populateAdd(); return }
      var upBtn = tg.closest('.fbup'), downBtn = tg.closest('.fbdown')
      if (upBtn || downBtn) {
        var rowsEl = document.getElementById(gid('FbRows'))
        var arr = Array.prototype.slice.call(rowsEl.querySelectorAll('.fbrow'))
        var i = arr.indexOf(r)
        var j = upBtn ? i - 1 : i + 1
        if (j < 0 || j >= arr.length) return
        if (j < i) rowsEl.insertBefore(r, arr[j])
        else rowsEl.insertBefore(arr[j], r)
      }
    })
    root.addEventListener('change', function (e) {
      if (e.target && e.target.id === gid('FbNewSvc')) populateModels()
    })
    return { load: load, collect: collect, el: root }
  }

  // 两壳的块实例：编辑（ef*）在此创建；添加（af*）在添加表单区创建
  // msg(text, cls)：写弹层左下角提示槽；cls 走 .testline.err / .testline.ok 语义色
  function testlineWriter(elId) {
    return function (text, cls) {
      var el = document.getElementById(elId)
      el.textContent = text
      el.className = cls === 'ok' || cls === 'err' ? 'testline ' + cls : 'testline'
    }
  }
  var efEp = createEndpointBlock('efEpHost', 'ef')
  var efModelB = createModelBlock('efModelHost', 'ef', {
    msg: testlineWriter('efMsg'),
    fetchCtx: function () {
      var ep = efEp.collect()
      var s = null
      ;(view.services || []).forEach(function (x) { if (x.id === editing) s = x })
      return { baseUrl: ep.url, protocol: ep.protocol || (s ? s.protocol : 'anthropic'), key: $('#efKey').value.trim(), serviceId: editing }
    },
  })
  var efFbB = createFallbackBlock('efFbHost', 'ef', {
    msg: testlineWriter('efMsg'),
    getServices: function () { return view.services || [] },
    getSelfId: function () { return editing },
  })
  // 模型目录保存前统一校验：NaN 字段标红该行输入框并提示；重复 id 提示。返回错误文案，无错返回 ''
  function validateModelCollect(collected, blockRoot) {
    for (var mid in collected.models) {
      var r = collected.models[mid]
      // 仅当字段为 NaN（parseTokens 认定非数字）才报错；留空(undefined)合法
      var badField = (r.context_window !== undefined && isNaN(r.context_window)) ? t('上下文', 'context')
        : (r.max_output !== undefined && isNaN(r.max_output)) ? t('最大输出', 'max output') : null
      if (badField) {
        Array.prototype.forEach.call(blockRoot.querySelectorAll('.mrow'), function (row) {
          if (row.querySelector('.mid').textContent.trim() === mid) {
            Array.prototype.forEach.call(row.querySelectorAll('input'), function (inp) {
              if (r.context_window !== undefined && isNaN(r.context_window) && inp.dataset.f === 'context_window') inp.classList.add('bad')
              if (r.max_output !== undefined && isNaN(r.max_output) && inp.dataset.f === 'max_output') inp.classList.add('bad')
            })
          }
        })
        return t('模型「', 'Model "') + mid + t('」的', "'s ") + badField + t('必须是整数（tokens，可用逗号分隔）', ' must be an integer (tokens; commas allowed)')
      }
    }
    if (collected.dup) return t('模型列表有重复项，请检查', 'The model list has duplicates; please check')
    return ''
  }

  function openEdit(id) {
    var s = null
    view.services.forEach(function (x) { if (x.id === id) s = x })
    if (!s) return
    editing = id
    $('#editTitle').textContent = t('编辑「', 'Edit "') + s.label + t('」', '"')
    // 编辑时不做厂商预设回填：表单里每个地址行只反映用户已保存的值，留空 = 用户显式不用该协议。
    // （曾按 host 匹配预设自动补全空行——用户删掉的端点会被猜回来，且回填后保存会把协议静默翻回
    //  anthropic 优先的推导，已移除；添加流程的预设填充见 pickPreset，属用户显式选择，保留。）
    efEp.load({
      name: s.label,
      baseUrl: s.base_url,
      protocol: s.protocol,
      endpoints: {
        anthropic: (s.endpoints && s.endpoints.anthropic) || '',
        openai: (s.endpoints && s.endpoints.openai) || '',
        responses: (s.endpoints && s.endpoints.responses) || '',
      },
    })
    // 安全模型：服务端不再回传 Key 明文；留空 = 不修改（空输入时 efSave 不会带 key 字段）
    $('#efKey').value = ''
    // 提示文案不画眼睛字形（控件图标一律走右侧 SVG 按钮，见 .agents/conventions/ui-kit.md）
    $('#efKey').placeholder = s.hasKey ? t('已保存（留空不修改；点右侧按钮查看并拷贝）', 'Saved (kept unless changed; use the button on the right to view & copy)') : t('尚未设置 Key，可在此填入', 'No key yet; type one here')
    $('#efKey').type = 'password'
    var kt = document.getElementById('efKeyToggle')
    if (kt) { kt.innerHTML = icon('eye', 14); kt.title = t('显示明文', 'Show plaintext') }
    efModelB.load(s.models || [], s.defaultModel ?? '')
    efFbB.load(s.fallback || [])
    $('#efMsg').textContent = ''
    $('#efMsg').className = 'testline'
    editM.open()
  }

  function closeEdit() {
    editM.close() // editing=null 在 onClose 钩子（✕/取消/遮罩/Esc 同一条路径）
  }

  $('#efSave').onclick = function () {
    if (!editing) return
    var body = { provider: editing }
    var ep = efEp.collect()
    // 与添加表单同口径：至少一行协议地址 + 逐行 URL 格式；全清空会让 base_url 与端点脱节
    if (!ep.url) { $('#efMsg').textContent = t('请至少填写一个协议接口地址（照抄厂商文档）', 'Fill in at least one protocol endpoint (copy from the vendor docs)'); $('#efMsg').className = 'testline err'; return }
    for (var pk in ep.urls) {
      if (ep.urls[pk] && !/^https?:\\/\\//i.test(ep.urls[pk])) { $('#efMsg').textContent = t('{proto} 接口地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: pk }); $('#efMsg').className = 'testline err'; return }
    }
    var key = $('#efKey').value
    var collected = efModelB.collect()
    var modelErr = validateModelCollect(collected, efModelB.el)
    if (modelErr) {
      $('#efMsg').textContent = modelErr
      $('#efMsg').className = 'testline err'
      return
    }
    if (ep.name) body.name = ep.name
    body.base_url = ep.url
    body.protocol = ep.protocol
    if (key) body.key = key
    body.models = collected.models
    body.fallback = efFbB.collect()
    // 全量替换语义（空串=清该协议端点）；默认协议那行落在 base_url，不重复存
    body.endpoints = {
      anthropic: ep.protocol !== 'anthropic' ? ep.urls.anthropic : '',
      openai: ep.protocol !== 'openai' ? ep.urls.openai : '',
      responses: ep.protocol !== 'responses' ? ep.urls.responses : '',
    }
    // 只在用户点过星标时写入默认模型；校验它仍在列表中
    var dm = efModelB.getDefault()
    if (efModelB.isDefaultDirty() && dm && collected.models[dm]) body.default_model = dm
    // 兜底：用户改过默认但所选已被删除 → 默认落到剩余第一行
    else if (efModelB.isDefaultDirty() && Object.keys(collected.models).length) body.default_model = Object.keys(collected.models)[0]
    $('#efSave').disabled = true
    $('#efMsg').textContent = t('保存中…', 'Saving…')
    api('/service/update', { method: 'POST', body: JSON.stringify(body) })
      .then(function () {
        closeEdit()
        $('#efSave').disabled = false
        toast('✓ ' + t('服务信息已更新，立即生效', 'Service updated; effective immediately'), true)
        return load()
      })
      .catch(function (e) {
        $('#efSave').disabled = false
        $('#efMsg').textContent = t('保存失败：', 'Save failed: ') + e.message
        $('#efMsg').className = 'testline err'
      })
  }

  var logsLastGood = ''
  var logPageEntries = [] // 当前页错误行的原始条目，供 ⧉ 复制按钮按索引取用
  var logsFailStreak = 0
  // 分页状态：page 从 1 数起（服务端第 1 页 = 最新 n 条）；每页条数记忆在 localStorage
  var logPage = 1
  var logPages = 1
  var logPageSize = Number(localStorage.getItem('mdk_log_size')) || 10
  if ([10, 30, 50, 100].indexOf(logPageSize) === -1) logPageSize = 10
  $('#logPageSize').value = String(logPageSize)
  // 错误行 ⧉ 复制：把整条日志格式化为纯文本进剪贴板，方便贴给排障/issue
  function logCopyText(l) {
    var lines = [
      t('时间', 'Time') + ': ' + String(l.ts || '').slice(11, 19),
      t('客户端', 'Client') + ': ' + (l.harness || '-'),
      t('路由', 'Profile') + ': ' + (l.profile || '-'),
      t('服务', 'Provider') + ': ' + (l.provider || '-'),
      t('模型', 'Model') + ': ' + (l.model || '-'),
      t('路径', 'Path') + ': ' + (l.path || '-'),
      t('状态', 'Status') + ': ' + (l.status == null ? '-' : l.status),
      t('耗时', 'Took') + ': ' + (l.ms == null ? '-' : l.ms + 'ms'),
    ]
    if (l.reason) lines.push(t('改发', 'Reroute') + ': ' + l.reason)
    if (l.err) lines.push(t('错误', 'Error') + ': ' + l.err)
    return lines.join('\\n')
  }
  function bindLogCopy() {
    Array.prototype.forEach.call(document.querySelectorAll('#logTable .lcopy'), function (b) {
      b.onclick = function () {
        var l = logPageEntries[Number(b.getAttribute('data-li'))]
        if (!l) return
        copyText(logCopyText(l), function () { b.innerHTML = icon('check', 11); setTimeout(function () { b.innerHTML = icon('copy', 12) }, 1200) })
      }
    })
  }
  function loadLogs(retried) {
    api('/logs?n=' + logPageSize + '&page=' + logPage).then(function (j) {
      var logs = (j.logs || []).slice().reverse() // 最新在最上
      var total = j.total || 0
      logPages = j.pages || Math.max(1, Math.ceil(total / logPageSize))
      // 环形缓冲滚动挤掉了旧记录导致当前页越界时，退回最后一页再取一次
      if (!retried && logPage > logPages) { logPage = logPages; loadLogs(true); return }
      logPageEntries = []
      var rows = logs.map(function (l) {
        var bad = l.status >= 400 || !!l.err
        // 双语条目按界面语言取字段（服务端审计条目存 op_en/detail_en/err_en；旧条目缺省回退主字段）
        function pick(f) { return LANG === 'en' && l[f + '_en'] != null ? l[f + '_en'] : l[f] }
        if (l.kind === 'audit') {
          // 操作审计行：齿轮图标 操作名 | 目标 | 变更摘要 | 成功/失败
          var ok = l.ok !== false
          var opTxt = pick('op') || t('操作', 'op')
          var detTxt = pick('detail') || ''
          var errTxt = pick('err') || ''
          return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
            '<td>' + iconInline('gear', 12) + ' ' + esc(opTxt) + '</td>' +
            '<td>' + esc(pick('target') || '-') + '</td>' +
            '<td class="muted" title="' + esc(detTxt) + '">' + esc(detTxt) + '</td>' +
            '<td class="' + (ok ? 'st-ok' : 'st-err') + '" title="' + esc(ok ? t('成功', 'ok') : t('失败', 'failed')) + '">' + iconInline(ok ? 'check' : 'close', 13) + '</td>' +
            '<td>-</td>' +
            '<td class="muted" title="' + esc(errTxt) + '">' + esc(errTxt.slice(0, 60)) + '</td></tr>'
        }
        var copyBtn = ''
        if (bad) {
          logPageEntries.push(l)
          copyBtn = '<button type="button" class="lcopy" data-li="' + (logPageEntries.length - 1) + '" title="' + t('复制日志详情', 'Copy log details') + '">' + icon('copy', 12) + '</button>'
        }
        return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
          '<td>' + esc(l.harness) + '</td>' +
          '<td>' + esc(l.profile) + '</td>' +
          '<td class="mono">' + esc(l.model || '-') + '</td>' +
          '<td style="color:' + (bad ? 'var(--err)' : 'var(--ok)') + '">' + esc(l.status == null ? '-' : l.status) + '</td>' +
          '<td>' + (l.ms == null ? '-' : l.ms + 'ms') + '</td>' +
          '<td class="muted" title="' + esc(pick('err') || '') + '">' + esc((pick('err') || '').slice(0, 60)) + copyBtn + '</td></tr>'
      }).join('')
      var html = '<thead><tr><th>' + t('时间', 'Time') + '</th><th>' + t('客户端 / 操作', 'Client / op') + '</th><th>' + t('服务 / 目标', 'Service / target') + '</th><th>' + t('模型 / 详情', 'Model / detail') + '</th><th>' + t('状态', 'Status') + '</th><th>' + t('耗时', 'Took') + '</th><th>' + t('错误', 'Error') + '</th></tr></thead>' +
        (rows || '<tr><td colspan="7" class="empty">' + t('暂无记录（错误请求与控制台操作）', 'No entries yet (error requests and console operations)') + '</td></tr>')
      logsLastGood = html
      logsFailStreak = 0
      $('#logTable').innerHTML = html
      bindLogCopy()
      $('#logPageInfo').textContent = t('第 ', 'Page ') + logPage + ' / ' + logPages + t(' 页 · 共 ', ' · ') + total + t(' 条', ' entries')
      $('#logPrev').disabled = logPage <= 1
      $('#logNext').disabled = logPage >= logPages
    }).catch(function () {
      // 刷新失败时保留最后成功的数据并明确标注，别让用户误以为是最新
      logsFailStreak++
      if (logsFailStreak >= 2 && logsLastGood && !document.getElementById('logTable').querySelector('tfoot')) {
        $('#logTable').innerHTML = logsLastGood +
          '<tfoot><tr><td colspan="7" class="muted">（' + t('日志刷新失败，以上为最后一次成功的数据', 'Log refresh failed — the table above shows the last successful data') + '）</td></tr></tfoot>'
      }
    })
  }
  $('#logPageSize').onchange = function () {
    logPageSize = Number(this.value) || 10
    localStorage.setItem('mdk_log_size', String(logPageSize))
    logPage = 1
    loadLogs()
  }
  $('#logPrev').onclick = function () { if (logPage > 1) { logPage--; loadLogs() } }
  $('#logNext').onclick = function () { if (logPage < logPages) { logPage++; loadLogs() } }

  // 语言切换：写入 localStorage 后立即应用（静态节点 + 重绘动态区域）
  Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) {
    b.onclick = function () {
      LANG = b.getAttribute('data-lang')
      localStorage.setItem('mdk_lang', LANG)
      applyLang()
      loadLogs() // 日志表头是 JS 渲染的，单独刷一次
      pollOverview() // 客户端卡片描述等服务端文案随语言重取重绘
    }
  })
  applyLang()
  pollHealth()
  // 更新完成重连回来：报「已更新到 vX.Y.Z」（apply 时记入 sessionStorage）。
  // 核验版本真的到位才提示——失败重载时 current 未变，静默清掉，不弹假完成
  try {
    var toV = sessionStorage.getItem('mdk_upd_to')
    if (toV) {
      sessionStorage.removeItem('mdk_upd_to')
      api('/admin/update/status').then(function (s) {
        if (s.current >= toV) toast(t('已更新到 v' + s.current, 'Updated to v' + s.current))
      }).catch(function () {})
    }
  } catch (e) { /* 隐私模式等 */ }
  refreshUpdStatus()
  setInterval(function () { if (!document.hidden) refreshUpdStatus() }, 60000)
  load().then(loadLogs).catch(function (e) {
    if (e && e.status === 401) { showLoginRequired(); return }
    toast(t('加载失败：', 'Failed to load: ') + e.message, false)
  })
  // 后台标签页暂停轮询（visibilitychange 恢复时立即刷一次），省掉无谓请求与 DOM 重建
  setInterval(function () { if (!document.hidden) pollHealth() }, 5000)
  setInterval(function () { if (!document.hidden) pollOverview() }, 5000)
  setInterval(function () { if (!document.hidden) loadLogs() }, 5000)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollHealth(); pollOverview(); loadLogs() }
  })
  // 快速跳转：页面上半部分只显示「↓ 到底部」，滚过中线后只显示「↑ 到顶部」；不足以滚动时都不显示
  var snavUp = $('#snavUp'), snavDown = $('#snavDown')
  function snavUpdate() {
    var max = document.documentElement.scrollHeight - window.innerHeight
    var y = window.pageYOffset || 0
    var ok = max > 60
    var upper = y < window.innerHeight / 2
    snavDown.hidden = !ok || !upper
    snavUp.hidden = !ok || upper
  }
  snavUp.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }) }
  snavDown.onclick = function () { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }) }
  window.addEventListener('scroll', snavUpdate, { passive: true })
  window.addEventListener('resize', snavUpdate)
  snavUpdate()
})()
</script>
</body>
</html>
`
