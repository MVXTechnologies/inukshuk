package expo.modules.inukshukmesh

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.nio.channels.SocketChannel

/**
 * Local network facts for the hotspot fallback and socket routing.
 *
 * - [info]: this phone's IPv4 interfaces and the Wi-Fi default gateways. On
 *   a phone joined to a hotspot, the gateway IS the hotspot phone, which
 *   listens on the well-known port: JS can dial gateway:47321 when mDNS is
 *   blocked. On the hotspot phone itself the AP interface (ap0, swlan0,
 *   wlan1…) is not a ConnectivityManager network, so interfaces are read
 *   from NetworkInterface as well.
 * - [bindToLan]: when Wi-Fi has no internet, Android keeps cellular as the
 *   default network and an unbound socket to a LAN address may go nowhere.
 *   A dial to an address inside a Wi-Fi network's subnet is bound to that
 *   network first. Failure to bind is ignored (the plain route may work).
 *
 * Needs ACCESS_NETWORK_STATE only.
 */
class MeshNetwork(context: Context) {
  private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  @Suppress("DEPRECATION")
  private fun wifiNetworks(): List<Network> {
    val manager = cm ?: return emptyList()
    return try {
      manager.allNetworks.filter { n ->
        manager.getNetworkCapabilities(n)?.let {
          it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || it.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } == true
      }
    } catch (e: Exception) {
      emptyList()
    }
  }

  fun info(): Map<String, Any?> {
    val interfaces = ArrayList<Map<String, Any?>>()
    try {
      for (ni in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
        if (!ni.isUp || ni.isLoopback) continue
        for (ia in ni.interfaceAddresses) {
          val a = ia.address as? Inet4Address ?: continue
          if (a.isLoopbackAddress || a.isLinkLocalAddress) continue
          interfaces.add(mapOf("name" to ni.name, "address" to a.hostAddress, "prefixLength" to ia.networkPrefixLength.toInt()))
        }
      }
    } catch (e: Exception) {
      // No interfaces readable: report none rather than fail.
    }
    val gateways = LinkedHashSet<String>()
    for (n in wifiNetworks()) {
      try {
        val lp = cm?.getLinkProperties(n) ?: continue
        for (r in lp.routes) {
          val gw = r.gateway
          if (r.isDefaultRoute && gw is Inet4Address && !gw.isAnyLocalAddress) gw.hostAddress?.let { gateways.add(it) }
        }
      } catch (e: Exception) {}
    }
    return mapOf("interfaces" to interfaces, "gateways" to gateways.toList())
  }

  fun bindToLan(channel: SocketChannel, target: InetAddress) {
    if (target !is Inet4Address) return
    val manager = cm ?: return
    for (n in wifiNetworks()) {
      try {
        val lp = manager.getLinkProperties(n) ?: continue
        val inSubnet = lp.linkAddresses.any { la ->
          val a = la.address
          a is Inet4Address && samePrefix(a, target, la.prefixLength)
        }
        if (inSubnet) {
          n.bindSocket(channel.socket())
          return
        }
      } catch (e: Exception) {
        return
      }
    }
  }

  private fun samePrefix(a: Inet4Address, b: Inet4Address, prefix: Int): Boolean {
    if (prefix !in 0..32) return false
    val x = a.address
    val y = b.address
    var bits = prefix
    for (i in 0 until 4) {
      if (bits <= 0) return true
      val mask = if (bits >= 8) 0xFF else (0xFF shl (8 - bits)) and 0xFF
      if ((x[i].toInt() and mask) != (y[i].toInt() and mask)) return false
      bits -= 8
    }
    return true
  }
}
