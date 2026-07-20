// Pure UTC bucket formatters shared by rollup, alert-rules, digest, and
// metrics-api. Zero dependencies — extracted so alert-rules/digest can import
// them without creating a static cycle with rollup.ts.

/** '2026-07-09T14' for the UTC hour containing `d`. */
export function hourBucket(d: Date): string {
  return d.toISOString().slice(0, 13);
}

/** '2026-07-09' for the UTC day containing `d`. */
export function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** [startIso, endIso) bounds for an hour bucket, matching SQLite's CURRENT_TIMESTAMP format. */
export function hourBounds(bucket: string): { start: string; end: string } {
  const start = new Date(`${bucket}:00:00.000Z`);
  const end = new Date(start.getTime() + 3600_000);
  // usage_events.created_at is 'YYYY-MM-DD HH:MM:SS' (SQLite CURRENT_TIMESTAMP).
  const fmt = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  return { start: fmt(start), end: fmt(end) };
}
