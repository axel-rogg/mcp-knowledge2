// PII masking applied BEFORE generating embeddings (PLAN §3.4 / §6.2).
//
// Embedding-inversion attacks can recover PII-like fragments from raw vectors.
// We mask deterministically — `[EMAIL]`, `[PHONE]`, `[IBAN]`, `[CC]`, `[IP]`,
// `[URL]`, `[UUID]` — so the vector reflects topical intent, not identifiers.
// Identical input must produce identical output (deterministic masking).

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?(?:\(\d{1,4}\)|\d{1,4})[\s-]?\d{3,4}[\s-]?\d{3,4}/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g;
const CC_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_RE = /\bhttps?:\/\/\S+\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function maskPII(text: string): string {
  return text
    .replace(URL_RE, '[URL]')
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(UUID_RE, '[UUID]')
    .replace(IBAN_RE, '[IBAN]')
    .replace(CC_RE, '[CC]')
    .replace(PHONE_RE, '[PHONE]')
    .replace(IPV4_RE, '[IP]');
}
