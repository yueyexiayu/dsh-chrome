import assert from "node:assert/strict";
import test from "node:test";
import {
  SNAPSHOT_SCRIPT,
  assertDirection,
  assertEval,
  assertFormat,
  assertHistory,
  assertHttpUrl,
  assertKey,
  assertRef,
  assertSelector,
  assertWait,
  a11yScript,
  assertBatch,
  assertFill,
  contentScript,
  elementScript,
  findScript,
  formatA11y,
  formatComputedA11y,
  formatContent,
  formatCookies,
  formatElement,
  formatFind,
  matchFrameBox,
  formatNetwork,
  formatObservation,
  formatQuery,
  queryScript,
  redactText,
  redactUrl,
  selectConsole,
  selectNetwork,
  toMarkdown,
} from "../lib/page.js";
import { chromeTools } from "../lib/tools.js";

test("assertHttpUrl allows http and https only", () => {
  assert.equal(assertHttpUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(assertHttpUrl(" http://127.0.0.1:8080/x "), "http://127.0.0.1:8080/x");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /only http and https/);
  assert.throws(() => assertHttpUrl("javascript:alert(1)"), /only http and https/);
  assert.throws(() => assertHttpUrl("not a url"), /http or https/);
});

test("assertRef and assertKey reject bad input", () => {
  assert.equal(assertRef(2), 2);
  assert.throws(() => assertRef(-1), /non-negative integer/);
  assert.throws(() => assertRef(1.5), /non-negative integer/);
  assert.equal(assertKey("Enter").key, "Enter");
  assert.equal(assertKey("Control+A").modifiers, 2);
  assert.equal(assertKey("a").code, "KeyA");
  assert.throws(() => assertKey("Control+Shift"), /one key/);
  assert.equal(assertDirection("left"), "left");
  assert.throws(() => assertDirection("sideways"), /direction/);
  assert.deepEqual(assertFill([{ ref: 1, value: true }]), [{ ref: 1, value: "true" }]);
});

test("formatObservation lists refs and text", () => {
  const text = formatObservation({
    url: "https://example.com",
    title: "Example",
    text: "Hello",
    elements: [{ ref: 0, tag: "a", name: "More", href: "https://example.com/more" }],
  });
  assert.match(text, /url: https:\/\/example.com/);
  assert.match(text, /\[0\] a "More" href=https:\/\/example.com\/more/);
  assert.match(text, /Hello/);
});

test("formatObservation keeps refs and adds offscreen reads", () => {
  const text = formatObservation({
    url: "https://example.com",
    title: "Example",
    text: "Hello",
    truncatedText: true,
    headings: [{ level: 1, name: "Welcome" }],
    elements: [{ ref: 0, tag: "a", name: "More", href: "https://example.com/more" }],
    offscreen: [{ ref: 1, tag: "button", name: "Next", inView: false }],
    offscreenCount: 3,
  });
  assert.match(text, /\[0\] a "More" href=https:\/\/example\.com\/more/);
  assert.match(text, /headings:\n- h1 "Welcome"/);
  assert.match(text, /offscreen: 3/);
  assert.match(text, /\[1\] button "Next" offscreen/);
  assert.match(text, /text truncated/);
});

test("read helpers redact secrets and format element reads", () => {
  assert.equal(
    redactUrl("https://example.com/cb?access_token=secret&q=1"),
    "https://example.com/cb?access_token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&q=1",
  );
  const masked = redactText('{"password":"hunter2","name":"ada"}', 100);
  assert.equal(masked.redacted, true);
  assert.match(masked.text, /"password":"••••"/);
  assert.match(masked.text, /"name":"ada"/);
  assert.equal(toMarkdown([{ tag: "h", level: 2, text: "Title" }, { tag: "li", text: "One" }]), "## Title\n\n- One");
  const content = formatContent({
    url: "https://example.com",
    title: "Example",
    format: "markdown",
    text: "Fallback",
    blocks: [],
    links: [{ text: "More", href: "https://example.com/more" }],
  });
  assert.match(content, /Fallback/);
  assert.match(content, /links:\n- More https:\/\/example.com\/more/);
  assert.match(formatQuery({ selector: "button", count: 1, elements: [{ ref: 4, tag: "button", name: "Go" }] }), /\[4\] button "Go"/);
  assert.match(formatElement({ ref: 2, tag: "input", type: "text", name: "Email", box: { left: 1, top: 2, width: 3, height: 4 }, attrs: { name: "email" }, text: "ada" }), /box: 1,2 3x4/);
  assert.match(formatNetwork([{ id: "1", method: "GET", status: 200, type: "Document", url: "https://example.com" }], null), /1 GET 200 Document/);
});

test("page scripts parse and keep a ref registry", () => {
  assert.doesNotThrow(() => new Function(`return ${SNAPSHOT_SCRIPT}`));
  assert.match(SNAPSHOT_SCRIPT, /__dshRefs/);
  assert.match(queryScript("a.more", 5), /__dshRefs/);
  assert.match(elementScript(3), /dshLookup\(3\)/);
  assert.match(contentScript("main", "html"), /script, style, noscript/);
  assert.doesNotThrow(() => new Function(`return ${a11yScript({ filter: "all", depth: 4, ref: null })}`));
  assert.match(findScript("login button", 5), /tokens.every/);
  assert.match(formatA11y({ filter: "interactive", count: 1, tree: [{ role: "button", name: "Go", ref: 2, children: [] }] }), /button "Go" \[2\]/);
  assert.match(formatFind({ query: "login", count: 1, elements: [{ ref: 3, tag: "button", name: "Login" }] }), /\[3\] button "Login"/);
  const sms = "https://passport.aliyun.com/login.htm?appEntrance=sms&rnd=1";
  const pwd = "https://passport.aliyun.com/login.htm?appEntrance=pwd&rnd=2";
  assert.equal(matchFrameBox(sms, [{ src: pwd, hidden: true }, { src: sms, hidden: false }]).src, sms);
  const ax = formatComputedA11y({
    filter: "interactive",
    nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, childIds: [], ref: 4 }],
  });
  assert.match(ax, /source: accessibility-tree/);
  assert.match(ax, /button "Go" \[4\]/);
  assert.deepEqual(selectConsole([
    { level: "log", text: "noise" },
    { level: "error", text: "MyApp failed" },
  ], { pattern: "MyApp", onlyErrors: true, limit: 10 }).map((entry) => entry.text), ["MyApp failed"]);
  assert.equal(selectNetwork([{ url: "https://a.test/api" }, { url: "https://b.test" }], "/api", 10).length, 1);
  assert.match(formatCookies([{ name: "access_token", value: "secret", domain: ".example.com" }], true), /redacted/);
  assert.equal(assertBatch([{ action: "click", ref: 1 }])[0].action, "click");
  assert.throws(() => assertBatch([{ action: "nope" }]), /action/);
  assert.equal(assertSelector("button"), "button");
  assert.equal(assertFormat("markdown"), "markdown");
  assert.equal(assertHistory("reload"), "reload");
  assert.equal(assertWait({ selector: "button", ms: 1000 }).state, "visible");
  assert.throws(() => assertWait({ state: "gone" }), /visible or hidden/);
  assert.throws(() => assertEval(""), /expression is required/);
  assert.throws(() => assertEval("x".repeat(8001)), /8000/);
});

test("chrome tools cover reading, elements, and page actions", () => {
  const names = chromeTools().map((definition) => definition.name);
  assert.deepEqual(names, [
    "chrome_navigate",
    "chrome_snapshot",
    "chrome_get_text",
    "chrome_content",
    "chrome_query",
    "chrome_element",
    "chrome_a11y",
    "chrome_find",
    "chrome_click",
    "chrome_drag",
    "chrome_hover",
    "chrome_type",
    "chrome_fill",
    "chrome_press",
    "chrome_scroll",
    "chrome_wait",
    "chrome_history",
    "chrome_dialog",
    "chrome_tabs",
    "chrome_screenshot",
    "chrome_batch",
    "chrome_resize",
    "chrome_upload_image",
    "chrome_upload",
    "chrome_downloads",
    "chrome_console",
    "chrome_network",
    "chrome_storage",
    "chrome_route",
    "chrome_evaluate",
    "chrome_gif",
    "chrome_shortcut",
    "chrome_browsers",
    "chrome_close",
  ]);
  for (const definition of chromeTools()) {
    assert.equal(typeof definition.execute, "function");
    assert.equal(typeof definition.output.render, "function");
    assert.equal(definition.output.schema.required[0], "text");
    assert.equal(definition.isConcurrencySafe(), false);
  }
  const queryTool = chromeTools().find((definition) => definition.name === "chrome_query");
  assert.deepEqual(queryTool.parameters.required, ["selector"]);
  const scrollTool = chromeTools().find((definition) => definition.name === "chrome_scroll");
  assert.deepEqual(scrollTool.parameters.required, []);
});
