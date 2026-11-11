# Run Telecart on your computer

## One-time installation

1. Install **Node.js 22.16+ or 24 LTS**, **pnpm**, and **PostgreSQL**. No Replit account or Clerk service is needed for a fresh local installation.
2. Download/clone this whole project. Create a PostgreSQL database.
3. Copy `.env.local.example` to `.env.local`. Enter your own PostgreSQL connection, admin email and a strong admin password. Generate a fresh `SESSION_SECRET` for a **new** shop with:
   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```
   Keep that secret private and stable. This is installation security, not a provider key. Do not paste secrets in chat.
4. In the project directory run:
   ```sh
   pnpm install
   pnpm db:local
   pnpm dev:local
   ```
   `db:local` applies this app's schema to the database you configured. Use a new empty database for a fresh installation; review changes if reusing a database.
5. Open **http://localhost:5173** (use this exact host/port), then sign in using the email and password in `.env.local`.

The frontend and backend bind to your computer's loopback interface. The development runner is for local use, not a public production server. Closing it or sleeping/shutting down the computer stops the bot and payment checks. On Windows, use a terminal with Node and pnpm installed.

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
- Preserve the **original SESSION_SECRET** when using existing data. Provider keys and stock are encrypted using it; generating another one does not migrate them.
- The local database must contain the existing shop's data if you want its products, stock, customers, orders, saved credentials and settings. An empty database starts a new shop; downloading code does **not** copy database rows.
- Point to a database you deliberately control. Do not reset or replace the running shop's database during setup. Plan the database transfer separately; no automatic transfer or destructive migration is performed here.
- With an explicit owner ID and no Clerk secret in the local environment, password sign-in uses that trusted local owner without creating or changing any cloud user.

## What remains installation configuration

Database access, `SESSION_SECRET`, the trusted owner binding, and the initial admin login must be supplied before the server can securely start. These cannot safely be initialized by an unauthenticated dashboard. Routine provider keys, connection mode, public callbacks, Telegram enable/disable, products, stock, messages and shop settings are managed inside the dashboard.
