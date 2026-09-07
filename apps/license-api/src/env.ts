export interface Env {
  /** Ed25519 private key, PKCS#8 PEM. Secret. */
  LICENSE_PRIVATE_KEY_PEM: string;
  /** Creem store API key (x-api-key). Secret. */
  CREEM_API_KEY: string;
  /** default https://api.creem.io; test mode is https://test-api.creem.io */
  CREEM_API_BASE?: string;
  /** default 7 */
  LEASE_DAYS?: string;
}
