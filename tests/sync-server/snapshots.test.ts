/**
 * Snapshot storage and commit semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/sync-server/src/app.js';
import { VaultStore } from '../../apps/sync-server/src/store.js';

const VAULT = 'c'.repeat(32);
const TOKEN = 'snapshot-token';
const DEVICE = 'device-1';

let store: VaultStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new VaultStore(':memory:');
  app = createApp({ store, rateLimitMax: 0 });
});

afterEach(() => store.close());

const auth = { Authorization: `Bearer ${TOKEN}` };

const push = (payload: string) =>
  request(app)
    .post(`/v1/vaults/${VAULT}/batches`)
    .set(auth)
    .send({ deviceId: DEVICE, payload });

const begin = async (): Promise<string> => {
  const res = await request(app)
    .post(`/v1/vaults/${VAULT}/snapshots`)
    .set(auth)
    .send({});
  return res.body.snapshotId;
};

const putChunk = (id: string, index: number, payload: string) =>
  request(app)
    .put(`/v1/vaults/${VAULT}/snapshots/${id}/chunks/${index}`)
    .set(auth)
    .send({ payload });

const commit = (id: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/v1/vaults/${VAULT}/snapshots/${id}/commit`)
    .set(auth)
    .send({ deviceId: DEVICE, rowCount: 1, ...body });

const getSnapshot = () =>
  request(app).get(`/v1/vaults/${VAULT}/snapshot`).set(auth);

describe('snapshot lifecycle', () => {
  it('reports no snapshot for a fresh vault', async () => {
    await push('one');
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBeNull();
  });

  it('hides chunks until the snapshot is committed', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'chunk-zero');

    // Uncommitted: neither the manifest nor its chunks are readable.
    expect((await getSnapshot()).body.snapshot).toBeNull();
    const chunk = await request(app)
      .get(`/v1/vaults/${VAULT}/snapshots/${id}/chunks/0`)
      .set(auth);
    expect(chunk.status).toBe(404);
  });

  it('publishes a committed snapshot and serves its chunks', async () => {
    await push('one');
    await push('two');

    const id = await begin();
    await putChunk(id, 0, 'chunk-zero');
    await putChunk(id, 1, 'chunk-one');
    const res = await commit(id, { throughSeq: 2, chunkCount: 2, rowCount: 7 });
    expect(res.status).toBe(200);

    const manifest = (await getSnapshot()).body.snapshot;
    expect(manifest).toMatchObject({
      snapshotId: id,
      throughSeq: 2,
      chunkCount: 2,
      rowCount: 7,
    });

    const chunk = await request(app)
      .get(`/v1/vaults/${VAULT}/snapshots/${id}/chunks/1`)
      .set(auth);
    expect(chunk.body.payload).toBe('chunk-one');
  });

  it('refuses to commit when chunks are missing', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'only-one');

    // Publishing an incomplete snapshot would make it unrestorable.
    const res = await commit(id, { throughSeq: 1, chunkCount: 3 });
    expect(res.status).toBe(409);
    expect((await getSnapshot()).body.snapshot).toBeNull();
  });

  it('refuses a throughSeq ahead of the log', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'chunk');
    const res = await commit(id, { throughSeq: 99, chunkCount: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects chunks for an unknown snapshot', async () => {
    const res = await putChunk('no-such-snapshot', 0, 'x');
    expect(res.status).toBe(404);
  });

  it('rejects further chunks once committed', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'chunk');
    await commit(id, { throughSeq: 1, chunkCount: 1 });

    // Readers may already be using it, so it must be immutable.
    const res = await putChunk(id, 1, 'late');
    expect(res.status).toBe(404);
  });
});

describe('commit compacts the log', () => {
  it('drops every batch the snapshot covers', async () => {
    for (let i = 0; i < 5; i++) await push(`batch-${i}`);

    const id = await begin();
    await putChunk(id, 0, 'full-state');
    await commit(id, { throughSeq: 5, chunkCount: 1 });

    const after = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=0`)
      .set(auth);
    expect(after.body.batches).toEqual([]);
    // Unlike bare compaction the head goes too: the snapshot is the floor.
    expect(after.body.latestSeq).toBe(5);
  });

  it('keeps issuing sequence numbers after the log is emptied', async () => {
    for (let i = 0; i < 3; i++) await push(`batch-${i}`);
    const id = await begin();
    await putChunk(id, 0, 'full-state');
    await commit(id, { throughSeq: 3, chunkCount: 1 });

    // Reusing seq 1 here would be invisible to a device restored at seq 3.
    const next = await push('after-snapshot');
    expect(next.body.seq).toBe(4);

    const after = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=3`)
      .set(auth);
    expect(after.body.batches.map((b: { seq: number }) => b.seq)).toEqual([4]);
  });

  it('leaves batches after throughSeq intact', async () => {
    for (let i = 0; i < 5; i++) await push(`batch-${i}`);
    const id = await begin();
    await putChunk(id, 0, 'state');
    await commit(id, { throughSeq: 3, chunkCount: 1 });

    const after = await request(app)
      .get(`/v1/vaults/${VAULT}/batches?since=0`)
      .set(auth);
    expect(after.body.batches.map((b: { seq: number }) => b.seq)).toEqual([
      4, 5,
    ]);
  });

  it('replaces the previous snapshot and frees its chunks', async () => {
    await push('one');
    const first = await begin();
    await putChunk(first, 0, 'old-state');
    await commit(first, { throughSeq: 1, chunkCount: 1 });

    await push('two');
    const second = await begin();
    await putChunk(second, 0, 'new-state');
    await commit(second, { throughSeq: 2, chunkCount: 1 });

    expect((await getSnapshot()).body.snapshot.snapshotId).toBe(second);

    // The superseded snapshot's chunks must not linger.
    const stale = await request(app)
      .get(`/v1/vaults/${VAULT}/snapshots/${first}/chunks/0`)
      .set(auth);
    expect(stale.status).toBe(404);
  });

  it('reclaims quota from compacted batches', async () => {
    const small = new VaultStore(':memory:', {
      maxBatchBytes: 128,
      maxVaultBytes: 200,
    });
    small.authenticate(VAULT, TOKEN);
    small.append(VAULT, DEVICE, 'x'.repeat(80));
    small.append(VAULT, DEVICE, 'y'.repeat(80));

    small.beginSnapshot(VAULT, 'snap-1');
    small.putSnapshotChunk(VAULT, 'snap-1', 0, 'state');
    small.commitSnapshot(VAULT, 'snap-1', {
      throughSeq: 2,
      chunkCount: 1,
      rowCount: 2,
      deviceId: DEVICE,
    });

    expect(() => small.append(VAULT, DEVICE, 'z'.repeat(80))).not.toThrow();
    small.close();
  });
});

describe('snapshot isolation and hygiene', () => {
  it('does not serve one vault a snapshot from another', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'secret-state');
    await commit(id, { throughSeq: 1, chunkCount: 1 });

    const otherVault = 'd'.repeat(32);
    const res = await request(app)
      .get(`/v1/vaults/${otherVault}/snapshots/${id}/chunks/0`)
      .set({ Authorization: 'Bearer other-token' });
    expect(res.status).toBe(404);
  });

  it('enforces the payload quota on chunks', async () => {
    const small = new VaultStore(':memory:', {
      maxBatchBytes: 32,
      maxVaultBytes: 10_000,
    });
    const smallApp = createApp({ store: small, rateLimitMax: 0 });

    const started = await request(smallApp)
      .post(`/v1/vaults/${VAULT}/snapshots`)
      .set(auth)
      .send({});

    const res = await request(smallApp)
      .put(`/v1/vaults/${VAULT}/snapshots/${started.body.snapshotId}/chunks/0`)
      .set(auth)
      .send({ payload: 'x'.repeat(200) });

    expect(res.status).toBe(413);
    small.close();
  });

  it('purges snapshots that were started but never committed', async () => {
    store.authenticate(VAULT, TOKEN);
    store.beginSnapshot(VAULT, 'abandoned');
    store.putSnapshotChunk(VAULT, 'abandoned', 0, 'partial');

    // Nothing is old enough yet.
    expect(store.purgeAbandonedSnapshots(60_000)).toBe(0);
    // With a zero window everything uncommitted qualifies.
    expect(store.purgeAbandonedSnapshots(0)).toBe(1);
    expect(store.getSnapshot(VAULT)).toBeNull();
  });

  it('never purges a committed snapshot', async () => {
    await push('one');
    const id = await begin();
    await putChunk(id, 0, 'state');
    await commit(id, { throughSeq: 1, chunkCount: 1 });

    expect(store.purgeAbandonedSnapshots(0)).toBe(0);
    expect(store.getSnapshot(VAULT)?.snapshotId).toBe(id);
  });
});
