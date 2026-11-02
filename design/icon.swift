// Draws TabTasker Dictate's app icon and menu bar mark: TabTasker's otter, as Business draws it, white on
// dark grey, a small waveform where its mouth is, filling the square (macOS rounds it); and its head alone
// in black for the menu bar (a template image macOS tints).
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

// TabTasker's otter exactly as Business draws it (flat, white, looking straight at you, its body running
// off the bottom), on a dark grey rather than Business's night blue, and speaking: where its mouth and
// whiskers are, a small waveform. Drawn on the 1024 grid, full bleed; CoreGraphics' y runs up.
let ink = CGColor(srgbRed: 0.09, green: 0.09, blue: 0.10, alpha: 1)        // #171719, the face
let tileTop = CGColor(srgbRed: 0.235, green: 0.239, blue: 0.255, alpha: 1)  // #3c3d41
let tileBottom = CGColor(srgbRed: 0.094, green: 0.094, blue: 0.106, alpha: 1) // #18181b
func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> CGPath { CGPath(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry), transform: nil) }
func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> CGPath { ellipse(cx, cy, r, r) }
func arc(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ from: CGFloat, _ to: CGFloat) -> CGPath {
  let path = CGMutablePath()
  path.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: from * .pi / 180, endAngle: to * .pi / 180, clockwise: false)
  return path
}

/// The white: the head and body as one rounded shape, with an ear on each side (Business's 512 grid, doubled).
func otterBody() -> CGPath {
  let body = CGMutablePath()
  // A tall rounded rectangle, its top corners at r 68, never a dome (a dome is what reads as a bear).
  body.addPath(CGPath(roundedRect: CGRect(x: 241, y: -300, width: 540, height: 1122), cornerWidth: 68, cornerHeight: 68, transform: nil))
  body.addPath(circle(324, 730, 92)); body.addPath(circle(698, 730, 92))
  return body
}
/// The face, cut from the white in ink.
func otterFace() -> CGPath {
  let face = CGMutablePath()
  face.addPath(circle(324, 730, 41)); face.addPath(circle(698, 730, 41))   // the ears' insides
  face.addPath(circle(407, 585, 32)); face.addPath(circle(615, 585, 32))   // eyes
  face.addPath(ellipse(511, 481, 34, 26))                                  // nose
  for side in [-1, 1] as [CGFloat] {                                       // three whisker dots each side, as Business has them
    for (dx, dy) in [(-73, 439), (-96, 419), (-73, 398)] as [(CGFloat, CGFloat)] { face.addPath(circle(511 + side * dx, dy, 9)) }
  }
  for (dx, h) in [(-36, 18), (-18, 30), (0, 42), (18, 30), (36, 18)] as [(CGFloat, CGFloat)] { // its voice, a small wave where the mouth is
    face.addPath(capsule(CGRect(x: 511 + dx - 5, y: 412 - h / 2, width: 10, height: h)))
  }
  return face
}

func mark(_ ctx: CGContext, _ k: CGFloat) {
  // White with a whisper of shade toward the top, and a soft shadow, so it sits on the tile.
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 18 * k, color: grey(0, 0.45)) // shadows ignore the scale
  ctx.addPath(otterBody()); ctx.setFillColor(grey(1)); ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState(); ctx.addPath(otterBody()); ctx.clip()
  let shade = CGGradient(colorsSpace: space, colors: [grey(0.9), grey(0.97)] as CFArray, locations: nil)!
  ctx.drawLinearGradient(shade, start: CGPoint(x: 0, y: 822), end: CGPoint(x: 0, y: 300), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  ctx.restoreGState()
  ctx.addPath(otterFace()); ctx.setFillColor(ink); ctx.fillPath()
}

// The app icon at any size: full bleed, as Business draws its own. macOS 26 and later mask every icon into
// the squircle themselves (and add the glass), so a tile drawn here with margins would end up as a tile
// inside a tile.
func appIcon(_ size: Int) -> CGImage {
  image(size) { ctx, s in
    ctx.scaleBy(x: s / 1024, y: s / 1024)
    // Dark grey, lighter at the top left, as if lit from above.
    let fill = CGGradient(colorsSpace: space, colors: [tileTop, tileBottom] as CFArray, locations: nil)!
    ctx.drawLinearGradient(fill, start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 1024, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    mark(ctx, s / 1024)
  }
}

// The menu bar mark: the otter's head, 18 pt tall (Tauri sizes the tray image to 18 pt), drawn on the
// 36 px grid of the @2x image so its edges land on pixels, in black on transparent with the face cut out
// (a template image macOS tints).
func trayIcon(_ size: Int) -> CGImage {
  image(size) { ctx, s in
    ctx.scaleBy(x: s / 36, y: s / 36)
    let head = CGMutablePath()
    head.addPath(CGPath(roundedRect: CGRect(x: 6, y: -12, width: 24, height: 42), cornerWidth: 3.5, cornerHeight: 3.5, transform: nil))
    head.addPath(circle(9.5, 26, 4)); head.addPath(circle(26.5, 26, 4))
    ctx.addPath(head); ctx.setFillColor(grey(0)); ctx.fillPath()
    let face = CGMutablePath()
    face.addPath(circle(9.5, 26, 1.8)); face.addPath(circle(26.5, 26, 1.8))
    face.addPath(circle(13.5, 20, 1.6)); face.addPath(circle(22.5, 20, 1.6))
    face.addPath(ellipse(18, 15.5, 2, 1.5))
    for (dx, h) in [(-3, 2.5), (0, 4.5), (3, 2.5)] as [(CGFloat, CGFloat)] { face.addPath(capsule(CGRect(x: 18 + dx - 0.8, y: 10 - h / 2, width: 1.6, height: h))) } // three bars read at 18 pt
    ctx.setBlendMode(.clear); ctx.addPath(face); ctx.fillPath()
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
