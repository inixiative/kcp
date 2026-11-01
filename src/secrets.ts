const secret = (kind: '' | 'run_' | 'refresh_') => new RegExp(`^kingdom_${kind}[a-zA-Z0-9_-]{43}$`);
export const runSecretPattern = secret('run_');
export const refreshSecretPattern = secret('refresh_');

/** Any Kingdom secret in free text. */
export const secretInText = /\bkingdom_(?:run_|refresh_)?[A-Za-z0-9_-]{20,}/g;
export const unredactedSecretInText = /\bkingdom_(?!REDACTED)(?:run_|refresh_)?[A-Za-z0-9_-]{20,}/;
/** Signet renewal credentials (`signet_renew_…`) in free text. */
export const renewalInText = /\bsignet_renew_[A-Za-z0-9_-]{20,}/g;

/** Kingdom API tokens (`<environment>_<model>_<48 hex>`) in free text. */
export const apiTokenInText = /\b[A-Za-z]+_[A-Za-z]+_[0-9a-f]{48}\b/g;

/** Text safe to print: every Kingdom secret and Signet renewal credential replaced. */
export const redactSecrets = (text: string) =>
  text
    .replace(secretInText, 'kingdom_REDACTED')
    .replace(renewalInText, 'signet_renew_REDACTED')
    .replace(apiTokenInText, 'REDACTED_API_TOKEN');
