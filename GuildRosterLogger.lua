-- GuildRosterLogger.lua
--
-- Watches the guild roster while you're logged in and records:
--   - new members joining
--   - members leaving (dropping off the roster)
--   - members rejoining after having left
--   - rank changes (promotions/demotions)
--   - each member's current guild note and officer note
--
-- Each event is appended to GuildRosterLoggerDB.changeLog as a simple
-- pipe-delimited string: "YYYY-MM-DD|CharacterName|event|detail"
-- Deliberately flat/simple (not nested Lua tables) so it's trivial to parse
-- back out of the SavedVariables file later without needing a full Lua
-- parser.
--
-- Guild/officer notes aren't logged as change events (too noisy, and we
-- only care about the current text) — GuildRosterLoggerDB.members[name].note
-- and .officernote just always hold the latest value seen, refreshed on
-- every roster snapshot. This is the only source for notes at all, since
-- Warmane's armory API doesn't expose them.
--
-- A note on "Show Offline Members": the server only sends offline members'
-- roster data when SetGuildRosterShowOffline(true) is set, and that flag is
-- shared with the Blizzard guild UI's own "Show Offline Members" checkbox.
-- We need it on briefly to get a complete roster, but we deliberately only
-- flip it on for one-off syncs (login, /grlog) and revert it right after —
-- earlier versions of this addon forced it on every single roster update,
-- which fought the checkbox and made it impossible to uncheck.
--
-- Whenever a join/leave/rejoin is detected, the addon automatically schedules
-- a full offline-inclusive resync a few seconds later (AUTO_SYNC_DELAY) —
-- the same thing /grlog does by hand. That catches members who were simply
-- offline (rather than truly gone) once their data actually arrives, and
-- refreshes notes/ranks right when membership changes instead of waiting for
-- the next login. The delay is just a debounce so a burst of roster events
-- (e.g. several people joining at once) triggers one resync, not several.
--
-- Commands:
--   /grlog        - force an immediate full roster sync (including offline members)
--
--
-- Raid attendance & loot tracking
--
-- While you're in a raid group, this addon automatically logs who's in the
-- raid and what loot drops — no manual command needed. It hooks
-- RAID_ROSTER_UPDATE (fires on any raid roster change, available to any
-- raid member, not just the leader) to detect the raid forming (0 -> N
-- members, which opens a new session) and disbanding (N -> 0, which closes
-- it), and diffs the roster on every update to catch individual joins and
-- leaves mid-raid.
--
-- Each raid gets a session ID: the timestamp it started, as YYYYMMDDHHMMSS.
-- Events are appended to GuildRosterLoggerDB.raidLog as pipe-delimited
-- strings: "YYYY-MM-DD HH:MM:SS|sessionId|event|CharacterName|detail"
-- where event is one of: raid_start, raid_join, raid_leave, raid_loot, raid_end.
-- (raid_start/raid_end use "-" for CharacterName and put the zone in detail.)
--
-- Loot is captured via CHAT_MSG_LOOT — under Group Loot/Need Before
-- Greed/Round Robin the server broadcasts a "<Name> receives loot: [Item]."
-- message to the whole raid, which is how we see everyone's loot, not just
-- our own. Only logged while a raid session is active, and filtered to rare
-- quality (blue) and above by default (MIN_LOOT_QUALITY) to skip vendor
-- trash/reagents.
--
-- Caveat: this only sees what YOU (the addon holder) see. If you leave the
-- raid before it actually disbands, the session ends from the addon's
-- perspective even though the raid continues without you.

local ADDON_NAME = "GuildRosterLogger"

-- Only Guardians of Justice's data should ever reach Supabase. If whoever
-- has this addon installed leaves/transfers to a different guild,
-- IsInGuild() alone would still be true (just for the wrong guild) - so
-- everything (roster snapshots AND raid tracking) is gated on actually
-- being in THIS guild, not just "a" guild. Tracking simply goes dormant for
-- that character until they're back in the right one.
local EXPECTED_GUILD_NAME = "Guardians of Justice"
local warnedWrongGuild = false

local function IsTrackedGuild()
    if not IsInGuild() then
        return false
    end
    local guildName = GetGuildInfo("player")
    if guildName ~= EXPECTED_GUILD_NAME then
        if not warnedWrongGuild then
            warnedWrongGuild = true
            print(string.format(
                "|cff33ff99GuildRosterLogger:|r Not tracking - you're in \"%s\", not \"%s\".",
                tostring(guildName), EXPECTED_GUILD_NAME))
        end
        return false
    end
    return true
end

local pendingOfflineRevert = false

-- Loot quality filter: 0=poor 1=common 2=uncommon 3=rare 4=epic 5=legendary
local MIN_LOOT_QUALITY = 3

-- Standard WoW item-quality hex colors, as they appear in item links.
local QUALITY_BY_COLOR = {
    ["|cff9d9d9d"] = 0, -- poor
    ["|cffffffff"] = 1, -- common
    ["|cff1eff00"] = 2, -- uncommon
    ["|cff0070dd"] = 3, -- rare
    ["|cffa335ee"] = 4, -- epic
    ["|cffff8000"] = 5, -- legendary
    ["|cffe6cc80"] = 5, -- heirloom/artifact (treated as top-tier)
}

local function InitDB()
    GuildRosterLoggerDB = GuildRosterLoggerDB or {}
    GuildRosterLoggerDB.members = GuildRosterLoggerDB.members or {}
    GuildRosterLoggerDB.changeLog = GuildRosterLoggerDB.changeLog or {}
    GuildRosterLoggerDB.raidLog = GuildRosterLoggerDB.raidLog or {}
    -- GuildRosterLoggerDB.currentRaidSession is intentionally left alone
    -- here — if a raid was in progress when the game closed, we want it to
    -- persist so SyncRaidRoster() can pick up where it left off (or cleanly
    -- close it out) on next login.
end

local function LogEvent(name, event, detail)
    local entry = string.format("%s|%s|%s|%s", date("%Y-%m-%d %H:%M:%S"), name, event, detail or "")
    table.insert(GuildRosterLoggerDB.changeLog, entry)
end

-- Reads whatever roster data is currently cached and diffs it against what
-- we've seen before. Deliberately does NOT touch SetGuildRosterShowOffline
-- here — see note above.
-- Returns true if a joined/rejoined/left event was logged this pass, so the
-- caller can decide whether membership actually changed (as opposed to this
-- just being a rank/note refresh with nobody arriving or leaving).
local function TakeSnapshot()
    if not IsTrackedGuild() then
        return false
    end

    local numMembers = GetNumGuildMembers(true)
    local currentNames = {}
    local membershipChanged = false

    for i = 1, numMembers do
        local name, rank, _, _, _, _, note, officernote = GetGuildRosterInfo(i)
        if name then
            currentNames[name] = true
            local existing = GuildRosterLoggerDB.members[name]

            if not existing then
                GuildRosterLoggerDB.members[name] = { rank = rank, status = "active", note = note, officernote = officernote }
                LogEvent(name, "joined", rank)
                membershipChanged = true
            else
                if existing.status == "left" then
                    LogEvent(name, "rejoined", rank)
                    membershipChanged = true
                elseif existing.rank ~= rank then
                    LogEvent(name, "rank_change", existing.rank .. "->" .. rank)
                end
                existing.rank = rank
                existing.status = "active"
                existing.note = note
                existing.officernote = officernote
            end
        end
    end

    for name, data in pairs(GuildRosterLoggerDB.members) do
        if data.status == "active" and not currentNames[name] then
            data.status = "left"
            LogEvent(name, "left", data.rank)
            membershipChanged = true
        end
    end

    return membershipChanged
end

-- Forces a one-time full roster fetch (including offline members) then
-- reverts the "Show Offline Members" flag back off once the data arrives,
-- so we don't leave the player's guild UI stuck showing offline members.
local function RequestFullSync()
    if not IsTrackedGuild() then
        return
    end
    SetGuildRosterShowOffline(true)
    pendingOfflineRevert = true
    GuildRoster()
end

-- Seconds to wait after a detected join/leave before doing the automatic
-- full resync. 3.3.5a has no C_Timer, so this is a plain elapsed-time
-- countdown driven by an OnUpdate script (only attached while a resync is
-- actually pending, so it costs nothing the rest of the time).
local AUTO_SYNC_DELAY = 5
local autoSyncCountdown = nil

-- Debounced: called every time TakeSnapshot() sees a join/rejoin/leave.
-- Restarts the countdown on each call so a burst of roster events (a bunch
-- of people logging in at once, etc.) still only triggers one resync, once
-- things settle down.
local function ScheduleAutoFullSync(triggerFrame)
    autoSyncCountdown = AUTO_SYNC_DELAY
    triggerFrame:SetScript("OnUpdate", function(self, elapsed)
        autoSyncCountdown = autoSyncCountdown - elapsed
        if autoSyncCountdown <= 0 then
            self:SetScript("OnUpdate", nil)
            autoSyncCountdown = nil
            RequestFullSync()
        end
    end)
end

-- ============================================================
-- Raid attendance & loot tracking
-- ============================================================

local function LogRaidEvent(sessionId, event, name, detail)
    local entry = string.format("%s|%s|%s|%s|%s", date("%Y-%m-%d %H:%M:%S"), sessionId, event, name or "-", detail or "")
    table.insert(GuildRosterLoggerDB.raidLog, entry)
end

-- A raid only counts as "ours" to log if more than this fraction of the
-- group is actually in the guild - keeps pugs, and guild members tagging
-- along with some other guild's run, out of the raid log entirely.
local GUILD_RAID_THRESHOLD = 0.5

-- Returns: set of names in the raid, total count, and how many of them are
-- currently in Guardians of Justice (checked live via GetGuildInfo on each
-- raid unit token, same source of truth as IsTrackedGuild() uses for the
-- player, rather than trusting our own possibly-stale roster snapshot).
local function GetRaidMemberSet()
    local set = {}
    local n = GetNumRaidMembers()
    local guildCount = 0
    for i = 1, n do
        local name = GetRaidRosterInfo(i)
        if name then
            set[name] = true
            if GetGuildInfo("raid" .. i) == EXPECTED_GUILD_NAME then
                guildCount = guildCount + 1
            end
        end
    end
    return set, n, guildCount
end

local function StartRaidSession()
    local id = date("%Y%m%d%H%M%S")
    local zone = GetRealZoneText()
    if not zone or zone == "" then
        zone = "Unknown"
    end
    GuildRosterLoggerDB.currentRaidSession = { id = id, zone = zone, members = {} }
    LogRaidEvent(id, "raid_start", "-", zone)
end

local function EndRaidSession()
    local session = GuildRosterLoggerDB.currentRaidSession
    if not session then
        return
    end
    -- Close out anyone still marked present so every join has a matching
    -- leave, even if the raid disbanded (or we left) without them getting
    -- an individual RAID_ROSTER_UPDATE removal first.
    for name in pairs(session.members) do
        LogRaidEvent(session.id, "raid_leave", name, "")
    end
    LogRaidEvent(session.id, "raid_end", "-", session.zone)
    GuildRosterLoggerDB.currentRaidSession = nil
end

-- Ask before logging a brand-new raid. nil = undecided, true/false = answered
-- for the raid currently forming. Reset whenever the raid ends (or stops
-- qualifying) so the next one asks again.
--
-- Note: this choice lives in memory only, not SavedVariables - a /reload
-- while still sitting in a raid you said "No" to will ask again, rather
-- than silently staying opted out forever.
local raidConsent = nil
local raidConsentPopupShown = false

-- Forward-declared so OnAccept below (defined before SyncRaidRoster's body)
-- closes over this same local rather than falling back to a global lookup.
local SyncRaidRoster

StaticPopupDialogs["GRL_RAID_CONSENT"] = {
    text = "GuildRosterLogger: record this raid's attendance and loot for the guild?",
    button1 = YES,
    button2 = NO,
    OnAccept = function()
        raidConsent = true
        raidConsentPopupShown = false
        SyncRaidRoster()
    end,
    OnCancel = function()
        raidConsent = false
        raidConsentPopupShown = false
    end,
    timeout = 0,
    whileDead = true,
    hideOnEscape = true,
    preferredIndex = 3,
}

-- Diffs the current raid roster against the active session's last-known
-- roster to detect joins/leaves, and opens/closes the session itself on the
-- 0<->N transitions. Safe to call on every RAID_ROSTER_UPDATE, and also on
-- login/reload to pick up (or cleanly close) a session that was already in
-- progress.
SyncRaidRoster = function()
    if not IsTrackedGuild() then
        -- Not in Guardians of Justice - if we happen to have a session open
        -- from before a guild change, close it out cleanly rather than
        -- leaving it dangling; otherwise just stay dormant.
        if GuildRosterLoggerDB.currentRaidSession then
            EndRaidSession()
        end
        raidConsent = nil
        raidConsentPopupShown = false
        return
    end

    local current, n, guildCount = GetRaidMemberSet()

    -- Require a strict majority of the raid to be verified guild members
    -- before we count it as "ours" - filters out pugs and guildies tagging
    -- along on someone else's run. Also covers n == 0 (empty raid).
    local isGuildRaid = n > 0 and (guildCount / n > GUILD_RAID_THRESHOLD)

    if not isGuildRaid then
        if GuildRosterLoggerDB.currentRaidSession then
            EndRaidSession()
        end
        -- Raid's over (or no longer qualifies) - next one starts fresh and
        -- asks again.
        raidConsent = nil
        raidConsentPopupShown = false
        return
    end

    if not GuildRosterLoggerDB.currentRaidSession then
        -- Brand new raid forming - ask before logging anything about it. A
        -- session already in progress (this login, or carried over across a
        -- /reload) is never re-asked about; only a fresh one is.
        if raidConsent == nil then
            if not raidConsentPopupShown then
                raidConsentPopupShown = true
                StaticPopup_Show("GRL_RAID_CONSENT")
            end
            return
        end
        if raidConsent == false then
            return
        end
        StartRaidSession()
    end

    local session = GuildRosterLoggerDB.currentRaidSession

    for name in pairs(current) do
        if not session.members[name] then
            session.members[name] = true
            LogRaidEvent(session.id, "raid_join", name, "")
        end
    end

    for name in pairs(session.members) do
        if not current[name] then
            session.members[name] = nil
            LogRaidEvent(session.id, "raid_leave", name, "")
        end
    end
end

-- Turns a Blizzard format string like "%s receives loot: %s." into a Lua
-- pattern, substituting each %s with the given capture group in order
-- (first-seen %s gets captures[1], etc). Keeps loot parsing correct even if
-- the exact wording differs by client/locale, since it's built from the
-- client's own global strings rather than hardcoded English text.
local function BuildPattern(fmt, captures)
    if not fmt then
        return nil
    end
    local i = 0
    local pattern = fmt:gsub("%%s", function()
        i = i + 1
        return captures[i] or "(.+)"
    end)
    return pattern
end

-- LOOT_ITEM_SELF = "You receive loot: %s."      (one capture: the item)
-- LOOT_ITEM      = "%s receives loot: %s."       (two captures: name, item)
-- Non-greedy on the name capture so it stops at the first " receives loot: "
-- rather than swallowing into the item text.
local LOOT_SELF_PATTERN = BuildPattern(LOOT_ITEM_SELF, { "(.+)" })
local LOOT_OTHER_PATTERN = BuildPattern(LOOT_ITEM, { "(.-)", "(.+)" })

-- Pulls the item ID, name, and quality color out of an item hyperlink like
-- "|cff0070dd|Hitem:12345:0:0:0:0:0:0:0:80:0:0:0|h[Item Name]|h|r".
local function ParseItemLink(text)
    local color, itemId, name = text:match("(|c%x%x%x%x%x%x%x%x)|Hitem:(%d+):[^|]*|h%[(.-)%]|h|r")
    if not itemId then
        return nil
    end
    return tonumber(itemId), name, color
end

local function HandleLootMessage(msg)
    local session = GuildRosterLoggerDB.currentRaidSession
    if not session then
        return
    end

    local winner, itemText

    if LOOT_SELF_PATTERN then
        local selfItem = msg:match(LOOT_SELF_PATTERN)
        if selfItem then
            winner = UnitName("player")
            itemText = selfItem
        end
    end

    if not winner and LOOT_OTHER_PATTERN then
        local otherName, otherItem = msg:match(LOOT_OTHER_PATTERN)
        if otherName then
            winner = otherName
            itemText = otherItem
        end
    end

    if not winner or not itemText then
        return
    end

    local itemId, itemName, color = ParseItemLink(itemText)
    if not itemId then
        return
    end

    local quality = QUALITY_BY_COLOR[color]
    if not quality or quality < MIN_LOOT_QUALITY then
        return
    end

    LogRaidEvent(session.id, "raid_loot", winner, itemId .. ":" .. itemName .. ":" .. quality)
end

-- ============================================================

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("GUILD_ROSTER_UPDATE")
frame:RegisterEvent("RAID_ROSTER_UPDATE")
frame:RegisterEvent("CHAT_MSG_LOOT")

frame:SetScript("OnEvent", function(self, event, arg1)
    if event == "ADDON_LOADED" then
        if arg1 == ADDON_NAME then
            InitDB()
        end
    elseif event == "PLAYER_LOGIN" then
        if IsInGuild() then
            RequestFullSync()
        end
    elseif event == "PLAYER_ENTERING_WORLD" then
        -- Picks up a raid already in progress (e.g. addon reloaded mid-raid),
        -- or cleanly closes out a stale session left open by a crash/DC.
        SyncRaidRoster()
    elseif event == "GUILD_ROSTER_UPDATE" then
        local membershipChanged = TakeSnapshot()
        if pendingOfflineRevert then
            -- This update is the response to our own full sync (manual
            -- /grlog or an automatic one below) - just revert the offline
            -- flag. Don't reschedule another auto-sync from our own sync.
            pendingOfflineRevert = false
            SetGuildRosterShowOffline(false)
        elseif membershipChanged then
            -- Someone joined/rejoined/left based on whatever's currently
            -- cached (which may only be online members). Schedule a full
            -- offline-inclusive resync shortly to confirm it and pick up
            -- fresh notes/ranks, same as running /grlog by hand.
            ScheduleAutoFullSync(self)
        end
    elseif event == "RAID_ROSTER_UPDATE" then
        SyncRaidRoster()
    elseif event == "CHAT_MSG_LOOT" then
        HandleLootMessage(arg1)
    end
end)

SLASH_GRLOG1 = "/grlog"
SlashCmdList["GRLOG"] = function()
    RequestFullSync()
    print("|cff33ff99GuildRosterLogger:|r Requested a full roster sync (including offline members). It'll be logged as soon as the server responds.")
end
