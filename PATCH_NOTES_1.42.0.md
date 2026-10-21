# Guild Hall 1.42.0

Fixes a real-world report of voice-attendance tracking missing players, plus a related discovery made
while chasing it down. Also adds a per-channel breakdown to the "Who got tracked" popup.

## Fixed: small-but-real parties were silently skipped from voice tracking

Any party with 3 or fewer members was treated as an automatic "placeholder" (not a real line-up) - which
meant Shotcaller never created a voice channel for it at all, so nobody in it could ever be tracked, no
matter how long they sat there unmuted. Only a genuinely empty (0-member) party now counts as a
placeholder automatically. A party menu's "Mark/Unmark as placeholder" override still works exactly as
before, in either direction.

## Fixed: the anchor party (Party 1) could be wrongly blocked for having no leader

A consequence of the fix above: the "every real party needs a leader before Shotcaller can start" check
started applying to Party 1 too - the one party that never needs a leader, since its channel is the one
the officer picks directly and Shotcaller never renames it. Party 1 is now explicitly exempt from that
check, same as it already was from the placeholder-based channel-skip decision.

## Fixed: voice-attendance crediting only checked channels it had already matched to a party

This was the real cause of the reported missed players. When Shotcaller is started without tying it to a
specific event (the standalone "Start Shotcaller session" panel, with a generic party count rather than
one chosen from the event itself), Guild Hall has no way to know in advance which bot-created channel
belongs to which of the event's real parties - it can only guess, by matching party-leader names or, 
failing that, falling back to position. That guess can miss, especially when more channels are created
than the event has real parties.

The bug: crediting (and the "who got tracked" log) only ever looked at channels that guess successfully
matched to a party - even though the bot was already reporting full presence data for every channel it
created, matched or not. Any channel the guess didn't claim was invisible to attendance, so anyone
standing in it was never credited, however long they waited, unmuted, from the start of the event.

Voice-attendance crediting now checks **every channel the live Shotcaller session reports**, regardless
of whether Guild Hall's own party-matching ever managed to attach a name to it. Being present in the
session is the only thing that matters now - which exact channel, or whether it ever got matched to a
party, no longer does. This makes tracking correct no matter how Shotcaller was started, named, or
guessed.

## New: "Who got tracked" now breaks sightings down by channel

The popup (event page > Voice channel tracking and Reminders > "Who got tracked") now opens with a
per-channel list above its usual table, e.g.:

```
Channel 1: Player 1 (Credited) , Player 8 (Credited) , Player 5 (Not Credited - deafened)
Channel 2: empty
Channel 3: Player 2 (Not Credited - deafened) , Player 6 (Credited) , Player 9 (Credited)
Channel 4: empty
```

Every channel the bot reported for that session is listed, including ones nobody ever joined (shown as
"empty") - so it's now possible to tell "this channel was checked and really was empty" apart from "this
channel was never checked at all", which is exactly the distinction that made the bug above hard to spot
from the UI. The full flat table below it is unchanged.

## Verified

Reproduced the exact reported scenario in an automated test: a standalone Shotcaller start with more
channels than the event has real parties, with a real party's members standing in a channel Guild Hall's
own matching never claimed. Confirmed this hangs/fails against the pre-fix crediting logic and passes
against the fix. Full test suite (220 tests, including 3 new ones added for this release) passes clean.
