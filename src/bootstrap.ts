import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Find the project root (the dir holding both .env and package.json) by walking
 * up from a starting directory, then load that .env. This lets any script run
 * regardless of the current working directory — the same self-bootstrap the
 * Python scripts had.
 *
 * @param fromDir directory to start the search from (defaults to this file's dir)
 * @returns the project root path, or null if not found
 */
export function loadProjectEnv(fromDir?: string): string | null {
  let dir = fromDir ?? dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, ".env")) && existsSync(join(dir, "package.json"))) {
      config({ path: join(dir, ".env") });
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
