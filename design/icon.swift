// Draws TabTasker Dictate's app icon and menu bar icon: a text cursor between voice bars ("speak to type").
// Run: swift design/icon.swift design   (writes icon.png, 1024 px, and tray.png / tray@2x.png)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func png(_ size: Int, _ path: String, _ draw: (CGContext, CGFloat) -> Void) {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  draw(ctx, CGFloat(size))
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
}
func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
func gradient(_ ctx: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
  let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
  ctx.drawLinearGradient(g, start: from, end: to, options: [])
}
// The mark on a canvas of side `s`: five bars, the middle one a text cursor. `ink` nil draws the colour version.
func mark(_ ctx: CGContext, _ s: CGFloat, ink: CGColor?, weight: CGFloat = 1) {
  let heights: [CGFloat] = [0.20, 0.34, 0.0, 0.34, 0.20]
  let bar = s * 0.062 * weight, gap = s * 0.052, mid = s / 2
  for (i, h) in heights.enumerated() {
    let x = mid + CGFloat(i - 2) * (bar + gap) - bar / 2
    if i == 2 { continue }
    let rect = CGRect(x: x, y: mid - s * h / 2, width: bar, height: s * h)
    let path = CGPath(roundedRect: rect, cornerWidth: bar / 2, cornerHeight: bar / 2, transform: nil)
    ctx.saveGState(); ctx.addPath(path); ctx.clip()
    if let ink { ctx.setFillColor(ink); ctx.fill(rect) } else { gradient(ctx, [rgb(0xF8BE6A), rgb(0xD9741F)], from: CGPoint(x: x, y: rect.maxY), to: CGPoint(x: x, y: rect.minY)) }
    ctx.restoreGState()
  }
  // The cursor: a tall stem with short serifs, cream on the tile, ink in the menu bar.
  let stem = s * 0.034 * weight, tall = s * 0.50, serif = s * 0.10
  ctx.setFillColor(ink ?? rgb(0xF6EFE4))
  ctx.addPath(CGPath(roundedRect: CGRect(x: mid - stem / 2, y: mid - tall / 2, width: stem, height: tall), cornerWidth: stem / 2, cornerHeight: stem / 2, transform: nil))
  for y in [mid + tall / 2 - stem, mid - tall / 2] {
    ctx.addPath(CGPath(roundedRect: CGRect(x: mid - serif / 2, y: y, width: serif, height: stem), cornerWidth: stem / 2, cornerHeight: stem / 2, transform: nil))
  }
  ctx.fillPath()
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
png(1024, "\(out)/icon.png") { ctx, s in
  // Apple's icon grid: an 824 px tile, centred, with a soft shadow below it.
  let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.35))
  ctx.addPath(shape); ctx.setFillColor(rgb(0x1A1715)); ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState(); ctx.addPath(shape); ctx.clip()
  gradient(ctx, [rgb(0x3A322C), rgb(0x161311)], from: CGPoint(x: 0, y: tile.maxY), to: CGPoint(x: 0, y: tile.minY))
  // A warm glow behind the mark, like the orb's light.
  let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0xE07D2A, 0.30), rgb(0xE07D2A, 0)] as CFArray, locations: nil)!
  ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 470), startRadius: 0, endCenter: CGPoint(x: 512, y: 470), endRadius: 420, options: [])
  // Light at the top edge only.
  ctx.setStrokeColor(rgb(0xFFFFFF, 0.14)); ctx.setLineWidth(4); ctx.addPath(CGPath(roundedRect: tile.insetBy(dx: 2, dy: 2), cornerWidth: 183, cornerHeight: 183, transform: nil)); ctx.strokePath()
  ctx.restoreGState()
  mark(ctx, s, ink: nil)
}
for (size, name) in [(22, "tray.png"), (44, "tray@2x.png")] {
  // The menu bar slot is small: the mark fills it, with heavier strokes so it stays legible.
  png(size, "\(out)/\(name)") { ctx, s in
    let k: CGFloat = 1.5
    ctx.translateBy(x: (s - s * k) / 2, y: (s - s * k) / 2)
    mark(ctx, s * k, ink: rgb(0x000000), weight: 1.35)
  }
}
print("wrote icon.png, tray.png, tray@2x.png to \(out)")
