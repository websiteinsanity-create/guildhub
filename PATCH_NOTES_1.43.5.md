# Guild Hall 1.43.5

Skill cores in Gear Threads (V29). Includes a small server change - restart after updating.

## New

- **Skill-core catalog**: 271 English skill cores (208 weapon, 63 armor/accessory) bundled in `catalog/skillcores.en.json`,
  taken from the Questlog Skill Cores table (snapshot 2026-10-25). Nothing is fetched from Questlog while using the app;
  only the icons load from Questlog's image server (if it can't be reached the icon is simply left blank).
- **Gear Threads -> a build -> Skill cores**: add cores to your *Owned* collection (search by name or effect, filter by slot
  and weapon). The collection is shared by all of a player's builds; no limit on how many you own.
- **Active cores per build**: 1 weapon core + 2 armor/accessory cores; a weapon core must match one of the build's weapons.
- A core that is active in any build has to be deactivated before it can be removed from Owned.
- Core removed from the game but still in the source table (Dark Wing's Bulwark / Power) are hidden unless
  "Include historical entries" is ticked.
- **Admin -> Gear threads -> Skill-core catalog**: officers can see the installed catalog and import a newer one. An import is
  refused if it would remove a core a player still uses.
- Old per-build Owned lists are merged automatically the first time a collection is saved.
- Shutdown now waits for a database write that is still in progress, so a restart can't lose the last change.

## Fixed

- Gear thread page: the Discussion panel and the Questlog / Coach folder / Skill cores row no longer sit 16px off from
  their neighbours.

## Updating

Replace the files with this package (keep your own `data/` folder) and restart. Existing data is migrated automatically.
