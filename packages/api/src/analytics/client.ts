import { PostHog } from 'posthog-node';

let client: PostHog | null = null;
let resolved = false;

/**
 * The PostHog client, or `null` when telemetry is not configured.
 *
 * Both the project key and the identity salt are required. A deployment with a
 * key but no salt would otherwise send events keyed by nothing, or — worse —
 * tempt a fallback to an unsalted hash, which is the one thing `identity.ts`
 * refuses to do.
 *
 * Lazy and memoised: nothing connects until the first event, so importing this
 * module costs a local development server nothing.
 */
export function getAnalyticsClient(env: NodeJS.ProcessEnv = process.env): PostHog | null {
  if (resolved) {
    return client;
  }
  resolved = true;

  const key = env.POSTHOG_KEY;
  if (!key || !env.POSTHOG_ID_SALT) {
    return null;
  }

  try {
    client = new PostHog(key, {
      host: env.POSTHOG_HOST ?? 'https://eu.i.posthog.com',
      /** Batched and flushed in the background. The alternative — flushing per
       *  event — would put a network round trip on the path of every message a
       *  user sends. */
      flushAt: 20,
      flushInterval: 10_000,
    });
  } catch {
    client = null;
  }
  return client;
}

/** Test seam. Production never calls this — the module is memoised for the life
 *  of the process. */
export function resetAnalyticsClient(): void {
  client = null;
  resolved = false;
}

/**
 * Flushes pending events. Called on shutdown so a deploy does not drop the last
 * batch; failures are ignored because a hung telemetry flush must never hold up
 * a restart.
 */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) {
    return;
  }
  try {
    await client.shutdown();
  } catch {
    /* telemetry is never a failure source */
  }
}
