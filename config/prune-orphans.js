const path = require('path');
const mongoose = require('mongoose');
const { createModels, createMethods } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Clears what the removed anonymous-visitor system left behind.
 *
 * Three kinds:
 *
 *   leftover accounts — `role: 'GUEST'`, created silently for visitors who
 *     never signed in. The feature is gone; the rows are not.
 *   orphans — rows whose owning user no longer exists. An anonymous `User`
 *     carried a 7-day TTL, and MongoDB's TTL monitor removes only the row it is
 *     set on: conversations, messages, files, subscriptions and quotas
 *     referencing it all survived it.
 *   inert quotas — `applyPlanChange` briefly created a period-aligned row on
 *     every plan change that nothing ever read. The gate counts against a
 *     single `period_start: new Date(0)` row per user.
 *
 * Usage:
 *   npm run prune-orphans            # report only, write nothing
 *   npm run prune-orphans -- --apply # delete
 */

/**
 * Collections keyed by a plain `user` field.
 *
 * `transactions` is deliberately absent. Cost auditing aggregates that
 * collection at read time and there is no second copy of it, so an orphaned row
 * is still the only record that money was spent — the account it belonged to
 * being gone does not make the spending un-happen. The rows carry a user id,
 * a model and token counts; no message content and, for the anonymous accounts
 * these came from, no personal detail either.
 */
const USER_OWNED = ['conversations', 'messages', 'files', 'balances'];
/** Collections keyed by `user_id`. */
const USER_ID_OWNED = ['subscriptions', 'quotas'];

(async () => {
  await connect();
  createModels(mongoose);
  const db = createMethods(mongoose);

  const apply = process.argv.includes('--apply');

  console.purple('----------------------------------------');
  console.purple(apply ? 'Prune anonymous remnants' : 'Prune anonymous remnants (DRY RUN)');
  console.purple('----------------------------------------');

  const { User } = mongoose.models;
  if (User == null) {
    console.red('User model is not registered — nothing to do.');
    return silentExit(1);
  }

  const allUsers = await User.find({}).select('_id role email').lean();
  /**
   * The one failure mode worth guarding. Every deletion below is justified by
   * "no user owns this row", so an empty or unreadable users collection turns
   * this into `deleteMany({})` against half the database.
   */
  if (allUsers.length === 0) {
    console.red('Refusing to run: the users collection is empty.');
    console.red('Every deletion here is keyed to "no such user", so this would clear everything.');
    return silentExit(1);
  }

  const guests = allUsers.filter((u) => u.role === 'GUEST');
  const keepers = allUsers.filter((u) => u.role !== 'GUEST');
  /**
   * Built from the accounts that must survive, not from the ones being removed.
   * A row is deleted only if its owner is absent from this set — so a real
   * user's data cannot be caught by a mistake in how guests are identified.
   */
  const keep = new Set(keepers.map((u) => String(u._id)));

  console.cyan(`  accounts kept:    ${keepers.length}`);
  console.cyan(`  guest accounts:   ${guests.length} (to remove)`);

  if (keepers.length === 0) {
    console.red('Refusing to run: every account looks like a guest.');
    return silentExit(1);
  }

  const orphanIdsByCollection = {};
  let orphanTotal = 0;

  for (const [name, field] of [
    ...USER_OWNED.map((c) => [c, 'user']),
    ...USER_ID_OWNED.map((c) => [c, 'user_id']),
  ]) {
    const collection = mongoose.connection.collection(name);
    const docs = await collection
      .find({})
      .project({ [field]: 1 })
      .toArray();
    const orphans = docs.filter((d) => !keep.has(String(d[field])));
    orphanIdsByCollection[name] = orphans.map((d) => d._id);
    orphanTotal += orphans.length;
    console.cyan(`  ${name.padEnd(14)} ${String(orphans.length).padStart(5)} / ${docs.length}`);
  }

  /** Inert only when the owner survives — an orphaned one is already counted. */
  const quotas = await mongoose.connection
    .collection('quotas')
    .find({})
    .project({ user_id: 1, period_start: 1 })
    .toArray();
  const inertQuotaIds = quotas
    .filter((q) => keep.has(String(q.user_id)) && new Date(q.period_start).getTime() !== 0)
    .map((q) => q._id);
  console.cyan(
    `  inert quotas   ${String(inertQuotaIds.length).padStart(5)} (live users, never read)`,
  );

  if (!apply) {
    console.purple('----------------------------------------');
    console.orange(
      `Dry run — would remove ${guests.length} guest accounts, ${orphanTotal} orphan rows, ` +
        `${inertQuotaIds.length} inert quotas.`,
    );
    console.orange('Re-run with --apply to delete.');
    return silentExit(0);
  }

  /**
   * Guest accounts go through the same cascade a user's own account deletion
   * uses, rather than a second list of collections written here. Maintaining
   * two lists is what produced these orphans in the first place.
   */
  for (const guest of guests) {
    const uid = String(guest._id);
    await Promise.all([
      db.deleteMessages({ user: uid }),
      db.deleteConvos(uid).catch(() => undefined),
      db.deleteFiles(null, uid),
      db.deleteBalances({ user: guest._id }),
      /** No `deleteTransactions` — see `USER_OWNED`. */
      db.deleteBillingRecords(guest._id),
      db.deleteAllUserSessions({ userId: uid }),
    ]);
    await User.deleteOne({ _id: guest._id });
  }
  console.green(`  removed ${guests.length} guest accounts and their content`);

  for (const [name, ids] of Object.entries(orphanIdsByCollection)) {
    if (ids.length === 0) {
      continue;
    }
    const res = await mongoose.connection.collection(name).deleteMany({ _id: { $in: ids } });
    console.green(`  ${name.padEnd(14)} deleted ${res.deletedCount}`);
  }

  if (inertQuotaIds.length > 0) {
    const res = await mongoose.connection
      .collection('quotas')
      .deleteMany({ _id: { $in: inertQuotaIds } });
    console.green(`  inert quotas   deleted ${res.deletedCount}`);
  }

  /**
   * The TTL index this fork briefly added for anonymous billing rows. The field
   * is gone from the schema, so the index matches nothing — harmless, but it
   * would outlive every explanation of why it exists.
   */
  for (const name of ['subscriptions', 'quotas']) {
    try {
      await mongoose.connection.collection(name).dropIndex('expiresAt_1');
      console.green(`  ${name.padEnd(14)} dropped stale expiresAt_1 index`);
    } catch {
      /* not present — nothing to drop */
    }
  }

  console.purple('----------------------------------------');
  console.green(`  users remaining: ${await User.countDocuments()}`);
  for (const name of [...USER_OWNED, ...USER_ID_OWNED]) {
    console.green(
      `  ${name.padEnd(14)} remaining ${await mongoose.connection.collection(name).countDocuments()}`,
    );
  }
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
