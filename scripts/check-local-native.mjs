import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function checkNativePackages() {
  const dashboard = createRequire(join(root, "artifacts/telecart/package.json"));
  const api = createRequire(join(root, "artifacts/api-server/package.json"));
  const vite = createRequire(dashboard.resolve("vite/package.json"));
  const tailwind = createRequire(dashboard.resolve("@tailwindcss/vite"));
  // Loading the parent packages verifies their native OS/CPU bindings, not
  // merely that a package directory exists in node_modules.
  vite("rollup");
  api("esbuild").transformSync("const ready = true", { loader: "js" });
  tailwind("@tailwindcss/oxide");
  tailwind("lightningcss").transform({ filename: "native-check.css", code: Buffer.from("a { color: red }") });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { checkNativePackages(); console.log(`Native build dependencies ready for ${process.platform}/${process.arch}.`); }
  catch {
    console.error(`Native build dependencies for ${process.platform}/${process.arch} are missing or incompatible. No app server was started.`);
    process.exitCode = 1;
  }
}
