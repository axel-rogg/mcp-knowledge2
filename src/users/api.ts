// AS-3 K6: User registry — auto-provision, lookup, invite, erase.
//
// Spec: PLAN-as3-autonomous.md §1.2.
//
// K4 brought in `provisionFromGoogleLogin` + the basic lookups so the
// OAuth-facade's Google-callback could persist users. K6 finalises the
// surface (invite-issuance, list, markErased, purge-cron helper).
//
// All ops run under withAdminTx because the registry lives outside RLS
// (auth-layer reads it before any user-context is established).

import { eq } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { invites, users } from '../db/schema.ts';
import { errForbidden, errNotFound } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';
import type { UserRow } from '../db/schema.ts';
import { and, isNull } from 'drizzle-orm';

export interface GoogleLogin {
  sub: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

/**
 * Auto-provision a user from a fresh Google ID-token.
 *
 * Bootstrap-Rule (First-Login-First-Admin):
 *   - If the users table is empty, accept the login and set role='admin'.
 *   - Otherwise: the email must either already exist as a user row
 *     (suspended/erased rejected) OR have an unconsumed invite token.
 *     Unknown emails get HTTP 403.
 *
 * Idempotent on UNIQUE(email): re-running for the same Google login updates
 * google_sub/display_name/last_seen_at but never changes role.
 */
export async function provisionFromGoogleLogin(login: GoogleLogin): Promise<UserRow> {
  if (!login.emailVerified) {
    throw errForbidden('google email_verified must be true');
  }
  return withAdminTx(async (db) => {
    const existingByEmail = await db.select().from(users).where(eq(users.email, login.email)).limit(1);
    const existing = existingByEmail[0];
    if (existing) {
      if (existing.status !== 'active') {
        throw errForbidden(`user account is ${existing.status}`);
      }
      const patch: Partial<UserRow> = { lastSeenAt: nowMs() };
      if (!existing.googleSub) patch.googleSub = login.sub;
      if (login.displayName && !existing.displayName) patch.displayName = login.displayName;
      if (existing.inviteToken) patch.inviteToken = null;
      await db.update(users).set(patch).where(eq(users.id, existing.id));
      return { ...existing, ...patch };
    }

    // No existing user. Check the invite-or-bootstrap rule.
    const userCountRows = await db.select({ id: users.id }).from(users).limit(1);
    const isBootstrap = userCountRows.length === 0;

    if (!isBootstrap) {
      const inviteRows = await db
        .select()
        .from(invites)
        .where(and(eq(invites.email, login.email), isNull(invites.usedAt)))
        .limit(1);
      const invite = inviteRows[0];
      if (!invite || invite.expiresAt < nowMs()) {
        throw errForbidden('email not invited');
      }
      const now = nowMs();
      const inserted = await db
        .insert(users)
        .values({
          email: login.email,
          googleSub: login.sub,
          displayName: login.displayName,
          role: 'member',
          status: 'active',
          createdAt: now,
          lastSeenAt: now,
          invitedBy: invite.invitedBy,
        })
        .returning();
      await db.update(invites).set({ usedAt: now }).where(eq(invites.id, invite.id));
      const row = inserted[0];
      if (!row) throw errNotFound('user insert returned no row');
      logger.info({ userId: row.id, email: row.email }, 'provisioned invited user');
      return row;
    }

    // Bootstrap path: first-login becomes admin.
    const now = nowMs();
    const inserted = await db
      .insert(users)
      .values({
        email: login.email,
        googleSub: login.sub,
        displayName: login.displayName,
        role: 'admin',
        status: 'active',
        createdAt: now,
        lastSeenAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw errNotFound('user insert returned no row');
    logger.warn({ userId: row.id, email: row.email }, 'first-login-admin bootstrap');
    return row;
  });
}

export async function resolveByGoogleSub(sub: string): Promise<UserRow | null> {
  return withAdminTx(async (db) => {
    const rows = await db.select().from(users).where(eq(users.googleSub, sub)).limit(1);
    return rows[0] ?? null;
  });
}

export async function resolveByEmail(email: string): Promise<UserRow | null> {
  return withAdminTx(async (db) => {
    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ?? null;
  });
}

export async function resolveById(id: string): Promise<UserRow | null> {
  return withAdminTx(async (db) => {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  });
}
