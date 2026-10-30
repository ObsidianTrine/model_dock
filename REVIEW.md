# REVIEW.md — 审查纪律（AI 与人工审查者共用）

> 代码所有者维护。审查者（AI bot、子 agent、人）看 PR 前先读这个。
> 保持简短：只写「在这个仓库里什么叫失败」。反复出现的误报/漏报修到这里或对应 lint，不在 PR 里反复争辩。

## 各区域「失败长什么样」

- **网关转发**（src/gateway/）：路由/模型映射错；密钥或 token 出现在日志与错误消息；流式响应中断处理缺失；端口/句柄/子进程泄漏。
- **配置与密钥**（src/config/）：静默丢用户数据；绕过 atomicWrite 直接写盘；secrets 明文外泄或权限过宽。
- **适配器**（src/adapters/）：写坏客户端配置文件（丢注释/丢格式）；detach 冲掉用户自己的改动。
- **更新与安装**（src/update/、scripts/installer.iss）：更新中途留残留进程或半成品文件；强杀误伤无辜进程。
- **测试**（test/）：踩 vitest 隔离雷（跨文件 vi.mock / clearAllMocks）；监听 8687/8890；NTFS 权限断言无平台分支；写死 /tmp 或盘符。
- **拆分/搬移类 refactor**（目录+shim、模板抽纯模块——T04/T05/T22/T23/T24 同款）：
  静态门禁与生成脚本按**文件路径**读源（ui-lint 令牌扫描、gen-ui-min 等），文件搬家后扫描面没跟着走——表现为门禁必红（令牌缺失/白名单陈旧）或更糟的静默漏检；
  搬移函数被跨模块引用时的**接线**遗漏（原非 export 的函数被 import、re-export 没保住旧 import 路径，调用点零改动是验收项）；
  「逐字搬移」红线只约束**内容**（函数体/模板字节级对拍），import/export/路径属**接线**可改——审查者见到 diff 里的接线改动不必拦，见到内容改动必须拦。
- **文档**：与代码行为不一致——「它撒谎」即失败。

## 一票否决红线（出现即 P0）

1. 测试或默认配置出现 8687 / 8890 端口。
2. 硬编码 `~/.modeldock`（必须走 src/util/paths.ts）。
3. 绕过 atomicWrite() 写盘。
4. 使用 import.meta.url（SEA 打包约束，必须走 process.execPath）。
5. 引入 native addon。
6. src/cli.ts 三路分发被破坏。

## 报告纪律

- 只报有把握的真问题：每条给 **文件+行号** 证据，不许按名字猜。
- 风格 / 诊断 / 清理类不报；不是本 PR 引入的问题标 **[存量]**。
- 同类问题一次说全（标明「同类还有 N 处」），不要每轮挤牙膏。
- 顶层评论以「发现 N 个问题」开头；N=0 明说通过，不凑数。
- 每条发现先自行验证（读文件确认行号与代码属实）再报，相当于「投票前先自证」。

## 跳过路径（生成物与锁文件，不审）

`src/gateway/ui-minified.ts`、`src/providers/catalog-snapshot.generated.ts`、`dist/`、`release/`、`coverage/`、`package-lock.json`。

## 分级提示

PR 的风险档位由 `scripts/pr-risk-tier.mjs` 按改动文件自动判定（risk:* label）：
低=文档/模板类，中=常规源码，高=网关核心/密钥/CI/发布面（规则见 `.agents/workflow.json` corePaths/releasePaths）。
高风险 PR 的发现逐条都要有把握——漏报一条的代价比多报一条高。
