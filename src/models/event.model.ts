import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

export interface EventRecord {
  id: string;
  accountId: string;
  eventName: string;
  timestamp: Date;
  createdAt: Date;
}

export interface CreateEventInput {
  accountId: string;
  eventName: string;
  timestamp?: Date;
}

export interface EventFilter {
  accountId?: string;
  eventName?: string;
  from?: Date;
  to?: Date;
}

export interface FindEventsOptions extends EventFilter {
  limit: number;
  offset: number;
}

export interface WindowBucket {
  windowStart: Date;
  count: number;
}

function toRecord(row: { id: bigint; accountId: string; eventName: string; timestamp: Date; createdAt: Date }): EventRecord {
  return { ...row, id: row.id.toString() };
}

function buildWhere(f: EventFilter): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = {};
  if (f.accountId) where.accountId = f.accountId;
  if (f.eventName) where.eventName = f.eventName;
  if (f.from || f.to) {
    where.timestamp = {};
    if (f.from) where.timestamp.gte = f.from;
    if (f.to) where.timestamp.lte = f.to;
  }
  return where;
}

/**
 * Data-access layer for the `events` table. No validation lives here —
 * callers (services) are expected to hand over already-validated input.
 */
export const eventModel = {
  async create(input: CreateEventInput): Promise<EventRecord> {
    const row = await prisma.event.create({
      data: {
        accountId: input.accountId,
        eventName: input.eventName,
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      },
    });
    return toRecord(row);
  },

  async findMany(opts: FindEventsOptions): Promise<EventRecord[]> {
    const rows = await prisma.event.findMany({
      where: buildWhere(opts),
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      skip: opts.offset,
    });
    return rows.map(toRecord);
  },

  async count(filter: EventFilter): Promise<number> {
    return prisma.event.count({ where: buildWhere(filter) });
  },

  /**
   * Counts events grouped into fixed-size time buckets of `windowSeconds`.
   * Buckets are aligned to the Unix epoch via Postgres `date_bin`, so a 1h
   * window always starts on the hour, a 1d window at 00:00 UTC, etc.
   * Empty buckets are not returned.
   */
  async countByWindow(filter: EventFilter, windowSeconds: number): Promise<WindowBucket[]> {
    const conditions: Prisma.Sql[] = [];
    if (filter.accountId) conditions.push(Prisma.sql`account_id = ${filter.accountId}`);
    if (filter.eventName) conditions.push(Prisma.sql`event_name = ${filter.eventName}`);
    if (filter.from) conditions.push(Prisma.sql`"timestamp" >= ${filter.from}`);
    if (filter.to) conditions.push(Prisma.sql`"timestamp" <= ${filter.to}`);
    const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

    const interval = `${windowSeconds} seconds`;
    const rows = await prisma.$queryRaw<{ window_start: Date; count: bigint }[]>`
      SELECT date_bin(${interval}::interval, "timestamp", TIMESTAMPTZ 'epoch') AS window_start,
             COUNT(*)::bigint AS count
      FROM events
      ${where}
      GROUP BY window_start
      ORDER BY window_start ASC
    `;
    return rows.map((r) => ({ windowStart: r.window_start, count: Number(r.count) }));
  },
};

export type EventModel = typeof eventModel;
