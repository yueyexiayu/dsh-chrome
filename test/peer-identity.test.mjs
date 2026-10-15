import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { peerAllowed } from "../host/peer-identity.mjs";

// Exercise the production gate without importing bridge.mjs (which starts a
// Native Host). The fake filesystem only supplies canonical executable paths;
// expected path/version decisions below are independent, literal examples.
const source = fs.readFileSync(new URL("../host/peer-identity.mjs", import.meta.url), "utf8");
const gate = source.match(/^export function peerAllowed\(exe\) \{[\s\S]*?^\}/m)?.[0]?.replace(/^export /, "");
assert.ok(gate, "shared identity module must export the bridge admission gate");
const main = bundle => `/Applications/${bundle}.app/Contents/MacOS/DeepSeek Harness`;
function peerGate(realpathSync = exe => exe) {
  return vm.runInNewContext(`${gate}\npeerAllowed`, { fs: { realpathSync } });
}

test("actual versioned DSH main executable is admitted", () => {
  assert.equal(peerGate()(main("DeepSeek Harness 0.2.1-alpha.2.20261015.1")), true);
});

test("only canonical DSH main executables with valid SemVer bundle names are admitted", () => {
  const allowed = peerGate();
  for (const bundle of [
    "DeepSeek Harness", "DeepSeek Harness 0.2.1", "DeepSeek Harness 1.0.0-rc.1",
    "DeepSeek Harness 0.2.1-alpha.2.20261015.1", "DeepSeek Harness 1.2.3+build.001",
    "DeepSeek Harness 1.2.3-alpha-1+arm64.20261015",
  ]) assert.equal(allowed(main(bundle)), true, bundle);
  for (const version of [
    "latest", "v0.2.1", "0.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01",
    "1.2.3-alpha..1", "1.2.3-", "1.2.3+", "1.2.3+build..1", "1.2.3 evil",
    "1.2.3/Other", "1.2.3\n", "1.2.3-alpha_1",
  ]) assert.equal(allowed(main(`DeepSeek Harness ${version}`)), false, version);
});

test("ordinary Node, argv disguises, arbitrary apps and nested lookalikes are denied", () => {
  const allowed = peerGate();
  for (const exe of [
    undefined, null, 123, "", "/usr/local/bin/node", "/opt/homebrew/bin/node",
    "/usr/local/bin/node /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "/Applications/Other.app/Contents/MacOS/DeepSeek Harness",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/node",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness Helper",
    "/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper",
    "/tmp/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "/Users/attacker/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "/Applications/Other.app/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness/extra",
    "/Applications/../tmp/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "//Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\0",
  ]) assert.equal(allowed(exe), false, String(exe));
});

test("symlink escape, noncanonical executable and filesystem resolution failure fail closed", () => {
  const exe = main("DeepSeek Harness 0.2.1-alpha.2.20261015.1");
  assert.equal(peerGate(() => "/usr/local/bin/node")(exe), false);
  assert.equal(peerGate(() => main("DeepSeek Harness"))(exe), false);
  assert.equal(peerGate(() => { throw Object.assign(new Error("missing executable"), { code: "ENOENT" }); })(exe), false);
});

test("real exported gate rejects ordinary Node without a mocked filesystem", () => {
  assert.equal(peerAllowed("/usr/local/bin/node"), false);
});

test("peerpath framing preserves filename whitespace and embedded NUL for rejection", () => {
  const bridge = fs.readFileSync(new URL("../host/bridge.mjs", import.meta.url), "utf8");
  const resolver = bridge.match(/^function peerExecutable\(socket\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(resolver);
  const exe = main("DeepSeek Harness 0.2.1-alpha.2.20261015.1");
  function resolve(output, status = 0) {
    // Only test helper framing here; real LOCAL_PEERPID/proc_pidpath coverage
    // belongs to native integration, not this VM's simulated helper output.
    const peerExecutable = vm.runInNewContext(`${resolver}\npeerExecutable`, {
      fs: {}, peerHelper: () => "/mock/peerpath",
      spawnSync: () => ({ status, stdout: Buffer.from(output) }),
    });
    return peerExecutable({ _handle: { fd: 3 } });
  }
  assert.equal(resolve(`${exe}\n`), exe);
  assert.equal(resolve(`${exe}\0\n`), exe);
  for (const filename of [`${exe} `, `${exe}\n`, `${exe}\t`, ` ${exe}`, `${exe}\0evil`, `${exe}\0\0`]) {
    const observed = resolve(`${filename}\n`);
    assert.equal(peerGate()(observed), false, JSON.stringify(filename));
  }
  assert.equal(resolve(exe), "", "missing helper delimiter must fail closed");
  assert.equal(resolve(`${exe}\n`, 1), "", "helper failure must fail closed");
});
