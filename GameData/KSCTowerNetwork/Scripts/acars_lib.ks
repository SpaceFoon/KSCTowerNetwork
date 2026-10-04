// =============================================================================
// KSCTowerNetwork ACARS helpers for kOS
// =============================================================================
//
// Drop this file in your Archive (the C# bridge auto-deploys it on first run)
// and pull it into other scripts:
//
//   RUNONCEPATH("0:/acars_lib.ks").
//
//   ACARS_SEND("departing for Mun, ETE 4d").
//   PRINT ACARS_LATEST(5).
//
// Functions:
//   ACARS_SEND(text)
//     Append `text` to the outbox file. The bridge POSTs each new non-comment
//     line to the Tower backend. Bodies over 4000 chars are truncated.
//
//   ACARS_LATEST(n)
//     Returns a STRING joined with newlines, holding the last `n` message
//     lines from the snapshot (header lines beginning with `#` are skipped).
//     Returns "" when the snapshot file does not exist yet.
//
//   ACARS_HAS_NEW(prevSnapshot)
//     Returns a LEXICON("changed", BOOL, "snapshot", STRING) so a long-running
//     monitor can poll cheaply: feed back the previous snapshot string each
//     tick and re-render only when changed.
// =============================================================================

LOCAL ACARS_SNAPSHOT_PATH IS "0:/acars.txt".
LOCAL ACARS_OUTBOX_PATH IS "0:/acars-out.txt".

FUNCTION ACARS_SEND {
  PARAMETER text.
  LOCAL t IS text:TOSTRING.
  IF t:LENGTH = 0 { RETURN. }
  IF t:LENGTH > 4000 {
    SET t TO t:SUBSTRING(0, 4000).
  }
  LOG t TO ACARS_OUTBOX_PATH.
}

FUNCTION ACARS_LATEST {
  PARAMETER n IS 10.
  IF NOT EXISTS(ACARS_SNAPSHOT_PATH) { RETURN "". }
  LOCAL raw IS OPEN(ACARS_SNAPSHOT_PATH):READALL:STRING.
  LOCAL lines IS raw:SPLIT(CHAR(10)).
  LOCAL kept IS LIST().
  FOR line IN lines {
    LOCAL trimmed IS line:TRIM.
    IF trimmed:LENGTH > 0 AND trimmed:STARTSWITH("#") = FALSE {
      kept:ADD(trimmed).
    }
  }
  LOCAL out IS "".
  LOCAL start IS MAX(0, kept:LENGTH - n).
  FROM { LOCAL i IS start. } UNTIL i >= kept:LENGTH STEP { SET i TO i + 1. } DO {
    IF out:LENGTH > 0 { SET out TO out + CHAR(10). }
    SET out TO out + kept[i].
  }
  RETURN out.
}

FUNCTION ACARS_HAS_NEW {
  PARAMETER prevSnapshot IS "".
  LOCAL result IS LEXICON().
  IF NOT EXISTS(ACARS_SNAPSHOT_PATH) {
    result:ADD("changed", FALSE).
    result:ADD("snapshot", prevSnapshot).
    RETURN result.
  }
  LOCAL contents IS OPEN(ACARS_SNAPSHOT_PATH):READALL:STRING.
  result:ADD("changed", contents <> prevSnapshot).
  result:ADD("snapshot", contents).
  RETURN result.
}
