const id = new URL(location.href).searchParams.get("id");
const status = document.getElementById("status");
const save = document.getElementById("save");
const fields = [];
let busy = false;
function el(tag, text) { const node = document.createElement(tag); if (text) node.textContent = text; return node; }
async function request(type, extra = {}) {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id == null) throw new Error("请在独立扩展标签页中打开标注");
  let response;
  try { response = await chrome.runtime.sendMessage({ type, id, tabId: tab.id, ...extra }); }
  catch (error) {
    if (type === "dsh-review-save") return { uncertain: true, warning: `结果未确认，请先到 DSH 检查；为避免重复，本审核页禁止再次发送。${error.message}` };
    throw error;
  }
  if (type === "dsh-review-save" && response?.ok !== true && response?.ok !== false)
    return { uncertain: true, warning: "结果未确认，请先到 DSH 检查；为避免重复，本审核页禁止再次发送。扩展未返回有效确认。" };
  if (response?.ok !== true) throw new Error(response?.error || "扩展没有响应，请重新打开标注");
  return response;
}
function outcome(result) {
  save.disabled = true;
  status.textContent = result.warning || (result.sent
    ? "已交给 DSH 标注队列，等待可用会话接收；没有自动发送消息。可以关闭此页。"
    : "结果未确认，请先到 DSH 检查；为避免重复，本审核页禁止再次发送。");
}
try {
  const result = await request("dsh-review-load");
  if (result.sent) outcome(result);
  else {
    const { params } = result;
    document.getElementById("source").textContent = `页面（不可信）：${params.title}\n${params.url}`;
    const preview = document.getElementById("preview");
    preview.src = `data:image/jpeg;base64,${params.image}`;
    await preview.decode();
    params.items.forEach((item, index) => {
      const section = el("section");
      section.append(el("h2", `${index + 1}. 元素参考（网页数据）`));
      const details = el("details");
      details.append(el("summary", item.selector || item.tag || "元素详情"), el("pre", JSON.stringify(item, null, 2)));
      const note = el("textarea"); note.required = true; note.maxLength = 1000; note.id = `note-${index}`; note.placeholder = "在这里输入你对此元素的要求";
      note.value = item.note || "";
      const label = el("label", "你的要求（必填）"); label.htmlFor = note.id;
      const intent = el("select"); intent.id = `intent-${index}`;
      for (const [value, text] of [["change", "修改"], ["ask", "询问"], ["remove", "移除"]]) { const option = el("option", text); option.value = value; intent.append(option); }
      intent.value = item.intent || "change";
      const intentLabel = el("label", "操作类型"); intentLabel.htmlFor = intent.id;
      section.append(details, label, note, intentLabel, intent);
      document.getElementById("items").append(section); fields.push({ note, intent });
    });
    status.textContent = "填写所有要求后，确认放入 DSH 草稿。"; save.disabled = false;
    if (result.uncertain) outcome(result);
  }
} catch (error) { status.textContent = `无法读取标注：${error.message}`; }
document.getElementById("review").addEventListener("submit", async event => {
  event.preventDefault();
  if (!event.isTrusted || busy || save.disabled || !fields.length) return;
  busy = true; save.disabled = true; status.textContent = "正在等待 DSH 保存确认…";
  try {
    const result = await request("dsh-review-save", { requests: fields.map(({ note, intent }) => ({ note: note.value, intent: intent.value })) });
    outcome(result);
  } catch (error) { status.textContent = `保存失败：${error.message}`; save.disabled = false; }
  finally { busy = false; }
});
