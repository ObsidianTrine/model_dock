// 一次性生成 DMG 背景提示语资产 scripts/assets/dmg-hint.png（透明底 2x，28px 系统字体）
// 用法: swift gen-dmg-hint.swift <输出路径>
import AppKit

let text = "拖动图标到 Applications 中安装"
let font = NSFont.systemFont(ofSize: 28, weight: .medium)
let color = NSColor(srgbRed: 0.541, green: 0.569, blue: 0.627, alpha: 1) // #8a91a0
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
let s = NSAttributedString(string: text, attributes: attrs)
let sz = s.size()
let pad = 8.0
let w = Int(ceil(sz.width)) + Int(pad) * 2
let h = Int(ceil(sz.height)) + Int(pad) * 2
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
s.draw(at: NSPoint(x: pad, y: Double(h) - pad - ceil(sz.height)))
NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dmg-hint.png"
try! png.write(to: URL(fileURLWithPath: out))
print("\(w)x\(h) -> \(out)")
