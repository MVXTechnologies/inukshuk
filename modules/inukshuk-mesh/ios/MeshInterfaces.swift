import Darwin
import Foundation

/// This phone's IPv4 interfaces, for the hotspot fallback (JS picks dial
/// candidates from them: src/data/team/hotspot.ts).
///
/// iOS has no public API for the default gateway, so `gateways` is empty and
/// JS falls back to the subnet's `.1`: an iPhone Personal Hotspot is
/// 172.20.10.1, and Android hotspots hand out their own `.1` address. On the
/// hotspot iPhone itself the shared network appears as `bridge100`.
enum MeshInterfaces {
  static func read() -> [String: Any] {
    var interfaces: [[String: Any]] = []
    var head: UnsafeMutablePointer<ifaddrs>?
    if getifaddrs(&head) == 0, let first = head {
      var cursor: UnsafeMutablePointer<ifaddrs>? = first
      while let ifa = cursor {
        defer { cursor = ifa.pointee.ifa_next }
        let flags = Int32(ifa.pointee.ifa_flags)
        guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
          let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
          let mask = ifa.pointee.ifa_netmask else { continue }
        let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
        let netmask = mask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
        let host = UInt32(bigEndian: ip.s_addr)
        // Skip link-local 169.254/16: never a hotspot or LAN peer.
        if host >> 16 == 0xA9FE { continue }
        let text = "\(host >> 24 & 0xFF).\(host >> 16 & 0xFF).\(host >> 8 & 0xFF).\(host & 0xFF)"
        interfaces.append([
          "name": String(cString: ifa.pointee.ifa_name),
          "address": text,
          "prefixLength": UInt32(bigEndian: netmask).nonzeroBitCount,
        ])
      }
      freeifaddrs(head)
    }
    return ["interfaces": interfaces, "gateways": [String]()]
  }
}
