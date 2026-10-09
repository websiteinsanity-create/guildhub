# Guild Hall

A small, self-hosted guild manager for Throne and Liberty. No database, no build step,
no dependencies: just Node 18+ and one JSON file of data.

## What it does

- **Sign in with Discord**: every player signs in with their Discord account, like on the original guild manager.
  Only members of your Discord server get in, and Discord roles decide who is an officer. Characters and answers
  are tied to the Discord account. (Without Discord settings the app runs in a demo mode with shared passcodes.)
- **One character per player**: every player has exactly one character. It is created the first time they sign in
  (or, for Discord servers that use applications, as part of applying). The "Add character" option disappears once
  they have one - enforced by the server itself, not just hidden in the menu - and editing the existing one is how
  they change role, weapons or anything else. A character can still have **several Questlog links** and **extra
  builds** (for example a PvE healer and a PvP dagger build on the same character, each with its own role, weapons,
  class and specialization) - the limit is one *character*, not one *build*.
- **My profile** (bottom of the menu): every player has their own page with a note, their time zone and their character.
- **Approval by the leadership**: in Admin the leadership chooses which changes players cannot make on their own
  (role, weapons and class, gear score, level, Questlog links, extra builds, profile text, or even adding a new
  character). Those changes wait under **Approvals** (with a badge in the menu); officers approve or reject with a note, and the player
  gets a Discord message. Officers are never held back.
- **What members see**: a normal member only sees their own characters in "Qualified for loot", **Loot** and
  **Attendance**. The server does not even send them other people's loot, attendance or requests. In Admin the
  leadership can hide whole sections from normal members (Parties, Member, Loot, Points, Requests, and two dashboard panels).
- **Requests**: players ask for **Lucent** or an **item** for a specific build. The leadership approves, rejects
  or marks it as handed over (an item then appears in the Loot section with its type). A player can withdraw their own
  request while it is still open; an officer can delete any request, in any status - for a troll request, even after
  rejecting it.
- **Tags**: the leadership creates tags (text and colour) in Admin and puts them on players on the Member page.
- **Standing, at a glance**: the leadership sees a Standing column on the Member page (active warnings, attendance %,
  coloured when it needs a look) and a full Standing panel on a player's profile (every active warning with its reason,
  current leave of absence) - so checking someone over does not mean a separate trip to the Warnings and Leave pages first.
  Only the leadership can see them. You can filter the Member list by tag.
- **Personal dashboard**: everybody can hide and re-order dashboard panels ("Customize"). The leadership sets a
  dashboard announcement, the guild name and tagline, the accent colour, the **guild icon** and a **background picture** in Admin > Appearance.
- **Leave of absence**: a player asks for days away (or the leadership enters one). While it runs, events do not count
  as no-show, no reply or missed attendance, there are no reminders, no warnings, and the player is marked "On leave".
  Whether the leadership has to approve it is a setting.
- **Attendance rules and warnings**: in Admin the leadership sets limits (no-shows, unanswered events, minimum attendance %, over the last N
  days, mandatory events only), plus how long after an event starts its attendance is treated as final (default 60 minutes) - this is
  separate from the PIN entry window itself, which can stay however long it already is. An event is only judged for no-shows and the
  attendance percentage once that time has passed, not the moment it starts or the moment any single person happens to check in, so nobody
  still inside their own valid PIN window gets wrongly counted as a no-show. A player over a limit gets a **full-screen pop-up asking for a reason** when they open the site. The pop-up only goes away
  once they typed a reason and sent it for approval; the leadership accepts or rejects it under Approvals (a rejected one asks again, with the
  answer). Too many no-shows or unanswered events also give an **automatic warning**, once per new offence. The **Warnings** page lists them
  (a member only sees their own) and a player's active warnings always show on their dashboard. Warnings end by themselves after N
  days, or when there was no new warning for N quiet days (the oldest few or all of them vanish), or when the leadership removes them
  one at a time, or **all at once** for a player with the "Clear all" button on the Warnings page. With N active warnings a player is
  **disqualified from loot** for as long as they have them. The leadership itself is never judged. In Admin, the whole system can also
  be **paused for a set number of hours** - a temporary pause on top of the usual on/off switch, for things like a planned break with
  no events, resuming on its own once that time is up rather than needing anyone to remember to switch it back on.
- **Login notices**: the leadership writes a notice in Admin (title and text) and sends it to **everybody or only to chosen players** (with a
  search box for the player list). It covers the whole screen when a player opens
  the app and only goes away when they press "I have read this and accept". Several notices queue up ("Message 1 of 2").
  The leadership sees how many accepted and who has not, can turn a notice off, and can make everybody accept an edited
  notice again. Players who are already signed in get a new notice within a minute. (This is a reminder to read,
  not a security control: someone who talks to the server directly can skip the pop-up.)
- **Time zones**: every player picks their own time zone on their profile (default Europe/Berlin, which is CEST in summer).
  The calendar, event times, PIN windows and the "New event" form all use it. Times typed in the "New event" form are
  taken as times in your zone.
- **Dashboard** (the landing page): the guild name in big letters, member count out of the guild cap, how many Tanks, Healers and DPS,
  the next event with an **Info** section under it (the leadership names it and creates categories and buttons; every button opens a
  popup with their own text), and a **Leadership** area in two parts: the tasks (only the leadership sees them) and a short "who is who"
  for everybody ("Freki: Officer. Jobs: Managing the Wargames"). Only the leadership can customize the dashboard. Everyone with a leadership rank (Guild Master and Officer by
  default) is listed with their tasks (To do / In progress / Done) and the events they are hosting.
  Officers can edit anyone's tasks; a leader can edit their own.
- **Audit log**: every important change - characters created, edited or removed, events, parties, points, settings
  (guild and Discord), and applications accepted or rejected - is recorded with who did it, when, and (where it
  applies) what the value was before and after. Only the leadership can see it, under **Audit log** in the menu, and
  it can be filtered by player, action, target and date, with pages for large histories.
- **Qualified for loot** (on the dashboard): attendance on **mandatory** events in the last 14 days, one row
  per member, coloured red / orange / green (default 0-59 / 60-80 / 81-100%). Clicking a row opens a
  dropdown with the player's Questlog link, the items they received in the last 7 days (read live from
  the Loot section) and their attendance. Officers see everyone and can change, in "Loot rules": the
  attendance needed (default 60%), the colour ranges, the item period, and the day the 14 days count back
  from. A normal member only sees their own characters. An officer can also **compare specific characters**:
  pick two or more by name (searchable) and the list narrows to just those picks, side by side, for deciding
  who gets one particular item - clearing the pick list goes back to the normal view. Each player's dropdown
  also has a **Give loot to [name]** button that jumps straight to the Loot page with that player already
  selected in the form, ready to record the entry.
- **Loot** (below Member): a log of who received which item, of which **type** (Skillcore, Item, Shard or **Lucent**), and on which day.
  For Lucent the item field slides away and you type the amount. When a Lucent or item request is marked paid out / handed over, the entry
  is added here by itself. Officers add, edit and delete
  entries; everyone can read the list.
- **Member** (the roster): characters with role, two weapons, an optional **Questlog link**, the **class name** that pair gives in
  Throne and Liberty (for example Wand & Tome / Orb - Oracle), a free-text **specialization** you type
  yourself, gear score, level, rank, Discord. Members manage
  their own characters (including alts); officers manage everyone. With Discord sign-in, an officer can also **kick**
  a player from a character's edit dialog: their history (loot, points, attendance) is kept and their character is
  simply deactivated, but their Discord account is flagged so they cannot sign in normally again - even a Discord role
  or officer/coach status they still technically have cannot override it. They land on the application page instead,
  same as anyone new, and only get back in if an officer accepts a fresh application from them, which also clears the
  flag.
- **Events**: a big **week or month calendar** with colour-coded event types and a **mandatory** flag per event (each
  event type has a default in `config.json`; you can change it per event). Event types include Wargames,
  Tax delivery, Guild bosses, PvE-Raid, Interserver Boonstone/Riftstone and Worldboss (Conflict/Peace). Click an event and a **window opens to the right of the calendar**: the event, your sign-up and the attendance PIN. Officers
  click an empty day to add one there. The title is optional (the type is used when you leave it empty). Members answer
  **Going** or **Can't** per character (there is no Maybe). Times show in each viewer's own time zone.
  - The calendar is **usable on a phone**: the week view becomes one full-width day per row instead of seven
  squeezed-together columns, and the month view stays a real calendar grid with a small coloured dot per event
  instead of unreadable text. Day and month names are always in English, regardless of the visitor's own browser language.
- **Colours in the calendar** show how you did: **green** you were there (recorded by the PIN or by an officer), **red** a no-show
    (you said Going, an officer recorded attendance and you were not on it), **orange** no reply (after the event), **grey** not attending
    (you said Can't). The legend is under the calendar. Red and orange appear once an officer has recorded who came.
  - **Recurring events** (leadership only, a dropdown at the top of the Events page): "New recurring event" repeats an event every week, every 2 weeks, on several weekdays, at a
    fixed local time in a chosen time zone (for example every Monday 21:00 Europe/Berlin, which stays 21:00 when the
    clocks change between CET and CEST). Dates are created about six weeks ahead. Changing the series changes all
    upcoming dates (sign-ups are kept); deleting one date only skips that date; deleting the series removes the upcoming
    dates and keeps the past ones. A party preset tied to the event type is applied to every new date.
  - **Sign-ups close** before the start (30 minutes by default, editable per event). Officers can still change answers.
  - **Attendance PIN**: at an editable time (Admin) a 4 digit PIN is created and sent by Discord message to the
    leader of every party and to the leadership. Players type it into the window next to the calendar during the PIN window
    (editable per event, 15 minutes by default) and their character is marked as attended (the event turns green). The window says
    whether sign-in is **not activated yet** (with the time it opens), **open** (with the input and the time it closes), or **too late**. Five wrong tries lock a player
    out for that event, and officers can always mark attendance by hand, send the PIN again, or create a new one.
  - **Reminders**: players who have not answered get a Discord message at editable times before the event
    (default 5 h and 2 h). Reminders stop when sign-ups close, and can be switched off per event. The message
    includes two one-tap buttons, **Can come** / **Can't come**, for anyone who would rather not open the site
    right now - tapping one answers immediately and shows a small "got it" confirmation, no sign-in needed. These
    are Discord link buttons: tapping one just opens a page, the same as tapping a normal link, so they work with
    nothing more than what this bot already does (no Gateway connection, no public interactions endpoint, neither
    of which this project asks a self-hosted server to run). Each button stops working once sign-ups close for
    that event, same as the reminder itself.
- **Going chart**: every event shows how many are going, not going and have not answered, per role (Tank, Healer, DPS), as bars or as rings.
  People on leave are shown separately instead of as "no reply".
- **Hidden presets**: the leadership can hide a party preset from normal members. The "use for several events" panel on the Parties page is a
  dropdown; with it closed the party board is bigger, and every role list always shows six members.
- **One preset for several events**: on the Parties page tick several event types and/or single events and use one preset for all
  of them at once (new events of those types get it automatically).
- **Class per party**: when a player has extra builds, the leadership can pick which build they play in a party
  (menu "..." on their row > "Class / build in this party"). The row then shows that build's class, role and colour.
- **Parties board (drag and drop)**: role lists on the left, party cards on the right. The role lists only show
  members who actually said Going for that event - to place someone who never answered, set their RSVP to Going
  first (on the Attendance or Events page) and they then appear here like anyone else. Drag members
  between parties, back to the role list, or drag a party by its handle to reorder. Every row shows
  the class and specialization, and the "..." menus (leader crown, move to, remove) do the same on
  touch screens. Party names are editable. Loading a preset carries over whoever was in the line-up when it
  was saved, not whoever has actually confirmed for this particular event - anyone still unconfirmed shows
  dimmed, set apart under their own party rather than looking the same as someone who is really coming.
- **Parties page (presets)**: saved line-ups. Create one from scratch or use "Save as preset" on an
  event, then load a preset into any upcoming event. Events use the same board. A preset can also be tied to an
  **event type**, for example "use this for every Wargames": it is copied into all upcoming events of that type and
  into every new one you create. Above every board, a small **notes** panel (officers only) is shared between the
  Parties page and every event's board - the same note everywhere, for anything worth remembering while building
  parties, such as who is away this week.
- **Attendance and points**: one row per player with their **attendance %**, how many events they **came to**, how often
  they said Going but did **not show up** ("no-show"), and how often they **never answered** Going or Can't. Click a row for the
  event-by-event list. Filter by period, mandatory only, role, colour, no-shows or unanswered events; sort by any column. Officers tick who showed up; when points are switched on they are awarded automatically and
  can be adjusted by hand (loot spent, corrections, decay). Attendance rate is tracked per character. For a guild moving its whole
  history onto Guild Hall, the **Starting attendance %** panel on this page lets officers give a player a starting baseline -
  a percentage, how many events it is based on, how many days those were spread across, and the date it starts counting from
  (for example "50% over their last 30 events across 14 days, starting Oct 1"). It decays away **linearly, day by day** rather
  than vanishing the moment one real event happens - which would otherwise let a single event swing someone from 5% to 100%
  overnight - or sitting there forever unchanged. By the start date plus the day count it has fully aged out and only real
  attendance counts from then on, with nothing to turn off by hand. Until then it blends directly into the normal percentage
  alongside whatever real events exist, and it can never trigger the attendance compliance warning by itself - that specific
  warning stays suspended for a player for as long as any of their baseline is still in effect, resuming normally the moment
  it has fully decayed away. No-show and no-reply counts are unaffected either way, since those are based on real events only.
- **Admin**: the defaults for sign-up closing, the PIN and the reminders, a test message to yourself, the list of
  players, linking old characters to Discord players, backup and restore, and a switch to turn **points for attending** on or off (they are **off** as standard). Every section of the Admin page is a dropdown, and
  "Open all" / "Close all" at the top opens or closes them together.

## Discord setup

Do this once. It takes about 10 minutes. You need to be an admin of your Discord server.

1. **Create the application.** Open https://discord.com/developers/applications , click *New Application*, give it a name.
2. **Sign-in (OAuth2).** In the application, open *OAuth2*. Copy the *Client ID* and (with *Reset Secret*) the *Client Secret*.
   Under *Redirects* add exactly `PUBLIC_URL/auth/discord/callback`, where `PUBLIC_URL` is the address your players
   will open, for example `https://guild.example.com/auth/discord/callback`. (`http://localhost:3000/auth/discord/callback`
   works for trying it on your own PC.)
3. **The bot account.** The guild manager needs its own Discord account, and Discord calls that a **bot user**. It is free and
   belongs to the application you just made (a normal Discord account cannot be used: Discord forbids running one by
   program). Open *Bot*, give it the name and picture you want people to see, click *Reset Token* and copy the token. You do not
   need any of the "privileged intents". Then **add the bot to your Discord server**: once the app runs, open **Admin > Discord**,
   press *Check the connection* and use the invite link there (it asks for exactly what the bot needs: view channels, send
   messages, attach files). Players must share a server with the bot, and the bot can only message people who allow
   direct messages from server members.
4. **Collect three IDs.** In Discord open *User Settings > Advanced* and switch on *Developer Mode*. Then right-click
   your server icon > *Copy Server ID*, right-click your officer role (Server Settings > Roles) > *Copy Role ID*, and right-click
   your own name > *Copy User ID*.
5. **Fill in `.env`.** Copy `.env.example` to `.env` (same folder) and fill in `PUBLIC_URL`, `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OFFICER_ROLE_IDS` and
   `DISCORD_OFFICER_USER_IDS` (put your own user ID there so you can always get in as officer). Keep this file private.
6. **Test the bot before you start the app.** Double-click `check-discord.bat` (Windows), or run `./check-discord.sh` or
   `npm run check-discord`. It goes through everything and tells you in plain words what works. See "Testing your bot" below.
7. **Start the app** (`start.bat`, `docker compose up -d`, or `node server.js`). The start-up log says
   `Sign-in: Discord` and `Discord bot: on`. Sign in, open **Admin > Discord**, press *Check the connection*, then *Send me a test message*.

### Testing your bot

`check-discord.js` reads your `.env` and tests, one after the other: the settings themselves, the bot token, whether the Client ID and
Client Secret belong together, whether the bot is in your server, which channels it sees, whether your officer and member roles and user IDs
exist, and (optional) a real test picture in a channel and a real direct message to you. Each line is `OK`, `FAIL` (with what to do) or a
warning. It uses the same code as the app and never prints your token or secret.

    node check-discord.js
    node check-discord.js --channel 123456789012345678 --dm 123456789012345678

The IDs after `--channel` and `--dm` are the channel and your user ID (right-click > Copy ID, with Developer Mode on; the script also lists
the channel IDs it can see). Without them it asks, and you can press Enter to skip.

The usual mistakes, and what the script says about them:

| What you see | What it means |
|---|---|
| `Discord does not accept the bot token` | Wrong token, or an old one. Developer Portal > Bot > *Reset Token*, copy it again, no quotes or spaces. |
| `does not look like a bot token` / `BOT_TOKEN and CLIENT_SECRET are the same` | You copied the Client Secret or the Public Key instead of the bot token. |
| `Client Secret does not match the Client ID` | Developer Portal > OAuth2 > *Reset Secret*, copy the new one. |
| `different applications` | The Client ID and the bot are from two different Discord applications. |
| `The bot is not in your server` | Use the invite link the script prints, and check `DISCORD_GUILD_ID`. |
| `Officer role ... does not exist` | Wrong role ID, or the ID of a role on another server. |
| `The test picture was not posted` | The bot needs View Channel, Send Messages and Attach Files in that channel. |
| `The test direct message was not sent` | You must share a server with the bot and allow direct messages from server members. |

One thing it cannot check: the *Redirect* in the Developer Portal (OAuth2 > Redirects). It prints the exact address that has to be there.
If Discord says "Invalid OAuth2 redirect_uri" when you sign in, that is the one.

**If your bot token ever ends up somewhere it should not be** (a chat, a screenshot, GitHub), open Developer Portal > Bot > *Reset Token*
at once. The old token stops working immediately.

Good to know:

- Normally only members of the Discord server can sign in (`DISCORD_GUILD_ID` is required). Add `DISCORD_MEMBER_ROLE_ID` if
  people also need a certain role.
- **Applications (people who are not in the guild yet):** in Admin > Discord tick "People who are not in our Discord server can sign in
  and apply". Then somebody outside signs in with their Discord account and sees only an application form (character, weapons, gear
  score, a few words about them). Nothing else in the app is open to them: the server refuses every other request. The leadership
  accepts or rejects it under **Approvals**. Accepting makes them a member at once (no new sign-in needed), puts their character on the
  roster, and, if `DISCORD_MEMBER_ROLE_ID` is set and they are in the server, the bot gives them that role (needs the "Manage Roles"
  permission and a bot role above the member role; the invite link in Admin has a version with it). People who are outside the
  server get the invite link you save there in their welcome message. Somebody who was accepted is never turned away again, even if you
  switch applications off. With applications off, outsiders are turned away as before.
- **Party pictures in a channel:** in Admin > Discord pick the channel and the standard text. Next to the parties of every event there is a
  **Post to Discord** button: it draws the parties as a picture in your browser (with the party leaders, the builds and the players who
  are going but not placed), shows you a preview, and the bot posts it with the text. You can change the channel and the text
  before posting. The bot needs View Channel, Send Messages and Attach Files in that channel. The event page keeps a note
  of who posted when, and why it failed if it did.
  - **@-mention roles**: in Admin > Discord, tick which Discord roles should be pinged on every party announcement (none ticked
    = no mention, exactly as before). Only roles that actually exist on your server can be picked, and the mention uses Discord's
    real `<@&role-id>` format - typed text elsewhere (the event title, the message) can never accidentally ping `@everyone`.
  - **Delete the previous announcement**: also in Admin > Discord, an option to remove the last party announcement message right
    before posting a new one, so the channel only ever shows the latest line-up instead of piling up old ones. If that old message
    was already deleted by hand, posting the new one still works normally.
- **View parties, built for a phone**: next to the parties of every event there is also a **View parties** button open to everyone,
  not just officers. It draws the same picture as a Discord post would, but as a single readable column instead of several
  side-by-side cards, since the normal party board (built for dragging people between columns) is hard to read at a phone's width.
- **Mercenaries**: players from other guilds who help fill the roster for a single event. Set the channel and the Discord role they
  carry in Admin > Mercenaries (a different role from your regular members), then press **Get mercenaries** on an event to ask for
  either a plain headcount or specific roles and classes with how many of each, plus an optional note. It posts in that channel,
  @-mentions the role, and includes a link. Whoever clicks it signs in with Discord (this works even with general guild applications
  switched off - asking for one-event help is treated separately from applying) and fills in a short character of their own, or taps
  the **Join as a mercenary** button posted alongside the link (a Discord link button - opens the same page, nothing more). They are
  never a guild member: they never mix into the Member page, attendance, loot or anywhere else that normal characters do, and the
  leadership is never asked to approve anything about them. They show up in the party board of the event they joined, marked "Merc",
  there for an officer to drag into a party like anyone else, and in a separate "Mercenaries" dropdown at the bottom of the Member
  page for officers to review or edit. If they help again for a different event, signing in again finds the same character rather
  than starting over - an officer removes it whenever it is no longer needed, nothing expires on its own. One current limitation: if
  someone already has a real guild character under the same Discord account, they cannot also sign up as a mercenary with it (the
  one-character rule applies here too) - if a mercenary later becomes a full member, an officer should remove their mercenary
  character first.
  After signing up, a mercenary lands on a simple waiting-hall page instead of the roster: just their own status, and once an
  officer places them into a party, just that one party - not anyone else's. When parties are posted to Discord, every mercenary
  already placed into a party also gets a DM with a picture of just their own party, automatically.
- **Guest class coaches**: similar to mercenaries, but for ongoing VOD review access instead of one event - someone outside the
  guild who coaches a single class. In a **"Guest coaches"** section on the Member page, between the roster and Mercenaries, copy
  the invite link and share it; the same trust model as a mercenary's link applies (it works even with general applications
  closed, there is no separate approval step). Whoever follows it signs in with Discord and picks the one class they are coaching
  from a dropdown; from then on they see VODs - and can leave coaching points on them - for whoever currently plays that class,
  the exact same access a real guild-member coach linked to that class would have, just without ever becoming a guild member
  themselves. They never appear in the roster, attendance, loot or anywhere else normal characters do. An officer can switch their
  class or remove them entirely (revoking access immediately) from the same section, each guest coach shown with their own
  dropdown; nothing expires on its own.
- **Extra officers from Admin, not only .env**: Admin > Officers can grant officer status to a Discord role or to specific players,
  on top of whatever DISCORD_OFFICER_ROLE_IDS / DISCORD_OFFICER_USER_IDS already say in .env - no restart needed. Like any other
  sign-in detail, it takes effect the next time that person signs in, not to an already-open session.
- **Loot remembers item names**: typing an item or skillcore name once in the Loot page makes it selectable from then on when adding
  or editing an entry, instead of having to type the exact same name again. It is drawn from your own past entries, not an outside
  catalog, so it only ever lists names your guild has actually used.
- **Class coaches and VOD review**: Admin > Coaches grants coach status (a Discord role and/or specific players, the same mechanism as
  extra officers) and links each coach to one or more **classes**, not to specific players - whoever is currently playing a linked
  class is automatically that coach's student, so the list never needs updating by hand as people join, leave, or switch classes.
  Specific-player coach assignments take effect immediately, including for someone already signed in - no need to sign out and back
  in. This works the same way in passcode mode as it does with Discord sign-in.
  A coach sees their students' full profile - questlog links, notes, loot and points included - the same as the student sees their own,
  not the stripped-down view a normal member gets of anyone else. Anyone can post a VOD (a YouTube link) for themselves on the **VODs**
  page; a coach can also post one for a student they are
  linked to. Each VOD's name is always built automatically from its type, the date it was recorded, and (for types where it applies -
  Wargame, Stonefight, GvG Boss) the enemy guild - never typed by hand. A VOD is private by default (the owner, their coach, and
  officers only); only a coach or an officer can share it more widely, with everyone or with a specific class - never the owner
  themselves. VODs are grouped into one folder per class - the first thing shown on the page - labelled with
  that class's two weapon icons, and created automatically the moment the first VOD from someone currently
  playing it exists; nobody creates or manages these by hand. Opening a class folder shows one smaller folder
  per player within it. Someone who has respecced moves to their new class's folder on its own, the same way
  they move in and out of a coach's roster elsewhere; a player with no resolvable class lands in one "Other"
  folder instead of being silently dropped. Checking **"Spectator/overview recording"** on the posting form
  pulls a VOD out of the class grouping entirely into its own **Spectator PoV** folder (shown first, above the
  class folders) - for wide-angle footage of a whole fight that is not really about whoever happened to post it.
  Posting a (non-spectator) VOD DMs whoever currently coaches that player's class - not the poster themselves if
  a coach posted it for their student, and not a guest coach, who can still see it but is not pinged about every
  upload the way a real guild-member coach is.
  Opening a VOD plays it with the normal YouTube controls, plus a **Fullscreen** button and a free-hand **drawing overlay** open to
  anyone watching, for a coach to sketch over the video while talking it through on Discord voice - nothing here is saved, it is for
  the moment only, unless it is turned into a **coaching point**: whoever can manage the VOD (its owner or their coach) can save the
  video's current position as a timestamped note, with whatever is currently drawn on it kept too, and how many seconds before and
  after that moment the marking should show for. Coaching points list down the side of the player, each one jumping straight to its
  timestamp and restoring its drawing when clicked - and during normal playback, a coaching point's drawing appears and disappears
  on its own as the video plays through its time window, without anyone needing to click anything. A note does not need a drawing
  attached at all; a plain timestamped reminder works just as well.
- **Proof of use**: an officer can mark any loot entry as confirmed (who confirmed it and when is remembered), for tracking whether a
  player actually showed proof the item was used for what it was given for. Click again to undo it if needed.
- A person's officer status is checked every time they sign in; sessions last 7 days. Remove someone's role and they lose the
  officer tools at their next sign-in.
- If a message cannot be delivered (DMs closed) the event page shows who did not get it.
- The bot also sends a message to a player when the leadership approves or rejects one of their changes or requests.
- **Switching from passcodes to Discord:** characters created before belong to a plain name. Once those players have signed in
  once, open Admin > *Link old characters to Discord players* and pick the right person for each name.
- `PUBLIC_URL` has to be an address that your players can open. On the internet use `https://` (a reverse proxy such as
  Caddy, or a tunnel such as Cloudflare Tunnel, does that for you).
- Trying the demo later? `start-demo.bat` always uses the demo mode, whatever is in `.env`.

## Shotcaller (optional)

A live control panel for a separate, self-hosted [Shotcaller](https://github.com/websiteinsanity-create/shotcallerbot)
Discord bot (voice-session start, mute, stop, and dedicated/extra caller management). Officers get a **Shotcaller**
page in the nav once it's set up, including a Start dialog that can pick the voice channel, party count (or match
an event's or preset's line-up, renaming the created channels to each party's leader), and dedicated caller - or a
session can still be started the usual way, with `/shotcaller start` in Discord.

Parties also get a **placeholder** flag (in each party's "..." menu on the Parties/board pages - a party with 3 or
fewer members counts as one automatically too, unless an officer overrides that for that party either way), and
events/recurring events get an "Also start Shotcaller when posting this event's parties to Discord" checkbox
that pre-ticks the same option in the Post-to-Discord dialog (still changeable there each time). When that
option is on, every party with more than 3 members needs a leader before the post goes through - posting is
blocked entirely until that's fixed, with the exception of any party flagged as a placeholder. An already-running
Shotcaller session is stopped and replaced automatically; the Discord post itself always goes through even if
Shotcaller then fails to start, which is reported separately.

Placeholder parties are skipped by Shotcaller entirely - no voice channel is created for them, and they don't
count toward the bot's 12-party limit - whether starting from the Post-to-Discord dialog, the Shotcaller page's
own Start dialog matched to an event or preset, or from the automatic 3-or-fewer rule. A party only stops being
a placeholder once it's unmarked (party menu > "Unmark as placeholder"), even if it still has 3 or fewer members.
The one party that's never skipped is whichever voice channel you pick yourself as "Party 1" - it's an existing
channel you chose, not one Shotcaller has to decide whether to create, so it always counts and is never renamed,
regardless of its own member count or placeholder flag.

The picture posted to Discord (and each mercenary's individual DM picture) only draws members who have actually
confirmed for that event - RSVP'd "yes", or a mercenary, same rule the live Parties board uses - as real rows.
Anyone else still sitting in a preset's party slot shows up instead in a small "Not confirmed: ..." line under
that party's card, so the line-up you post never implies someone is in when they haven't actually signed up.

Clicking **Post to Discord** now also checks that every non-placeholder party has a leader, independent of
whether "Also start Shotcaller" is ticked - if any don't, you get a confirmation prompt naming them before the
announcement goes out, instead of it posting silently with an unled party.

Starting a session can legitimately take a while - the bot creates a new voice channel and logs in a relay bot
for each party, one at a time - so starting (unlike the other quick status/mute/stop calls) gives it up to 45
seconds before Guild Hall reports it as unreachable. The Start dialog closes the moment you click Start rather
than sitting there for that whole stretch, and the Shotcaller page itself shows a "Starting…" state until the
bot answers either way.

1. Set up Shotcaller itself (its own repo, its own `docker-compose.yml`) and generate a shared secret for it:
   `openssl rand -hex 32`. Put that value in Shotcaller's own `CONTROL_API_KEY`.
2. In Guild Hall's `.env`, set:
   - `SHOTCALLER_URL` - where Guild Hall can reach the bot's control API. If Shotcaller runs with
     `network_mode: host` and Guild Hall runs on the normal Docker network (the default here), that's
     `http://host.docker.internal:<port>`, where `<port>` is whatever the bot's health server listens on. The
     provided `docker-compose.yml` already adds the `extra_hosts` entry Guild Hall needs to resolve that hostname.
   - `SHOTCALLER_API_KEY` - the exact same value as Shotcaller's `CONTROL_API_KEY`.
   - `DISCORD_GUILD_ID` (already set for Discord sign-in) is reused - Shotcaller only ever runs on that same server.
3. In Admin > Shotcaller, tick which players can be picked as the dedicated or extra caller(s) - only players who
   have signed in to Guild Hall at least once can be picked.

## Quick start on your own PC

1. Install Node.js (LTS) from https://nodejs.org. On Windows 10/11 you can also run
   `winget install OpenJS.NodeJS.LTS` in a terminal.
2. Unzip this folder anywhere.
3. **Try it first:** double-click `start-demo.bat` (Windows) or run `bash start-demo.sh`
   (Mac/Linux). It loads a fake guild into `demo-data/` and opens your browser. Sign in with any
   name (sign in as `Ash` to see a leader's own tasks); passcode `officer` gives officer tools, `guild` is a normal member. Delete `demo-data/`
   to reset.
4. **Real use:** set up Discord sign-in (section above), then double-click `start.bat`. Your data goes in `data/`.
   (Without a `.env` file `start.bat` still runs in the passcode demo mode.)

Others on your home network can open `http://YOUR-PC-IP:3000` while it runs (Windows may ask
to allow it through the firewall).

## Run it (any platform)

```bash
MEMBER_PASSCODE=your-guild-code OFFICER_PASSCODE=your-officer-code node server.js
# open http://localhost:3000
```

Or with Docker: create the `.env` file (see *Discord setup*), then `docker compose up -d`.

With Discord set up, everyone signs in with **Sign in with Discord**. Without it (demo mode) people use a display
name plus the shared passcodes above, and characters are linked to the display name.

Data lives in `data/db.json` (set `DATA_DIR` to move it). Back that folder up, or use
Admin > Download backup.

## Hosting for your guild

- **Home PC / Raspberry Pi**: run it and share your LAN or a tunnel (Tailscale, Cloudflare Tunnel).
- **Small VPS or PaaS** (Fly.io, Railway, Render, any $5 VPS): use the Dockerfile and mount a
  volume at `/data`.
- Put it behind HTTPS (Caddy, nginx, or your host's built-in TLS). Passcodes travel in the login
  request, so don't expose it over plain HTTP on the internet.

### Test run on your own Linux server (no Windows needed)

The app is plain Node.js (version 18 or newer, no other software), so it runs the same on Linux, macOS and Windows. The Windows `.bat`
files are only shortcuts; on a server you use the commands below. Everything in this project was developed and tested on Linux.
The steps, on Debian or Ubuntu:

1. **Node.js**: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git`
2. **Copy the app** to `/opt/guild-hall` (unzip the download there, or `git clone` your GitHub repository) and create the settings:
   `cd /opt/guild-hall && cp .env.example .env && nano .env`. Set `PUBLIC_URL` to the address your players will open, plus the `DISCORD_*` values.
3. **Test the Discord setup before starting anything**: `node check-discord.js` (see "Testing your bot").
4. **First try, by hand**: `node server.js`, then open the address in a browser. Stop with Ctrl+C.
5. **Make it a service that starts by itself and restarts after a crash**: copy `deploy/guild-hall.service` to `/etc/systemd/system/`, create its
   user (the command is written in the file), `sudo systemctl daemon-reload && sudo systemctl enable --now guild-hall`.
   Logs: `journalctl -u guild-hall -f`. The data is in `/var/lib/guild-hall` (that is the folder to back up).
6. **HTTPS**: install Caddy (`sudo apt install caddy`), put `deploy/Caddyfile` in `/etc/caddy/` with your domain, `sudo systemctl reload caddy`.
   Open ports 80 and 443 in the firewall and keep port 3000 closed (the service file already makes the app listen on this machine only).
7. **Discord Developer Portal**: the redirect must be exactly `https://your-domain/auth/discord/callback`.

Docker instead: create `.env`, then `docker compose up -d` (see `docker-compose.yml`; builds the image locally by
default, the data goes into `/opt/persistent_volume/guildhub/data` on the host, and there is a `/health` endpoint
the container's healthcheck uses).

**Test-run checklist** (about 30 minutes with two people):
- [ ] `node check-discord.js` shows no FAIL, including a test picture and a direct message.
- [ ] You can sign in with Discord and you are an officer (Admin is in the menu). A second person can sign in as a normal member.
- [ ] Admin > Discord > *Check the connection* is all green; pick the party channel and send the test message.
- [ ] Create a character each, an event that starts in a few minutes, and sign up. Let the leader receive the PIN by Discord and enter it as the other person: the event turns green.
- [ ] Build parties and press *Post to Discord*: the picture and text arrive in the channel.
- [ ] Try a recurring event, a leave of absence, a request and a login notice to one player.
- [ ] Restart (`sudo systemctl restart guild-hall`): everything is still there. Download a backup in Admin and look at the file.
- [ ] Sign out, then open the address on your phone.

**Before real players come in:** without the `DISCORD_*` settings the app runs in demo mode with the shared passcodes `guild` and `officer`.
That is fine on your own PC, never on the internet. Check the start-up log: it must say `Sign-in: Discord`. Also keep `.env` private (it holds the
bot token), and update by hand with `git pull && sudo systemctl restart guild-hall` (the automatic update option is meant for the start scripts, not for systemd).

## Put it on GitHub (with automatic updates)

The project is ready to be a GitHub repository. Every push runs the tests, and every push to `main` that
passes also builds a Docker image and publishes it to GitHub's container registry (`.github/workflows/ci.yml`).

**1. Create the repository** (once)

- Windows: install [Git](https://git-scm.com/download/win) and the [GitHub CLI](https://cli.github.com/), run
  `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then
  double-click `setup-github.bat`. On Mac/Linux run `bash setup-github.sh`.
- Or by hand: create an empty private repository on github.com, then in this folder:
  `git init -b main`, `git add -A`, `git commit -m "Guild Hall"`,
  `git remote add origin https://github.com/YOU/guild-hall.git`, `git push -u origin main`.

Your guild's data (`data/`) and your secrets (`.env`) are never committed. `.gitignore` keeps them out.

**2. Change code, push, done.** Edit files, then `git add -A && git commit -m "what you changed" && git push`.
GitHub runs the tests (Actions tab). If they fail you get an email and the image is not published.

**3. Make your running copy update itself**, pick one:

- *Start scripts (`start.bat` / `start.sh`)*: if the folder came from GitHub (`git clone`), the server checks
  every 5 minutes for new commits. When it finds some it stops, the script runs `git pull`, and starts it
  again. Nothing needs to be reachable from the internet. Change `AUTO_UPDATE_MINUTES` to check more or less
  often, or set it to 0 to turn it off. Uses `git pull --ff-only`, so if you edited files on the server
  itself and they clash, the update is refused instead of overwriting your work.
- *Docker*: `docker-compose.yml` builds the image locally by default (Option A), which never auto-updates itself -
  you `git pull && docker compose up -d --build` when you want the new code. Switching to Option B (the commented-out
  `image: ghcr.io/YOUR-GITHUB-NAME/guild-hall:latest` line, with your GitHub name lower case) pulls the image GitHub
  already built instead of building locally, but this compose file does not include Watchtower or any other
  auto-updater, so you still update it yourself with `docker compose pull && docker compose up -d` whenever you
  want the newer image. Add your own Watchtower (or similar) service if you want that step to happen on its own.

The first time, GitHub may keep the published image private. That is fine for `docker login ghcr.io`, or set
the package to public under your profile's Packages.

### If the container crash-loops with "Cannot find module '/app/server.js'"

The image built, but `server.js` never made it into it. Two causes, in order of likelihood:

1. **The build context was missing the source.** `docker-compose.yml`'s default (option A) builds from the
   folder the compose file is in. If that folder only has `docker-compose.yml` and `.env` - for example a slim
   deploy folder copied from a server that otherwise uses the prebuilt image - there is nothing to copy in.
   Fix: either put the full source next to `docker-compose.yml` (the whole unzipped/cloned `guild-hall` folder),
   or switch to option B (the commented-out `image: ghcr.io/...` line), which needs no source at all.
2. **An old, broken image is cached under the `guild-hall:latest` tag** from an earlier attempt, and
   `docker compose up -d` reused it instead of rebuilding. Fix: force a rebuild once with
   `docker compose up -d --build` (or `docker compose build --no-cache` first).

Since this version, `docker build` fails loudly with a clear message the moment this happens, instead of
producing an image that starts and then crash-loops - so a plain `docker compose up -d --build` now tells you
straight away if the context is wrong, rather than leaving you to read the runtime error.

## Tests

`npm test` starts the real server on a random port and checks logins, permissions, attendance and points,
loot, the loot rules, party presets and backup/restore. A second test file starts a **fake Discord** and checks
the Discord sign-in, the attendance PIN (who receives it, the window, the lock after wrong tries) and the reminders.
GitHub runs the same command.

## Good to know

- **Weapons and class names**: the Gauntlet (from "The Frozen Divide", June 2026) is in the weapon list, with the class names Mauler
  (Gauntlet + Greatsword), Soulcrusher (+ Orb), Archon (+ Staff), Destroyer (+ Spear), Mobilist (+ Longbow), Predator (+ Daggers) and
  Shrike (+ Crossbow), taken from Questlog. **Two Gauntlet pairs have no name yet in this list**: Gauntlet + Sword & Shield and
  Gauntlet + Wand & Tome. They work anyway (the weapons are shown instead of a class name). To add a name, put one line into the
  `classes` list in `config.json`, for example `{ "name": "Name", "weapons": ["Gauntlet", "Sword & Shield"] }`, and restart.
- **Questlog links** are shown to the leadership (a dropdown in the Member list) and to the owner of the character, not to other members.
- **Restoring a backup** now brings back everything (recurring events, tags, requests, profiles, notices, the info section, leave, warnings...).
  Older versions only restored the original data and dropped the rest, so do not rely on a backup made before this version for those parts.

- **Upgrading**: existing data is converted automatically (a single Questlog link becomes a list, characters get an empty
  build list). Make a backup first (Admin > Download backup), as always.
- **Upgrading from before "one character per player"**: existing data is left exactly as it was - nobody loses a character
  automatically. Going forward, nobody can create a second one. The server can still find and clean up anyone who already
  had more than one (keeping their oldest, the same safe way a normal delete works - out of every party, loot entry,
  points entry and sign-up), but this is no longer a button in Admin, since most guilds only need it once. Ask if you
  ever need it run again - a backup first, as always with anything that deletes data.
- **Approvals cannot be dodged by re-creating a character** if you also switch on "Adding a new character": new
  characters then wait, hidden from other players, until approved.
- **Pictures**: PNG, JPEG, GIF or WebP only (no SVG, because SVG can carry scripts). They are stored in `data/uploads/`
  and are part of your data folder, so back that up too (the JSON backup does not contain pictures).
- **Recurring events and per-date edits**: editing the series overwrites edits you made to single upcoming dates.
  Past dates are never changed.
- Time zones for recurring events use the names from `timezones` in `config.json`; add any name from the IANA list.

## Making it yours

| Want to change | Edit |
| --- | --- |
| Loot rules (`lootWindowDays`, `lootThresholdPercent`, `lootBands`, `lootItemDays` are the starting values; officers change them live), time zones and default zone (`timezones`, `defaultTimezone`), how far ahead recurring dates are created (`recurrenceHorizonDays`), PvE/PvP modes (`buildModes`), request kinds, what can need approval (`approvalGroups`, with the starting default), the sections that can be hidden (`sections`), class names per weapon pair (`classes`), weapon list, week start (`weekStartsOn`), guild name, guild cap, which ranks count as leadership, roles, weapons, ranks, event types, default points, party size | `config.json` (restart after) |
| Colors and fonts | CSS variables at the top of `public/index.html`. The brand colour is RAL 470-5 (`--accent: #ac2d4c`); role colours follow the order of `roles` in `config.json` |
| Rules (who can do what, validation, new fields) | `server.js`, the `pickMember` / `pickEvent` functions and the routes |
| Screens | `public/index.html`, one `view...` function per page |

Ideas that fit the existing structure: a loot-council log (another array in `db.json`, a route or
two, one new view), Discord webhook posts when an event is created (a `fetch` call inside the
`POST /api/events` route), per-event role requirements, or per-event role requirements.

## Security notes

Sign-in goes through Discord and only members of your server get in. Sessions are signed cookies (7 days,
`HttpOnly`, `SameSite=Lax`, `Secure` on https), requests that another website could trigger are rejected, and
officer-only routes protect everything destructive. Attendance PINs never reach players' browsers; a player only
sees whether the PIN window is open. To sign everybody out, delete `data/secret.txt` and restart.

Demo mode (no Discord settings) uses two shared passcodes (`guild` / `officer`) and is meant for your own PC only.
