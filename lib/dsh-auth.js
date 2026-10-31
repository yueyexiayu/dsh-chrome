import { createHash } from "node:crypto";

// Only the current local listener is eligible; advertised public proxies are not.
export async function dshBrowserCookie(target, services, signal, fetchImpl = fetch) {
  if (!services?.webApp || !services?.webServer || !services?.connection) return null;
  let wanted, advertised, listener;
  try {
    wanted = new URL(target);
    advertised = new URL(services.webApp.getAdvertisedUrl());
    listener = new URL(services.webServer.getOrigin());
  } catch { return null; }
  if (listener.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(listener.hostname)
    || advertised.origin !== listener.origin || wanted.origin !== listener.origin
    || advertised.pathname !== "/" || advertised.search || advertised.hash
    || advertised.username || advertised.password || wanted.username || wanted.password) return null;
  try {
    const response = await fetchImpl(services.connection.authenticatedUrl(`${listener.origin}/`), {
      redirect: "manual", signal,
    });
    const header = response.headers.get("set-cookie") || "";
    const name = `dsh-auth-${createHash("sha256").update(listener.host).digest("base64url")}`;
    const pieces = header.split(";").map((piece) => piece.trim());
    const match = pieces[0]?.match(/^([^=]+)=([A-Za-z0-9._-]+)$/);
    const expires = pieces.find((piece) => /^expires=/i.test(piece))?.slice(8);
    const expiry = expires ? Date.parse(expires) / 1000 : NaN;
    if (response.status !== 303 || response.headers.get("location") !== "./" || match?.[1] !== name
      || !pieces.some((piece) => /^httponly$/i.test(piece))
      || !pieces.some((piece) => /^samesite=strict$/i.test(piece))
      || !pieces.some((piece) => /^path=\/$/i.test(piece))
      || !Number.isFinite(expiry) || expiry <= Date.now() / 1000) throw new Error();
    return { name, value: match[2], url: `${listener.origin}/`, path: "/", httpOnly: true, sameSite: "Strict", expires: expiry };
  } catch {
    throw new Error("DSH browser authorization failed");
  }
}
