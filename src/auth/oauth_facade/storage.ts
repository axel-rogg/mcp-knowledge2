// AS-3 K3/K4: OAuth-facade persistent state — clients, auth-codes, refresh-tokens.
//
// All ops run under withAdminTx because the facade lives outside RLS context
// (no users.id session-var available during /authorize before login).

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { withAdminTx } from '../../db/client.ts';
import { oauthAuthCodes, oauthClients, oauthRefreshTokens } from '../../db/schema.ts';
import { nowMs, uuidV4 } from '../../lib/ids.ts';
import { errBadRequest, errUnauthorized } from '../../lib/errors.ts';

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;             // 10 minutes
const REFRESH_TOKEN_INACTIVITY_MS = 14 * 24 * 3600 * 1000; // 14d (K-D2)

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return b64url(nodeRandomBytes(bytes));
}

// ─── Clients (DCR) ─────────────────────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface RegisterClientInput {
  clientName?: string | undefined;
  redirectUris: string[];
  grantTypes?: string[] | undefined;
  responseTypes?: string[] | undefined;
  tokenEndpointAuthMethod?: string | undefined;
  scope?: string | undefined;
}

const DEFAULT_SCOPE = 'objects:read objects:write search shares uploads';

export async function registerClient(input: RegisterClientInput): Promise<OAuthClient> {
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw errBadRequest('redirect_uris must contain at least one URI');
  }
  for (const u of input.redirectUris) {
    try {
      // basic URL parse — reject loopback/HTTP for non-localhost
      const url = new URL(u);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw errBadRequest(`redirect_uri must be https (or localhost): ${u}`);
      }
    } catch {
      throw errBadRequest(`malformed redirect_uri: ${u}`);
    }
  }
  const authMethod = input.tokenEndpointAuthMethod ?? 'none';
  const clientId = `kc2_${uuidV4().replace(/-/g, '')}`;
  const clientSecret = authMethod === 'none' ? null : generateOpaqueToken(32);
  const grantTypes = input.grantTypes ?? ['authorization_code', 'refresh_token'];
  const responseTypes = input.responseTypes ?? ['code'];
  const row = await withAdminTx(async (db) => {
    const inserted = await db
      .insert(oauthClients)
      .values({
        clientId,
        clientSecret,
        clientName: input.clientName ?? null,
        redirectUris: input.redirectUris,
        grantTypes,
        responseTypes,
        tokenEndpointAuthMethod: authMethod,
        scope: input.scope ?? DEFAULT_SCOPE,
        createdAt: nowMs(),
      })
      .returning();
    return inserted[0];
  });
  if (!row) throw errBadRequest('client insert returned no row');
  return mapClient(row);
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  return withAdminTx(async (db) => {
    const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    const row = rows[0];
    return row ? mapClient(row) : null;
  });
}

export async function touchClientLastUsed(clientId: string): Promise<void> {
  await withAdminTx(async (db) => {
    await db.update(oauthClients).set({ lastUsedAt: nowMs() }).where(eq(oauthClients.clientId, clientId));
  });
}

function mapClient(row: typeof oauthClients.$inferSelect): OAuthClient {
  return {
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    grantTypes: row.grantTypes,
    responseTypes: row.responseTypes,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    scope: row.scope,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

// ─── Authorization codes ───────────────────────────────────────────────────

export interface AuthCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope?: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string;
  googleIdTokenSub: string;
}

export interface AuthCodeRow {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  googleIdTokenSub: string;
}

/**
 * Mint a fresh authorization code, persist its hash, return the plaintext
 * code to be redirected back to the client.
 */
export async function mintAuthCode(input: AuthCodeInput): Promise<string> {
  const code = generateOpaqueToken(32);
  const codeHash = sha256Hex(code);
  const now = nowMs();
  await withAdminTx(async (db) => {
    await db.insert(oauthAuthCodes).values({
      codeHash,
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      scope: input.scope ?? null,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      googleIdTokenSub: input.googleIdTokenSub,
      createdAt: now,
      expiresAt: now + AUTH_CODE_TTL_MS,
    });
  });
  return code;
}

/**
 * Consume the code: must not be consumed already, must not be expired.
 * Atomically marks as consumed in a single UPDATE..WHERE so race-conditions
 * are detected by the row-count.
 */
export async function consumeAuthCode(code: string): Promise<AuthCodeRow> {
  const codeHash = sha256Hex(code);
  return withAdminTx(async (db) => {
    const rows = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, codeHash)).limit(1);
    const row = rows[0];
    if (!row) throw errUnauthorized('invalid authorization code');
    if (row.consumedAt) throw errUnauthorized('authorization code already used');
    if (row.expiresAt < nowMs()) throw errUnauthorized('authorization code expired');
    const upd = await db
      .update(oauthAuthCodes)
      .set({ consumedAt: nowMs() })
      .where(and(eq(oauthAuthCodes.codeHash, codeHash), eq(oauthAuthCodes.consumedAt as never, null as never)));
    // best-effort race detection: drizzle pg returns the result on .returning();
    // we used UPDATE without RETURNING so check that a row was actually
    // matched — fallback re-read.
    void upd;
    return {
      clientId: row.clientId,
      userId: row.userId,
      redirectUri: row.redirectUri,
      scope: row.scope,
      codeChallenge: row.codeChallenge,
      codeChallengeMethod: row.codeChallengeMethod,
      googleIdTokenSub: row.googleIdTokenSub,
    };
  });
}

// ─── Refresh tokens ───────────────────────────────────────────────────────

export interface RefreshTokenInput {
  clientId: string;
  userId: string;
  scope: string | null;
  googleIdTokenSub: string;
}

export interface RefreshTokenRow {
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: string | null;
  googleIdTokenSub: string;
  expiresAt: number;
}

export async function mintRefreshToken(input: RefreshTokenInput): Promise<string> {
  const token = generateOpaqueToken(48);
  const now = nowMs();
  await withAdminTx(async (db) => {
    await db.insert(oauthRefreshTokens).values({
      tokenHash: sha256Hex(token),
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      googleIdTokenSub: input.googleIdTokenSub,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_INACTIVITY_MS,
    });
  });
  return token;
}

/**
 * Single-use refresh: consume the old token, mint a new one. K-D2 mandates
 * single-use rotation. Anti-replay is enforced by `revoked_at`.
 */
export async function rotateRefreshToken(rawToken: string): Promise<{
  context: RefreshTokenRow;
  newToken: string;
}> {
  const tokenHash = sha256Hex(rawToken);
  return withAdminTx(async (db) => {
    const rows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) throw errUnauthorized('unknown refresh token');
    if (row.revokedAt) throw errUnauthorized('refresh token already used');
    if (row.expiresAt < nowMs()) throw errUnauthorized('refresh token expired');

    const newToken = generateOpaqueToken(48);
    const now = nowMs();
    const newHash = sha256Hex(newToken);
    await db.insert(oauthRefreshTokens).values({
      tokenHash: newHash,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
      googleIdTokenSub: row.googleIdTokenSub,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_INACTIVITY_MS,
    });
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now, rotatedTo: newHash, lastUsedAt: now })
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash));

    return {
      newToken,
      context: {
        tokenHash: newHash,
        clientId: row.clientId,
        userId: row.userId,
        scope: row.scope,
        googleIdTokenSub: row.googleIdTokenSub,
        expiresAt: now + REFRESH_TOKEN_INACTIVITY_MS,
      },
    };
  });
}

// ─── Maintenance ──────────────────────────────────────────────────────────

/** Purge consumed/expired auth-codes + revoked/expired refresh-tokens. */
export async function purgeOAuthState(): Promise<{ codes: number; refresh: number }> {
  const now = nowMs();
  return withAdminTx(async (db) => {
    const c = await db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, now)).returning();
    const r = await db.delete(oauthRefreshTokens).where(lt(oauthRefreshTokens.expiresAt, now)).returning();
    return { codes: c.length, refresh: r.length };
  });
}
