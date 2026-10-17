# Guild Hall 1.36.0 — full package

This is the **complete application** (everything except your own `data/` folder), not an update package -
unzip it over a fresh install, or replace everything except your `data/` folder in an existing one. Changes
below are since 1.35.0, covering the five issues from your last bug report.

## Fix: correcting a player's attendance history from the Attendance page didn't save

Opening a player's attendance-history popup, changing one of their results (e.g. No-show → Came) and
pressing Save looked like it did nothing - the popup reopened showing the old value again, as if the
correction never happened. The correction actually was saved; the popup you saw right after was reading from
a cached copy of the page's own stats that had no way to know it had just gone stale. It now forces a fresh
read of those stats before the popup reopens, so the value you just set is what you see.

## Fix: roster columns weren't sorted the way you wanted

Each role column on an event's roster (Tank/Healer/DPS) was sorted purely by gear score. It's now sorted by
attendance status first (Came, then No-show, then No reply, etc. - the same order the status dropdown itself
uses), and alphabetically by name within each group.

## Fix: "PIN window" field left showing when voice tracking governs an event

The PIN checkbox and its own window field already hid themselves correctly when voice tracking takes over,
but a separate "PIN window (minutes players can enter it)" field next to it didn't - it's just as unused in
that case, so it's now hidden alongside the rest. Fixed on both the one-off event dialog and the recurring-
event dialog.

## Fix: some parties weren't getting tracked by voice attendance

This was the cause behind "party 1-8 tracked, party 11 not": starting voice tracking by hand (the "Start
tracking now" button, or "Track again") works out which of an event's parties are real line-ups at the
moment you click it. In your setup specifically - no party leaders, parties reassigned by voice/chat instead
of re-posting - if how many parties still counted as "real" (versus a placeholder) changed in between, every
real party after that point could shift onto the wrong voice channel, or lose its channel entirely once the
list ran past the end. Fixed properly this time: the moment you actually start a Shotcaller session "from an
event" (the Start dialog's event picker), that event's party-to-channel layout is now frozen right then and
there. "Start tracking now" and "Track again" use that frozen layout from then on, however long a gap there
is and whatever gets reassigned to the parties in between - so a party keeps its own real channel no matter
what changes about the line-up afterward.

## Fix: the dashboard's Attendance Tracking panel looked like it kept restarting

Nothing was actually restarting - the panel polls for live numbers every 5 seconds while a track is running,
and that redraws the whole card from scratch each time, which replayed the "just started" entrance look (the
button's color morph, the stat boxes popping in) on every single one of those redraws. That's what looked
like the panel "starting" over and over, for as long as tracking stayed running or awaiting save - including
well past 10 minutes, since the poll keeps running the whole time. It now only plays that entrance look the
first time a track actually changes state; redrawing the same state again settles straight into its normal
look with no animation.

## Verification

213 tests, all passing - two new ones added specifically for the voice-tracking party-channel fix (one for a
party changing position, one for the no-leader case matching your actual setup: an earlier party dropped to
a placeholder in between, shifting a later real party's slot). Both were confirmed to fail against the
previous code and pass against this fix. The other four fixes are client-side UI/caching changes with no
automated test in this project (every existing test exercises the server over HTTP, not the browser UI) -
each was checked by hand in a real browser:
- The attendance-history correction was made, saved, and confirmed to show the new value on reopening
  instead of reverting.
- The roster sort order was checked against a deliberately mis-ordered set of test players.
- The PIN window field's hide/show was checked in both the one-off and recurring-event dialogs, with the
  guild default set to each of PIN and voice mode, and with the per-event override set to each option.
- The party-channel fix was checked end-to-end through the actual "Start tracking now" flow, with parties
  reassigned between starting Shotcaller and starting tracking and no leaders set anywhere, confirming the
  right party still ends up tracked on its own channel.
- The dashboard animation fix was checked by simulating several consecutive 5-second poll redraws of the same
  tracking state and confirming the entrance animation only plays on the first one.

Boot-tested from this exact zip's contents before packaging.

## Image note (this zip only - not a code change)

To fit the delivery size limit, the large opaque banner/tile images in this zip are compressed JPEGs instead
of the original lossless PNGs (same as every full package since 1.25.0). The Discord banner
(`public/img/schedule-banner-discord.png`) and the transparency-dependent class icons (`colcard-*.png`) are
untouched PNGs. If you want the original, full-quality PNGs for the recompressed ones, just ask and I'll send
those separately - nothing about how the app works depends on which format these are in.
