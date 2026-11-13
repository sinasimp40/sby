# Run Telecart on your computer

**SQLite location:** You can enter a folder (for example `C:\My Shop\data`) or a filename (`C:\My Shop\data\telecart.db`). A folder uses `telecart.db` inside it. An existing database file, including one without an extension, is kept as the selected file. If an earlier setup already saved a folder in `.env.local`, the launcher handles it automatically without rewriting settings. Do **not** delete `.env.local` to fix this error: its original `SESSION_SECRET` is needed for existing encrypted data.

## One-time installation

1. Install **Node.js 22.16+ or 24+** and **pnpm**. **PostgreSQL is no longer required.** SQLite is built into the supported Node.js runtime; no database service or native module compilation is needed.
2. Download or clone the whole project onto your computer.
3. On Windows, double-click **`start-local.bat`**. On macOS or Linux, open a terminal in the project folder and run **`./start-local.sh`**. The launchers work from any starting folder and install locked project dependencies when they are missing.
4. The first launch asks for a SQLite file path (press Enter for **`data/telecart.db`**), admin email, and a password of at least 12 characters. Password input is hidden. A new installation gets a fresh `SESSION_SECRET`; attaching an existing live SQLite shop requires its original secret and owner ID. The launcher writes `.env.local` once and never replaces it. Keep this file private.
5. If the selected SQLite file is new, type **`CREATE TELECART TABLES`** to create its tables. Existing live databases are preserved. Unrelated, incomplete or unsupported files are refused, not silently overwritten. A portable export's `shop.db` is a transfer file, not a live database: import its ZIP through the dashboard.
6. If saved Telegram polling, advertising, or pending payments are present, the launcher describes the background work and asks you to type **`START LOCAL PROCESSING`** before starting. Disable Telegram on the old copy first; never run two receivers for one account or bot.
7. The dashboard opens at **http://localhost:5173** only after both the API and website respond. Sign in using the email and password you entered privately. If either port (8080 or 5173) is already occupied, close the other local app yourself; the launcher never kills unrelated processes.

### One-time setup versus daily startup

- Install Node.js and pnpm once.
- First launch creates `.env.local`, installs locked dependencies if needed, checks SQLite, and asks before initializing a new file or resuming saved processing.
- **`pnpm db:local`** explicitly checks/initializes the current supported SQLite schema. It never force-rewrites unknown databases. Daily startup does not apply schema changes to existing databases.
- After setup, double-click **`start-local.bat`** on Windows or run **`./start-local.sh`** to start the API and dashboard together.
- Press Ctrl+C in the launcher window to stop the local services. Closing it or putting the computer to sleep stops shop processing and payment checks.

If SQLite cannot open, check `TELECART_SQLITE_PATH` in `.env.local`, available disk space and folder permissions. Only one Telecart server may open a shop file at a time. Stop the other copy before retrying; do not delete a live process's `.lock` file. The local servers bind to loopback. No Replit secrets are copied into the local installation.

## SQLite storage and durability

- All shop tables, encrypted stock, settings, orders, wallet entries, admin sessions and saved account/provider records now live in the SQLite file. Images remain image links; exported shop data preserves those links.
- Keep `.env.local` with its original `SESSION_SECRET` when keeping a live database file. Losing the key makes encrypted inventory and credentials unreadable.
- SQLite uses foreign keys, WAL journaling, full synchronous writes and serialized write transactions. Stop Telecart cleanly before manually moving its live file. Do not copy only the `.db` while it is running: committed changes can still be in `.db-wal`.
- For shop transfers, use the dashboard ZIP export/import. It contains real SQLite tables and readable portable credentials, so keep the ZIP private.
- **Replit Preview is suitable for trying this setup. Replit's published-app filesystem is not permanent storage across publishes/redeployments. Do not run live sales on a published Replit copy using this local SQLite file.** Use your computer or a host with a persistent disk.
- Validation: `pnpm test:local`, `pnpm test:sqlite`, and `pnpm run typecheck`. With ports 8080 and 5173 free, `pnpm test:launcher` starts and stops the real local services against a temporary SQLite file. A GitHub Actions workflow is included for Ubuntu and Windows; it still needs to run on GitHub. Linux checks cannot certify Windows.

## Daily controls — all in the dashboard

Under **Bot messages → Provider connections** (also available under **NOWPayments**):

- Enter, check and save your **Telegram token**.
- Enter, check and save your **NOWPayments API key and IPN secret**. The API key is checked with the provider; the IPN secret can only be verified when a signed payment notification arrives.
- Select **Polling** for localhost. A public Telegram callback URL is not needed.
- Leave the public HTTPS callback origin blank unless you have a real public server/tunnel.
- Click **Enable Telegram**, read the live-processing warning, confirm the provider rules, and approve. The displayed worker status changes from Starting to Running only after a successful Telegram poll.
- **Disable Telegram** pauses new commands and delivery messages. Payment verification continues. Already-started requests may finish. Stock and orders are not deleted.
- Change mode or URL while disabled. Settings persist in SQLite and apply without restarting the server.

With polling and no public callback URL, NOWPayments invoices omit the IPN URL. Automatic outbound reconciliation checks provider status while this server is running; the dashboard also provides payment checks (older invoices may have a buyer-side Check payment button). Only a verified `finished` payment with the required amount can settle. Some retries are bounded; do not leave a selling shop unattended/offline for long periods. Existing allocated deliveries remain retryable.

For **Webhook** mode, supply a public HTTPS origin, e.g. `https://shop.example.com` with no path. Incoming Telegram/payment callbacks must reach this app's `/api` endpoints without requiring login. A localhost URL cannot be reached by the providers. A configured webhook is not proof that the provider has successfully delivered a message.

## Moving your existing shop, not starting a new one

- Disable Telegram on the old copy **before** enabling it on your computer. Never run two receivers for one token.
- Keep the **same shop owner ID** shown in the dashboard's “Moving this shop to your computer” section.
- With a **new SQLite ZIP export** from the dashboard, the ZIP alone is sufficient: it contains `shop.db`, not JSON files. The destination can use its own installation secret and owner; import encrypts stock and saved provider credentials for that installation. Keep the ZIP private: anyone with it can read those credentials. Only import a trusted file.
- Preserve the **original SESSION_SECRET** when attaching an existing database or importing an old JSON ZIP. Existing ciphertext needs its original key; an old ZIP alone cannot recover that key. The new format does not repair previously exported files with lost keys.
- The local database must contain the existing shop's data if you want its products, stock, customers, orders, saved credentials and settings. An empty database starts a new shop; downloading code does **not** copy database rows.
- An old `.env.local` containing only `DATABASE_URL` is detected and left unchanged. For an old PostgreSQL shop, stop the source server and run the explicit one-time conversion: `node scripts/migrate-postgres-to-sqlite.mjs --confirm-read-only-migration`, with the source `DATABASE_URL` privately supplied in that process's environment and `TELECART_SQLITE_PATH` pointing at an empty destination. It reads PostgreSQL without changing it, checks row counts and relationships, and pauses processing in the destination. Keep the original `SESSION_SECRET` and owner ID. Then replace `DATABASE_URL` in the local config with `TELECART_SQLITE_PATH`. This is not part of daily startup.
- With an explicit owner ID and no Clerk secret in the local environment, password sign-in uses that trusted local owner without creating or changing any cloud user.

## What remains installation configuration

Database access, `SESSION_SECRET`, the trusted owner binding, and the initial admin login must be supplied before the server can securely start. These cannot safely be initialized by an unauthenticated dashboard. Routine provider keys, connection mode, public callbacks, Telegram enable/disable, products, stock, messages and shop settings are managed inside the dashboard.
