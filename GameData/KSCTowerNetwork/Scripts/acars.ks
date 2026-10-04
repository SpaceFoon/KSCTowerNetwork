// =============================================================================
// KSCTowerNetwork ACARS terminal for kOS
// =============================================================================
//
// Reads tower ACARS messages from the file the C# bridge maintains in your
// Archive volume (acars.txt) and lets you send messages by appending to
// acars-out.txt. The bridge polls the backend and POSTs your outgoing lines,
// so this script never makes an HTTP call itself (kOS is sandboxed).
//
// USAGE (from any kOS terminal — including the IVA terminal popup, or a
// RasterPropMonitor / kOSPropMonitor cockpit page):
//
//   COPYPATH("0:/acars.ks", "1:/acars.ks").   // optional: copy onto local CPU
//   RUN ACARS.                                // monitor mode, refresh on change
//   RUN ACARS("hello tower, callsign K-001"). // send first, then monitor
//
// CONTROLS:
//   Press Ctrl+C in the terminal to stop the monitor.
//   Re-run with a string argument any time to send another ACARS line.
//
// REQUIREMENTS:
//   - kOS installed (this script runs on any kOS CPU, including the in-cockpit
//     terminal accessible from IVA).
//   - KSCTowerNetwork plugin running with kosBridgeEnabled=true (default).
//   - You must be logged in to Tower (open the radio panel and sign in once)
//     before the bridge will fetch or send ACARS — otherwise acars.txt will
//     show a "Tower not logged in" placeholder line.
// =============================================================================

PARAMETER outboundText IS "".

LOCAL SNAPSHOT_PATH IS "0:/acars.txt".
LOCAL OUTBOX_PATH IS "0:/acars-out.txt".
LOCAL POLL_SECONDS IS 1.5.

// ---------- Send first if a message was passed in --------------------------

IF outboundText:LENGTH > 0 {
  IF outboundText:LENGTH > 4000 {
    SET outboundText TO outboundText:SUBSTRING(0, 4000).
  }
  LOG outboundText TO OUTBOX_PATH.
  PRINT "ACARS> queued: " + outboundText.
}

// ---------- Monitor loop ---------------------------------------------------

LOCAL lastSnapshot IS "".

PRINT " ".
PRINT "================== KSCTowerNetwork ACARS monitor ==================".
PRINT "Reading: " + SNAPSHOT_PATH.
PRINT "Outbox : " + OUTBOX_PATH + " (one message per line; lines starting".
PRINT "         with # are ignored).".
PRINT "Re-run: RUN ACARS(""text"") to send. Ctrl+C to stop.".
PRINT "===================================================================".
PRINT " ".

UNTIL FALSE {
  IF EXISTS(SNAPSHOT_PATH) {
    LOCAL contents IS OPEN(SNAPSHOT_PATH):READALL:STRING.
    IF contents <> lastSnapshot {
      SET lastSnapshot TO contents.
      CLEARSCREEN.
      PRINT contents.
      PRINT " ".
      PRINT "[refreshed " + TIME:CALENDAR + "  " + TIME:CLOCK + "]".
    }
  } ELSE {
    PRINT "[acars.txt not present yet — waiting for the bridge…]".
  }

  WAIT POLL_SECONDS.
}
