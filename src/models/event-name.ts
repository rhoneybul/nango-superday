/**
 * Every event name the API accepts, for both `POST /ingest` and the `event`
 * filter on `GET /events`. To support a new event, add it here.
 *
 * The database column stays plain text, so adding a value needs no migration.
 */
export enum EventName {
  Signup = 'signup',
  Login = 'login',
  Logout = 'logout',
  Purchase = 'purchase',
}

export const EVENT_NAMES: readonly EventName[] = Object.values(EventName);

export function isEventName(value: string): value is EventName {
  return EVENT_NAMES.includes(value as EventName);
}
