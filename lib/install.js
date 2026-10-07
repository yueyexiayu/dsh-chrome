import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.yueyexiayu.dsh.chrome";
export const EXTENSION_ID = "clpkniojjahfbaegnkedibgcipgamlim";

export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function extensionDir() {
  return path.join(pluginRoot(), "extension");
}

export function hostPath() {
  return path.join(pluginRoot(), "host", "dsh-chrome-host");
}

export function socketPaths(home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh")) {
  const dir = path.join(home, "cache");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(entry => entry.isSocket()
    && (entry.name === "dsh-chrome.sock" || /^dsh-c-[a-f0-9]{8}$/.test(entry.name)))
    .map(entry => path.join(dir, entry.name)).sort();
}

export function nativeHostManifest() {
  return {
    name: HOST_NAME,
    description: "DSH Chrome bridge",
    path: hostPath(),
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

export function installMessage() {
  return [
    "DSH Chrome extension is not connected.",
    "Open chrome://extensions in the Chrome window you want to use, turn on Developer mode, and Load unpacked:",
    extensionDir(),
    "If it is already listed, click Reload. Leave Chrome open and retry.",
    "Control stays in a background DSH tab group and does not focus Chrome.",
  ].join("\n");
}

export async function installNativeHost() {
  const manifestPath = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${HOST_NAME}.json`,
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(nativeHostManifest(), null, 2)}\n`);
  await chmod(hostPath(), 0o755);
  return manifestPath;
}
