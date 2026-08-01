/**
 * Compatibility entry point for older imports.
 *
 * The duplicated legacy setup router was intentionally retired for Portal 4.0:
 * it had no setup-token guard, created the owner outside a transaction, and
 * wrote client-selected SVG/extensions directly into the public branding
 * directory. Keeping one implementation prevents the hardened setup contract
 * from drifting again.
 */
export { default, requireSetupPending, requireSetupToken } from './setup-v3';
