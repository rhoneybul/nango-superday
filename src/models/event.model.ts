import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import type { EventName } from './event-name';

/**
 * Data access for the `events` table. No validation lives here: the service
 * hands over already-validated input and a ready-made `where` clause.
 */

export interface EventRecord {
  id: string;
  accountId: string;
  eventName: string;
  /** The event's metadata as sent (fields per src/models/event-catalog.ts). */
  metadata: Record<string, unknown>;
  timestamp: Date;
  createdAt: Date;
}

/** What gets stored: the fields a client sends, resolved. */
export interface NewEvent {
  accountId: string;
  eventName: EventName;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

/** Filter built by the service. Shaped so Prisma accepts it directly as a `where`. */
export interface EventWhere {
  accountId?: string;
  eventName?: EventName;
  timestamp?: { gte?: Date; lte?: Date };
}

/** BigInt ids are not JSON-serialisable, so they go out as strings. */
function toRecord(row: { id: bigint; accountId: string; eventName: string; metadata: unknown; timestamp: Date; createdAt: Date }): EventRecord {
  return { ...row, id: row.id.toString(), metadata: (row.metadata as Record<string, unknown> | null) ?? {} };
}

export async function createEvent(event: NewEvent): Promise<EventRecord> {
  const row = await prisma.event.create({
    data: { ...event, metadata: event.metadata as Prisma.InputJsonValue },
  });
  return toRecord(row);
}

/** Newest first, paged with limit/offset. */
export async function findEvents(where: EventWhere, limit: number, offset: number): Promise<EventRecord[]> {
  const rows = await prisma.event.findMany({
    where,
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    take: limit,
    skip: offset,
  });
  return rows.map(toRecord);
}

export async function countEvents(where: EventWhere): Promise<number> {
  return prisma.event.count({ where });
}

export interface WindowBucket {
  windowStart: Date;
  count: number;
}

/** Bucket alignment origin: 1970-01-05 00:00 UTC, a Monday, so 1w buckets start on Mondays and 1h/1d stay on the hour/midnight UTC. */
export const BUCKET_ORIGIN_MS = Date.UTC(1970, 0, 5);

/**
 * Counts events per fixed-size time bucket of `windowSeconds`, aligned to
 * BUCKET_ORIGIN_MS via Postgres `date_bin`. Only buckets with events come back;
 * the service fills the gaps. The validator bounds the number of buckets.
 */
export async function countEventsByWindow(where: EventWhere, windowSeconds: number): Promise<WindowBucket[]> {
  const conditions: Prisma.Sql[] = [];
  if (where.accountId) conditions.push(Prisma.sql`account_id = ${where.accountId}`);
  if (where.eventName) conditions.push(Prisma.sql`event_name = ${where.eventName}`);
  if (where.timestamp?.gte) conditions.push(Prisma.sql`"timestamp" >= ${where.timestamp.gte}`);
  if (where.timestamp?.lte) conditions.push(Prisma.sql`"timestamp" <= ${where.timestamp.lte}`);
  const whereSql = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const interval = `${windowSeconds} seconds`;
  const rows = await prisma.$queryRaw<{ window_start: Date; count: bigint }[]>`
    SELECT date_bin(${interval}::interval, "timestamp", TIMESTAMPTZ '1970-01-05 00:00:00+00') AS window_start,
           COUNT(*)::bigint AS count
    FROM events
    ${whereSql}
    GROUP BY window_start
    ORDER BY window_start ASC
  `;
  return rows.map((r) => ({ windowStart: r.window_start, count: Number(r.count) }));
}
