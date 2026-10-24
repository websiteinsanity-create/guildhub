# Guild Hall 1.43.0

## New: Gear Threads

A personal page for every character, replacing the gear tracking that used to live in Discord threads.
Opens from the new **Gear Threads** entry in the menu (officers and class coaches) and from **My Gear Thread**
(everyone, for their own character).

### One thread per build

A character with a main build and extra builds (for example a Warden main and a Predator build) gets a
separate thread for each build, shown as tabs at the top of the page. Each build has its own:

- **Chat** - a running conversation between the player, their coach and the officers. Long conversations
  load in pages as you scroll up, and new messages appear on their own.
- **Screenshots** - one picture plus a note per topic (Gear, Damage & Defense, Main Stats, CC Stats by
  default). Drag and drop or choose a file.
- **Skill cores** - the owned/active picker. The list of skill cores itself is still empty and will follow.
- **Questlog links** - the same links as on the character, reachable for coaches too.
- **Folder** - notes, links and pictures that coaches and officers post for the player. The player can read
  it but cannot post into it (that is what the chat is for).

### Who can open what

- The **player** opens every build of their own characters.
- **Officers** open everything.
- A **class coach** only opens the builds whose class they coach. If one character has a Warden build and a
  Predator build, the Warden coach sees only the Warden build and the Predator coach only the Predator
  build. Coaches see one row per matching build in the Gear Threads list; officers see one row per character.

### For officers

- **Admin > Gear Threads**: add, rename, reorder or remove the screenshot topics. Renaming keeps the pictures
  already uploaded under a topic; removing a topic removes its pictures.
- Deleting a build (or a character) removes that build's thread, including its uploaded pictures.

## Also

- New package contents: `server-geargear.js`, `public/geargear.js` and the Gear Threads banner.
- Nothing else changes and no data has to be migrated; existing saves open as before.

## Verified

- New automated test for the per-build rules (who sees which build, chat/screenshots/folder/links kept
  apart per build, build deletion cleans up): passes. All other test files pass when run one by one.
- Browser check of the officer view, the coach view (only their class's build) and the admin screen.

## Updating

Replace the files with this package and restart. If the old layout shows, refresh the browser with Ctrl+F5.
