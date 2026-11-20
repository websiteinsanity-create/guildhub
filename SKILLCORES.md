# Skill cores — v29

The Gear Thread now includes a local English catalog captured from the visible
[Questlog Skill Cores table](https://questlog.gg/throne-and-liberty/en/skill-cores)
on October 25, 2026: **271 entries — 208 weapon and 63 armor/accessory cores**.
Names, effects, slot assignments, weapon affinity and icon URLs come from that
table. `Sword` and `Wand` are mapped to the application's `Sword & Shield` and
`Wand & Tome` weapon names; Universal affinity is an empty weapons array.

## Collection and active builds

- Open **Gear Threads → a player's build → Skill cores → Add**.
- Search by name or effect, or filter by slot and weapon. Click a result to read
  its effect and add it to Owned. Hovering a tile also displays its effect.
- Owned has no six-core or fifteen-core limit. The collection is shared across
  the player's builds. Active cores are saved separately for each build.
- Each build permits **one weapon core and two armor/accessory cores**. A core's
  weapon affinity must match either weapon in the selected build.
- Active cores appear above unused Owned cores. Tiles show only icon and name;
  the detail dialog contains descriptions and activation/removal controls.
- A core active in any build must be deactivated there before it can be removed
  from the shared collection. Rejected changes leave existing data intact.
- Existing owner, officer and class-coach Gear Thread permissions apply.
  Legacy per-build Owned lists are merged on read and migrated on the first
  successful collection write. Deleting an alternate build preserves Owned.

## Source limitations

This is the complete captured **source table**, not a certification that every
listed core is available in the current game client. Questlog does not state a
game patch on the table; the data deliberately says `Not stated by source`.
Rarity is not inferred from CSS colors.

Three descriptions contain unresolved source formula tokens: Lightning
Condensation, Thunder's Shadow and Thunderclouds Explosion. Their descriptions
are preserved as published and their detail dialogs explain the limitation.

Dark Wing's Bulwark and Dark Wing's Power remain in the source table although
the official [Update 4.3.0 notes](https://www.playthroneandliberty.com/en-us/news/articles/update-4-3-0)
identify them as removed. They are retained as historical records and excluded
from catalog search unless **Include historical entries** is checked.

Catalog text is bundled locally; normal use never scrapes Questlog. Icons are
loaded from Questlog's CDN and require access to that host. No generated icons
or guessed effect values substitute for missing source data.

## Catalog updates

The bundled file is `catalog/skillcores.en.json`. Officers can inspect the installed
catalog and import a replacement under **Admin → Gear threads → Skill-core
catalog**. Import a complete JSON object in the same schema as the bundled file.
The import is validated before it replaces the stored catalog. Existing player
references cannot be removed or have their slot/weapon affinity changed by an
import. Keep their IDs, retaining historical records when necessary.

IDs are internal stable identifiers built from slot, weapon affinity and name;
they are **not Questlog item IDs**. Preserve them across future name corrections.
Import metadata records source, source snapshot date and game version (if known).
Catalog overrides, Owned and active selections persist in the existing database;
no separate database service or background scraper is required.

The restart check also exposed an existing persistence race: shutdown could exit
while an asynchronous database write was still in progress. Shutdown now waits
for that write, then saves any newer changes before exiting. A deterministic
test covers a shutdown signal arriving during an unfinished write.

## Validation

`node --test test/skillcores.test.js` checks the source snapshot, import schema,
slot/weapon rules, ownership above fifteen cores, cross-build collection sharing,
independent active builds, permission failures, atomic rejected edits, protected
imports, build deletion and persistence across a server restart. Existing Gear
Thread and coaching integration tests cover class-coach build access.
`node --test test/persistence.test.js` covers the shutdown race. UI logic checks
also cover filtered catalog results, escaped descriptions, activation controls,
stale dialogs, duplicate saves and failed requests. No real-browser layout
inspection of the Guild Manager was performed for this update.
