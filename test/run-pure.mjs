// Explicit allowlist: never start a real socket, Native Host, Chrome or App.
// Filesystem fixtures and their ordinary Node shortcut-write children are local.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const jobs = [
  { name: "unit-vm-filesystem", files: ["image", "mark-recovery-host", "files", "page", "browser-repair", "mark", "download-shortcut", "lifecycle", "ownership", "capture-session", "bridge-status", "peer-identity"].map(name => `test/${name}.test.mjs`) },
  { name: "bridge-source-only", files: ["test/bridge.test.mjs"], names: ["frames round-trip a command", "tab creation does not focus Chrome", "native host manifest is bound to this extension", "conversations get separate tab groups", "extension source does not activate a tab or window"] },
  { name: "bridge-repair-vm-only", files: ["test/bridge-repair.test.mjs"], names: ["hello rejects socket error and keeps an error handler after rejection", "hello rejects close, abort, malformed frames and protocol mismatch without waiting for timeout", "hello success retains permanent socket error handling", "connect-to-hello transition has no unhandled error window", "connect is bounded and abortable even when net.connect never emits", "legacy discovery refuses without connecting to or evicting the old host"] },
  { name: "native-expiry-vm-only", files: ["test/reconnect.test.mjs"], names: ["unanswered native requests expire after 60 seconds and their late replies are discarded"] },
];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let failed = false;
for (const job of jobs) {
  const args = ["--test", "--test-reporter=tap"];
  if (job.names) args.push(`--test-name-pattern=^(?:${job.names.map(escape).join("|")})$`);
  args.push(...job.files);
  console.log(`# PURE_BATCH ${job.name} ${JSON.stringify(args)}`);
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 120000 });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  console.log(`# PURE_BATCH_RESULT ${JSON.stringify({ name: job.name, status: result.status, signal: result.signal, error: result.error?.message })}`);
  if (result.status !== 0 || result.signal || result.error) failed = true;
}
process.exitCode = failed ? 1 : 0;
