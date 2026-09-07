const path = require('path');
const mongoose = require('mongoose');
const { CREDIT_DISPLAY_DIVISOR } = require('librechat-data-provider');
const { createModels, createMethods } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  const { User } = createModels(mongoose);
  const methods = createMethods(mongoose);

  console.purple('--------------------------');
  console.purple('Grant purchased credits to a user!');
  console.purple('--------------------------');

  let email = '';
  let credits = '';
  if (process.argv.length >= 4) {
    email = process.argv[2];
    credits = process.argv[3];
  } else {
    console.orange('Usage: npm run grant-credits <email> <credits>');
    console.orange('<credits> is the number the customer sees — a 1,000,000-credit top-up is');
    console.orange('entered as 1000000, not as its internal cost value.');
    console.purple('--------------------------');
  }

  if (!email) {
    email = await askQuestion('Email:');
  }
  if (!email.includes('@')) {
    console.red('Error: Invalid email address!');
    silentExit(1);
  }

  const user = await User.findOne({ email }).lean();
  if (!user) {
    console.red('Error: No user with that email was found!');
    silentExit(1);
  }
  console.purple(`Found user: ${user.email}`);

  if (!credits) {
    credits = await askQuestion('Display credits to grant:');
  }
  const displayCredits = Number(credits);
  if (!Number.isFinite(displayCredits) || displayCredits <= 0) {
    console.red(`Error: credits must be a positive number, got "${credits}"`);
    silentExit(1);
  }

  /**
   * Purchased credits are stored in the same internal cost unit as the monthly
   * grant, so the customer-facing number has to be scaled here rather than at
   * the point of sale — the divisor is the only place the two units meet.
   */
  const tokenCredits = Math.round(displayCredits * CREDIT_DISPLAY_DIVISOR);

  let total;
  try {
    total = await methods.grantPurchasedCredits({ userId: user._id, credits: tokenCredits });
  } catch (error) {
    console.red('Error: ' + error.message);
    console.error(error);
    silentExit(1);
  }

  console.green('Credits granted successfully!');
  console.purple(
    `Granted ${displayCredits.toLocaleString()} credits — purchased balance is now ${Math.floor(
      total / CREDIT_DISPLAY_DIVISOR,
    ).toLocaleString()} credits.`,
  );
  console.purple('These do not expire at the monthly renewal, unlike the plan allowance.');
  silentExit(0);
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
