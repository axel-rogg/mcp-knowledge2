// KMS — resolves per-user DEKs (Data Encryption Keys).
//
// Variant B (decided): mcp-knowledge2 calls mcp-approval2's internal API.
// mcp-approval2 unwraps the DEK from OpenBao Transit-Engine using the
// user's KEK and returns the raw DEK bytes. The DEK stays request-scoped
// in mcp-knowledge2 memory only — never persisted.

export interface KmsProvider {
  /**
   * Resolve the user's current DEK for object operations.
   *
   * @param userId - user UUID (from JWT sub)
   * @param requestId - propagated request id for cross-service audit
   * @returns 32-byte raw key (AES-256-GCM input)
   */
  resolveUserDek(userId: string, requestId: string): Promise<Uint8Array>;

  /**
   * SEC-K-024: Per-user embed-salt für maskPII-Postfix vor Embedding.
   * Verhindert Cross-User-Inference-Oracle via deterministischen masked
   * Strings (z.B. "[EMAIL]"-Token im AI-Gateway-Cache, Backup-Stream).
   *
   * Domain-separation vom DEK durch eigenen HKDF-`info`-Tag. Stable pro
   * User (derived from master + userId), nicht in DB persisted — wenn
   * master rotated wird, ändern sich alle embed-salts und Vektoren
   * werden konsistent neu generiert.
   *
   * @returns Hex-encoded String (32 chars für 16 random bytes)
   */
  resolveEmbedSalt(userId: string, requestId: string): Promise<string>;
}
