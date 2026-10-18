# Guild Hall 1.39.0 — full package

This is the **complete application** (everything except your own `data/` folder), not an update package -
unzip it over a fresh install, or replace everything except your `data/` folder in an existing one. Changes
below are since 1.38.0.

## Fix: a VOD review note cut coaches off at 1000 characters, silently

The "Write a review" / "Add review" box on a VOD (the overall wrap-up note a coach writes when they finish
reviewing someone's footage) had a 1000-character limit, with nothing telling you it was there - once you hit
it, the box simply stopped accepting more typing or pasted text got quietly cut off mid-sentence, with no
warning. For a coach writing a genuinely detailed review, that's not much room.

- **The limit is now 1700 characters** - about 70% more room. That number isn't arbitrary: this note gets
  wrapped in a Discord DM to the player, and Discord rejects any message over 2000 characters outright, so it
  has to stay under that even after the "Boss reviewed your VOD ..." text and link added around it - 1700
  leaves comfortable room for that wrapper.
- **A live counter** now sits under the box ("480 / 1700") so you can see how much room you have left as you
  type, instead of finding out the hard way.

I also checked the "empty row as a separator" complaint specifically - a blank line between paragraphs
already displays correctly once a review is saved (the review box preserves line breaks, including blank
ones). What you ran into there was very likely the same 1000-character wall: if it cut a note off right
around a blank line, it would have looked like the blank line itself broke something, when it was really
just the length limit biting at an unlucky spot. With the longer limit this should not come up again.

## Verification

216 tests, all passing (1 new - a coach writes a review well past the old 1000-character cap and the test
confirms the full note is kept *and* that the resulting Discord DM still fits in a single message). Checked
by hand in a real browser: the live counter tracks typing correctly, a 1500-character note that used to get
cut off now saves in full, and a blank-line-separated note renders with the gap intact.

## Image note (this zip only - not a code change)

To fit the delivery size limit, the large opaque banner/tile images in this zip are compressed JPEGs instead
of the original lossless PNGs (same as every full package since 1.25.0). The Discord banner
(`public/img/schedule-banner-discord.png`) and the transparency-dependent class icons (`colcard-*.png`) are
untouched PNGs. If you want the original, full-quality PNGs for the recompressed ones, just ask and I'll send
those separately - nothing about how the app works depends on which format these are in.
