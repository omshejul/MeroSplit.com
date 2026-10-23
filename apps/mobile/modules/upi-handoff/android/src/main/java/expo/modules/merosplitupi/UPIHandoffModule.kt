package expo.modules.merosplitupi

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/** Confirms chooser selection only. It cannot observe or verify a payment. */
class UPIHandoffModule : Module() {
  private var pending: Promise? = null
  private var receiver: BroadcastReceiver? = null
  private var registeredContext: Context? = null
  private var callback: PendingIntent? = null
  private var leftActivity = false
  private val main = Handler(Looper.getMainLooper())

  private fun finish(selected: Boolean) {
    val promise = pending
    pending = null
    receiver?.let { registeredContext?.unregisterReceiver(it) }
    receiver = null
    registeredContext = null
    callback?.cancel()
    callback = null
    leftActivity = false
    promise?.resolve(selected)
  }

  override fun definition() = ModuleDefinition {
    Name("MeroSplitUPIHandoff")
    AsyncFunction("openChooser") { url: String, promise: Promise ->
      check(pending == null) { "A payment chooser is already open." }
      val uri = Uri.parse(url)
      require(uri.scheme == "upi" && uri.host == "pay") { "Only a UPI payment link is supported." }
      val activity = appContext.throwingActivity
      val context = activity.applicationContext
      val action = "${context.packageName}.UPI_CHOSEN.${UUID.randomUUID()}"
      pending = promise
      receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          // The OS fills EXTRA_CHOSEN_COMPONENT after a real target selection.
          if (intent.action == action && intent.hasExtra(Intent.EXTRA_CHOSEN_COMPONENT)) finish(true)
        }
      }
      try {
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") context.registerReceiver(receiver, IntentFilter(action))
        registeredContext = context
        val flags = PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_ONE_SHOT or
          (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        callback = PendingIntent.getBroadcast(context, 0, Intent(action).setPackage(context.packageName), flags)
        activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW, uri), "Pay with UPI", callback!!.intentSender))
      } catch (error: Exception) {
        val failed = pending
        pending = null
        finish(false)
        failed?.reject("ERR_UPI_OPEN", "Could not open a UPI app chooser.", error)
      }
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { if (pending != null) leftActivity = true }
    OnActivityEntersForeground {
      // Let an already-dispatched chooser callback run before treating resume as cancel.
      main.post { if (pending != null && leftActivity) finish(false) }
    }
    OnDestroy { main.post { finish(false) } }
  }
}
