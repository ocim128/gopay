// Admin credential utility.
//
// Changes the panel admin login directly in the SQLite database. This is
// needed because ADMIN_USERNAME / ADMIN_PASSWORD in .env only seed the admin
// on first boot (when the user does not yet exist); afterwards the credentials
// live as a scrypt hash in the database, so .env edits have no effect.
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
//   --db <path>            Database path (defaults to $DB_PATH or data/panel.db).
//   --list                 Print existing admin usernames and exit.
//
// A rename and a password change can be combined in one call.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { hashPasswordSync } from '../src/auth/hashing.js';

/** Minimal `--flag value` / `--flag` parser. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ?? process.env.DB_PATH ?? 'data/panel.db';
const db = new Database(dbPath);

function fail(message) {
  console.error(`Error: ${message}`);
  db.close();
  process.exit(1);
}

try {
  if (args.list) {
    const rows = db.prepare('SELECT username FROM admin_users').all();
    if (rows.length === 0) {
      console.log(`No admin users in ${dbPath}.`);
    } else {
      console.log(`Admin users in ${dbPath}:`);
      for (const r of rows) {
        console.log(`  - ${r.username}`);
      }
    }
    db.close();
    process.exit(0);
  }

  const username = typeof args.user === 'string' ? args.user : null;
  if (!username) {
    fail('--user <name> is required (or use --list). See the header for usage.');
  }

  const newUsername = typeof args['new-username'] === 'string' ? args['new-username'] : null;
  const newPassword = typeof args.password === 'string' ? args.password : null;

  if (!newUsername && !newPassword) {
    fail('nothing to do: pass --password and/or --new-username.');
  }

  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);

  // Create path.
  if (!existing) {
    if (!args.create) {
      fail(`admin user '${username}' not found. Pass --create (with --password) to create it.`);
    }
    if (!newPassword) {
      fail('--create requires --password.');
    }
    db.prepare(
      `INSERT INTO admin_users (id, username, password_hash)
       VALUES (?, ?, ?)`,
    ).run(randomUUID(), newUsername ?? username, hashPasswordSync(newPassword));
    console.log(`Created admin user '${newUsername ?? username}' in ${dbPath}.`);
    db.close();
    process.exit(0);
  }

  // Update path (rename and/or password). Always clear lockout counters.
  if (newUsername && newUsername !== username) {
    const clash = db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(newUsername);
    if (clash) {
      fail(`cannot rename: username '${newUsername}' already exists.`);
    }
  }

  const sets = [];
  const params = {};
  if (newUsername) {
    sets.push('username = @newUsername');
    params.newUsername = newUsername;
  }
  if (newPassword) {
    sets.push('password_hash = @passwordHash');
    params.passwordHash = hashPasswordSync(newPassword);
  }
  params.username = username;

  let changes = 0;
  if (sets.length > 0) {
    const info = db
      .prepare(`UPDATE admin_users SET ${sets.join(', ')} WHERE username = @username`)
      .run(params);
    changes = info.changes;
  }

  // Clear all IP-based lockout counters when managing the admin account
  db.prepare('DELETE FROM login_attempts').run();

  const parts = [];
  if (newUsername) parts.push(`username -> '${newUsername}'`);
  if (newPassword) parts.push('password updated');
  console.log(`Updated admin '${username}' (${changes} row): ${parts.join(', ')}.`);
} finally {
  if (db.open) db.close();
}
