# Guild Hall 1.43.13 (with Shotcaller bot 4.3.3)

Attendance tracking and Shotcaller lifecycle fixes. Update the bot FIRST, then Guild Hall, between events.

## Guild Hall

- A failed read of who is in voice is retried instead of being treated as "session stopped"; failed extra-channel reads are
  retried instead of consuming a check. After five failures the track is marked incomplete (sightings so far are kept).
- Three valid empty snapshots now correctly finish as tracked attendance with nobody present.
- The event's start time gate is saved and re-checked after a restart.
- Every tracking run has its own ID; late answers from a replaced run (e.g. "Track again") are discarded.
- A run is tied to the bot's real session ID, but several events can be tracked one after another on the same session
  without restarting voice ("Start tracking now" on the next event).
- Attendance no longer depends on party, leader or name matching: any registered active character (and the event's
  mercenaries) in any channel of the session or the extra channels counts, assigned to a party or not. The live Deafened
  counter counts unassigned members too and shows "unknown" instead of 0.
- Interrupted tracks stay visibly incomplete; they never turn the remaining members into finalized no-shows.
- The admin voice test only stops or expires the session it started itself (also during startup).
- Cached Shotcaller status is invalidated after start/stop/mute etc.; stale answers are ignored. The page shows
  starting / stopping / cleanup-failed states and retryable tracking errors.
- Tracks that were running before the update finish as incomplete after the restart - start a fresh track.

## Shotcaller bot 4.3.3 (separate download)

- One start reservation shared by Discord and Guild Hall: two simultaneous starts can no longer create two sessions.
- Stopping keeps the reservation until cleanup is done; audio/voice stop first, slow Discord updates come after, relay
  logouts are awaited. A failed cleanup stays retryable instead of reporting "inactive".
- Startup can be cancelled; partly created sessions are cleaned up. Stop/control requests for a replaced session are
  rejected. Sessions have unique IDs and a lifecycle phase.

Already included from earlier versions: 60 s stop timeout, resume of stalled tracks, System status tab.

## Updating

Replace the files with this package (keep your own `data/` folder) and restart. No data changes.
