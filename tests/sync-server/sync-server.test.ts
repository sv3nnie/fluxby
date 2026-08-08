/**
 * Tests for the remote sync server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/sync-server/src/app.js';
import { VaultStore, hashToken } from '../../apps/sync-server/src/store.js';

const VAULT = 'a'.repeat(32);
const OTHER_VAULT = 'b'.repeat(32);
const TOKEN = 'token-for-vault-a';
const DEVICE = 'device-1';

let store: VaultStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new VaultStore(':memory:');
  app = createApp({ store, rateLimitMax: 0 });
});

afterEach(() => {
  store.close();
});

const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

async function push(payload: string, token = TOKEN, deviceId = DEVICE) {
  return request(app)
    .post(`/v1/vaults/${VAULT}/batches`)
    .set(auth(token))
    .send({ deviceId, payload });
}

describe('health', () => {
  it('responds without authentication', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('authentication', () => {
  it('claims an unknown vault on first use', async () => {
    const res = await push('first');
    expect(res.status).toBe(200);
    expect(res.body.seq).toBe(1);
  });

  it('rejects a different token for a claimed vault', async () => {
    await push('first');
    const res = await push('second', 'a-different-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects a missing token', async () => {
    const res = await request(app)
      .post(`/v1/vaults/${VAULT}/batches`)
      .send({ deviceId: DEVICE, payload: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects reads with the wrong token', async () => {
    await push('first');
    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches`)
      .set(auth('wrong'));
    expect(res.status).toBe(401);
  });

  it('keeps vaults isolated from one another', async () => {
    await push('vault-a-data');
    // A different vault with its own token must not see the first vault's log.
    const res = await request(app)
      .get(`/v1/vaults/${OTHER_VAULT}/batches`)
      .set(auth('token-for-vault-b'));

    expect(res.status).toBe(200);
    expect(res.body.batches).toEqual([]);
  });

  it('never stores the raw token', () => {
    store.authenticate(VAULT, TOKEN);
    const raw = JSON.stringify(store.list(VAULT, 0, 10));
    expect(raw).not.toContain(TOKEN);
    // Only the hash is persisted.
    expect(hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('vault id validation', () => {
  it('rejects a malformed vault id', async () => {
    const res = await request(app)
      .get('/v1/vaults/not-a-vault/batches')
      .set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_vault_id');
  });
});

describe('append and read', () => {
  it('assigns monotonic sequence numbers', async () => {
    expect((await push('one')).body.seq).toBe(1);
    expect((await push('two')).body.seq).toBe(2);
    expect((await push('three')).body.seq).toBe(3);
  });

  it('returns batches after a cursor with the latest sequence', async () => {
    await push('one');
    await push('two');
    await push('three');

    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=1`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.batches.map((b: { seq: number }) => b.seq)).toEqual([2, 3]);
    expect(res.body.latestSeq).toBe(3);
  });

  it('stores payloads verbatim', async () => {
    const opaque = 'AAECAwQFBgcICQoL/+opaque+ciphertext';
    await push(opaque);

    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches`)
      .set(auth());
    expect(res.body.batches[0].payload).toBe(opaque);
    expect(res.body.batches[0].deviceId).toBe(DEVICE);
  });

  it('clamps an oversized page request instead of rejecting it', async () => {
    for (let i = 0; i < 5; i++) await push(`batch-${i}`);

    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?limit=99999`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.batches.length).toBe(5);
  });

  it('paginates', async () => {
    for (let i = 0; i < 5; i++) await push(`batch-${i}`);

    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=0&limit=2`)
      .set(auth());

    expect(res.body.batches.map((b: { seq: number }) => b.seq)).toEqual([1, 2]);
    expect(res.body.latestSeq).toBe(5);
  });

  it('rejects a request without deviceId or payload', async () => {
    const noDevice = await request(app)
      .post(`/v1/vaults/${VAULT}/batches`)
      .set(auth())
      .send({ payload: 'x' });
    expect(noDevice.status).toBe(400);

    const noPayload = await request(app)
      .post(`/v1/vaults/${VAULT}/batches`)
      .set(auth())
      .send({ deviceId: DEVICE });
    expect(noPayload.status).toBe(400);
  });

  it('rejects a negative cursor', async () => {
    const res = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=-1`)
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe('quotas', () => {
  it('rejects a batch larger than the per-batch limit', async () => {
    const small = new VaultStore(':memory:', {
      maxBatchBytes: 64,
      maxVaultBytes: 1024,
    });
    const smallApp = createApp({ store: small, rateLimitMax: 0 });

    const res = await request(smallApp)
      .post(`/v1/vaults/${VAULT}/batches`)
      .set(auth())
      .send({ deviceId: DEVICE, payload: 'x'.repeat(100) });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('quota_exceeded');
    small.close();
  });

  it('rejects once the vault total is exhausted', async () => {
    const small = new VaultStore(':memory:', {
      maxBatchBytes: 64,
      maxVaultBytes: 100,
    });
    const smallApp = createApp({ store: small, rateLimitMax: 0 });

    const first = await request(smallApp)
      .post(`/v1/vaults/${VAULT}/batches`)
      .set(auth())
      .send({ deviceId: DEVICE, payload: 'x'.repeat(60) });
    expect(first.status).toBe(200);

    const second = await request(smallApp)
      .post(`/v1/vaults/${VAULT}/batches`)
      .set(auth())
      .send({ deviceId: DEVICE, payload: 'y'.repeat(60) });
    expect(second.status).toBe(413);
    small.close();
  });
});

describe('rate limiting', () => {
  it('rejects once the window is exhausted', async () => {
    const limited = createApp({
      store,
      rateLimitMax: 3,
      rateLimitWindowMs: 60_000,
    });

    for (let i = 0; i < 3; i++) {
      const ok = await request(limited)
        .get(`/v1/vaults/${VAULT}/batches`)
        .set(auth());
      expect(ok.status).toBe(200);
    }

    const blocked = await request(limited)
      .get(`/v1/vaults/${VAULT}/batches`)
      .set(auth());
    expect(blocked.status).toBe(429);
  });
});

describe('compaction', () => {
  it('drops superseded batches but never the head', async () => {
    for (let i = 0; i < 5; i++) await push(`batch-${i}`);

    const res = await request(app)
      .post(`/v1/vaults/${VAULT}/compact`)
      .set(auth())
      .send({ throughSeq: 5 });

    expect(res.status).toBe(200);
    // Seq 5 is retained: an empty log is indistinguishable from a lost one.
    expect(res.body.removed).toBe(4);

    const after = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=0`)
      .set(auth());
    expect(after.body.batches.map((b: { seq: number }) => b.seq)).toEqual([5]);
  });

  it('keeps sequence numbers monotonic after compaction', async () => {
    for (let i = 0; i < 3; i++) await push(`batch-${i}`);
    await request(app)
      .post(`/v1/vaults/${VAULT}/compact`)
      .set(auth())
      .send({ throughSeq: 2 });

    // A new batch must not reuse a discarded sequence number.
    const next = await push('after-compaction');
    expect(next.body.seq).toBe(4);
  });

  it('frees quota when batches are removed', async () => {
    const small = new VaultStore(':memory:', {
      maxBatchBytes: 128,
      maxVaultBytes: 200,
    });
    small.authenticate(VAULT, TOKEN);
    small.append(VAULT, DEVICE, 'x'.repeat(80));
    small.append(VAULT, DEVICE, 'y'.repeat(80));

    small.truncate(VAULT, 1);

    // Without the quota being released this would throw.
    expect(() => small.append(VAULT, DEVICE, 'z'.repeat(80))).not.toThrow();
    small.close();
  });

  it('rejects a malformed throughSeq', async () => {
    const res = await request(app)
      .post(`/v1/vaults/${VAULT}/compact`)
      .set(auth())
      .send({ throughSeq: 'banana' });
    expect(res.status).toBe(400);
  });
});
