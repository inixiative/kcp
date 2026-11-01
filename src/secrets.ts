/** Any Kingdom secret in free text. */
const secretInText = /\bkingdom_(?:run_|refresh_)?[A-Za-z0-9_-]{20,}/g;
/** Signet renewal credentials (`signet_renew_…`) in free text. */
const renewalInText = /\bsignet_renew_[A-Za-z0-9_-]{20,}/g;
/** Kingdom API tokens (`<environment>_<model>_<48 hex>`) in free text. */
const apiTokenInText = /\b[A-Za-z]+_[A-Za-z]+_[0-9a-f]{48}\b/g;

/** Text safe to print: every Kingdom secret, Signet renewal credential and API token replaced. */
export const redactSecrets = (text: string) =>
  text
    .replace(secretInText, 'kingdom_REDACTED')
    .replace(renewalInText, 'signet_renew_REDACTED')
    .replace(apiTokenInText, 'REDACTED_API_TOKEN');
