const path = require('path');
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Clears billing rows that no longer belong to anything.
 *
 * Two kinds, both left behind by the same omission — `Subscription` and `Quota`
 * arrived with plan gating and were never added to any deletion path:
 *
 *   orphans — the user is gone. Anonymous visitors are the bulk of it: their
 *     `User` carries a 7-day TTL and MongoDB's TTL monitor removes only the row
 *     it is set on, never the rows referencing it.
 *   period-aligned quotas — `applyPlanChange` used to create one on every plan
 *     change, and nothing ever read it. The gate counts against a single
 *     `period_start: new Date(0)` row per user and paid plans have no message
 *     limit at all, so every row with any other `period_start` is inert.
 *
 * Both classes stop being produced by the same change that adds this script;
 * this clears what accumulated before it.
 *
 * Usage:
 *   npm run prune-orphans            # report only, write nothing
 *   npm run prune-orphans -- --apply # delete
 */
(async () => {
  await connect();
  createModels(mongoose);

  const apply = process.argv.includes('--apply');

  console.purple('----------------------------------------');
  console.purple(apply ? 'Prune orphaned billing rows' : 'Prune orphaned billing rows (DRY RUN)');
  console.purple('----------------------------------------');

  const { User, Subscription, Quota } = mongoose.models;
  if (User == null || Subscription == null || Quota == null) {
    console.red('User, Subscription or Quota model is not registered — nothing to do.');
    silentExit(1);
  }

  const userIds = await User.find({}).select('_id').lean();
  /**
   * The one failure mode worth guarding. Every deletion below is justified by
   * "no user owns this row", so an empty or unreadable users collection turns
   * the script into `deleteMany({})` against both tables. A real deployment
   * always has at least one account.
   */
  if (userIds.length === 0) {
    console.red('Refusing to run: the users collection is empty.');
    console.red('Every deletion here is keyed to "no such user", so this would clear both tables.');
    silentExit(1);
  }
  console.cyan(`  users found: ${userIds.length}`);

  const live = new Set(userIds.map((u) => String(u._id)));
  const isOrphan = (doc) => !live.has(String(doc.user_id));

  const subs = await Subscription.find({}).select('_id user_id plan_code status').lean();
  const quotas = await Quota.find({}).select('_id user_id period_start').lean();

  const orphanSubs = subs.filter(isOrphan);
  const orphanQuotas = quotas.filter(isOrphan);
  /** Not `!== 0`: `period_start` is a Date, and the epoch row is the only one
   *  the gate ever reads. */
  const inertQuotas = quotas.filter(
    (q) => new Date(q.period_start).getTime() !== 0 && !isOrphan(q),
  );

  console.purple('----------------------------------------');
  console.cyan(`  orphaned subscriptions: ${orphanSubs.length} / ${subs.length}`);
  console.cyan(`  orphaned quotas:        ${orphanQuotas.length} / ${quotas.length}`);
  console.cyan(`  inert period quotas:    ${inertQuotas.length} (live users, never read)`);

  const byPlan = orphanSubs.reduce((acc, s) => {
    acc[s.plan_code] = (acc[s.plan_code] ?? 0) + 1;
    return acc;
  }, {});
  for (const [plan, n] of Object.entries(byPlan)) {
    console.cyan(`    orphan plan '${plan}': ${n}`);
  }

  const subIds = orphanSubs.map((s) => s._id);
  const quotaIds = [...orphanQuotas, ...inertQuotas].map((q) => q._id);

  if (!apply) {
    console.purple('----------------------------------------');
    console.orange(
      `Dry run — would delete ${subIds.length} subscriptions, ${quotaIds.length} quotas.`,
    );
    console.orange('Re-run with --apply to delete.');
    return silentExit(0);
  }

  const [subResult, quotaResult] = await Promise.all([
    subIds.length > 0 ? Subscription.deleteMany({ _id: { $in: subIds } }) : { deletedCount: 0 },
    quotaIds.length > 0 ? Quota.deleteMany({ _id: { $in: quotaIds } }) : { deletedCount: 0 },
  ]);

  console.purple('----------------------------------------');
  console.green(`  deleted subscriptions: ${subResult.deletedCount}`);
  console.green(`  deleted quotas:        ${quotaResult.deletedCount}`);
  console.green(`  remaining subscriptions: ${await Subscription.countDocuments()}`);
  console.green(`  remaining quotas:        ${await Quota.countDocuments()}`);
  return silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
