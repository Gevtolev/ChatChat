const path = require('path');
const mongoose = require('mongoose');
const { SystemRoles } = require('librechat-data-provider');
const { createModels } = require('@librechat/data-schemas');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Changes a user's role.
 *
 * The role is what the capability layer resolves system grants against, so
 * promoting to ADMIN hands over every capability granted to that role — user
 * management, role management and config management included, not just the
 * admin screens someone asked for. To give one person a narrow slice instead,
 * grant the individual capabilities against their user principal rather than
 * moving them to ADMIN.
 *
 * The role lives in the JWT, so the change only takes effect after the user
 * signs out and back in.
 *
 * Usage:
 *   npm run set-role <email> <role>
 *   npm run set-role                  # prompts for both
 */
(async () => {
  await connect();
  createModels(mongoose);

  const User = mongoose.models.User;
  const roles = Object.values(SystemRoles);

  console.purple('--------------------------');
  console.purple("Set a user's role");
  console.purple('--------------------------');

  let email = '';
  let role = '';
  if (process.argv.length >= 4) {
    email = process.argv[2];
    role = process.argv[3];
  } else {
    console.orange('Usage: npm run set-role <email> <role>');
    console.orange(`role must be one of: ${roles.join(', ')}`);
    console.orange('Note: if you do not pass in the arguments, you will be prompted for them.');
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
  console.purple(`Found user: ${user.email} (current role: ${user.role ?? 'none'})`);

  if (!role) {
    role = await askQuestion(`Role (${roles.join(', ')}):`);
  }
  if (!roles.includes(role)) {
    console.red(`Error: Unknown role "${role}". Must be one of: ${roles.join(', ')}`);
    silentExit(1);
  }

  if (user.role === role) {
    console.orange(`${user.email} already has role ${role} — nothing to do.`);
    silentExit(0);
  }

  /** ADMIN is not a single permission. Show what it actually carries so the
   *  decision is made with the real scope in view, not the intended one. */
  if (role === SystemRoles.ADMIN) {
    console.orange('\nADMIN carries every capability granted to that role, which on a');
    console.orange('default install includes managing users, roles and configs — not just');
    console.orange('read access to the admin screens.');
    const confirm = await askQuestion(`Promote ${user.email} to ADMIN? (yes/no):`);
    if (confirm.trim().toLowerCase() !== 'yes') {
      console.orange('Aborted — nothing was changed.');
      silentExit(0);
    }
  }

  const result = await User.updateOne({ _id: user._id }, { $set: { role } });
  if (result.modifiedCount !== 1) {
    console.red(`Error: expected to modify 1 document, modified ${result.modifiedCount}.`);
    silentExit(1);
  }

  console.green(`\n${user.email}: ${user.role ?? 'none'} → ${role}`);
  console.orange('The role is carried in the JWT — they must sign out and back in for');
  console.orange('this to take effect.');

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
