// sync-log.js
//
// Tiny shared helper so poll-roster.js / import-grl-log.js / import-raid-log.js
// each record one row per run to sync_log - this is what the dashboard's Log
// tab reads to show sync history. See schema-sync-log.sql.
//
// Deliberately swallows its own errors (beyond logging them to the console) -
// a failure to *record* a sync run should never take down the sync itself.

export async function logSync(supabase, source, { success, summary, error }) {
  const { error: insertErr } = await supabase.from("sync_log").insert({
    source,
    success,
    summary,
    error: error ?? null,
  });
  if (insertErr) {
    console.error(`[sync-log] Failed to record sync_log entry for ${source}:`, insertErr.message);
  }
}
