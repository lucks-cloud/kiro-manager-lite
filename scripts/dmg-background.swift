// 生成 DMG 窗口背景：build/background.png（1x）与 build/background@2x.png（Retina）。
// electron-builder 发现同名 @2x 会自动合成多分辨率 tiff，所以两张都要。
//
// 用法（仓库根目录）：swift scripts/dmg-background.swift
//
// 坐标必须和 electron-builder.yml 的 dmg.contents 对上：
// 背景图按「内容区左上角 = (0,0)、1 像素 = 1 点」铺，图标坐标是图标中心。
// 改了这里的坐标就同步改 yml，反之亦然。
//
// 踩过的坑：背景图不能和窗口外框一样大。外框里还要扣掉标题栏，用户开着 Finder 的路径栏 / 状态栏时
// （全局设置，DMG 里关不掉）再少五十多点；可视区一旦比背景图小，Finder 就按背景图尺寸出横竖滚动条，
// 而且图标和背景会错位。所以背景图比窗口矮一截（见 yml 的 window.height），底色用纯白，
// 没开那两栏的用户看到下方多出的空白也和 Finder 的白底连成一片。
import AppKit

let width: CGFloat = 560
let height: CGFloat = 340
// 与 yml 一致：App 在 (140, 180)，Applications 在 (420, 180)，图标 96 点
let iconY: CGFloat = 180
let leftX: CGFloat = 140
let rightX: CGFloat = 420
let iconHalf: CGFloat = 48

func render(scale: CGFloat, to path: String) {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(width * scale),
    pixelsHigh: Int(height * scale),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )!
  rep.size = NSSize(width: width, height: height)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  // AppKit 原点在左下，下面统一用「距顶部」的 y 换算，和 Finder 的坐标方向一致
  func top(_ y: CGFloat) -> CGFloat { height - y }

  // 底色纯白：和背景图以外的 Finder 窗口底色一致，见文件头的说明
  NSColor.white.setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()

  // 中间的箭头：从 App 指向 Applications，避开两侧图标
  let arrowStart = leftX + iconHalf + 34
  let arrowEnd = rightX - iconHalf - 34
  let arrow = NSBezierPath()
  arrow.lineWidth = 3
  arrow.lineCapStyle = .round
  arrow.lineJoinStyle = .round
  arrow.move(to: NSPoint(x: arrowStart, y: top(iconY)))
  arrow.line(to: NSPoint(x: arrowEnd, y: top(iconY)))
  arrow.move(to: NSPoint(x: arrowEnd - 12, y: top(iconY) + 12))
  arrow.line(to: NSPoint(x: arrowEnd, y: top(iconY)))
  arrow.line(to: NSPoint(x: arrowEnd - 12, y: top(iconY) - 12))
  NSColor(calibratedWhite: 0.62, alpha: 1).setStroke()
  arrow.stroke()

  // 文案居中：箭头下方一行操作提示，底部一行 pkg 推荐
  func centered(_ text: String, y: CGFloat, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) {
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: size, weight: weight),
      .foregroundColor: color
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let s = str.size()
    str.draw(at: NSPoint(x: (width - s.width) / 2, y: top(y) - s.height / 2))
  }
  centered("拖到 Applications 完成安装", y: iconY + 30, size: 12, color: NSColor(calibratedWhite: 0.45, alpha: 1))
  // 文案要短：两侧上角留给隐藏文件，底部这一行不能宽过两侧图标的位置
  centered("推荐改用同版本 .pkg 安装：双击按向导安装，免去打开时的拦截",
           y: 300, size: 11.5, color: NSColor(calibratedWhite: 0.5, alpha: 1))

  NSGraphicsContext.restoreGraphicsState()
  let data = rep.representation(using: .png, properties: [:])!
  try! data.write(to: URL(fileURLWithPath: path))
  print("wrote \(path)")
}

render(scale: 1, to: "build/background.png")
render(scale: 2, to: "build/background@2x.png")
