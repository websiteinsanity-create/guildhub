# Guild Hall 1.42.2

New look for the party planner (Parties page and the party board on every event). Only the screen changes:
nothing about how parties are saved, posted to Discord or used by Shotcaller is different.

## What is new

- **Party planner header** with the formation emblem, an "Active preset" bar, and the preset's settings and
  officer notes folded away until you open them.
- **Role lists** (Tank, Healer, DPS) on the left: each can be collapsed, shows how many are available, shows
  up to three cards at a time and scrolls beyond that. One search box filters all three.
- **Party cards** show a small role count (for example "1 Tank 1 Healer 3 DPS"), a "Full" marker, dashed
  "Open slot" placeholders up to the party size, and the leader crown next to the name.
- **Inactive members** that are still in a line-up now carry an "Inactive" tag.
- **Save status** next to "Add party": "Saving..." / "Saved" / a clear message if a save failed.
- **"Clear" is now called "Confirmed only"** and only appears on event boards, not on presets.
- Players in a party who are not confirmed for the event stay dimmed under "Not confirmed for this event":
  a red edge for "said not attending", a grey edge for "no reply yet", a blue edge for an approved leave.
- Normal members see the same board read-only (no drag handles, no member lists).

## Verified

- Browser test of the whole planner: drag a member into a party, between parties and back to the list,
  search, collapse, move/remove/add/delete party, rename preset, load a preset into an event, drag on the
  event board, "Confirmed only", read-only view for normal members: 21 of 21 checks pass, no page errors.
- Party and Shotcaller posting tests, feature tests and API tests pass.

## Updating

Replace the files with this package and restart. No settings or data change. If the old layout still shows,
refresh the browser with Ctrl+F5.
