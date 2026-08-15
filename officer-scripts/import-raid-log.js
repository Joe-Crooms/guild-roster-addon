// import-raid-log.js
//
// Imports raid attendance + loot events logged by GuildRosterLogger.lua's
// automatic RAID_ROSTER_UPDATE / CHAT_MSG_LOOT hooks, straight from its
// SavedVariables file — same approach as import-grl-log.js.
//
// The addon logs each raid event as a plain string:
//   "YYYY-MM-DD HH:MM:SS|sessionId|event|CharacterName|detail"
// where event is one of: raid_start, raid_join, raid_leave, raid_loot, raid_end.
// e.g. "2026-08-11 20:03:15|20260811200315|raid_start|-|Icecrown Citadel"
//      "2026-08-11 20:04:02|20260811200315|raid_join|Autumnlily|"
//      "2026-08-11 21:15:40|20260811200315|raid_loot|Corran|49623:Muradin's Spyglass:4"
//
// This script pulls every matching string out of the file with a regex (see
// import-grl-log.js for why: deliberately not a full Lua parser), then:
//   - builds one raid_sessions row per sessionId (start/end/zone)
//   - collapses each character's raid_join/raid_leave pairs within a
//     session into one raid_attendance row (first joined_at, last left_at,
//     total seconds_present — handles someone DCing and rejoining mid-raid)
//   - inserts one raid_loot row per raid_loot event
//
// Safe to re-run: sessions/attendance are upserted by their natural keys,
// and loot rows are skipped if their raw_entry was already imported.
//
// Usage:
//   node import-raid-log.js "C:\path\to\WTF\Account\ACCOUNTNAME\SavedVariables\GuildRosterLogger.lua"
//
// Required env vars: SUPABASE_URL, SUPABASE_KEY (service role key)

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { logSync } from "./sync-log.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const filePath = process.argv[2];

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_KEY");
  process.exit(1);
}
if (!filePath) {
  console.error("Usage: node import-raid-log.js path/to/GuildRosterLogger.lua");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Matches every quoted "YYYY-MM-DD HH:MM:SS|sessionId|event|name|detail"
// string anywhere in the file, same trick as import-grl-log.js's extractEvents.
function extractRaidEvents(content) {
  const matches = [...content.matchAll(/"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|[^"]*)"/g)];
  return matches.map((m) => {
    const [timestamp, sessionId, event, name, detail] = m[1].split("|");
    return { timestamp, sessionId, event, name, detail, raw: m[1] };
  });
}

// detail for raid_loot is "itemId:itemName:quality" — split on the first
// and last colon rather than all of them, since item names practically
// never contain a colon but could in principle.
function parseLootDetail(detail) {
  const first = detail.indexOf(":");
  const last = detail.lastIndexOf(":");
  if (first === -1 || last === first) return null;
  const itemId = parseInt(detail.slice(0, first), 10);
  const itemName = detail.slice(first + 1, last);
  const quality = parseInt(detail.slice(last + 1), 10);
  return { itemId: Number.isFinite(itemId) ? itemId : null, itemName, quality: Number.isFinite(quality) ? quality : null };
}

// Supabase's timestamptz columns want ISO 8601; the addon logs
// "YYYY-MM-DD HH:MM:SS" in the player's local time, so just swap the
// separator — no timezone conversion attempted (matches how the rest of
// this project treats dates as "local, at face value").
function toIso(timestamp) {
  return timestamp.replace(" ", "T");
}

async function main() {
  const content = fs.readFileSync(filePath, "utf-8");
  const events = extractRaidEvents(content);
  console.log(`Found ${events.length} logged raid events in ${filePath}`);

  if (!events.length) {
    console.log("No raid events to import.");
    await logSync(supabase, "import-raid-log", { success: true, summary: "No raid events found." });
    return;
  }

  // --- Sessions ---
  const sessionsById = new Map();
  for (const e of events) {
    let session = sessionsById.get(e.sessionId);
    if (!session) {
      session = { id: e.sessionId, zone: null, started_at: null, ended_at: null };
      sessionsById.set(e.sessionId, session);
    }
    if (e.event === "raid_start") {
      session.zone = e.detail || session.zone;
      session.started_at = toIso(e.timestamp);
    } else if (e.event === "raid_end") {
      session.ended_at = toIso(e.timestamp);
      if (!session.zone) session.zone = e.detail || session.zone;
    }
  }
  // A session with no raid_start line (e.g. log predates this feature, or
  // the file was trimmed) still gets a row so attendance/loot can point at
  // it — fall back to the earliest event timestamp we do have.
  for (const e of events) {
    const session = sessionsById.get(e.sessionId);
    if (!session.started_at || toIso(e.timestamp) < session.started_at) {
      session.started_at = session.started_at ?? toIso(e.timestamp);
    }
  }

  // --- Cross-observer session reconciliation ---
  // The addon generates sessionId locally per client (a timestamp captured
  // the moment THAT client sees raid roster go 0->N), so if two officers are
  // both watching the same real raid, their SavedVariables logs disagree on
  // the session id for it. Left alone that fragments attendance across two
  // "sessions" and double-imports loot (everyone in a raid sees the same
  // loot roll). Reconcile by treating any existing raid_sessions row in the
  // same zone, started within SESSION_MERGE_WINDOW_MS of this one, as the
  // same real raid, and remapping every event in this file onto its id
  // instead of minting a new session. Order-independent and idempotent:
  // whichever observer's data lands in the table first "wins" the canonical
  // id, and later imports (from any observer, including re-imports of the
  // same file) always resolve back onto it.
  const SESSION_MERGE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  const idRemap = new Map(); // local sessionId -> canonical sessionId
  const mergedSessions = new Map(); // canonical id -> merged {id, zone, started_at, ended_at}

  for (const s of sessionsById.values()) {
    let match = null;
    if (s.zone && s.started_at) {
      const lo = new Date(new Date(s.started_at).getTime() - SESSION_MERGE_WINDOW_MS).toISOString();
      const hi = new Date(new Date(s.started_at).getTime() + SESSION_MERGE_WINDOW_MS).toISOString();
      const { data, error } = await supabase
        .from("raid_sessions")
        .select("id, started_at, ended_at")
        .eq("zone", s.zone)
        .gte("started_at", lo)
        .lte("started_at", hi)
        .order("started_at", { ascending: true })
        .limit(1);
      if (error) throw error;
      match = data?.[0] ?? null;
    }

    const canonicalId = match?.id ?? s.id;
    idRemap.set(s.id, canonicalId);

    const base = mergedSessions.get(canonicalId) ?? {
      id: canonicalId,
      zone: s.zone,
      started_at: match?.started_at ?? s.started_at,
      ended_at: match?.ended_at ?? s.ended_at,
    };
    mergedSessions.set(canonicalId, {
      id: canonicalId,
      zone: base.zone ?? s.zone,
      started_at: [base.started_at, s.started_at].filter(Boolean).sort()[0] ?? null,
      ended_at: [base.ended_at, s.ended_at].filter(Boolean).sort().at(-1) ?? null,
    });
  }

  // Remap every event onto its canonical session id before doing anything
  // else — attendance/loot grouping below then just works, unchanged.
  for (const e of events) {
    e.sessionId = idRemap.get(e.sessionId) ?? e.sessionId;
  }

  const sessionRows = [...mergedSessions.values()].map((s) => ({
    id: s.id,
    zone: s.zone,
    started_at: s.started_at,
    ended_at: s.ended_at,
    source: "GuildRosterLogger",
  }));
  const { error: sessionErr } = await supabase.from("raid_sessions").upsert(sessionRows, { onConflict: "id" });
  if (sessionErr) throw sessionErr;
  console.log(`Upserted ${sessionRows.length} raid session(s).`);

  // --- Attendance: collapse raid_join/raid_leave pairs per (session, name) ---
  const attendanceByKey = new Map(); // `${sessionId}::${name}` -> { session_id, character_name, joined_at, left_at, seconds_present, openSince }
  for (const e of events) {
    if (e.event !== "raid_join" && e.event !== "raid_leave") continue;
    const key = `${e.sessionId}::${e.name}`;
    let att = attendanceByKey.get(key);
    if (!att) {
      att = { session_id: e.sessionId, character_name: e.name, joined_at: null, left_at: null, seconds_present: 0, openSince: null };
      attendanceByKey.set(key, att);
    }
    const iso = toIso(e.timestamp);
    if (e.event === "raid_join") {
      if (!att.joined_at) att.joined_at = iso;
      att.openSince = iso;
    } else {
      att.left_at = iso;
      if (att.openSince) {
        att.seconds_present += (new Date(iso) - new Date(att.openSince)) / 1000;
        att.openSince = null;
      }
    }
  }

  const attendanceRows = [...attendanceByKey.values()]
    .filter((a) => a.joined_at) // ignore a stray leave with no matching join
    .map((a) => ({
      session_id: a.session_id,
      character_name: a.character_name,
      joined_at: a.joined_at,
      left_at: a.left_at,
      seconds_present: Math.round(a.seconds_present),
    }));

  if (attendanceRows.length) {
    // Merge with whatever's already there instead of blindly overwriting —
    // sessionId is now canonical (see reconciliation above), so a second
    // officer's import of the same real raid lands on the same
    // (session_id, character_name) key. Each observer may have only seen
    // part of the picture (addon loaded late, brief disconnect, etc.), so
    // take the widest join/leave range and the larger presence reading
    // rather than letting whichever import ran last win.
    const sessionIdsTouched = [...new Set(attendanceRows.map((r) => r.session_id))];
    const { data: existingAttendance, error: existAttErr } = await supabase
      .from("raid_attendance")
      .select("session_id, character_name, joined_at, left_at, seconds_present")
      .in("session_id", sessionIdsTouched);
    if (existAttErr) throw existAttErr;
    const existingByKey = new Map(
      (existingAttendance ?? []).map((r) => [`${r.session_id}::${r.character_name}`, r])
    );

    const mergedAttendanceRows = attendanceRows.map((r) => {
      const existing = existingByKey.get(`${r.session_id}::${r.character_name}`);
      if (!existing) return r;
      return {
        session_id: r.session_id,
        character_name: r.character_name,
        joined_at: [existing.joined_at, r.joined_at].sort()[0],
        left_at: [existing.left_at, r.left_at].filter(Boolean).sort().at(-1) ?? null,
        seconds_present: Math.max(existing.seconds_present, r.seconds_present),
      };
    });

    const { error: attErr } = await supabase
      .from("raid_attendance")
      .upsert(mergedAttendanceRows, { onConflict: "session_id,character_name" });
    if (attErr) throw attErr;
    console.log(`Upserted ${mergedAttendanceRows.length} raid attendance row(s).`);
  } else {
    console.log("No raid attendance to import.");
  }

  // --- Loot: one row per raid_loot event ---
  // Dedup can't rely on raw_entry alone anymore (session, watching the
  // reconciliation above): the same real loot roll is witnessed and logged
  // independently by every officer in the raid, each with their own local
  // timestamp/sessionId baked into raw_entry, so exact-string matching
  // wouldn't catch cross-observer duplicates. Instead, treat a new loot
  // event as a duplicate if the same character looted the same item in the
  // same (now-canonical) session within LOOT_DEDUPE_WINDOW_MS of an
  // already-recorded one — close enough in time that it's almost certainly
  // the same real event seen twice, while still allowing genuinely repeat
  // drops of the same item later in a long raid night.
  const LOOT_DEDUPE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
  let newLootCount = 0;
  const lootEvents = events.filter((e) => e.event === "raid_loot");
  if (lootEvents.length) {
    const sessionIdsForLoot = [...new Set(lootEvents.map((e) => e.sessionId))];
    const { data: existingLoot, error: existingErr } = await supabase
      .from("raid_loot")
      .select("session_id, character_name, item_id, looted_at")
      .in("session_id", sessionIdsForLoot);
    if (existingErr) throw existingErr;
    const seen = [...(existingLoot ?? [])]; // grows as we stage new rows below, so within-file dupes catch too

    const lootRows = [];
    let dupeCount = 0;
    for (const e of lootEvents) {
      const parsed = parseLootDetail(e.detail || "");
      if (!parsed) continue;
      const isoTime = toIso(e.timestamp);
      const isDupe = seen.some(
        (r) =>
          r.session_id === e.sessionId &&
          r.character_name === e.name &&
          r.item_id === parsed.itemId &&
          Math.abs(new Date(r.looted_at) - new Date(isoTime)) <= LOOT_DEDUPE_WINDOW_MS
      );
      if (isDupe) {
        dupeCount++;
        continue;
      }
      const row = {
        session_id: e.sessionId,
        character_name: e.name,
        item_id: parsed.itemId,
        item_name: parsed.itemName,
        quality: parsed.quality,
        looted_at: isoTime,
        raw_entry: e.raw,
      };
      lootRows.push(row);
      seen.push({ session_id: row.session_id, character_name: row.character_name, item_id: row.item_id, looted_at: row.looted_at });
    }
    if (dupeCount) {
      console.log(`Skipping ${dupeCount} already-imported loot event(s).`);
    }

    if (lootRows.length) {
      const { error: lootErr } = await supabase.from("raid_loot").insert(lootRows);
      if (lootErr) throw lootErr;
      console.log(`Inserted ${lootRows.length} new raid loot row(s).`);
      newLootCount = lootRows.length;
    } else {
      console.log("No new raid loot to import.");
    }
  } else {
    console.log("No raid loot events found.");
  }

  const summary = `Upserted ${sessionRows.length} session(s), ${attendanceRows.length} attendance row(s), ${newLootCount} new loot row(s).`;
  await logSync(supabase, "import-raid-log", { success: true, summary });
}

main().catch(async (err) => {
  console.error("Import failed:", err);
  await logSync(supabase, "import-raid-log", {
    success: false,
    summary: "Raid log import failed",
    error: err.message ?? String(err),
  });
  process.exit(1);
});
