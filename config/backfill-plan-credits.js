const path = require('path');
const mongoose = require('mongoose');
const { PLANS, applyPlanChange, buildPlanChangeDeps } = require('@librechat/api');
const { createModels, createMethods } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Brings every pre-existing account up to what the gate expects: an active
 * subscription, and a Balance holding its plan's grant.
 *
 * Needed once, when credit metering is switched on. Two separate holes leave
 * accounts unable to send a single message the moment enforcement lands, and
 * the gate reads a missing Balance as zero rather than as unlimited —
 * deliberately, so a grant that never landed cannot hand out free capacity:
 *
 *   no subscription at all — everyone who signed up through OAuth, because
 *     `createSocialUser` never called `applyPlanChange`. Granted the plan named
 *     by `--plan`.
 *   subscription but no Balance — signed up before the grant existed. Given
 *     their existing plan's credits.
 *
 * Idempotent by construction: the first case is skipped once a subscription
 * exists, the second once a Balance does. Neither tops up. GUEST accounts are
 * left alone — the anonymous trial is counted in messages, not credits.
 *
 * Usage:
 *   npm run backfill-plan-credits -- --dry           # report only, write nothing
 *   npm run backfill-plan-credits                    # subscription-less users → free
 *   npm run backfill-plan-credits -- --plan beta     # ...→ beta instead
 */
(async () => {
  await connect();
  createModels(mongoose);
  const methods = createMethods(mongoose);

  const dryRun = process.argv.includes('--dry');
  const planIndex = process.argv.indexOf('--plan');
  const targetPlan = planIndex > -1 ? process.argv[planIndex + 1] : 'free';

  if (PLANS[targetPlan] == null) {
    console.red(`Unknown --plan '${targetPlan}'. Known: ${Object.keys(PLANS).join(', ')}`);
    silentExit(1);
  }

  console.purple('----------------------------------------');
  console.purple(dryRun ? 'Backfill plan credits (DRY RUN)' : 'Backfill plan credits');
  console.purple(`Subscription-less users will be granted: ${targetPlan}`);
  console.purple('----------------------------------------');

  const Subscription = mongoose.models.Subscription;
  const Balance = mongoose.models.Balance;
  const User = mongoose.models.User;
  if (Subscription == null || Balance == null || User == null) {
    console.red('Subscription, Balance or User model is not registered — nothing to do.');
    silentExit(1);
  }

  const ENTITLED = ['active', 'trialing', 'admin_granted'];
  const tally = { adopted: 0, granted: 0, skipped: 0, noGrant: 0, unknownPlan: 0, credits: 0 };

  /**
   * Pass 1 — accounts with no entitled subscription at all. `applyPlanChange` is
   * the only sanctioned way to create one (see project CLAUDE.md), and it grants
   * the credits as its final step, so these need no second visit.
   */
  const users = await User.find({ role: { $ne: 'GUEST' } })
    .select('_id email')
    .lean();

  for (const user of users) {
    const sub = await Subscription.findOne({ user_id: user._id, status: { $in: ENTITLED } })
      .select('_id')
      .lean();
    if (sub != null) {
      continue;
    }
    if (!dryRun) {
      await applyPlanChange(
        { user_id: user._id, plan_code: targetPlan, source: 'cli' },
        buildPlanChangeDeps(methods),
      );
    }
    const label = user.email || String(user._id);
    console.green(`  ${label}: no subscription → ${targetPlan}`);
    tally.adopted++;
  }

  /** Pass 2 — subscriptions that predate the credit grant. */
  const subscriptions = await Subscription.find({ status: { $in: ENTITLED } })
    .select('user_id plan_code status')
    .lean();

  for (const sub of subscriptions) {
    const plan = PLANS[sub.plan_code];
    if (plan == null) {
      console.red(`  ${sub.user_id}: unknown plan '${sub.plan_code}' — skipped`);
      tally.unknownPlan++;
      continue;
    }

    const credits = plan.monthly_token_credits;
    if (credits <= 0) {
      /** anonymous is capped by message count, not credits. */
      tally.noGrant++;
      continue;
    }

    const existing = await Balance.findOne({ user: sub.user_id }).select('_id').lean();
    if (existing != null) {
      tally.skipped++;
      continue;
    }

    if (!dryRun) {
      await methods.grantMonthlyCredits({ userId: sub.user_id, credits });
    }
    console.green(`  ${sub.user_id}: ${sub.plan_code} → ${credits.toLocaleString()} credits`);
    tally.granted++;
    tally.credits += credits;
  }

  console.purple('----------------------------------------');
  console.cyan(`  new subs:      ${tally.adopted}`);
  console.cyan(`  granted:       ${tally.granted}`);
  console.cyan(`  already had:   ${tally.skipped}`);
  console.cyan(`  plan grants 0: ${tally.noGrant}`);
  if (tally.unknownPlan > 0) {
    console.red(`  unknown plan:  ${tally.unknownPlan}`);
  }
  console.cyan(`  total credits: ${tally.credits.toLocaleString()}`);
  if (dryRun) {
    console.orange('Dry run — nothing was written.');
  }

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }
  if (!err.message.includes('fetch failed')) {
    process.exit(1);
  }
});
