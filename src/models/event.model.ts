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

export interface WindowBucket {
  windowStart: Date;
  count: number;
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

/**
 * Counts events grouped into fixed-size time buckets of `windowSeconds`.
 * Buckets are aligned to the Unix epoch via Postgres `date_bin`, so a 1h
 * window always starts on the hour, a 1d window at 00:00 UTC, etc.
 * Empty buckets are not returned.
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
    SELECT date_bin(${interval}::interval, "timestamp", TIMESTAMPTZ 'epoch') AS window_start,
           COUNT(*)::bigint AS count
    FROM events
    ${whereSql}
    GROUP BY window_start
    ORDER BY window_start ASC
  `;
  return rows.map((r) => ({ windowStart: r.window_start, count: Number(r.count) }));
}
