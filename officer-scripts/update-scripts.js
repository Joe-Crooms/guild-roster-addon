// update-scripts.js
//
// Self-updater for the officer-side Node import pipeline (the companion to
// install-addon-updater.bat, which auto-updates the addon itself over in the
// public guild-roster-addon repo — this covers the other half: "scheduler
// and auto updater (import)"). Fetches the current versions of
// watch-and-import.js / import-grl-log.js / import-raid-log.js / sync-log.js
// / update-scripts.js itself from that same public repo's officer-scripts/
// folder and overwrites the local copies if anything changed, then restarts
// watch-and-import.js so the update actually takes effect instead of waiting
// for the next logon.
//
// Deliberately does NOT touch package.json/package-lock.json — if a change
// ever needs a new dependency, that's a manual re-install event (new zip
// from Joe), same as today. In practice fixes/features land in the .js files
// above, which this does cover automatically.
//
// Usage: node update-scripts.js "C:\path\to\...\SavedVariables\GuildRosterLogger.lua"
// (the SavedVariables path is only forwarded to the respawned watcher, not
// used for anything else here)

import fs from "fs";
import path from "path";
import https from "https";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_BASE = "https://raw.githubusercontent.com/Joe-Crooms/guild-roster-addon/main/officer-scripts/";
const FILES = ["watch-and-import.js", "import-grl-log.js", "import-raid-log.js", "sync-log.js", "update-scripts.js"];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "cache-control": "no-cache" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

// Returns true if anything changed on disk.
export async function updateScripts() {
  let updatedAny = false;
  for (const file of FILES) {
    const url = RAW_BASE + file;
    const destFile = path.join(__dirname, file);
    try {
      const newContent = await fetchText(url);
      const oldContent = fs.existsSync(destFile) ? fs.readFileSync(destFile, "utf8") : "";
      if (newContent.replace(/\r\n/g, "\n") !== oldContent.replace(/\r\n/g, "\n")) {
        fs.writeFileSync(destFile, newContent);
        updatedAny = true;
        console.log(`[update-scripts] Updated ${file}`);
      }
    } catch (err) {
      console.error(`[update-scripts] Failed to fetch ${file}: ${err.message}`);
    }
  }
  return updatedAny;
}

// Respawns watch-and-import.js as a fresh, detached process (picking up
// whatever just got written to disk) and exits this one. Called by
// watch-and-import.js itself after a successful update.
export function restartWatcher(savedVarsPath) {
  console.log("[update-scripts] Restarting to apply update...");
  const child = spawn(process.execPath, [path.join(__dirname, "watch-and-import.js"), savedVarsPath], {
    detached: true,
    stdio: "ignore",
    cwd: __dirname,
  });
  child.unref();
  process.exit(0);
}

// Allow running standalone: node update-scripts.js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  updateScripts().then((updated) => {
    if (updated) console.log("[update-scripts] Done - restart watch-and-import.js to pick up the changes.");
    else console.log("[update-scripts] Already up to date.");
  });
}
