const path = require('path');
const mongoose = require('mongoose');
const { PLANS } = require('@librechat/api');
const { createModels, createMethods } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Grants each existing user the credit balance their current plan entitles them
 * to, and arms monthly auto-refill.
 *
 * Needed once, when credit metering is switched on: `applyPlanChange` grants
 * credits going forward, but users who subscribed before that code existed have
 * no Balance document. Since the gate reads a missing row as zero — deliberately,
 * so a failed grant can't hand out free capacity — they would all be refused
 * until they happened to change plans.
 *
 * Idempotent: users who already hold a Balance are skipped, never topped up. Run
 * it twice and the second run reports every user as skipped.
 *
 * Usage:
 *   npm run backfill-plan-credits           # apply
 *   npm run backfill-plan-credits -- --dry  # report only, write nothing
 */
(async () => {
  await connect();
  createModels(mongoose);
  const methods = createMethods(mongoose);

  const dryRun = process.argv.includes('--dry');

  console.purple('----------------------------------------');
  console.purple(dryRun ? 'Backfill plan credits (DRY RUN)' : 'Backfill plan credits');
  console.purple('----------------------------------------');

  const Subscription = mongoose.models.Subscription;
  const Balance = mongoose.models.Balance;
  if (Subscription == null || Balance == null) {
    console.red('Subscription or Balance model is not registered — nothing to do.');
    silentExit(1);
  }

  /** Only currently-entitled subscriptions; expired ones grant nothing. */
  const subscriptions = await Subscription.find({
    status: { $in: ['active', 'trialing', 'admin_granted'] },
  })
    .select('user_id plan_code status')
    .lean();

  if (subscriptions.length === 0) {
    console.orange('No active subscriptions found.');
    silentExit(0);
  }

  const tally = { granted: 0, skipped: 0, noGrant: 0, unknownPlan: 0, credits: 0 };

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
