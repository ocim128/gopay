// Admin credential utility.
//
// Changes the panel admin login through the storage-agnostic DAL so the same
// command works against BOTH backends (SQLite and MongoDB). It is needed
// because ADMIN_USERNAME / ADMIN_PASSWORD in .env only seed the admin on first
// boot (when the user does not yet exist); afterwards the credentials live as a
// scrypt hash in the database, so .env edits have no effect.
//
// Passwords are hashed with the same scrypt encoder the app uses to verify
// them, so the result is always login-compatible.
//
// Usage:
//   node scripts/manage-admin.mjs --list
//   node scripts/manage-admin.mjs --user <name> --password <newPassword>
//   node scripts/manage-admin.mjs --user <oldName> --new-username <newName>
//   node scripts/manage-admin.mjs --user <name> --password <p> --create
//
// Flags:
//   --user <name>          Existing admin username to act on (required unless --list).
//   --password <value>     Set a new password for that user.
//   --new-username <name>  Rename the user to this username.
//   --create               Create the user if it does not exist (needs --password).
//   --backend <sqlite|mongodb>  Override STORAGE_BACKEND (default: from env).
//   --db <path>            SQLite database path (SQLite only; defaults to
//                           $DB_PATH or data/panel.db).
//   --mongo-uri <uri>      MongoDB URI (required for --backend mongodb when
//                           $MONGODB_URI is unset; must include a db name).
//   --list                 Print existing admin usernames and exit.
//
// A rename and a password change can be combined in one call.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { createDal } from '../src/dal/index.js';
import { hashPasswordSync } from '../src/auth/hashing.js';

/** Minimal `--flag value` / `--flag` parser. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * Run an async main and exit with the right code on success or failure.
 *
 * @param {() => Promise<void>} fn
 */
async function run(fn) {
  try {
    await fn();
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err?.message ?? err}`);
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));

run(async () => {
  // Resolve the backend the same way the server does, with CLI overrides.
  const backend =
    args.backend === 'sqlite' || args.backend === 'mongodb'
      ? args.backend
      : process.env.STORAGE_BACKEND ?? 'sqlite';

  /** @type {import('../src/dal/index.js').CreateDalOptions} */
  const dalOptions = { backend };
  if (backend === 'sqlite') {
    dalOptions.dbPath = args.db ?? process.env.DB_PATH ?? 'data/panel.db';
  } else {
    const uri = args['mongo-uri'] ?? process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "--backend mongodb requires --mongo-uri <uri> or MONGODB_URI in the environment.",
      );
    }
    dalOptions.mongoUri = uri;
  }

  const storage = await createDal(dalOptions);
  try {
    if (args.list) {
      const rows = await storage.adminUsers.listUsernames();
      const where =
        backend === 'mongodb'
          ? `the configured MongoDB database`
          : (dalOptions.dbPath ?? '');
      if (rows.length === 0) {
        console.log(`No admin users in ${where}.`);
      } else {
        console.log(`Admin users in ${where}:`);
        for (const r of rows) {
          console.log(`  - ${r.username}`);
        }
      }
      return;
    }

    const username = typeof args.user === 'string' ? args.user : null;
    if (!username) {
      throw new Error('--user <name> is required (or use --list). See the header for usage.');
    }

    const newUsername = typeof args['new-username'] === 'string' ? args['new-username'] : null;
    const newPassword = typeof args.password === 'string' ? args.password : null;

    if (!newUsername && !newPassword) {
      throw new Error('nothing to do: pass --password and/or --new-username.');
    }

    const existing = await storage.adminUsers.getByUsername(username);

    if (!existing) {
      if (!args.create) {
        throw new Error(
          `admin user '${username}' not found. Pass --create (with --password) to create it.`,
        );
      }
      if (!newPassword) {
        throw new Error('--create requires --password.');
      }
      // Create via ensure() so the insert is idempotent and races safely.
      await storage.adminUsers.ensure({
        id: randomUUID(),
        username: newUsername ?? username,
        passwordHash: hashPasswordSync(newPassword),
      });
      console.log(`Created admin user '${newUsername ?? username}'.`);
      // Clear all IP lockouts on a credential change (matches prior behaviour).
      await storage.loginAttempts.clearAll();
      return;
    }

    // Update path (rename and/or password).
    const result = await storage.adminUsers.updateCredentials({
      currentUsername: username,
      newUsername: newUsername ?? undefined,
      passwordHash: newPassword ? hashPasswordSync(newPassword) : undefined,
    });
    if (!result.ok) {
      const code = result.code ?? 'UNKNOWN';
      if (code === 'USERNAME_IN_USE') {
        throw new Error(`cannot rename: username '${newUsername}' already exists.`);
      }
      if (code === 'ADMIN_NOT_FOUND') {
        throw new Error(`admin user '${username}' not found.`);
      }
      throw new Error(`update failed: ${code}`);
    }

    // Clear all IP-based lockout counters when managing the admin account.
    await storage.loginAttempts.clearAll();

    const parts = [];
    if (newUsername) parts.push(`username -> '${newUsername}'`);
    if (newPassword) parts.push('password updated');
    console.log(`Updated admin '${username}' (${parts.join(', ')}).`);
  } finally {
    await storage.close();
  }
});
