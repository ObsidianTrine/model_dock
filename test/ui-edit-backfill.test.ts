import { describe, it, expect } from 'vitest'
import { UI_HTML } from '../src/gateway/ui.js'

// 编辑服务弹窗曾按 host 匹配厂商预设、把空着的协议地址行自动回填——用户显式删掉的端点
// 会在下次编辑时"复活"，且回填后保存会把默认协议按 anthropic 优先推导静默翻回。
// 现编辑只回显已保存值（留空 = 显式不用该协议）；添加流程的预设填充属用户点选预设的
// 显式行为（pickPreset），保留。
describe('编辑服务表单：不做厂商预设回填', () => {
  it('UI 载荷不再包含 presetEndpoints 回填机制与其提示文案', () => {
    expect(UI_HTML).not.toContain('presetEndpoints')
    expect(UI_HTML).not.toContain('已按厂商预设自动填充')
  })

  it('添加流程的预设端点填充保留（pickPreset 显式选择）', () => {
    expect(UI_HTML).toContain('endpoints: p.endpoints')
  })
})
