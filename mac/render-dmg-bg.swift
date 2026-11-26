// Renders 1x (640x400) and 2x (1280x800) Retina macOS DMG installer background PNGs using CoreGraphics/AppKit.
import AppKit
import Foundation

guard CommandLine.arguments.count >= 3 else {
	fputs("Usage: swift render-dmg-bg.swift <out-1x.png> <out-2x.png> [version]\n", stderr)
	exit(1)
}

let out1x = CommandLine.arguments[1]
let out2x = CommandLine.arguments[2]
let version = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : ""

let width: CGFloat = 640
let height: CGFloat = 400

func render(scale: CGFloat, to path: String) throws {
	let pxW = Int(width * scale)
	let pxH = Int(height * scale)

	guard let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil,
		pixelsWide: pxW,
		pixelsHigh: pxH,
		bitsPerSample: 8,
		samplesPerPixel: 4,
		hasAlpha: true,
		isPlanar: false,
		colorSpaceName: .calibratedRGB,
		bytesPerRow: 0,
		bitsPerPixel: 0
	) else {
		throw NSError(domain: "render-dmg-bg", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate bitmap"])
	}
	rep.size = NSSize(width: width, height: height)

	guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
		throw NSError(domain: "render-dmg-bg", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create graphics context"])
	}

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = ctx
	let cg = ctx.cgContext
	cg.setShouldAntialias(true)
	cg.setAllowsAntialiasing(true)
	cg.setShouldSmoothFonts(true)

	// 1. Clean macOS light gradient background (top-to-bottom subtle cool paper tone)
	let bgGradient = NSGradient(colors: [
		NSColor(srgbRed: 0.985, green: 0.990, blue: 0.998, alpha: 1.0),
		NSColor(srgbRed: 0.945, green: 0.960, blue: 0.984, alpha: 1.0),
	])!
	bgGradient.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

	// 2. Subtle radial blue ambient glow behind the center transfer corridor
	let glow = NSGradient(colors: [
		NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.085),
		NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.0),
	])!
	glow.draw(
		fromCenter: NSPoint(x: width / 2, y: height - 195),
		radius: 10,
		toCenter: NSPoint(x: width / 2, y: height - 195),
		radius: 260,
		options: []
	)

	// 3. Architectural dot grid (echoes DataDip's app icon and ER diagram canvas)
	let spacing: CGFloat = 24
	let dotRadius: CGFloat = 1.25
	NSColor(srgbRed: 0.28, green: 0.38, blue: 0.56, alpha: 0.13).setFill()
	var gx: CGFloat = 20
	while gx < width - 12 {
		var gy: CGFloat = 20
		while gy < height - 12 {
			// Softly fade dots near edges for a clean vignette
			let dx = abs(gx - width / 2) / (width / 2)
			let dy = abs(gy - height / 2) / (height / 2)
			let edge = max(dx, dy)
			if edge < 0.96 {
				let alpha = max(0.03, 0.14 * (1.0 - edge * 0.65))
				NSColor(srgbRed: 0.26, green: 0.37, blue: 0.56, alpha: alpha).setFill()
				cg.fillEllipse(in: CGRect(x: gx - dotRadius, y: gy - dotRadius, width: dotRadius * 2, height: dotRadius * 2))
			}
			gy += spacing
		}
		gx += spacing
	}

	// Coordinate note: AppKit origin is bottom-left; Finder icon y=180 from top => center box cleanly around icon + label.
	let iconCenterY: CGFloat = height - 196 // 204 in AppKit coords
	let leftX: CGFloat = 175
	let rightX: CGFloat = 465

	// 4. Subtle rounded card wells behind DataDip.app and Applications drop target
	let cardSize: CGFloat = 152
	let leftRect = NSRect(x: leftX - cardSize / 2, y: iconCenterY - cardSize / 2 - 12, width: cardSize, height: cardSize + 24)
	let rightRect = NSRect(x: rightX - cardSize / 2, y: iconCenterY - cardSize / 2 - 12, width: cardSize, height: cardSize + 24)

	// Left subtle elevated surface
	let leftPath = NSBezierPath(roundedRect: leftRect, xRadius: 24, yRadius: 24)
	NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.65).setFill()
	leftPath.fill()
	NSColor(srgbRed: 0.15, green: 0.25, blue: 0.45, alpha: 0.09).setStroke()
	leftPath.lineWidth = 1.0
	leftPath.stroke()

	// Right dashed drop-target well for Applications
	let rightPath = NSBezierPath(roundedRect: rightRect, xRadius: 24, yRadius: 24)
	NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.045).setFill()
	rightPath.fill()
	NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.26).setStroke()
	rightPath.lineWidth = 1.5
	let dashes: [CGFloat] = [5, 5]
	rightPath.setLineDash(dashes, count: dashes.count, phase: 0)
	rightPath.stroke()

	// 5. Crisp centered drag arrow pointing left -> right
	let arrowY = iconCenterY + 6
	let arrowStartX: CGFloat = 278
	let arrowEndX: CGFloat = 362

	// Pill halo behind arrow
	let pillRect = NSRect(x: width / 2 - 52, y: arrowY - 22, width: 104, height: 44)
	let pillPath = NSBezierPath(roundedRect: pillRect, xRadius: 22, yRadius: 22)
	NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.88).setFill()
	pillPath.fill()
	NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.18).setStroke()
	pillPath.lineWidth = 1.0
	pillPath.stroke()

	// Arrow shaft + chevron head in DataDip brand blue
	let arrowColor = NSColor(srgbRed: 0.145, green: 0.388, blue: 0.922, alpha: 0.92)
	arrowColor.setStroke()
	let shaft = NSBezierPath()
	shaft.lineWidth = 3.0
	shaft.lineCapStyle = .round
	shaft.lineJoinStyle = .round
	shaft.move(to: NSPoint(x: arrowStartX + 14, y: arrowY))
	shaft.line(to: NSPoint(x: arrowEndX - 16, y: arrowY))
	shaft.stroke()

	let head = NSBezierPath()
	head.lineWidth = 3.0
	head.lineCapStyle = .round
	head.lineJoinStyle = .round
	head.move(to: NSPoint(x: arrowEndX - 27, y: arrowY + 10))
	head.line(to: NSPoint(x: arrowEndX - 15, y: arrowY))
	head.line(to: NSPoint(x: arrowEndX - 27, y: arrowY - 10))
	head.stroke()

	// 6. Top header title + subtle version badge
	let titleStyle = NSMutableParagraphStyle()
	titleStyle.alignment = .center
	let titleAttrs: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 21, weight: .semibold),
		.foregroundColor: NSColor(srgbRed: 0.07, green: 0.08, blue: 0.11, alpha: 0.92),
		.paragraphStyle: titleStyle,
		.kern: -0.4,
	]
	let titleStr = version.isEmpty ? "Install DataDip" : "Install DataDip \(version)"
	NSAttributedString(string: titleStr, attributes: titleAttrs)
		.draw(in: NSRect(x: 40, y: height - 62, width: width - 80, height: 30))

	// 7. Bottom instruction text (extra bottom breathing room in case Finder's Path Bar is enabled)
	let subAttrs: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 13, weight: .regular),
		.foregroundColor: NSColor(srgbRed: 0.31, green: 0.34, blue: 0.40, alpha: 0.9),
		.paragraphStyle: titleStyle,
	]
	NSAttributedString(string: "Drag DataDip.app into Applications to install", attributes: subAttrs)
		.draw(in: NSRect(x: 40, y: 48, width: width - 80, height: 22))

	NSGraphicsContext.restoreGraphicsState()

	guard let png = rep.representation(using: .png, properties: [:]) else {
		throw NSError(domain: "render-dmg-bg", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
	}
	try png.write(to: URL(fileURLWithPath: path))
}

try render(scale: 1.0, to: out1x)
try render(scale: 2.0, to: out2x)
