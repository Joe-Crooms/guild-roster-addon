// import-grl-log.js
//
// Imports events logged by the custom GuildRosterLogger addon
// (GuildRosterLogger.lua) directly from its SavedVariables file — no export
// step needed in-game, just point this at the .lua file on disk.
//
// The addon logs each event as a plain string:
//   "YYYY-MM-DD|CharacterName|event|detail"
// e.g. "2026-08-10|Thundermace|rank_change|Member->Officer"
//
// This script pulls every matching string out of the file with a regex
// (deliberately not a full Lua parser — the addon's log format was designed
// to be this easy to extract), then imports rank_change and joined events
// into guild_rank_history and updates current_rank on guild_members.
//
// Join/leave/rejoin events from this source are intentionally NOT written
// to guild_members' status/first_seen/last_seen — poll-roster.js (via the
// Warmane API) is the source of truth for that, since it runs continuously
// in the background rather than only while you're logged in.
//
// The file also holds GuildRosterLoggerDB.members[name] = { rank, status,
// note, officernote }, a nested (not pipe-delimited) table of each
// character's *current* guild note / officer note — this is the only
// source for notes at all, since Warmane's armory API doesn't expose them.
// extractMembers() below pulls those out with a second, narrower regex.
//
// Usage:
//   node import-grl-log.js "C:\path\to\WTF\Account\ACCOUNTNAME\SavedVariables\GuildRosterLogger.lua"
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
  console.error("Usage: node import-grl-log.js path/to/GuildRosterLogger.lua");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function extractEvents(content) {
  // Matches every quoted "YYYY-MM-DD|Name|event|detail" string anywhere in
  // the file, regardless of how Blizzard's Lua serializer nested/indexed
  // the surrounding table.
  const matches = [...content.matchAll(/"(\d{4}-\d{2}-\d{2}\|[^"]*)"/g)];
  return matches.map((m) => {
    const [date, name, event, detail] = m[1].split("|");
    return { date, name, event, detail, raw: m[1] };
  });
}

// Unescapes the Lua string escapes the SavedVariables serializer produces
// (\" \\ \n \t, plus the general "\<anything>" -> "<anything>" fallback).
function unescapeLuaString(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

// Pulls each character's current note/officernote out of
// GuildRosterLoggerDB.members. Each member is serialized as a flat table
// with no further nesting, e.g.:
//   ["CharName"] = {
//       ["rank"] = "Recruit",
//       ["status"] = "active",
//       ["note"] = "some text",
//       ["officernote"] = "officer text",
//   },
// so `["Name"] = { ...no braces inside... }` matches exactly the per-member
// blocks — the outer "members"/"changeLog" tables contain nested braces and
// don't match this pattern themselves.
function extractMembers(content) {
  const blockRe = /\["([^"]+)"\]\s*=\s*\{([^{}]*)\}/g;
  const field = (body, key) => {
    const m = body.match(new RegExp(`\\["${key}"\\]\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`));
    return m ? unescapeLuaString(m[1]) : undefined;
  };

  const members = new Map();
  for (const m of content.matchAll(blockRe)) {
    const [, name, body] = m;
    // Only treat this as a member block if it has a rank field — guards
    // against accidentally matching an unrelated flat table elsewhere.
    if (!/\["rank"\]/.test(body)) continue;
    members.set(name, {
      note: field(body, "note"),
      officernote: field(body, "officernote"),
    });
  }
  return members;
}

async function main() {
  const content = fs.readFileSync(filePath, "utf-8");
  const events = extractEvents(content);
  const members = extractMembers(content);
  console.log(`Found ${events.length} logged events and ${members.size} member note snapshots in ${filePath}`);

  const rankEvents = events.filter(
    (e) => e.event === "rank_change" || e.event === "joined"
  );
  const skipped = events.length - rankEvents.length;
  if (skipped) {
    console.log(`Skipping ${skipped} join/leave/rejoin events (handled by poll-roster.js instead).`);
  }

  let rankSummary;
  if (!rankEvents.length) {
    console.log("No rank events to import.");
    rankSummary = "no rank events";
  } else {
    // The SavedVariables file keeps every event the addon has ever logged, so
    // re-running this script (e.g. via run-import.bat) always re-scans the
    // whole file. To keep it idempotent, skip any event whose exact raw_entry
    // string is already in the table instead of re-inserting it.
    const { data: existingRows, error: existingErr } = await supabase
      .from("guild_rank_history")
      .select("raw_entry");
    if (existingErr) throw existingErr;
    const alreadyImported = new Set(existingRows.map((r) => r.raw_entry));

    const newRankEvents = rankEvents.filter((e) => !alreadyImported.has(e.raw));
    const dupeCount = rankEvents.length - newRankEvents.length;
    if (dupeCount) {
      console.log(`Skipping ${dupeCount} already-imported rank event(s).`);
    }

    const rows = newRankEvents.map((e) => {
      // For rank_change, detail is "OldRank->NewRank" — take the new rank.
      // For joined, detail is just the rank they joined at.
      const rank = e.detail.includes("->") ? e.detail.split("->")[1] : e.detail;
      return {
        character_name: e.name,
        rank,
        event: e.event,
        event_date: e.date,
        source: "GuildRosterLogger",
        raw_entry: e.raw,
      };
    });

    if (rows.length) {
      const { error: insertErr } = await supabase.from("guild_rank_history").insert(rows);
      if (insertErr) throw insertErr;
      console.log(`Inserted ${rows.length} new rank history entries.`);
      rankSummary = `${rows.length} new rank event(s)`;
    } else {
      console.log("No new rank events to import.");
      rankSummary = "no new rank events";
    }
  }

  // Derive current_rank from every rank event the SavedVariables file knows
  // about (not just newly-inserted ones) — the file always holds full
  // history, so this stays correct even on a re-run against a guild_members
  // row that didn't exist yet the last time this script ran (e.g. before
  // poll-roster.js had ever populated it).
  const latestByName = new Map();
  for (const e of rankEvents) {
    const rank = e.detail.includes("->") ? e.detail.split("->")[1] : e.detail;
    const existing = latestByName.get(e.name);
    if (!existing || e.date >= existing.date) {
      latestByName.set(e.name, { rank, date: e.date });
    }
  }

  // Merge current_rank with the current guild_note/officer_note snapshot
  // from `members` so each character gets a single combined update instead
  // of one round trip per field.
  const allNames = new Set([...latestByName.keys(), ...members.keys()]);
  let updated = 0;
  for (const name of allNames) {
    const update = {};
    const rankInfo = latestByName.get(name);
    if (rankInfo) update.current_rank = rankInfo.rank;

    const memberInfo = members.get(name);
    if (memberInfo) {
      if (memberInfo.note !== undefined) update.guild_note = memberInfo.note;
      if (memberInfo.officernote !== undefined) update.officer_note = memberInfo.officernote;
    }

    if (Object.keys(update).length === 0) continue;

    const { error } = await supabase.from("guild_members").update(update).eq("character_name", name);
    if (error) {
      console.warn(`Could not update ${name}:`, error.message);
    } else {
      updated++;
    }
  }

  console.log(`Updated rank/notes for ${updated} members.`);

  const summary = `Imported ${rankSummary}, updated rank/notes for ${updated} member(s).`;
  await logSync(supabase, "import-grl-log", { success: true, summary });
}

main().catch(async (err) => {
  console.error("Import failed:", err);
  await logSync(supabase, "import-grl-log", {
    success: false,
    summary: "GRL log import failed",
    error: err.message ?? String(err),
  });
  process.exit(1);
});
