// watch-and-import.js
//
// Watches your WoW SavedVariables file for GuildRosterLogger and
// automatically re-runs the importers (rank/notes + raid attendance/loot)
// every time it changes on disk — which happens whenever the addon saves,
// i.e. on /reload or logout. Leave this running in the background (a
// terminal window, or set it up as a Windows startup task) and the whole
// roster/rank/raid pipeline stays in sync without running anything by hand.
//
// The addon itself can't push to Supabase or launch this script directly —
// WoW's addon sandbox has no network access and no way to execute external
// programs, by design, in every version of the game. This watcher is the
// closest equivalent: it reacts the instant the file changes instead of
// waiting for someone to double-click an importer.
//
// This does NOT install/update the addon — that's install-addon-updater.bat
// from the public guild-roster-addon repo, a separate Node-free step. Run
// that first so the SavedVariables file this script waits for actually gets
// created by the game.
//
// Note: this only reacts to the SavedVariables file changing. It doesn't
// replace poll-roster.js, which polls the Warmane armory API on its own
// schedule (see poll-roster.js's header) to catch joins/leaves even when
// nobody is logged in to run the addon.
//
// Usage:
//   node watch-and-import.js "C:\path\to\WTF\Account\ACCOUNTNAME\SavedVariables\GuildRosterLogger.lua" [second path] [third path] ...
//
// Pass more than one path if an officer raids on characters split across
// multiple separate WoW accounts (each account has its own
// WTF\Account\<NAME>\SavedVariables\ folder) — one watcher instance/scheduled
// task then covers all of them, each tracked and debounced independently.
//
// Required env vars: SUPABASE_URL, SUPABASE_KEY (anon/public key — see
// schema-officer-import-rls.sql in the private companion repo)
// (passed through to the importer scripts it spawns, via .env / dotenv)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { updateScripts, restartWatcher } from "./update-scripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePaths = process.argv.slice(2);

if (filePaths.length === 0) {
  console.error("Usage: node watch-and-import.js path/to/GuildRosterLogger.lua [path2] [path3] ...");
  process.exit(1);
}

const DEBOUNCE_MS = 3000; // WoW can write the file in bursts; wait for it to settle before importing
const FILE_WAIT_POLL_MS = 5000;
const SCRIPT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

function runImporter(script, filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), filePath], {
      stdio: "inherit",
      cwd: __dirname,
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(`${script} exited with code ${code} (${filePath})`);
      }
      resolve();
    });
    child.on("error", (err) => {
      console.error(`Failed to start ${script}:`, err.message);
      resolve();
    });
  });
}

// Each watched path gets its own debounce/running state so one account's
// SavedVariables changing doesn't delay or skip another account's import.
const watchState = new Map(filePaths.map((p) => [p, { timer: null, running: false, rerunQueued: false }]));

async function importAll(filePath) {
  const state = watchState.get(filePath);
  if (state.running) {
    state.rerunQueued = true;
    return;
  }
  state.running = true;
  const stamp = new Date().toLocaleTimeString();
  console.log(`\n[${stamp}] ${filePath} changed — importing...`);
  await runImporter("import-grl-log.js", filePath);
  await runImporter("import-raid-log.js", filePath);
  console.log(`[${stamp}] Done with ${filePath}. Watching for the next change...`);
  state.running = false;
  if (state.rerunQueued) {
    state.rerunQueued = false;
    scheduleImport(filePath);
  }
}

function scheduleImport(filePath) {
  const state = watchState.get(filePath);
  clearTimeout(state.timer);
  state.timer = setTimeout(() => importAll(filePath), DEBOUNCE_MS);
}

async function waitForFile(p) {
  if (fs.existsSync(p)) return;
  console.log(`Waiting for ${p} to appear.`);
  console.log("Log into WoW with GuildRosterLogger installed and enabled, then /reload (or log out) once — that's what creates this file.");
  while (!fs.existsSync(p)) {
    await new Promise((resolve) => setTimeout(resolve, FILE_WAIT_POLL_MS));
  }
  console.log("Found it. Watching for changes now.");
}

async function main() {
  // Keep these scripts current before doing anything else — if anything
  // changed, respawn a fresh process running the new code and exit this
  // one, instead of silently running stale logic until the next Windows
  // logon.
  const scriptsUpdated = await updateScripts().catch((err) => {
    console.error("[update-scripts] error:", err.message);
    return false;
  });
  if (scriptsUpdated) {
    restartWatcher(filePaths);
    return; // unreachable after process.exit(0) in restartWatcher, but keeps intent clear
  }

  await Promise.all(filePaths.map(waitForFile));

  console.log(
    filePaths.length === 1
      ? `Watching ${filePaths[0]} for changes. Press Ctrl+C to stop.`
      : `Watching ${filePaths.length} SavedVariables files for changes. Press Ctrl+C to stop.`
  );
  for (const filePath of filePaths) {
    if (filePaths.length > 1) console.log(`  - ${filePath}`);
    fs.watch(filePath, { persistent: true }, () => {
      scheduleImport(filePath);
    });
    // Run once immediately on startup too, so you don't have to wait for the
    // next in-game change to pick up anything logged since this last ran.
    scheduleImport(filePath);
  }

  // Keep checking for script updates going forward too — same logic as the
  // startup check above, just riding along on this already-scheduled task
  // instead of a second one.
  setInterval(async () => {
    const updated = await updateScripts().catch((err) => {
      console.error("[update-scripts] error:", err.message);
      return false;
    });
    if (updated) restartWatcher(filePaths);
  }, SCRIPT_UPDATE_INTERVAL_MS);
}

main();
