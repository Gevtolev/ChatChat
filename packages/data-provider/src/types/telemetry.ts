/**
 * Event names live here rather than in the emitter so the frontend can use the
 * same strings when it starts sending its half of the funnel. Two ends spelling
 * an event differently produces two events in PostHog that look like one, and
 * the mistake is invisible until someone builds a funnel on the wrong one.
 */
export const TelemetryEvents = {
  SIGNUP_COMPLETED: 'signup_completed',
  MESSAGE_SENT: 'message_sent',
  PLAN_CHANGED: 'plan_changed',
  QUOTA_EXHAUSTED: 'quota_exhausted',
} as const;

export type TelemetryEvent = (typeof TelemetryEvents)[keyof typeof TelemetryEvents];

/** Which cap a user ran into. The two are different products decisions — one is
 *  a paid allowance, the other the anonymous trial — and conflating them would
 *  hide the trial conversion step. */
export type QuotaLimitType = 'credits' | 'trial_messages';

export type SignupMethod = 'google' | 'github' | 'local';
