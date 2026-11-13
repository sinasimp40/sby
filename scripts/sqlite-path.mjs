import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keep relative paths portable in .env.local. Resolve them against the project,
// not whichever directory a caller happens to launch a subprocess from.
export function normalizeSqlitePath(input, {
  baseDir = projectRoot, pathApi = path, inspect = statSync,
} = {}) {
  let value = (input || "data/telecart.db").trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
  if (!value || value === ":memory:" || /^[a-z]+:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Choose a local SQLite folder or database filename, not a server URL or in-memory database.");
  }
  let info;
  try { info = inspect(pathApi.resolve(baseDir, value)); }
  catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Cannot inspect the SQLite location. Check folder permissions and that its parent is a folder.");
    }
  }
  if (info?.isDirectory()) return pathApi.join(value, "telecart.db");
  if (info) {
    if (!info.isFile()) throw new Error("The SQLite location must be a regular file or a folder.");
    return value; // Preserve existing databases, including extensionless files.
  }
  // A missing folder named "data" is a common first-run choice. A supplied
  // filename with an extension remains a file, regardless of its extension.
  if (/[\\/]$/.test(value) || !pathApi.extname(value)) return pathApi.join(value, "telecart.db");
  return value;
}

export function resolveSqlitePath(input) {
  return path.resolve(projectRoot, normalizeSqlitePath(input));
}
