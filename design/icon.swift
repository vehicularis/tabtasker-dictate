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

// TabTasker's otter exactly as Business draws it (apps/web/public/tabtasker-mark.svg), on a dark grey
// rather than Business's night blue, and speaking: a small waveform where its mouth is. The mark's own
// numbers are used: its tile is 64 units and the otter's group sits at translate(32 47) scale(1.3), so
// on the 1024 grid one unit of the group is 20.8 px. The head is a dome with shoulders (never a tall
// rounded box, which reads as a bear), the ears stand proud of it, and the body runs off the bottom.
// CoreGraphics' y runs up and the mark's down, so the group is flipped and every number below is the SVG's.
let ink = CGColor(srgbRed: 0.09, green: 0.09, blue: 0.10, alpha: 1)        // #171719, the face
let tileTop = CGColor(srgbRed: 0.235, green: 0.239, blue: 0.255, alpha: 1)  // #3c3d41
let tileBottom = CGColor(srgbRed: 0.094, green: 0.094, blue: 0.106, alpha: 1) // #18181b
let unit: CGFloat = 1024 / 64 * 1.3
let markOrigin = CGPoint(x: 512, y: 1024 - 47 * 1024 / 64)
/// A path drawn in the group's units, placed on the grid given (the 1024 one unless told otherwise).
func inMark(origin: CGPoint = markOrigin, unit u: CGFloat = unit, _ draw: (CGMutablePath) -> Void) -> CGPath {
  let path = CGMutablePath(); draw(path)
  var flip = CGAffineTransform(translationX: origin.x, y: origin.y).scaledBy(x: u, y: -u)
  return path.copy(using: &flip) ?? path
}
func dot(_ path: CGMutablePath, _ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat? = nil) {
  path.addEllipse(in: CGRect(x: cx - rx, y: cy - (ry ?? rx), width: 2 * rx, height: 2 * (ry ?? rx)))
}
/// The head and body as one shape: the mark's path, verbatim.
func otterHead(_ path: CGMutablePath) {
  path.move(to: CGPoint(x: -13, y: -16))
  path.addCurve(to: CGPoint(x: 0, y: -25), control1: CGPoint(x: -13, y: -22), control2: CGPoint(x: -7, y: -25))
  path.addCurve(to: CGPoint(x: 13, y: -16), control1: CGPoint(x: 7, y: -25), control2: CGPoint(x: 13, y: -22))
  path.addLine(to: CGPoint(x: 13, y: 15))
  path.addCurve(to: CGPoint(x: 0, y: 25), control1: CGPoint(x: 13, y: 22), control2: CGPoint(x: 7, y: 25))
  path.addCurve(to: CGPoint(x: -13, y: 15), control1: CGPoint(x: -7, y: 25), control2: CGPoint(x: -13, y: 22))
  path.closeSubpath()
}
/// Its voice: five bars of a small wave between the whiskers, where the mouth is.
let voice: [(CGFloat, CGFloat)] = [(-1.73, 0.87), (-0.865, 1.44), (0, 2.02), (0.865, 1.44), (1.73, 0.87)]
/// The face, cut from the white in ink: the ears' insides, eyes, nose and whisker dots as Business has them, and the voice.
func otterFace(_ face: CGMutablePath, voice bars: [(CGFloat, CGFloat)]) {
  dot(face, -9, -22, 2); dot(face, 9, -22, 2)
  dot(face, -5, -15, 1.6); dot(face, 5, -15, 1.6)
  dot(face, 0, -10, 1.7, 1.3)
  for side in [-1, 1] as [CGFloat] { for (x, y) in [(3.5, -8), (4.6, -7), (3.5, -6)] as [(CGFloat, CGFloat)] { dot(face, side * x, y, 0.45) } }
  for (x, h) in bars { face.addRoundedRect(in: CGRect(x: x - 0.24, y: -6.75 - h / 2, width: 0.48, height: h), cornerWidth: 0.24, cornerHeight: 0.24) }
}
/// The white, in two fills (the head's curve and the ears' circles may wind opposite ways, and one
/// nonzero fill would then leave the overlap empty): drawn in a layer, so the shadow and the shade
/// fall on the union once.
func white(_ ctx: CGContext, origin: CGPoint = markOrigin, unit u: CGFloat = unit, shade: Bool) {
  ctx.beginTransparencyLayer(auxiliaryInfo: nil)
  ctx.setFillColor(grey(1))
  ctx.addPath(inMark(origin: origin, unit: u) { otterHead($0) }); ctx.fillPath()
  ctx.addPath(inMark(origin: origin, unit: u) { dot($0, -9, -22, 4.5); dot($0, 9, -22, 4.5) }); ctx.fillPath()
  if shade { // a whisper of shade toward the top, on the white alone
    ctx.setBlendMode(.sourceAtop)
    let tone = CGGradient(colorsSpace: space, colors: [grey(0.9), grey(0.97)] as CFArray, locations: nil)!
    ctx.drawLinearGradient(tone, start: CGPoint(x: 0, y: origin.y + 25 * u), end: CGPoint(x: 0, y: origin.y), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.setBlendMode(.normal)
  }
  ctx.endTransparencyLayer()
}

func mark(_ ctx: CGContext, _ k: CGFloat) {
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 18 * k, color: grey(0, 0.45)) // shadows ignore the scale
  white(ctx, shade: true)
  ctx.restoreGState()
  ctx.addPath(inMark { otterFace($0, voice: voice) }); ctx.setFillColor(ink); ctx.fillPath()
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
    // The same mark, 0.92 px a unit on the 36 grid, its head's top at y 29 and its body running off the bottom.
    let origin = CGPoint(x: 18, y: 6), u: CGFloat = 0.92
    ctx.setFillColor(grey(0))
    ctx.addPath(inMark(origin: origin, unit: u) { otterHead($0) }); ctx.fillPath()
    ctx.addPath(inMark(origin: origin, unit: u) { dot($0, -9, -22, 4.5); dot($0, 9, -22, 4.5) }); ctx.fillPath()
    ctx.setBlendMode(.clear)
    ctx.addPath(inMark(origin: origin, unit: u) { face in
      dot(face, -9, -22, 2); dot(face, 9, -22, 2)
      dot(face, -5, -15, 1.6); dot(face, 5, -15, 1.6)
      dot(face, 0, -10, 1.7, 1.3)
      for (x, h) in [(-1.75, 2.7), (0, 4.9), (1.75, 2.7)] as [(CGFloat, CGFloat)] { // three bars read at 18 pt; the whiskers would not
        face.addRoundedRect(in: CGRect(x: x - 0.45, y: -5 - h / 2, width: 0.9, height: h), cornerWidth: 0.45, cornerHeight: 0.45)
      }
    }); ctx.fillPath()
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
