const path = require('path');
const mongoose = require('mongoose');
const { spendableCredits } = require('@librechat/data-schemas');
const { User, Balance } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('-----------------------------');
  console.purple('Show the balance of all users');
  console.purple('-----------------------------');

  let users = await User.find({});
  for (const user of users) {
    let balance = await Balance.findOne({ user: user._id });
    if (balance !== null) {
      /** Both buckets, split out: a top-up is invisible in `tokenCredits`, and
       *  reading this list as the whole balance is the point of running it. */
      const purchased = balance.purchasedCredits ?? 0;
      const suffix =
        purchased > 0 ? ` (${balance.tokenCredits} granted + ${purchased} bought)` : '';
      console.green(
        `User ${user.name} (${user.email}) has a balance of ${spendableCredits(balance)}${suffix}`,
      );
    } else {
      console.yellow(`User ${user.name} (${user.email}) has no balance`);
    }
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
