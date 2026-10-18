//
// service/redact.mjs — keep the Blockfrost project token out of every output.
//
// The wallet SDK and midnight-js take URLs only, so the token travels as
// ?project_id=... on the service's own indexer, WebSocket and RPC URLs, and
// client libraries put those URLs into error messages. Everything that leaves
// the process (stdout, stderr, JSON bodies) goes through redact().
//
const PARAM = /(project_id=)[^&\s"'<>)]+/gi;
const TOKEN = /\bnight(?:preprod|mainnet)[A-Za-z0-9]{8,}\b/g;

/** Build a redactor that also masks the exact secret values it is given. */
export const makeRedactor = (secrets = []) => {
  const exact = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  return (text) => {
    let out = String(text).replace(PARAM, '$1<redacted>').replace(TOKEN, '<redacted>');
    for (const s of exact) out = out.split(s).join('<redacted>');
    return out;
  };
};

/** Wrap a stream's write so nothing logged can carry the token. */
export const guardStream = (stream, redact) => {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => write(typeof chunk === 'string' ? redact(chunk) : Buffer.isBuffer(chunk) ? Buffer.from(redact(chunk.toString('utf8'))) : chunk, ...rest);
};
