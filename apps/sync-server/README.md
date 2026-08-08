# Fluxby Sync Server

A small, self-hostable server that lets multiple Fluxby devices stay in sync.

It stores **encrypted blobs and nothing else**. Every payload is encrypted on
your device before it is sent, with a key derived from a passphrase the server
never receives. Running this server does not give you — or anyone who
compromises it — the ability to read anyone's finances.

---

## What the server can and cannot see

| It sees | It cannot see |
| --- | --- |
| Vault id (a derived, opaque 128-bit value) | Any transaction, account, category or amount |
| Device ids | Table names or row ids |
| Sequence numbers and timestamps | Row timestamps |
| Payload sizes | Your passphrase or any encryption key |

Payload size and write frequency are genuine metadata leaks: someone with
access to the server can tell *that* a vault is active and roughly how much
data it holds, just not what any of it is.

---

## Requirements

- Node.js 22 or newer
- No external database — storage is SQLite on local disk

## Quick start

```bash
git clone <this-repo>
cd fluxby
npm install
npm run build -w apps/sync-server
npm run start -w apps/sync-server
```

The server listens on port 3002 and writes to `./sync-server.db`.

Check it is alive:

```bash
curl http://localhost:3002/v1/health
# {"ok":true,"service":"fluxby-sync","protocol":1}
```

For development with auto-reload:

```bash
npm run dev:sync-server
```

## Connecting a device

In Fluxby: **Settings → Remote Sync**, then enter

- **Server URL** — where this server is reachable, e.g. `https://sync.example.com`
- **Vault label** — anything you like, but **every device must use exactly the
  same one**. It salts your key derivation. An email address works well.
- **Vault passphrase** — this protects your data. It never leaves the device.

Repeat on each device with the **identical label and passphrase**. Matching
credentials derive the same vault id, so the devices find each other with no
account, no signup, and nothing for the server to hand out.

> **There is no password reset.** If you lose the passphrase, the data on the
> server is permanently unreadable. That is the point, but it means the
> passphrase belongs in a password manager.

## Configuration

All settings are environment variables. Every one has a working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3002` | Port to listen on |
| `SYNC_DB_PATH` | `./sync-server.db` | Where the SQLite database lives |
| `SYNC_MAX_BATCH_BYTES` | `1048576` (1 MiB) | Largest single payload |
| `SYNC_MAX_VAULT_BYTES` | `268435456` (256 MiB) | Storage cap per vault |
| `SYNC_RATE_LIMIT_MAX` | `120` | Requests per window, per IP |
| `SYNC_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `SYNC_TRUST_PROXY` | unset | Number of reverse proxies in front (set to `1` behind one proxy) |

Example:

```bash
PORT=8080 \
SYNC_DB_PATH=/var/lib/fluxby/sync.db \
SYNC_MAX_VAULT_BYTES=1073741824 \
npm run start -w apps/sync-server
```

## Deploying

### Put it behind HTTPS

The server speaks plain HTTP and does not terminate TLS. Run it behind a
reverse proxy. The payloads are already encrypted, so TLS is not what protects
your data — but without it, your auth token crosses the network in the clear
and anyone in between could write to your vault.

Caddy, which handles certificates automatically:

```
sync.example.com {
    reverse_proxy localhost:3002
}
```

nginx:

```nginx
server {
    server_name sync.example.com;
    listen 443 ssl;

    location / {
        proxy_pass http://localhost:3002;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If you proxy, set `SYNC_TRUST_PROXY=1`, or rate limiting will see every request
as coming from the proxy and throttle all your users as one.

### Keep it running

systemd:

```ini
[Unit]
Description=Fluxby Sync Server
After=network.target

[Service]
Type=simple
User=fluxby
WorkingDirectory=/opt/fluxby
Environment=SYNC_DB_PATH=/var/lib/fluxby/sync.db
ExecStart=/usr/bin/node apps/sync-server/dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Docker:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w apps/sync-server
ENV SYNC_DB_PATH=/data/sync.db
VOLUME /data
EXPOSE 3002
CMD ["node", "apps/sync-server/dist/index.js"]
```

Mount `/data` on a real volume. If the database is lost, every device has to
re-upload from scratch.

### Back it up

The database is a single SQLite file. Because it runs in WAL mode, do not copy
it while the server is writing — use SQLite's own backup:

```bash
sqlite3 /var/lib/fluxby/sync.db ".backup '/backups/sync-$(date +%F).db'"
```

Backups contain only ciphertext, so they are about as sensitive as the live
database — which is to say, not very. Losing them is the real risk, not leaking
them.

## How it works

The server is an **append-only log of encrypted batches**, one log per vault.

1. A device encrypts its changed rows and appends them as a batch.
2. The server assigns a monotonic sequence number.
3. Other devices ask for everything after the sequence number they last saw,
   decrypt it, and merge with Last-Write-Wins.

The server never merges anything, because it cannot read anything.

### Snapshots and compaction

Left alone, the log grows forever and every new device replays all of history.
So devices periodically publish a **snapshot**: a complete encrypted copy of
the dataset, split into chunks, representing one point in the log.

When a snapshot is committed, the server atomically publishes it, deletes the
previous one, and drops every batch the snapshot covers. New devices restore
from the snapshot and then replay only the short tail after it.

Two details that matter if you modify this:

- A snapshot's `throughSeq` is the **creating device's own applied position**,
  never the server's latest sequence. A device that has not applied batch N
  cannot produce a snapshot that stands in for batch N.
- Sequence numbers come from a persisted per-vault counter, not from
  `MAX(seq)`. Compaction can empty the batch table entirely, and a counter that
  restarted would issue numbers that restored devices have already moved past —
  so those batches would never be delivered.

## API

Every endpoint except `/v1/health` requires `Authorization: Bearer <token>`,
where the token is derived on the device. The server stores only its SHA-256
hash and compares in constant time.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness probe |
| `POST` | `/v1/vaults/:vaultId/batches` | Append an encrypted batch |
| `GET` | `/v1/vaults/:vaultId/batches?since=&limit=` | Read batches after a cursor |
| `POST` | `/v1/vaults/:vaultId/compact` | Drop batches through a sequence |
| `GET` | `/v1/vaults/:vaultId/snapshot` | Current snapshot manifest |
| `POST` | `/v1/vaults/:vaultId/snapshots` | Begin a snapshot upload |
| `PUT` | `/v1/vaults/:vaultId/snapshots/:id/chunks/:index` | Upload one chunk |
| `POST` | `/v1/vaults/:vaultId/snapshots/:id/commit` | Publish and compact |
| `GET` | `/v1/vaults/:vaultId/snapshots/:id/chunks/:index` | Download one chunk |

The full request and response shapes live in
`apps/web/src/addons/remote-sync/protocol.ts`, which is the contract for any
alternative implementation.

## Security notes

**Vault ownership is trust-on-first-use.** The first client to present a token
for an unknown vault id claims it; later requests must match. Vault ids are
128-bit values derived from a passphrase, so claiming someone else's vault
means already knowing a secret you could not derive without their passphrase.

**Anyone who can reach the server can create a vault.** There is no
registration, so a public instance is open to anyone who finds it. If that
matters, restrict access at the proxy — IP allow-list, mTLS, or basic auth in
front — or keep it on a private network or VPN.

**Quotas are your only defence against a full disk.** The defaults cap each
vault at 256 MiB. Lower `SYNC_MAX_VAULT_BYTES` on a small instance.

**No account recovery exists by design.** You cannot help a user who has lost
their passphrase, because you hold nothing that could.

## Troubleshooting

**Devices do not see each other's data.** They must have the *exact* same vault
label and passphrase. The label is trimmed and lowercased; the passphrase is
not. A different passphrase silently produces a different vault rather than an
error, because the server cannot tell the two apart.

**`401 unauthorized`.** The vault id exists with a different token — typically
a changed passphrase or label. Changing either creates a new vault and strands
the old one.

**`413 quota_exceeded`.** The vault hit its cap. Raise
`SYNC_MAX_VAULT_BYTES`, or let the device publish a snapshot so the log can be
compacted.

**`429`.** Rate limited. Raise `SYNC_RATE_LIMIT_MAX`, or set `SYNC_TRUST_PROXY=1`
if everything arrives via a reverse proxy and is being counted as one client.

**Sync stops after locking the app.** Expected. The sync key is wrapped with
your app password, so syncing resumes when you unlock.

## Development

```bash
npm run dev:sync-server                  # auto-reloading server
npx vitest run tests/sync-server/         # server tests
npx vitest run tests/web/addons/          # client and end-to-end tests
```

`tests/web/addons/remote-sync-e2e.test.ts` runs two devices and this server in
one process with real encryption, which is the fastest way to check that a
protocol change has not broken the round trip.

## License

MIT, the same as Fluxby.
