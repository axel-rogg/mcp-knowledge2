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

import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { invites, users } from '../db/schema.ts';
import { errForbidden, errNotFound } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';
import type { InviteRow, UserRow } from '../db/schema.ts';

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

// ─── Admin operations ─────────────────────────────────────────────────────

export interface ListUsersOpts {
  status?: 'active' | 'suspended' | 'erased';
  limit?: number;
}

/** Caller is responsible for restricting access — these ops bypass RLS. */
export async function listUsers(opts: ListUsersOpts = {}): Promise<UserRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  return withAdminTx(async (db) => {
    if (opts.status) {
      return db.select().from(users).where(eq(users.status, opts.status)).limit(limit);
    }
    return db.select().from(users).limit(limit);
  });
}

export async function setUserRole(userId: string, role: 'admin' | 'member'): Promise<UserRow> {
  const row = await withAdminTx(async (db) => {
    const updated = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
    return updated[0] ?? null;
  });
  if (!row) throw errNotFound('user not found');
  return row;
}

export async function setUserStatus(
  userId: string,
  status: 'active' | 'suspended' | 'erased',
): Promise<UserRow> {
  const row = await withAdminTx(async (db) => {
    const updated = await db.update(users).set({ status }).where(eq(users.id, userId)).returning();
    return updated[0] ?? null;
  });
  if (!row) throw errNotFound('user not found');
  return row;
}

export interface InviteUserInput {
  email: string;
  invitedBy: string;
  ttlSeconds?: number;
}

const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 3600;

export async function inviteUser(input: InviteUserInput): Promise<InviteRow> {
  const token = randomBytes(32).toString('base64url');
  const now = nowMs();
  const ttl = (input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000;
  const row = await withAdminTx(async (db) => {
    const inserted = await db
      .insert(invites)
      .values({
        email: input.email,
        token,
        invitedBy: input.invitedBy,
        expiresAt: now + ttl,
        createdAt: now,
      })
      .returning();
    return inserted[0] ?? null;
  });
  if (!row) throw errNotFound('invite insert returned no row');
  logger.info({ inviteId: row.id, email: row.email }, 'invite issued');
  return row;
}

export async function listInvites(opts: { includeUsed?: boolean; limit?: number } = {}): Promise<InviteRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  return withAdminTx(async (db) => {
    if (opts.includeUsed) {
      return db.select().from(invites).limit(limit);
    }
    return db.select().from(invites).where(isNull(invites.usedAt)).limit(limit);
  });
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await withAdminTx(async (db) => {
    await db.delete(invites).where(eq(invites.id, inviteId));
  });
}

/** Cron-friendly: purge invites that have never been used and are expired. */
export async function purgeExpiredInvites(): Promise<number> {
  return withAdminTx(async (db) => {
    const out = await db
      .delete(invites)
      .where(and(isNull(invites.usedAt), lt(invites.expiresAt, nowMs())))
      .returning();
    return out.length;
  });
}

/**
 * Companion for /v1/internal/erase-user — the hard data-erasure path
 * lives in routes/internal.ts; here we mark the row as erased and break
 * the email/google_sub links so re-login can't accidentally re-attach.
 */
export async function markUserErased(userId: string): Promise<void> {
  await withAdminTx(async (db) => {
    await db
      .update(users)
      .set({
        status: 'erased',
        googleSub: null,
        inviteToken: null,
        displayName: null,
      })
      .where(eq(users.id, userId));
  });
}

// ─── User-Sync from approval2 (AS-3 A11 ↔ K-side) ─────────────────────────

export interface UserSyncInput {
  /** approval2-side users.id. We mirror it in `invite_token` for cross-ref. */
  readonly approval2UserId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'suspended' | 'erased';
  readonly externalId?: string;
}

export interface UserSyncOutput {
  readonly status: 'created' | 'updated' | 'unchanged';
  readonly kcUserId: string;
}

/**
 * Push-mode user-sync from approval2 (PLAN-as3-autonomous.md §2.2).
 *
 * approval2 is the User-Owner; KC2 mirrors state by email. Idempotent —
 * re-running with the same payload returns `unchanged`. Status transitions
 * (active → suspended → erased) are honoured; erased rows are not
 * resurrected to active by a sync call (caller must use a separate
 * re-invitation path).
 *
 * Auth: caller wraps this in /v1/internal/users/sync with service-token
 * middleware. NOT exposed via OBO — admin-call only.
 */
export async function syncFromApproval2(input: UserSyncInput): Promise<UserSyncOutput> {
  return withAdminTx(async (db) => {
    const existingByEmail = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    const existing = existingByEmail[0];
    const now = nowMs();

    if (!existing) {
      const inserted = await db
        .insert(users)
        .values({
          email: input.email,
          displayName: input.displayName,
          role: 'member',
          status: input.status,
          createdAt: now,
          lastSeenAt: now,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw errNotFound('users insert returned no row');
      logger.info(
        { kcUserId: row.id, approval2UserId: input.approval2UserId, email: row.email },
        'user-sync: created',
      );
      return { status: 'created', kcUserId: row.id };
    }

    // Determine whether we have a real diff. Erased rows: no-op
    // (idempotent state).
    if (existing.status === 'erased') {
      return { status: 'unchanged', kcUserId: existing.id };
    }

    const patch: Partial<UserRow> = {};
    if (existing.status !== input.status) patch.status = input.status;
    if ((existing.displayName ?? null) !== (input.displayName ?? null)) {
      patch.displayName = input.displayName;
    }
    if (Object.keys(patch).length === 0) {
      return { status: 'unchanged', kcUserId: existing.id };
    }
    await db.update(users).set(patch).where(eq(users.id, existing.id));
    logger.info(
      {
        kcUserId: existing.id,
        approval2UserId: input.approval2UserId,
        email: existing.email,
        patchKeys: Object.keys(patch),
      },
      'user-sync: updated',
    );
    return { status: 'updated', kcUserId: existing.id };
  });
}
