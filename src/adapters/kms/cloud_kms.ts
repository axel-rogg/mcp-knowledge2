// AS-3 K9: Google Cloud KMS adapter.
//
// Boot-time pattern (similar in spirit to hkdf_local, harder Crypto-Root):
//   1. CLOUDFLARE_AI_GATEWAY-style envelope: an *encrypted* master key
//      lives in Doppler/env as base64 ciphertext (CLOUD_KMS_WRAPPED_MASTER_B64).
//   2. At service boot we call Cloud-KMS `decrypt(ciphertext, key=KMS_KEY_NAME)`
//      to unwrap the master key — keeps the master key off-disk on the VM.
//   3. The unwrapped master then drives per-user HKDF derivation, just like
//      hkdf_local — but the master never lives in plaintext outside the
//      Cloud KMS HSM until this single boot-time call.
//
// Auth precedence (ADC chain):
//   1. GOOGLE_APPLICATION_CREDENTIALS (file path) — local dev
//   2. Workload Identity Federation on Cloud Run / GKE — prod
//
// Why this and not "per-request decrypt to Cloud KMS"?
//   - Latency: every per-request KMS-call adds 50-200ms. KC2 needs DEK
//     access for every object CRUD + every search, this is hot-path.
//   - Cost: per-request KMS-call ≈ $0.03/10k calls — adds up at scale.
//   - Audit: boot-time single decrypt is the integrity event; per-request
//     access lives in the audit_log + Postgres-RLS layer instead.
//
// Rotation: when CLOUD_KMS_WRAPPED_MASTER_B64 is re-issued (new master,
// wrapped under the same or rotated KMS-key), the service must be
// redeployed/restarted. Cloud KMS key rotation alone does NOT rotate the
// wrapped master — that takes a fresh wrap call + Doppler-update + restart.

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { loadEnv } from '../../types/env.ts';
import { logger } from '../../lib/logger.ts';
import { errInternal } from '../../lib/errors.ts';
import type { KmsProvider } from './interface.ts';

const hkdfAsync = promisify(hkdf);

const DEK_LENGTH_BYTES = 32;
const HKDF_INFO = new TextEncoder().encode('dek-v1');

let cachedMasterKey: Uint8Array | null = null;
let cachedKmsClient: KeyManagementServiceClient | null = null;

function kmsClient(): KeyManagementServiceClient {
  if (cachedKmsClient) return cachedKmsClient;
  // Auth-Resolution (in Precedence-Reihenfolge):
  //   1. GOOGLE_APPLICATION_CREDENTIALS_JSON — inline JSON in env (Fly-Pattern,
  //      vom TF-Apply via doppler_secret eingespielt). NICHT Teil des
  //      Standard-ADC-Chains, deswegen explizit.
  //   2. GOOGLE_APPLICATION_CREDENTIALS — file-path (local dev, k8s-mounts)
  //   3. Metadata-Server / gcloud auth (Cloud Run, GCE)
  const env = loadEnv();
  const inlineJson = env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inlineJson && inlineJson.trim().length > 0) {
    const parsed = parseSaJson(inlineJson);
    cachedKmsClient = new KeyManagementServiceClient({
      credentials: parsed,
      projectId: parsed.project_id,
    });
    return cachedKmsClient;
  }
  // Fallback: Default-ADC-Chain.
  cachedKmsClient = new KeyManagementServiceClient();
  return cachedKmsClient;
}

/**
 * Parse Service-Account-JSON. Akzeptiert raw JSON (KC2-Convention) ODER
 * base64-encoded JSON (TF-Default: google_service_account_key.private_key).
 * Spiegelt das Pattern in mcp-approval2/packages/adapters/src/kek/cloud_kms.ts.
 */
function parseSaJson(raw: string): {
  client_email: string;
  private_key: string;
  project_id: string;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.client_email === 'string') {
      return parsed as unknown as ReturnType<typeof parseSaJson>;
    }
  } catch {
    /* fall through */
  }
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof parsed.client_email === 'string') {
      return parsed as unknown as ReturnType<typeof parseSaJson>;
    }
  } catch {
    /* fall through */
  }
  throw errInternal(
    'CloudKmsKms: GOOGLE_APPLICATION_CREDENTIALS_JSON ist weder valides ' +
      'JSON noch base64-encoded JSON mit client_email-Feld.',
  );
}

async function unwrapMasterKey(): Promise<Uint8Array> {
  if (cachedMasterKey) return cachedMasterKey;
  const env = loadEnv();
  if (!env.CLOUD_KMS_KEY_NAME) {
    throw errInternal('KMS_PROVIDER=cloud_kms requires CLOUD_KMS_KEY_NAME');
  }
  if (!env.CLOUD_KMS_WRAPPED_MASTER_B64) {
    throw errInternal('KMS_PROVIDER=cloud_kms requires CLOUD_KMS_WRAPPED_MASTER_B64');
  }
  const ciphertext = Buffer.from(env.CLOUD_KMS_WRAPPED_MASTER_B64, 'base64');
  logger.info({ kmsKey: env.CLOUD_KMS_KEY_NAME }, 'unwrapping master key via Cloud KMS');
  const [resp] = await kmsClient().decrypt({
    name: env.CLOUD_KMS_KEY_NAME,
    ciphertext,
  });
  if (!resp.plaintext) {
    throw errInternal('Cloud KMS decrypt returned empty plaintext');
  }
  const raw = Buffer.isBuffer(resp.plaintext)
    ? resp.plaintext
    : Buffer.from(resp.plaintext as Uint8Array);
  if (raw.length !== 32) {
    throw errInternal(
      `Cloud KMS unwrapped master must be 32 bytes (got ${raw.length}). Re-wrap with a 32-byte plaintext.`,
    );
  }
  cachedMasterKey = new Uint8Array(raw);
  return cachedMasterKey;
}

export class CloudKmsKms implements KmsProvider {
  async resolveUserDek(userId: string, _requestId: string): Promise<Uint8Array> {
    const master = await unwrapMasterKey();
    const salt = new TextEncoder().encode(userId);
    const derived = await hkdfAsync('sha256', master, salt, HKDF_INFO, DEK_LENGTH_BYTES);
    return new Uint8Array(derived as ArrayBuffer);
  }
}

/**
 * Test seam — reset the cached master key + KMS client. Called between
 * tests that switch KMS_PROVIDER, otherwise the next boot would reuse an
 * already-decrypted master from a different test's env.
 */
export function resetCloudKmsCacheForTest(): void {
  cachedMasterKey = null;
  cachedKmsClient = null;
}
