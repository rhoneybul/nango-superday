/**
 * The metered events: what a customer is billed for. Used by `POST /ingest`,
 * `POST /ingest/batch` and the `event` filter on `GET /events`. To meter a
 * new kind of usage, add it here; the database column is plain text, so no
 * migration is needed.
 */
export enum EventName {
  /** A request the customer made through the platform to a third-party API. */
  ApiRequest = 'api_request',
  /** One execution of a sync (continuous data pull). */
  SyncRun = 'sync_run',
  /** Records moved by a sync; send `quantity` = number of records. */
  RecordsSynced = 'records_synced',
  /** One execution of an action (on-demand call). */
  ActionExecuted = 'action_executed',
  /** One inbound webhook received and processed on the customer's behalf. */
  WebhookReceived = 'webhook_received',
  /** A new connection (authorised integration) created. */
  ConnectionCreated = 'connection_created',
}
