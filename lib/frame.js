const MAX_FRAME = 48 * 1024 * 1024;

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME) throw new Error("frame too large");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function createFrameParser(onMessage) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > MAX_FRAME) throw new Error("frame too large");
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        onMessage(JSON.parse(body.toString("utf8")));
      }
    },
  };
}
