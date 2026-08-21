// Manual savepoint purge: "delete every savepoint older than the one I clicked", never a
// scheduled/automatic policy. See plans/concepts.md § Decisions "Savepoint retention is a
// manual purge" and todos/05-savepoint-purge-api.md for the DELETE /instance/{id}/savepoints
// endpoint this builds requests for. The anchor is an element (task), not a timestamp: nobody
// remembers when a savepoint was taken, but they remember what had been done by then.

export interface SavePointSummary {
  id: string;
  task_id?: string;
  task_name?: string;
  created_at?: string;
}

export interface PurgeRequest {
  before_task_id: string;
}

export function buildPurgeRequest(point: SavePointSummary): PurgeRequest {
  if (!point.task_id) {
    throw new Error(`savepoint ${point.id} has no task_id; cannot anchor a purge on it`);
  }
  return { before_task_id: point.task_id };
}

/** Every savepoint strictly older than the anchor's own savepoint -- never the anchor itself. */
export function selectPurgedIds(points: SavePointSummary[], anchorId: string): string[] {
  const anchor = points.find((p) => p.id === anchorId);
  if (!anchor || !anchor.created_at) return [];
  const cutoff = anchor.created_at;
  return points.filter((p) => p.id !== anchorId && (p.created_at ?? "") < cutoff).map((p) => p.id);
}

export function describePurge(points: SavePointSummary[], anchorId: string): string {
  const anchor = points.find((p) => p.id === anchorId);
  if (!anchor) throw new Error(`no savepoint with id ${anchorId}`);
  const purgedCount = selectPurgedIds(points, anchorId).length;
  const anchorLabel = anchor.task_name || anchor.id;
  if (purgedCount === 0) {
    return `There is nothing to purge: no savepoints exist before "${anchorLabel}".`;
  }
  const plural = purgedCount === 1 ? "savepoint" : "savepoints";
  return (
    `This will permanently delete ${purgedCount} ${plural} recorded before "${anchorLabel}". ` +
    `This cannot be undone.`
  );
}
