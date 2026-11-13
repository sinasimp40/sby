import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { serializeLocalEnv, validateLocalConfig } from "./local-core.mjs";
import { normalizeSqlitePath } from "./sqlite-path.mjs";

function askLine(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("First-run setup needs an interactive terminal. Run start-local.bat from Windows Terminal or start-local.sh from a terminal."));
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    readline.question(question, answer => {
      readline.close();
      resolve(answer.trim());
    });
    readline.once("SIGINT", () => {
      readline.close();
      reject(new Error("Setup cancelled. No database was changed."));
    });
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Private first-run setup needs a real terminal. No secrets were displayed or saved."));
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const onData = chunk => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Setup cancelled. No database was changed."));
          return;
        }
        if (character === "\n" || character === "\r") {
          finish(null);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = [...value].slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
        } else if (character >= " ") {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    const onSignal = () => finish(new Error("Setup cancelled. No database was changed."));
    function finish(error) {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("SIGINT", onSignal);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    process.stdin.on("data", onData);
    process.stdin.once("SIGINT", onSignal);
  });
}

export async function makeFirstRunConfig({ ask = askLine, askSecret = askHidden } = {}) {
  console.log("First-run setup saves a private .env.local file on this computer.");
  console.log("SQLite stores all shop data in a local file. PostgreSQL is not required.");
  console.log("For a new empty shop or a new destination for a portable SQLite ZIP, choose 1.");
  console.log("For an existing live SQLite database, choose 2 and use its original SESSION_SECRET and owner ID.");
  const installation = await ask("1) New local installation   2) Attach an existing installation [1/2]: ");
  if (!["1", "2"].includes(installation)) throw new Error("Choose 1 or 2. No configuration was saved.");

  const enteredPath = await ask("SQLite folder or database file [data/telecart.db]: ") || "data/telecart.db";
  const databasePath = normalizeSqlitePath(enteredPath);
  if (databasePath !== enteredPath.trim()) console.log("Using telecart.db inside the selected folder (or removing surrounding path quotes).");
  const sessionSecret = installation === "1"
    ? randomBytes(48).toString("hex")
    : await askSecret("Original SESSION_SECRET for this existing installation (input hidden): ");
  const ownerId = installation === "1"
    ? "local-admin"
    : await ask("Existing TELECART_OWNER_ID (must exactly match the shop): ");
  const email = await ask("Admin sign-in email: ");
  const password = await askSecret("Admin password (12+ characters, input hidden): ");
  const passwordAgain = await askSecret("Confirm admin password (input hidden): ");
  if (password !== passwordAgain) throw new Error("The passwords did not match. No configuration was saved.");
  if (password.length < 12) throw new Error("The new admin password must contain at least 12 characters. No configuration was saved.");

  const config = {
    TELECART_SQLITE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    TELECART_OWNER_ID: ownerId,
    TELECART_ADMIN_EMAIL: email,
    TELECART_ADMIN_INITIAL_PASSWORD: password,
  };
  const error = validateLocalConfig(config);
  if (error) throw new Error(`${error} No configuration was saved.`);
  return config;
}

export async function saveFirstRunConfig(envPath, config) {
  const serialized = serializeLocalEnv(config);
  let fd;
  try {
    fd = openSync(envPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(".env.local already exists. It was left unchanged; keep its current SESSION_SECRET and review it locally.");
    }
    throw new Error("Could not create .env.local. Check the project folder permissions; no database was changed.");
  }
  try {
    writeFileSync(fd, serialized, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}
