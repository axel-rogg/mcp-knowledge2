// Drizzle schema mirrors PLAN-architecture-v2 §2.1.
// Single-tenant: no tenant_id columns. owner_id is the user-scope.
// Timestamps are stored as INTEGER (Unix ms) per the v1 decision.

import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

// Custom pgvector type — drizzle-orm v0.36 does not ship one natively.
const vector = (name: string, dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]) {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string) {
      // pg returns the raw text representation '[1.2,3.4,...]'
      const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '');
      if (trimmed.length === 0) return [];
      return trimmed.split(',').map((v) => Number.parseFloat(v));
    },
  })(name);

// ─── Objects ──────────────────────────────────────────────────────────────

export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    subtype: text('subtype'),

    title: text('title'),
    description: text('description'),
    keywordsJson: text('keywords_json'),
    triggerHints: text('trigger_hints'),
    metaJson: jsonb('meta_json'),

    bodyInline: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('body_inline'),
    blobKey: text('blob_key'),
    bodySize: bigint('body_size', { mode: 'number' }).notNull(),
    bodyHash: text('body_hash'),
    mimeType: text('mime_type'),
    filename: text('filename'),

    visibility: text('visibility').notNull().default('private'),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    archivedAt: bigint('archived_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    refcount: integer('refcount').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),

    nonce: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('nonce').notNull(),
    keyVersion: integer('key_version').notNull().default(1),

    // description / title / keywords / trigger_hints are plaintext-only
    // (FTS-indexed). The previous description_enc/_nonce/_key_version
    // columns were dropped in migration 0003 — they didn't add secrecy
    // because the plaintext column sat right next to them. Sensitive
    // payloads belong in `body` which IS encrypted (see SECURITY.md).

    qualityScore: integer('quality_score'),
    qualityCheckedAt: bigint('quality_checked_at', { mode: 'number' }),
    qualityRubricVersion: integer('quality_rubric_version'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => ({
    ownerSubtype: index('idx_objects_owner_subtype').on(t.ownerId, t.subtype),
    updated: index('idx_objects_updated').on(t.updatedAt),
    ownerHash: index('idx_objects_owner_hash').on(t.ownerId, t.bodyHash),
    deleted: index('idx_objects_deleted_at').on(t.deletedAt),
  }),
);

// ─── Object Refs (knowledge graph) ─────────────────────────────────────────

export const objectRefs = pgTable(
  'object_refs',
  {
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    role: text('role').notNull(),
    metaJson: jsonb('meta_json'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromId, t.toId, t.role] }),
    toIdx: index('idx_refs_to').on(t.toId),
    roleIdx: index('idx_refs_role').on(t.role),
  }),
);

// ─── Tags ──────────────────────────────────────────────────────────────────

export const objectTags = pgTable(
  'object_tags',
  {
    objectId: uuid('object_id').notNull(),
    tag: text('tag').notNull(),
    source: text('source').notNull().default('manual'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.objectId, t.tag] }),
    tagIdx: index('idx_tags_tag').on(t.tag),
  }),
);

// ─── Revisions ─────────────────────────────────────────────────────────────

export const objectRevisions = pgTable(
  'object_revisions',
  {
    objectId: uuid('object_id').notNull(),
    version: integer('version').notNull(),
    bodyInline: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('body_inline'),
    blobKey: text('blob_key'),
    metaJson: jsonb('meta_json'),
    nonce: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('nonce'),
    keyVersion: integer('key_version'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.objectId, t.version] }),
  }),
);

// ─── Share Grants ──────────────────────────────────────────────────────────

export const shareGrants = pgTable(
  'share_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id').notNull(),
    grantedTo: uuid('granted_to').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    scope: text('scope').notNull(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => ({
    lookup: index('idx_grants_lookup').on(t.grantedTo, t.revokedAt),
    resource: index('idx_grants_resource').on(t.resourceId, t.revokedAt),
  }),
);

// ─── Object Vectors (pgvector) ─────────────────────────────────────────────

export const objectVectors = pgTable(
  'object_vectors',
  {
    objectId: uuid('object_id').primaryKey(),
    // Dim follows EMBED_PROVIDER:
    //   cloudflare → 1024 (bge-m3, default)
    //   vertex     → 768  (text-multilingual-embedding-002, legacy)
    // Schema is sized for the default (1024). Switching to vertex requires a
    // dimension-shrink migration, not just a config flip.
    embedding: vector('embedding', 1024),
    model: text('model').notNull(),
    embeddedAt: bigint('embedded_at', { mode: 'number' }).notNull(),
  },
);

// ─── Audit Log ─────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    action: text('action').notNull(),
    resourceId: uuid('resource_id'),
    requestId: uuid('request_id'),
    result: text('result').notNull(),
    details: jsonb('details'),
    // AS-3 K12: proxy-vs-direct provenance + approval correlation.
    viaProxy: boolean('via_proxy').notNull().default(false),
    approvalId: uuid('approval_id'),
  },
  (t) => ({
    actorTs: index('idx_audit_actor_ts').on(t.actorUserId, t.ts),
    actionTs: index('idx_audit_action_ts').on(t.action, t.ts),
    requestIdx: index('idx_audit_request_id').on(t.requestId),
  }),
);

// ─── Users (AS-3 K2) ───────────────────────────────────────────────────────

// CITEXT in the DB; drizzle has no native citext customType so we surface as
// text. The unique-index/CITEXT comparison stays case-insensitive at the DB
// layer regardless of how the column is typed in TS.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  googleSub: text('google_sub'),
  displayName: text('display_name'),
  role: text('role').notNull().default('member'),       // 'admin' | 'member'
  status: text('status').notNull().default('active'),   // 'active' | 'suspended' | 'erased'
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
  invitedBy: uuid('invited_by'),
  inviteToken: text('invite_token'),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  token: text('token').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  usedAt: bigint('used_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// ─── Signing Keys (AS-3 K1) ────────────────────────────────────────────────

export const signingKeys = pgTable('signing_keys', {
  kid: text('kid').primaryKey(),
  alg: text('alg').notNull(),
  publicJwk: jsonb('public_jwk').notNull(),
  privatePem: text('private_pem').notNull(),
  privateNonce: customType<{ data: Uint8Array; driverData: Buffer }>({
    dataType() {
      return 'bytea';
    },
    toDriver(v) {
      return Buffer.from(v);
    },
    fromDriver(v) {
      return new Uint8Array(v as Buffer);
    },
  })('private_nonce').notNull(),
  active: boolean('active').notNull().default(true),
  rotatedAt: bigint('rotated_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// ─── Idempotency Records ───────────────────────────────────────────────────

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    userId: uuid('user_id').notNull(),
    idemKey: text('idem_key').notNull(),
    responseBody: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('response_body'),
    responseStatus: integer('response_status'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.idemKey] }),
    expires: index('idx_idem_expires').on(t.expiresAt),
  }),
);

// ─── Uploads (presigned-upload lifecycle) ─────────────────────────────────

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  status: text('status').notNull(), // 'pending' | 'finalized' | 'expired' | 'hard_deleted'
  blobKey: text('blob_key').notNull(),
  bodySize: bigint('body_size', { mode: 'number' }),
  bodyHash: text('body_hash'),
  metaJson: jsonb('meta_json'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  finalizedAt: bigint('finalized_at', { mode: 'number' }),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

// ─── User Quotas ───────────────────────────────────────────────────────────

export const blobDeletionQueue = pgTable('blob_deletion_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  blobKey: text('blob_key').notNull(),
  reason: text('reason').notNull(),
  enqueuedAt: bigint('enqueued_at', { mode: 'number' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: bigint('next_attempt_at', { mode: 'number' }).notNull(),
});

export const userQuotas = pgTable('user_quotas', {
  userId: uuid('user_id').primaryKey(),
  objectCountMax: integer('object_count_max').notNull().default(10_000),
  storageBytesMax: bigint('storage_bytes_max', { mode: 'number' }).notNull().default(5_368_709_120),
  embedCallsPerDay: integer('embed_calls_per_day').notNull().default(5_000),
  searchQpsBurst: integer('search_qps_burst').notNull().default(30),

  objectCountUsed: integer('object_count_used').notNull().default(0),
  storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
  embedCallsToday: integer('embed_calls_today').notNull().default(0),
  embedCallsResetAt: bigint('embed_calls_resetat', { mode: 'number' }).notNull(),

  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ─── OAuth Facade (AS-3 K3/K4) ─────────────────────────────────────────────

export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecret: text('client_secret'),
  clientName: text('client_name'),
  redirectUris: text('redirect_uris').array().notNull(),
  grantTypes: text('grant_types').array().notNull(),
  responseTypes: text('response_types').array().notNull(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  scope: text('scope').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
});

export const oauthAuthCodes = pgTable('oauth_auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope'),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  googleIdTokenSub: text('google_id_token_sub').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  consumedAt: bigint('consumed_at', { mode: 'number' }),
});

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  scope: text('scope'),
  googleIdTokenSub: text('google_id_token_sub').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  rotatedTo: text('rotated_to'),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
});

// ─── Re-exported helpers ───────────────────────────────────────────────────

export const schema = {
  objects,
  objectRefs,
  objectTags,
  objectRevisions,
  shareGrants,
  objectVectors,
  auditLog,
  idempotencyRecords,
  uploads,
  userQuotas,
  blobDeletionQueue,
  signingKeys,
  users,
  invites,
  oauthClients,
  oauthAuthCodes,
  oauthRefreshTokens,
};

export type ObjectRow = typeof objects.$inferSelect;
export type NewObjectRow = typeof objects.$inferInsert;
export type ShareGrantRow = typeof shareGrants.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type UserQuotaRow = typeof userQuotas.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;
export type SigningKeyRow = typeof signingKeys.$inferSelect;
export type NewSigningKeyRow = typeof signingKeys.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
