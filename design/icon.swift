// Draws TabTasker Dictate's app icon and menu bar mark: a text cursor between voice bars ("speak to type"),
// white on a black tile, and the mark alone in black for the menu bar (a template image macOS tints).
// Run from the repository root: swift design/icon.swift
// It writes design/icon.png (1024 px) and design/tray*.png, and every icon Tauri bundles in src-tauri/icons.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let icons = "\(root)/src-tauri/icons"
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func image(_ size: Int, _ draw: (CGContext, CGFloat) -> Void) -> CGImage {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  draw(ctx, CGFloat(size))
  return ctx.makeImage()!
}
func pngData(_ image: CGImage) -> Data {
  let data = NSMutableData()
  let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  CGImageDestinationFinalize(dest)
  return data as Data
}
func write(_ image: CGImage, _ path: String) { try! pngData(image).write(to: URL(fileURLWithPath: path)) }
func grey(_ white: CGFloat, _ alpha: CGFloat = 1) -> CGColor { CGColor(srgbRed: white, green: white, blue: white, alpha: alpha) }
func capsule(_ rect: CGRect) -> CGPath {
  let r = min(rect.width, rect.height) / 2
  return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
}

// Apple's tile has continuous corners, not circular ones: the curve eases out of each straight edge over
// about 1.53 radii. These are the Bézier points of that corner, in radii from the corner, along the edge
// first and then into it.
let corner: [(CGFloat, CGFloat)] = [
  (1.52866483, 0), (1.08849323, 0), (0.86840689, 0), (0.66993427, 0.06549600), (0.63149399, 0.07491100),
  (0.37282392, 0.16905899), (0.16906013, 0.37282401), (0.07491176, 0.63149399),
  (0, 0.86840701), (0, 1.08849299), (0, 1.52866483),
]
func squircle(_ rect: CGRect, radius r: CGFloat) -> CGPath {
  let path = CGMutablePath()
  // Clockwise from the top edge; every other corner runs its points the other way round.
  let corners: [(CGFloat, CGFloat, CGFloat, CGFloat, Bool)] = [(rect.maxX, rect.maxY, -1, -1, false), (rect.maxX, rect.minY, -1, 1, true), (rect.minX, rect.minY, 1, 1, false), (rect.minX, rect.maxY, 1, -1, true)]
  for (i, (cx, cy, sx, sy, swap)) in corners.enumerated() {
    let p = corner.map { a, b in swap ? CGPoint(x: cx + sx * b * r, y: cy + sy * a * r) : CGPoint(x: cx + sx * a * r, y: cy + sy * b * r) }
    if i == 0 { path.move(to: p[0]) } else { path.addLine(to: p[0]) }
    path.addCurve(to: p[3], control1: p[1], control2: p[2])
    path.addLine(to: p[4])
    path.addCurve(to: p[7], control1: p[5], control2: p[6])
    path.addCurve(to: p[10], control1: p[8], control2: p[9])
  }
  path.closeSubpath()
  return path
}

// The mark on the 1024 grid, centred on (512, 512): four bars, the cursor in the middle.
func mark(_ ctx: CGContext, _ k: CGFloat) {
  let bar: CGFloat = 64, stem: CGFloat = 35, serif: CGFloat = 102, tall: CGFloat = 512
  let path = CGMutablePath()
  for (dx, h) in [(-234, 205), (-117, 348), (117, 348), (234, 205)] as [(CGFloat, CGFloat)] {
    path.addPath(capsule(CGRect(x: 512 + dx - bar / 2, y: 512 - h / 2, width: bar, height: h)))
  }
  path.addPath(capsule(CGRect(x: 512 - stem / 2, y: 512 - tall / 2, width: stem, height: tall)))
  for y in [512 + tall / 2 - stem, 512 - tall / 2] { path.addPath(capsule(CGRect(x: 512 - serif / 2, y: y, width: serif, height: stem))) }
  // White with a whisper of shade toward the bottom, and a soft shadow, so it sits on the tile.
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 18 * k, color: grey(0, 0.45)) // shadows ignore the scale
  ctx.addPath(path); ctx.setFillColor(grey(1)); ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState(); ctx.addPath(path); ctx.clip()
  let shade = CGGradient(colorsSpace: space, colors: [grey(1), grey(0.86)] as CFArray, locations: nil)!
  ctx.drawLinearGradient(shade, start: CGPoint(x: 0, y: 768), end: CGPoint(x: 0, y: 256), options: [])
  ctx.restoreGState()
}

// The app icon at any size, drawn on Apple's 1024 grid: an 824 px tile, centred, with its shadow below.
func appIcon(_ size: Int) -> CGImage {
  image(size) { ctx, s in
    ctx.scaleBy(x: s / 1024, y: s / 1024)
    let tile = squircle(CGRect(x: 100, y: 100, width: 824, height: 824), radius: 185)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * s / 1024), blur: 28 * s / 1024, color: grey(0, 0.3))
    ctx.addPath(tile); ctx.setFillColor(grey(0.04)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState(); ctx.addPath(tile); ctx.clip()
    let fill = CGGradient(colorsSpace: space, colors: [grey(0.2), grey(0.035)] as CFArray, locations: nil)!
    ctx.drawLinearGradient(fill, start: CGPoint(x: 0, y: 924), end: CGPoint(x: 0, y: 100), options: [])
    let glow = CGGradient(colorsSpace: space, colors: [grey(1, 0.09), grey(1, 0)] as CFArray, locations: nil)!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 560), startRadius: 0, endCenter: CGPoint(x: 512, y: 560), endRadius: 440, options: [])
    // Light along the top edge only, fading out down the sides.
    ctx.addPath(squircle(CGRect(x: 102, y: 102, width: 820, height: 820), radius: 183)); ctx.setLineWidth(4); ctx.replacePathWithStrokedPath(); ctx.clip()
    let rim = CGGradient(colorsSpace: space, colors: [grey(1, 0.22), grey(1, 0)] as CFArray, locations: nil)!
    ctx.drawLinearGradient(rim, start: CGPoint(x: 0, y: 924), end: CGPoint(x: 0, y: 640), options: [])
    ctx.restoreGState()
    mark(ctx, s / 1024)
  }
}

// The menu bar mark: 18 pt tall (Tauri sizes the tray image to 18 pt), drawn on the 36 px grid of the @2x
// image so every edge lands on a pixel, in black on transparent.
func trayIcon(_ size: Int) -> CGImage {
  image(size) { ctx, s in
    ctx.scaleBy(x: s / 36, y: s / 36)
    let path = CGMutablePath()
    for (x, h) in [(4, 12), (11, 20), (25, 20), (32, 12)] as [(CGFloat, CGFloat)] { path.addPath(capsule(CGRect(x: x - 2, y: 18 - h / 2, width: 4, height: h))) }
    path.addPath(capsule(CGRect(x: 17, y: 3, width: 2, height: 30)))
    for y in [3, 31] as [CGFloat] { path.addPath(capsule(CGRect(x: 15, y: y, width: 6, height: 2))) }
    ctx.addPath(path); ctx.setFillColor(grey(0)); ctx.fillPath()
  }
}

// An .ico is a directory of PNGs: a 6-byte header, a 16-byte entry per image, then the images.
func ico(_ sizes: [Int], _ path: String) {
  func le16(_ v: Int) -> Data { Data([UInt8(v & 255), UInt8(v >> 8 & 255)]) }
  func le32(_ v: Int) -> Data { Data([UInt8(v & 255), UInt8(v >> 8 & 255), UInt8(v >> 16 & 255), UInt8(v >> 24 & 255)]) }
  var head = le16(0) + le16(1) + le16(sizes.count), body = Data()
  for size in sizes {
    let png = pngData(appIcon(size))
    head += Data([UInt8(size % 256), UInt8(size % 256), 0, 0]) + le16(1) + le16(32) + le32(png.count) + le32(6 + 16 * sizes.count + body.count)
    body += png
  }
  try! (head + body).write(to: URL(fileURLWithPath: path))
}

write(appIcon(1024), "\(root)/design/icon.png")
write(trayIcon(18), "\(root)/design/tray.png")
write(trayIcon(36), "\(root)/design/tray@2x.png")
for (size, name) in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "icon.png")] { write(appIcon(size), "\(icons)/\(name)") }
write(trayIcon(18), "\(icons)/tray.png")
write(trayIcon(36), "\(icons)/tray@2x.png")
ico([16, 24, 32, 48, 64, 256], "\(icons)/icon.ico")

let set = FileManager.default.temporaryDirectory.appendingPathComponent("TabTaskerDictate-\(getpid()).iconset")
try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  write(appIcon(size), set.appendingPathComponent("icon_\(size)x\(size).png").path)
  write(appIcon(size * 2), set.appendingPathComponent("icon_\(size)x\(size)@2x.png").path)
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", set.path, "-o", "\(icons)/icon.icns"]
try! iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: set)
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("wrote design/icon.png, design/tray*.png and src-tauri/icons")
