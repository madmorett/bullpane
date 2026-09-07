export interface Env {
  /** Ed25519 private key, PKCS#8 PEM. Secret. */
  LICENSE_PRIVATE_KEY_PEM: string;
  /** Polar organization id. Secret only because it is not public information. */
  POLAR_ORGANIZATION_ID: string;
  /** default https://api.polar.sh */
  POLAR_API_BASE?: string;
  /** default 7 */
  LEASE_DAYS?: string;
}
