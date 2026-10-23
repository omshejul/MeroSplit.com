import AppKit
let args = CommandLine.arguments
let root = URL(fileURLWithPath: args[1])
let source = NSImage(contentsOf: root.appendingPathComponent("apps/mobile/assets/brand/03-linked-friends.png"))!
let transparent = NSImage(contentsOfFile: args[2])!
func png(_ path: String, width: Int, height: Int, opaque: Bool, draw: ()->Void) {
 let cg = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:(opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue))!
 NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext:cg,flipped:false)
 NSGraphicsContext.current!.imageInterpolation = .high
 if opaque { NSColor.white.setFill(); NSRect(x:0,y:0,width:width,height:height).fill() } else { NSColor.clear.setFill(); NSRect(x:0,y:0,width:width,height:height).fill(using: .copy) }
 draw(); NSGraphicsContext.restoreGraphicsState()
 let rep = NSBitmapImageRep(cgImage:cg.makeImage()!)
 try! rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent(path))
}
let asset="apps/mobile/assets/"
png(asset+"icon.png",width:1024,height:1024,opaque:true){source.draw(in:NSRect(x:0,y:0,width:1024,height:1024))}
png(asset+"android-icon-foreground.png",width:1080,height:1080,opaque:false){transparent.draw(in:NSRect(x:156,y:156,width:768,height:768))}
png(asset+"splash-icon.png",width:1024,height:1024,opaque:false){transparent.draw(in:NSRect(x:0,y:0,width:1024,height:1024))}
png("store-assets/google-play/icon-512.png",width:512,height:512,opaque:true){source.draw(in:NSRect(x:0,y:0,width:512,height:512))}
png("store-assets/app-store/icon-1024.png",width:1024,height:1024,opaque:true){source.draw(in:NSRect(x:0,y:0,width:1024,height:1024))}
png("store-assets/google-play/feature-graphic-1024x500.png",width:1024,height:500,opaque:true){
 source.draw(in:NSRect(x:85,y:65,width:370,height:370))
 let style=NSMutableParagraphStyle();style.alignment = .left
 ("MeroSplit" as NSString).draw(in:NSRect(x:475,y:195,width:480,height:90),withAttributes:[.font:NSFont.systemFont(ofSize:66,weight:.medium),.foregroundColor:NSColor(calibratedWhite:0.09,alpha:1),.paragraphStyle:style])
}
// Crop only the emulator title bar. Native UI pixels remain unchanged.
let names=["45-final-5040-groups-preserved.png","31-canonical-joined-group.png","32-canonical-totals-disclosure.png","38-canonical-draft-restored.png"]
for (i,name) in names.enumerated(){
 let u=URL(fileURLWithPath:args[3]).appendingPathComponent(name)
 let data=try! Data(contentsOf:u);let rep=NSBitmapImageRep(data:data)!
 let cg=rep.cgImage!.cropping(to:CGRect(x:0,y:28,width:rep.pixelsWide,height:rep.pixelsHigh-28))!
 let out=NSBitmapImageRep(cgImage:cg)
 try! out.representation(using:.png,properties:[:])!.write(to:root.appendingPathComponent("store-assets/google-play/screenshots/0\(i+1)-\(name)"))
}
