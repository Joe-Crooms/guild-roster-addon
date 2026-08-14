# Guild Roster Logger

WoW 3.3.5a addon that logs guild roster changes (joins/leaves/rank changes)
and, for raids where more than half the group is guild members, raid
attendance and loot. Built for Guardians of Justice.

This repo is just the distribution copy the addon auto-updates itself from -
day-to-day development happens in a private companion repo that also runs
the Supabase import pipeline.

## Installing (for officers)

1. Download [install-addon-updater.bat](https://raw.githubusercontent.com/Joe-Crooms/guild-roster-addon/main/install-addon-updater.bat)
   and [update-addon.vbs](https://raw.githubusercontent.com/Joe-Crooms/guild-roster-addon/main/update-addon.vbs)
   into the same folder anywhere on your PC (e.g. Desktop).
2. Double-click `install-addon-updater.bat`. If it says "Access is denied",
   right-click it and choose **Run as administrator**.
3. It'll ask once for your WoW AddOns folder - that's the `Interface\AddOns`
   folder inside your WoW install, e.g.
   `C:\Games\World of Warcraft 3.3.5a\Interface\AddOns`.
4. In-game, at character select: AddOns -> make sure **GuildRosterLogger**
   is checked on.

That's it. From then on, it silently checks for updates every time you log
into Windows and applies them automatically (pick them up in-game with
`/reload`) - nothing to remember, nothing to reinstall.

To stop auto-updates later, run `uninstall-addon-updater.bat`.

## What data this collects

The addon only ever logs data while you're actually in Guardians of Justice
(checked live, not cached) - if a character transfers to another guild it
stops contributing data automatically. Raid tracking only kicks in for
raids where over half the group is verified guild members, so pugs and
other guilds' runs aren't logged.
