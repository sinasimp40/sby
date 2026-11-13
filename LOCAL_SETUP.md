# Run Telecart on your computer

## One-time installation

1. Install **Node.js 22.16+ or 24+**, **pnpm**, and **PostgreSQL**. Start PostgreSQL and create a database in pgAdmin (for a new shop, make it empty). The launcher never installs system software or creates/drops a database.
2. Download or clone the whole project onto your computer.
3. On Windows, double-click **`start-local.bat`**. On macOS or Linux, open a terminal in the project folder and run **`./start-local.sh`**. The launchers work from any starting folder and install locked project dependencies when they are missing.
4. The first launch privately asks for the PostgreSQL address, admin email, and admin password. Passwords and the database address are hidden while you type. A new installation gets a fresh `SESSION_SECRET`; attaching an existing PostgreSQL shop requires its original secret and owner ID. The launcher writes `.env.local` once and never replaces it. Keep this file private.
5. If the selected database is empty, the launcher explains that it will create Telecart's tables and asks you to type **`CREATE TELECART TABLES`** before applying the schema. Existing databases are not migrated during routine launches. A database with unrelated or incomplete tables is left unchanged; back up and review it before using the explicit `pnpm db:local` command.
6. If saved Telegram polling, advertising, or pending payments are present, the launcher describes the background work and asks you to type **`START LOCAL PROCESSING`** before starting. Disable Telegram on the old copy first; never run two receivers for one account or bot.
7. The dashboard opens at **http://localhost:5173** only after both the API and website respond. Sign in using the email and password you entered privately. If either port (8080 or 5173) is already occupied, close the other local app yourself; the launcher never kills unrelated processes.

### One-time setup versus daily startup

- Install Node.js, pnpm and PostgreSQL once; start PostgreSQL and create your database.
- First launch creates `.env.local`, installs project dependencies if needed, checks PostgreSQL, and asks before initializing an empty database or resuming saved processing.
- For a deliberate schema change to an existing database, back it up and run **`pnpm db:local`** from the project folder. Confirm the prompt and review every schema change Drizzle displays. Daily startup never runs this command automatically.
- After setup, double-click **`start-local.bat`** on Windows or run **`./start-local.sh`** to start the API and dashboard together.
- Press Ctrl+C in the launcher window to stop the local services. Closing it or putting the computer to sleep stops shop processing and payment checks.

If the launcher reports a PostgreSQL connection error, start PostgreSQL and verify the address, username, password and database name in `.env.local`. The connection URL is never printed. The local servers bind to loopback and are for development, not public hosting. No Replit secrets are copied into the local installation.

## Daily controls — all in the dashboard

Under **Bot messages → Provider connections** (also available under **NOWPayments**):

- Enter, check and save your **Telegram token**.
- Enter, check and save your **NOWPayments API key and IPN secret**. The API key is checked with the provider; the IPN secret can only be verified when a signed payment notification arrives.
- Select **Polling** for localhost. A public Telegram callback URL is not needed.
- Leave the public HTTPS callback origin blank unless you have a real public server/tunnel.
- Click **Enable Telegram**, read the live-processing warning, confirm the provider rules, and approve. The displayed worker status changes from Starting to Running only after a successful Telegram poll.
- **Disable Telegram** pauses new commands and delivery messages. Payment verification continues. Already-started requests may finish. Stock and orders are not deleted.
- Change mode or URL while disabled. Settings persist in PostgreSQL and apply without restarting the server.

With polling and no public callback URL, NOWPayments invoices omit the IPN URL. Automatic outbound reconciliation checks provider status while this server is running; the dashboard also provides payment checks (older invoices may have a buyer-side Check payment button). Only a verified `finished` payment with the required amount can settle. Some retries are bounded; do not leave a selling shop unattended/offline for long periods. Existing allocated deliveries remain retryable.

For **Webhook** mode, supply a public HTTPS origin, e.g. `https://shop.example.com` with no path. Incoming Telegram/payment callbacks must reach this app's `/api` endpoints without requiring login. A localhost URL cannot be reached by the providers. A configured webhook is not proof that the provider has successfully delivered a message.

## Moving your existing shop, not starting a new one

- Disable Telegram on the old copy **before** enabling it on your computer. Never run two receivers for one token.
- Keep the **same shop owner ID** shown in the dashboard's “Moving this shop to your computer” section.
- With a **new SQLite ZIP export** from the dashboard, the ZIP alone is sufficient: it contains `shop.db`, not JSON files. The destination can use its own installation secret and owner; import encrypts stock and saved provider credentials for that installation. Keep the ZIP private: anyone with it can read those credentials. Only import a trusted file.
- Preserve the **original SESSION_SECRET** when attaching an existing database or importing an old JSON ZIP. Existing ciphertext needs its original key; an old ZIP alone cannot recover that key. The new format does not repair previously exported files with lost keys.
- The local database must contain the existing shop's data if you want its products, stock, customers, orders, saved credentials and settings. An empty database starts a new shop; downloading code does **not** copy database rows.
- Point to a database you deliberately control. Do not reset or replace the running shop's database during setup. Plan the database transfer separately; no automatic transfer or destructive migration is performed here.
- With an explicit owner ID and no Clerk secret in the local environment, password sign-in uses that trusted local owner without creating or changing any cloud user.

## What remains installation configuration

Database access, `SESSION_SECRET`, the trusted owner binding, and the initial admin login must be supplied before the server can securely start. These cannot safely be initialized by an unauthenticated dashboard. Routine provider keys, connection mode, public callbacks, Telegram enable/disable, products, stock, messages and shop settings are managed inside the dashboard.
