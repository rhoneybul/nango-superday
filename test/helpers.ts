import { vi } from 'vitest';
import { createApp } from '../src/app';
import { createEventController } from '../src/controllers/event.controller';
import type { EventModel, EventRecord, WindowBucket } from '../src/models/event.model';
import { createEventService } from '../src/services/event.service';

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: '1',
    accountId: 'acc_1',
    eventName: 'signup',
    timestamp: new Date('2026-09-01T10:00:00.000Z'),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

export function makeModel(overrides: Partial<EventModel> = {}) {
  const model = {
    create: vi.fn(async (input) => makeEvent({ accountId: input.accountId, eventName: input.eventName, timestamp: input.timestamp ?? new Date() })),
    findMany: vi.fn(async () => [] as EventRecord[]),
    count: vi.fn(async () => 0),
    countByWindow: vi.fn(async () => [] as WindowBucket[]),
    ...overrides,
  } satisfies EventModel;
  return model;
}

/** Builds a full Express app wired to a stubbed model. */
export function buildApp(model: ReturnType<typeof makeModel> = makeModel()) {
  const service = createEventService(model);
  const controller = createEventController(service);
  return { app: createApp({ eventController: controller }), model };
}
