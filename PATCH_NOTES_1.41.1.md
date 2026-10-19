# Guild Hall 1.41.1

Follow-up to 1.41.0's quick-check voice-tracking rework.

## Admin > Testing's voice-attendance dry-run now matches real tracking

The "Attendance tracking test" tool (Admin > Testing) still demonstrated the *old* rolling-30-second,
2-sightings crediting rule after 1.41.0 shipped - a leftover from before the rework, since the diagnostic
runs its own independent copy of the logic. It now runs the exact same fixed cycle real event tracking
does: one check immediately once the lead time has passed, then two more 10 seconds apart, with anyone
seen in any one of the 3 checks reported as confirmed. The dialog also now shows "quick check X of Y"
progress while a test is running, instead of the old rolling-window framing.

## Minor: a stale popup message fixed

The "Who got tracked" popup on an event's page could, in a corner case that should no longer actually
occur, have shown "Seen too briefly to be confirmed yet" as a miss-reason - wording left over from the
old 2-sightings rule. Replaced with neutral wording, since under the new union-based crediting, anyone
recognized and not excluded by the mute/deafen settings is credited on their very first sighting.

## Verified

Ran a real, production-timed (no test-speedup) end-to-end check of the quick-check tracking cycle: check
1 fires immediately on start, check 2 ~10 seconds later, check 3 ~10 seconds after that, the whole cycle
finishes in ~20 seconds, and three separate testers - one seen only during check 1, one only during check
2, one only during check 3 - were all correctly credited as attended once the cycle finished. `ev.attended`
stayed untouched through checks 1 and 2 and populated all at once on finish, exactly as designed.
