const ZCODE_PROVIDER_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

export function normalizeModelNameForUpstream(model) {
  if (typeof model !== 'string') return model;
  return model.replace(ZCODE_PROVIDER_PREFIX_RE, '');
}

export function headerValueToByteString(value) {
  const text = String(value);
  return /^[\x00-\xFF]*$/.test(text) ? text : null;
}

export function isRetryableFetchError(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''} ${error?.cause?.code || ''}`;
  return /fetch failed|socket disconnected|other side closed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(message);
}
