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
  timestamp: Date;
  createdAt: Date;
}

/** Filter built by the service. Shaped so Prisma accepts it directly as a `where`. */
export interface EventWhere {
  accountId?: string;
  eventName?: EventName;
  timestamp?: { gte?: Date; lte?: Date };
}

/** BigInt ids are not JSON-serialisable, so they go out as strings. */
function toRecord(row: { id: bigint; accountId: string; eventName: string; timestamp: Date; createdAt: Date }): EventRecord {
  return { ...row, id: row.id.toString() };
}

export async function createEvent(accountId: string, eventName: EventName, timestamp?: Date): Promise<EventRecord> {
  const row = await prisma.event.create({
    data: { accountId, eventName, timestamp }, // undefined timestamp → DB default now()
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
  /** Present when the query grouped by account / event. */
  account?: string;
  event?: string;
  count: number;
}

export type WindowGroup = 'account' | 'event';

/** Bucket alignment origin: 1970-01-05 00:00 UTC, a Monday, so 1w buckets start on Mondays and 1h/1d stay on the hour/midnight UTC. */
export const BUCKET_ORIGIN_MS = Date.UTC(1970, 0, 5);

const GROUP_COLUMN: Record<WindowGroup, Prisma.Sql> = { account: Prisma.sql`account_id`, event: Prisma.sql`event_name` };

/**
 * Counts events grouped into fixed-size time buckets of `windowSeconds`,
 * aligned to BUCKET_ORIGIN_MS via Postgres `date_bin`, optionally further
 * grouped by account and/or event name. Only buckets with events come back
 * (the service fills the gaps); at most `maxRows` rows, which the service
 * treats as "range too wide" when hit.
 */
export async function countEventsByWindow(
  where: EventWhere,
  windowSeconds: number,
  maxRows: number,
  groupBy: WindowGroup[] = [],
): Promise<WindowBucket[]> {
  const conditions: Prisma.Sql[] = [];
  if (where.accountId) conditions.push(Prisma.sql`account_id = ${where.accountId}`);
  if (where.eventName) conditions.push(Prisma.sql`event_name = ${where.eventName}`);
  if (where.timestamp?.gte) conditions.push(Prisma.sql`"timestamp" >= ${where.timestamp.gte}`);
  if (where.timestamp?.lte) conditions.push(Prisma.sql`"timestamp" <= ${where.timestamp.lte}`);
  const whereSql = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const interval = `${windowSeconds} seconds`;
  const keys = Prisma.join([Prisma.sql`window_start`, ...groupBy.map((g) => GROUP_COLUMN[g])], ', ');
  const rows = await prisma.$queryRaw<{ window_start: Date; account_id?: string; event_name?: string; count: bigint }[]>`
    SELECT date_bin(${interval}::interval, "timestamp", TIMESTAMPTZ '1970-01-05 00:00:00+00') AS window_start,
           ${groupBy.includes('account') ? Prisma.sql`account_id,` : Prisma.empty}
           ${groupBy.includes('event') ? Prisma.sql`event_name,` : Prisma.empty}
           COUNT(*)::bigint AS count
    FROM events
    ${whereSql}
    GROUP BY ${keys}
    ORDER BY ${keys}
    LIMIT ${maxRows}
  `;
  return rows.map((r) => ({
    windowStart: r.window_start,
    ...(r.account_id !== undefined && { account: r.account_id }),
    ...(r.event_name !== undefined && { event: r.event_name }),
    count: Number(r.count),
  }));
}
