/**
 * Opaque keyset-pagination cursor for GET /events: the (timestamp, id) of the
 * last row on a page, base64url-encoded. The next page is every row strictly
 * after it in the listing order (timestamp desc, id desc), which the
 * (account_id, timestamp) indexes serve without scanning skipped rows, unlike
 * a large OFFSET.
 */
export interface EventCursor {
  timestamp: Date;
  id: bigint;
}

export function encodeCursor(c: EventCursor): string {
  return Buffer.from(`${c.timestamp.toISOString()}|${c.id}`).toString('base64url');
}

/** Returns null for anything that is not a cursor this API produced. */
export function decodeCursor(raw: string): EventCursor | null {
  const [ts, id] = Buffer.from(raw, 'base64url').toString().split('|');
  if (!ts || !id || !/^\d+$/.test(id)) return null;
  const timestamp = new Date(ts);
  return Number.isNaN(timestamp.getTime()) ? null : { timestamp, id: BigInt(id) };
}
