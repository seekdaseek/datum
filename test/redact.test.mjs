import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor } from '../service/redact.mjs';
import { withBlockfrost, NETWORKS } from '../scripts/networks.mjs';
import { CONTRACT_ACTION_QUERY, normalizeQuery } from '../scripts/relay-queries.mjs';

const TOKEN = 'nightpreprodTESTTOKEN0123456789abcdefgh'; // a made-up value, not a real project id

describe('REDACT: the Blockfrost project token never leaves the service', () => {
  const redact = makeRedactor([TOKEN]);

  test('masks the token inside the URLs the clients put in error messages', () => {
    const net = withBlockfrost(NETWORKS.preprod, TOKEN);
    for (const u of [net.indexerHttp, net.indexerWs, net.node]) {
      assert.ok(u.includes(TOKEN), 'control: the unredacted URL carries the token');
      const out = redact(`getaddrinfo failed for ${u} (retrying)`);
      assert.ok(!out.includes(TOKEN));
      assert.match(out, /project_id=<redacted>/);
    }
  });

  test('masks a bare token and an unknown token of the same shape', () => {
    assert.ok(!redact(`token ${TOKEN}`).includes(TOKEN));
    assert.equal(redact('id nightpreprodZZZZZZZZZZ1'), 'id <redacted>');
  });

  test('leaves ordinary text alone', () => {
    assert.equal(redact('sponsor is syncing, 12 of 40'), 'sponsor is syncing, 12 of 40');
  });
});

describe('NETWORKS: Preprod reads Blockfrost through the relay', () => {
  test('the page-facing indexer is the relay and holds no token', () => {
    assert.equal(NETWORKS.preprod.indexerHttp, 'https://datum-api.ochinimus.app/api/indexer');
    assert.ok(!/project_id/i.test(JSON.stringify(NETWORKS.preprod)));
  });
  test('withBlockfrost needs a token, and leaves networks without Blockfrost alone', () => {
    assert.throws(() => withBlockfrost(NETWORKS.preprod, ''), /BLOCKFROST_PROJECT_ID/);
    assert.equal(withBlockfrost(NETWORKS.preview, undefined), NETWORKS.preview);
  });
  test('the relay query matches itself however it is spaced and nothing else', () => {
    const spaced = CONTRACT_ACTION_QUERY.replace(/\n/g, '\n\n  ');
    assert.equal(normalizeQuery(spaced), normalizeQuery(CONTRACT_ACTION_QUERY));
    assert.notEqual(normalizeQuery(CONTRACT_ACTION_QUERY.replace('state', 'state zswapState')), normalizeQuery(CONTRACT_ACTION_QUERY));
  });
});
