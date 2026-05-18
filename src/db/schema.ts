// Drizzle schema mirrors PLAN-architecture-v2 §2.1.
// Single-tenant: no tenant_id columns. owner_id is the user-scope.
// Timestamps are stored as INTEGER (Unix ms) per the v1 decision.

import { randomBytes as randomBytesSync } from 'node:crypto';
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
    isSubdoc: boolean('is_subdoc').notNull().default(false),
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

    // ── Group-Sharing Phase 1 (Migration 0019) ───────────────────────────
    // dek_scheme: 'owner_hkdf' (legacy) oder 'per_object' (random DEK,
    // wrapped). Lazy-Migrate beim ersten Share. CHECK-Constraint in DB
    // enforct Consistency mit owner_wrapped_dek.
    dekScheme: text('dek_scheme').notNull().default('owner_hkdf'),
    ownerWrappedDek: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('owner_wrapped_dek'),
    ownerWrapKeyVersion: integer('owner_wrap_key_version'),
    // Cascade-on-share opt-out per Object. Default TRUE: bei addObjectRef
    // (role='skill_resource') werden Shares des Parents auto-übertragen.
    cascadeOnShare: boolean('cascade_on_share').notNull().default(true),

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
    // Per-Revision DEK-Scheme. Migration 0020. Bei Lazy-Migration sind
    // alte Revs 'owner_hkdf' (Owner-DEK + legacy-AAD), neue Revs sind
    // 'per_object' (Per-Object-DEK + AAD-v2). Read-Pfad in revisions.ts
    // braucht dispatch-logic basierend auf dieser Spalte.
    dekScheme: text('dek_scheme').notNull().default('owner_hkdf'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.objectId, t.version] }),
  }),
);

// ─── Share Grants ──────────────────────────────────────────────────────────
//
// Erweiterung Phase 1 (Migration 0019): Group-Sharing.
// granted_to (User-Grant) ist jetzt NULLABLE. Entweder granted_to ODER
// granted_to_group_id ist gesetzt — XOR-Constraint in DB enforct das.
// Bei granted_to_group_id IS NOT NULL: wrapped_object_dek + group_master_
// version sind Pflicht (Body-Decrypt-Chain).

export const shareGrants = pgTable(
  'share_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id').notNull(),
    grantedTo: uuid('granted_to'),
    grantedToGroupId: uuid('granted_to_group_id'),
    grantedBy: uuid('granted_by').notNull(),
    scope: text('scope').notNull(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    // Audit-Spur fuer cascaded shares (z.B. via skill_resource ref).
    // NULL = direkt geteilt; NOT NULL = via Skill-Bundle.
    viaCascadeFromObjectId: uuid('via_cascade_from_object_id'),
    // Object-DEK wrapped mit Group-Master-DEK. Nur für Group-Grants.
    wrappedObjectDek: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('wrapped_object_dek'),
    // Snapshot von groups.master_version zum Wrap-Zeitpunkt. Bei Member-
    // Remove-Rotation wird die Spalte fuer die bleibenden Grants
    // hochgezogen. Read-Pfad prueft `wrapped_for_master_version >=
    // group_master_version` als Stale-Check.
    groupMasterVersion: integer('group_master_version'),
  },
  (t) => ({
    lookup: index('idx_grants_lookup').on(t.grantedTo, t.revokedAt),
    resource: index('idx_grants_resource').on(t.resourceId, t.revokedAt),
    groupActive: index('idx_share_grants_group_active').on(
      t.grantedToGroupId,
      t.resourceId,
    ),
  }),
);

// ─── Groups (Phase 1, Migration 0019) ──────────────────────────────────────

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // Group-Master-DEK wrapped mit GCP-KMS (Variante C: KMS-wrapped +
    // Process-Cache TTL 5min, NICHT Owner-KEK-wrapped — siehe ADR-0024).
    wrappedMasterDek: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('wrapped_master_dek').notNull(),
    // Monoton inkrementiert bei Member-Remove-Rotation. Coordinator-Lock-
    // Ziel fuer die Eine-TX-Member-Remove-Sequenz.
    masterVersion: integer('master_version').notNull().default(1),
    rotatedAt: bigint('rotated_at', { mode: 'number' }),
    // Wenn TRUE: jeder body-Read von non-Owner via Group-Membership
    // schreibt share.read-Audit-Event. Default FALSE (kein Surveillance-
    // Default; Group-Admin entscheidet).
    readAuditEnabled: boolean('read_audit_enabled').notNull().default(false),
    // Default fuer cascade-on-share bei addObjectRef innerhalb dieser Group.
    // Default TRUE (auto-cascade ist erwarteter UX-Pfad).
    cascadeOnShareDefault: boolean('cascade_on_share_default')
      .notNull()
      .default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    archivedAt: bigint('archived_at', { mode: 'number' }),
  },
  (t) => ({
    owner: index('idx_groups_owner').on(t.ownerId),
  }),
);

// ─── Group Members (Phase 1, Migration 0019) ───────────────────────────────

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    // Group-Master-DEK gewrapped mit Member-KEK (per-User-HKDF).
    wrappedGroupDek: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('wrapped_group_dek').notNull(),
    // = groups.master_version zum Wrap-Zeitpunkt. Wenn <
    // groups.master_version → Member ist stale (post-rotation).
    wrappedForMasterVersion: integer('wrapped_for_master_version').notNull(),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
    removedAt: bigint('removed_at', { mode: 'number' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    user: index('idx_group_members_user').on(t.userId),
    active: index('idx_group_members_active').on(t.groupId, t.userId),
  }),
);

// ─── Rewrap Jobs (Phase 2-7, Migration 0026) ───────────────────────────────
//
// Async-Worker-Queue fuer Group-Master-Rotation bei >1000 share_grants.
// Producer: removeMember (storage/groups.ts). Consumer: storage/rewrap.ts.

export const rewrapJobs = pgTable(
  'rewrap_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id').notNull(),
    oldMasterVersion: integer('old_master_version').notNull(),
    newMasterVersion: integer('new_master_version').notNull(),
    status: text('status').notNull().default('pending'),
    totalGrants: integer('total_grants').notNull(),
    processedGrants: integer('processed_grants').notNull().default(0),
    batchSize: integer('batch_size').notNull().default(100),
    triggeredBy: uuid('triggered_by'),
    triggerReason: text('trigger_reason').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    startedAt: bigint('started_at', { mode: 'number' }),
    completedAt: bigint('completed_at', { mode: 'number' }),
    lastError: text('last_error'),
    oldMasterKmsWrapped: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType() {
        return 'bytea';
      },
      toDriver(v) {
        return Buffer.from(v);
      },
      fromDriver(v) {
        return new Uint8Array(v as Buffer);
      },
    })('old_master_kms_wrapped').notNull(),
  },
  (t) => ({
    group: index('idx_rewrap_jobs_group').on(t.groupId, t.status),
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
  // SEC-K-006: persist approval2-User-ID damit syncFromApproval2 nicht nur
  // auf Email-Match angewiesen ist. Bei Mismatch (Email gleich, external_id
  // verschieden) → refuse Sync-Update. Migration 0012.
  externalId: text('external_id'),
  // SEC-K-005: per-user random salt (32 bytes) für HKDF, gemischt in den
  // DEK-derivation-Pfad. Master-Leak + public-userId reicht nicht mehr für
  // DEK-Recovery — dek_salt muss aus DB. Migration 0015. DB-default
  // (gen_random_bytes(32)) füllt das Feld auf Insert; $defaultFn ist
  // Client-side-Fallback wenn Tests ohne DB-default arbeiten.
  dekSalt: customType<{ data: Uint8Array; driverData: Buffer }>({
    dataType() {
      return 'bytea';
    },
    toDriver(v) {
      return Buffer.from(v);
    },
    fromDriver(v) {
      return new Uint8Array(v as Buffer);
    },
  })('dek_salt')
    .notNull()
    .$defaultFn(() => new Uint8Array(randomBytesSync(32))),
  // SEC-K-005 Step B: NEUE User starten mit version=2 (per-user salt mixed in
  // HKDF input, info='dek-v2'). Legacy-Rows aus Migration 0015 stehen auf
  // DB-default=1 — werden via scripts/re-encrypt-dek-v2.mjs auf 2 gebumped
  // sobald ihre Bodies neu verschluesselt sind. Drizzle's $defaultFn ueberschreibt
  // den DB-DEFAULT bei Client-Inserts, also sind alle neuen Users post-Step-B
  // automatisch v2 ohne Migrations-Code-Path.
  dekSaltVersion: integer('dek_salt_version')
    .notNull()
    .default(1)
    .$defaultFn(() => 2),
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

// SEC-K-010: OBO jti-Replay-Protection. INSERT-on-Conflict im
// require_jwt_or_obo-middleware-path verhindert dass derselbe OBO-Token
// innerhalb seines Expiry-Windows (120s default) ein zweites Mal akzeptiert
// wird. TTL-Sweep über exp_at-Index.
export const oboJtiSeen = pgTable('obo_jti_seen', {
  jti: text('jti').primaryKey(),
  userId: uuid('user_id').notNull(),
  seenAt: bigint('seen_at', { mode: 'number' }).notNull(),
  expAt: bigint('exp_at', { mode: 'number' }).notNull(),
});

// ─── Re-exported helpers ───────────────────────────────────────────────────

export const schema = {
  objects,
  objectRefs,
  objectTags,
  objectRevisions,
  shareGrants,
  groups,
  groupMembers,
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

export type GroupRow = typeof groups.$inferSelect;
export type GroupMemberRow = typeof groupMembers.$inferSelect;

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
