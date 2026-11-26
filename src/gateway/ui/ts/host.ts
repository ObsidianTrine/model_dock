/**
 * Web 控制台 · 真 TS 通道宿主环境类型（S-03）。
 *
 * tsconfig 的 lib 只有 ES2023、没有 DOM（`tsconfig*.json` 属红线文件，不为 UI 通道单独改 lib），
 * 因此浏览器全局在这里以「最小结构类型」声明：本文件只导出类型，模块侧用 `import type`
 * 引入，esbuild 打包时整段擦除——不产生任何运行时包装对象，也不向全局污染名字。
 *
 * 新模块需要新的 DOM 能力时，在这里补最小接口（保持结构类型，不要引入 DOM 库）。
 */

/** classList：只声明用到的开关能力 */
export interface UiClassList {
  toggle(name: string, force?: boolean): void
}

/** 事件对象：target 可能为空（焦点丢失等），与 DOM 语义一致 */
export interface UiEvent {
  target: UiElement | null
}

/** 元素：按真 TS 通道现有消费面收窄（innerHTML / 属性 / 事件 / 查询） */
export interface UiElement {
  id: string
  hidden: boolean
  title: string
  innerHTML: string
  textContent: string | null
  disabled: boolean
  onclick: ((ev?: UiEvent) => void) | null
  readonly classList: UiClassList
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  addEventListener(type: string, fn: (ev: UiEvent) => void): void
  querySelectorAll(sel: string): ArrayLike<UiElement>
  closest(sel: string): UiElement | null
  remove(): void
}

/** document：只声明用到的查询能力 */
export interface UiDocument {
  getElementById(id: string): UiElement | null
  querySelectorAll(sel: string): ArrayLike<UiElement>
}

/** createModal 的 foot 条目（见 src/gateway/ui/kit.ts 工厂实现与 ui-kit §9） */
export interface ModalFootItem {
  slot?: 'msg'
  id: string
  kind?: 'err' | 'info'
  label?: string
  html?: string
  title?: string
  primary?: boolean
  end?: boolean
  disabled?: boolean
  onClick?: () => void
}

/** createModal 选项：按真 TS 通道现有消费面收窄 */
export interface ModalOptions {
  id: string
  title?: string
  titleId?: string
  align?: 'top' | 'center'
  modalClass?: string
  bodyId?: string
  bodyClass?: string
  bodyHtml?: string
  footId?: string
  footHidden?: boolean
  closeButton?: boolean
  closeOnEsc?: boolean
  closeOnScrim?: boolean
  foot?: ModalFootItem[]
  onOpen?: () => void
  onClose?: () => void
}

/** createModal 返回句柄 */
export interface ModalHandle {
  scrim: UiElement
  body: UiElement
  foot: UiElement
  isOpen(): boolean
  open(): void
  close(): void
}

/**
 * 宿主桥（window.__MDUI_HOST__，由 src/gateway/ui/overview.ts 的启动片段建立）。
 * 真 TS 通道的 bundle 在独立 <script> 的全局作用域运行，无法直接看到既有内联脚本的 IIFE 闭包；
 * 桥对象是唯一通道。函数类依赖可直接取；可变状态（view/liveUsage/LANG）必须用取值函数，
 * 否则会固化在加载时刻。
 */
export interface UiHost {
  esc(s: unknown): string
  t(zh: string, en: string, params?: Record<string, unknown>): string
  fmtTok(n: number): string
  fmtUsd(n: number): string
  createModal(opts: ModalOptions): ModalHandle
  view(): unknown
  liveUsage(): unknown
  lang(): string
}
