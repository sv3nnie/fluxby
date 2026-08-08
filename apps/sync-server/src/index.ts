import { createApp } from './app.js';
import { DEFAULT_QUOTA, VaultStore } from './store.js';

const PORT = Number(process.env.PORT ?? 3002);
const DB_PATH = process.env.SYNC_DB_PATH ?? './sync-server.db';

const store = new VaultStore(DB_PATH, {
  maxBatchBytes: Number(
    process.env.SYNC_MAX_BATCH_BYTES ?? DEFAULT_QUOTA.maxBatchBytes
  ),
  maxVaultBytes: Number(
    process.env.SYNC_MAX_VAULT_BYTES ?? DEFAULT_QUOTA.maxVaultBytes
  ),
});

const app = createApp({
  store,
  rateLimitMax: Number(process.env.SYNC_RATE_LIMIT_MAX ?? 120),
  rateLimitWindowMs: Number(process.env.SYNC_RATE_LIMIT_WINDOW_MS ?? 60_000),
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fluxby sync server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Storing encrypted batches in ${DB_PATH}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
