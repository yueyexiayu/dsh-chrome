// Synthetic bridge metadata for protocol tests; never evidence of a real Chrome run.
export const engine = Object.freeze({
  kind: "external-browser",
  resolver: "chrome-extension-native-messaging",
  browserVersion: "1.2.3.4",
  versionSource: "extension-worker-userAgentData.fullVersionList",
  extensionVersion: "0.2.5",
  capabilities: Object.freeze(["dom", "screenshot", "browser-extension", "authenticated-state"]),
});
