import { createHmac } from 'node:crypto';

/**
 * The identifier sent to third-party telemetry in place of a user id.
 *
 * HMAC rather than a bare SHA-256 of the id: a MongoDB ObjectId is small and
 * structured — a 4-byte timestamp, a machine identifier and a counter — so its
 * whole plausible input space can be enumerated and a bare digest reversed. With
 * a secret salt, a leak on the telemetry vendor's side still cannot be walked
 * back to our user table.
 *
 * **The salt must never change once set.** Changing it splits every existing
 * user into two unrelated people, which makes retention and funnel figures wrong
 * in a way no later correction can repair.
 *
 * Returns `null` when the salt is absent, and deliberately does *not* fall back
 * to an unsalted hash: a deployment that forgot to configure telemetry should
 * send nothing, not send something weaker than promised.
 */
export function hashUserId(
  userId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const salt = env.POSTHOG_ID_SALT;
  if (!salt || !userId) {
    return null;
  }
  return createHmac('sha256', salt).update(String(userId)).digest('hex').slice(0, 32);
}
