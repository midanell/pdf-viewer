// Shared results-directory resolution so the harness and analysis scripts agree
// on where artifacts live. The --quick profile writes to results/quick/ so it
// never clobbers a full-run dataset in results/.

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

export function isQuick(argv = process.argv) {
  return argv.includes("--quick");
}

export function resultsDir(argv = process.argv) {
  return isQuick(argv) ? join(ROOT, "results", "quick") : join(ROOT, "results");
}
