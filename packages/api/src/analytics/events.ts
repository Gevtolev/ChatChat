import { TelemetryEvents } from 'librechat-data-provider';
import type { QuotaLimitType, SignupMethod, TelemetryEvent } from 'librechat-data-provider';
import { getAnalyticsClient } from './client';
import { hashUserId } from './identity';

/**
 * Properties any event is allowed to carry.
 *
 * An allowlist rather than a denylist, so a property added later is dropped
 * until someone deliberately adds it here. The failure this prevents is the one
 * that matters: a well-meaning `conversationId` or `title` added to an event in
 * a hurry and shipped to a third party. Reviewing what leaks is a task nobody
 * does; being unable to leak by default is a property of the code.
 */
const ALLOWED_PROPERTIES = new Set([
  'method',
  'model',
  'plan',
  'endpoint',
  'is_new_conversation',
  'from',
  'to',
  'source',
  'limit_type',
  'credits_at_block',
]);

type PropertyValue = string | number | boolean | null;

function filterProperties(
  properties: Record<string, PropertyValue>,
): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (ALLOWED_PROPERTIES.has(key) && value != null) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Fire-and-forget. Everything is swallowed — an outage at the telemetry vendor,
 * a malformed property, a DNS failure — because none of it is a reason for a
 * user's message to fail. `capture` enqueues and returns; it does not await the
 * network.
 */
function emit(
  event: TelemetryEvent,
  userId: string | null | undefined,
  properties: Record<string, PropertyValue>,
): void {
  try {
    const client = getAnalyticsClient();
    if (!client) {
      return;
    }
    const distinctId = hashUserId(userId);
    if (!distinctId) {
      return;
    }
    client.capture({
      distinctId,
      event,
      properties: filterProperties(properties),
    });
  } catch {
    /* telemetry is never a failure source */
  }
}

export function signupCompleted(userId: string, method: SignupMethod): void {
  emit(TelemetryEvents.SIGNUP_COMPLETED, userId, { method });
}

/**
 * Fired once per user-visible turn, from the request's terminal state — not
 * from `recordCollectedUsage`, which runs once per model group (message,
 * summarization, subagent) and would count a single turn several times.
 *
 * Carries `is_new_conversation` rather than the spec's `is_first_message`:
 * knowing whether this was a user's first ever message needs a database lookup
 * on the message path, and the activation number that property existed to serve
 * comes free from a `signup_completed` → `message_sent` funnel — which also
 * gives time-to-activation, which the property would not.
 */
export function messageSent(
  userId: string,
  properties: { model?: string; plan?: string; endpoint?: string; is_new_conversation?: boolean },
): void {
  emit(TelemetryEvents.MESSAGE_SENT, userId, properties);
}

export function planChanged(
  userId: string,
  properties: { from: string | null; to: string; source: string },
): void {
  emit(TelemetryEvents.PLAN_CHANGED, userId, properties);
}

export function quotaExhausted(
  userId: string,
  properties: { plan: string; limit_type: QuotaLimitType; credits_at_block?: number },
): void {
  emit(TelemetryEvents.QUOTA_EXHAUSTED, userId, properties);
}
