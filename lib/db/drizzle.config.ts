import { defineConfig } from "drizzle-kit";
import path from "path";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  out: path.relative(process.cwd(), path.join(__dirname, "./migrations")),
  dbCredentials: {
    url: process.env.TELECART_SQLITE_PATH || path.resolve(__dirname, "../../data/telecart.db"),
  },
});
