# Private synchronization with MEGA

The private root is discovered automatically beside the repository. `Omnichannel.bat` prioritizes `omnichannel-data`, recognizes one marked sibling folder, and creates the default folder when necessary. Shared company configuration stays in `config/platform.env`; the repository stores no real `.env`.

Each company has separate `context`, `rag`, `rules`, `conversations`, `contacts`, `cards`, `attachments`, and `datasets` folders. Records that exist only in PostgreSQL/Chatwoot are automatically included in the portable state created during graceful shutdown.

## One-time setup

1. Create a dedicated MEGA account and confirm its email address.
2. Sign in through the browser at least once. This generates the cryptographic account keys required by MEGA.
3. On the computer containing the original approximately 8 GB archive, run `Omnichannel.bat` and select **Configure MEGA synchronization**. The configurator refuses to create the master copy from an empty local folder.
4. Enter the email and password once. Windows DPAPI protects the credential so only the same user on that computer can recover it automatically. The local value remains in `_local/machine.env`, outside the repository and excluded from synchronization.
5. An empty remote folder receives that computer's initial copy. A remote folder containing a valid, non-empty Omnichannel copy is downloaded. A remote containing only the marker never overwrites an existing local archive.

There is no recurring login after setup: **Start system** downloads before Docker starts and **Stop system** pauses the services, creates a consistent portable state, uploads everything after graceful shutdown, and closes Docker Desktop to release `vmmem` memory. Each new computer must be authorized once through the same menu.

Startup also installs the **Omnichannel - Sincronizacao automatica** task. It checks for changes every 15 minutes, waits for 15 minutes of stability before uploading, and forces an update within 2 hours when writes are continuous. It creates consistent live dumps without interrupting service, skips overlapping runs, and logs results to `<OMNICHANNEL_DATA_ROOT>\_local\logs\auto-sync.log`.

While temporary quick tunnels are in use, the **Omnichannel - Monitor publico** task checks Gateway and Chatwoot every 5 minutes. It tolerates transient failures, but recreates the tunnels and republishes the manifest after persistent unavailability. Its log is stored at `%LOCALAPPDATA%\Omnichannel\logs\public-monitor.log`.

The `state/current` directory contains the restorable copy of PostgreSQL, Redis, Chatwoot attachments, n8n data, and infrastructure secrets. It covers customers, cards, conversations, context/RAG, and configuration stored in Docker volumes. `platform.env` does not contain the MEGA password or the machine-bound DPAPI credential. On another computer, the first startup restores this state automatically; later startups use `_local/applied-state-id` to avoid unnecessary restores.

Keep the account dedicated to Omnichannel and do not enable 2FA while the `rclone` backend requires a current code for each new session; that would prevent unattended automation.

## Graceful shutdown

The **Start system** option registers a Windows task for shutdown and restart events. It stops the containers before uploading private changes. If task registration fails due to permissions, run `Omnichannel.bat` as administrator and select **Install automatic Windows shutdown** once.

The log is stored at `%LOCALAPPDATA%\Omnichannel\logs\shutdown.log`. The `backups` subfolder is not uploaded to MEGA.

Before each upload, rclone compares the local size with the account's actual available space. A mandatory 250 MB margin applies; if the data would not fit, synchronization is disabled before any partial upload starts. Remote deletions are permanent so old versions cannot consume the limited quota.

Large source archives may be kept under `imports`; database snapshots remain the portable runtime source of truth. Keep raw bulk exports outside Git and package them before remote transfer when needed.

## Important limitation

MEGA synchronizes files and a portable volume snapshot; while running, PostgreSQL still uses its local Docker volume. Never run two environments against the same webhook simultaneously. MEGA storage is temporary and can later be replaced by the private server without changing the local `omnichannel-data` location.
