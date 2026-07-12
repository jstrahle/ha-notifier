import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { tenants, users, topics, apiKeys } from './schema.js';
import { generateToken, hashSecret } from '../lib/tokens.js';
import { hashPassword } from '../lib/password.js';
import { subscribeUserToAllTopics } from '../lib/subscriptions.js';

/**
 * Idempotent bootstrap. Run once at install time (setup.sh calls this).
 * Reads the admin name/password from ADMIN_NAME / ADMIN_PASSWORD env vars.
 * Prints a freshly generated API key exactly once — it is not recoverable
 * later because only its hash is stored.
 */
async function seed(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  const { db, sql } = createDb(config.DATABASE_URL);

  try {
    // Tenant (single row for the MVP).
    let tenant = (await db.select().from(tenants).limit(1))[0];
    if (!tenant) {
      tenant = (
        await db.insert(tenants).values({ name: config.TENANT_NAME }).returning()
      )[0]!;
      console.log(`Created tenant "${tenant.name}" (${tenant.id})`);
    }

    // Admin user.
    const adminName = process.env.ADMIN_NAME ?? 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;
    const existingAdmin = (
      await db.select().from(users).where(eq(users.name, adminName)).limit(1)
    )[0];
    if (!existingAdmin) {
      if (!adminPassword) {
        throw new Error('ADMIN_PASSWORD env var is required to create the admin user');
      }
      const passwordHash = await hashPassword(adminPassword);
      await db.insert(users).values({
        tenantId: tenant.id,
        name: adminName,
        role: 'admin',
        passwordHash,
      });
      console.log(`Created admin user "${adminName}"`);
    }

    // Default topics.
    for (const name of ['security', 'general']) {
      const exists = (
        await db.select().from(topics).where(eq(topics.name, name)).limit(1)
      )[0];
      if (!exists) {
        await db.insert(topics).values({ tenantId: tenant.id, name });
        console.log(`Created topic "${name}"`);
      }
    }

    // Initial API key (only if none exist).
    const anyKey = (await db.select().from(apiKeys).limit(1))[0];
    if (!anyKey) {
      const plaintext = generateToken(24);
      await db.insert(apiKeys).values({
        tenantId: tenant.id,
        name: 'default-sender',
        keyHash: hashSecret(plaintext),
        scopes: ['notify'],
      });
      console.log('\n=== SAVE THIS API KEY (shown once) ===');
      console.log(plaintext);
      console.log('======================================\n');
    }

    // Ensure every user is subscribed to every topic. This is what makes the
    // service work out of the box: the router only delivers to users that have
    // a subscription row, so without this a fresh install delivers nothing.
    const allUsers = await db.select({ id: users.id }).from(users);
    for (const u of allUsers) {
      await subscribeUserToAllTopics(db, tenant.id, u.id);
    }
    console.log(`Ensured subscriptions for ${allUsers.length} user(s).`);

    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
