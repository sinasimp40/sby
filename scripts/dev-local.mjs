import { spawn } from "node:child_process";

const required = ["DATABASE_URL", "SESSION_SECRET", "TELECART_OWNER_ID", "TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD"];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Complete .env.local first. Missing configuration names: ${missing.join(", ")}`);
  process.exit(1);
}
const bin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = {
  ...process.env, NODE_ENV: "development", BASE_PATH: "/", TELECART_LOCAL_ONLY: "true",
  TELECART_ADMIN_ORIGIN: "http://localhost:5173",
  TELECART_LOCAL_API_PORT: "8080",
};
if (process.argv.includes("--setup")) {
  const setup = spawn(bin, ["--filter", "@workspace/db", "run", "push"], { env, stdio: "inherit", shell: process.platform === "win32" });
  setup.on("exit", code => process.exit(code ?? 1));
} else {
  // Avoid the Replit dev script's Unix `export` command on Windows.
  const built = await new Promise(resolve => {
    const build = spawn(bin, ["--filter", "@workspace/api-server", "run", "build"], {
      env, stdio: "inherit", shell: process.platform === "win32",
    });
    build.on("error", () => resolve(false));
    build.on("exit", code => resolve(code === 0));
  });
  if (!built) {
    console.error("API build failed. Resolve the displayed error before starting the local shop.");
    process.exit(1);
  }
  const api = spawn(bin, ["--filter", "@workspace/api-server", "run", "start"], {
    env: { ...env, PORT: "8080" }, stdio: "inherit", shell: process.platform === "win32", detached: process.platform !== "win32",
  });
  const web = spawn(bin, ["--filter", "@workspace/telecart", "exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
    env: { ...env, PORT: "5173" }, stdio: "inherit", shell: process.platform === "win32", detached: process.platform !== "win32",
  });
  let stopping = false;
  const stop = code => {
    if (stopping) return;
    stopping = true;
    for (const child of [api, web]) {
      if (!child.pid) continue;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ } }
    }
    process.exitCode = code;
  };
  api.on("error", () => { console.error("Could not start pnpm. Install Node.js and pnpm first."); stop(1); });
  web.on("error", () => stop(1));
  api.on("exit", code => stop(code ?? 1));
  web.on("exit", code => stop(code ?? 1));
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  console.log("Dashboard: http://localhost:5173 — configure provider keys and Telegram processing after signing in.");
}
