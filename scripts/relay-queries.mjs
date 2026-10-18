//
// scripts/relay-queries.mjs — the one indexer query the page sends.
//
// datum-api's read-only relay (POST /api/indexer) answers exactly this query and
// nothing else, so the Blockfrost project token never reaches a browser. The
// page and the relay import the same string; a change here changes both.
//
export const CONTRACT_ACTION_QUERY = `query Datum($addr: HexEncoded!) {
  contractAction(address: $addr) { __typename state transaction { hash block { height timestamp } } }
}`;

/** Whitespace-insensitive form, for matching what a client sends. */
export const normalizeQuery = (q) => String(q).replace(/\s+/g, ' ').trim();
