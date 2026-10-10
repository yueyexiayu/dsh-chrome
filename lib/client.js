window.__ModuleLoader__.load({
  id: "chrome",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];
    var API_PATH = "/api/chrome/mark";
    var consumer = window.crypto.randomUUID();
    var inFlight = false;
    var pendingRollback = null;

    function snapshotOf(shell) {
      if (!shell) return null;
      if (shell.snapshot) return shell.snapshot;
      if (shell.state && shell.state.getSnapshot) return shell.state.getSnapshot();
      return null;
    }

    function containsPrompt(draft, prompt) {
      // Lexical restoration drops empty paragraph separators. Preserve every
      // nonempty line verbatim so changed requests are not treated as received.
      function lines(text) {
        return text.replace(/\r\n/g, "\n").split("\n").filter(function (line) { return line.trim().length > 0; }).join("\n");
      }
      return lines(draft).includes(lines(prompt));
    }

    function shown(node) {
      if (!node || !node.isConnected) return false;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
      var el = node;
      while (el) {
        if (el.nodeType === 1) {
          var style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        el = el.parentElement;
      }
      return true;
    }

    function fileFromJpeg(image, name) {
      var binary = atob(image);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name, { type: "image/jpeg" });
    }

    function shellFor(ctx, sessionId) {
      var sessions = ctx.get ? ctx.get("sessions") : null;
      var conversation = ctx.get ? ctx.get("conversation") : null;
      if (!sessions || !conversation || !conversation.input || !sessions.binding) return null;
      var binding = sessions.binding(sessionId);
      if (!binding) return null;
      var shell = conversation.input.for(binding.ctx);
      if (!shell) return null;
      return { conversation: conversation, shell: shell, binding: binding };
    }

    function canInsert(shell) {
      var snap = snapshotOf(shell);
      return Boolean(
        snap
        && (snap.phase === "plain" || snap.phase === "claimed")
        && shell.actions
        && typeof shell.actions.addAttachments === "function"
        && typeof shell.actions.captureInsertion === "function"
        && typeof shell.actions.insertText === "function",
      );
    }

    async function request(init) {
      var response;
      try {
        response = await fetch(API_PATH, { ...init, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        var name = error && error.name;
        var text = error && error.message || "";
        if (name === "TimeoutError" || (name === "AbortError" && /timeout/i.test(text))) {
          throw new Error("标注请求超时");
        }
        throw error;
      }
      var body = await response.json();
      if (!response.ok || !body || body.ok !== true) throw new Error(body && body.error || "标注请求失败");
      return body;
    }

    function settleMark(mark, action, delivery) {
      return request({ method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: mark.id, claim: mark.claim, consumer: consumer, action: action, delivery: delivery }) });
    }

    function rollbackImage() {
      if (!pendingRollback) return;
      var rollback = pendingRollback;
      var shell = rollback.found.shell;
      for (var draft of rollback.drafts) {
        var snap = snapshotOf(shell);
        if (snap && snap.attachmentIds.includes(draft.id) && !shell.removeAttachment(draft.id)) {
          throw new Error("标注文字未插入，图片回滚等待输入框恢复可编辑");
        }
      }
      rollback.found.conversation.releaseDraftAttachments(rollback.drafts);
      pendingRollback = null;
    }

    async function insertMark(found, sessionId, mark, span, stillCurrent, recovering) {
      if (!canInsert(found.shell)) throw new Error("输入框正忙，标注保留待重试");
      if (typeof found.conversation.createDrafts !== "function"
        || typeof found.conversation.releaseDraftAttachments !== "function"
        || typeof found.shell.removeAttachment !== "function") throw new Error("输入框不能安全附加标注图片");
      var file = fileFromJpeg(mark.image, "page-mark-" + mark.id + ".jpg");
      var drafts = found.conversation.createDrafts(sessionId, [file]);
      pendingRollback = { mark: mark, found: found, drafts: drafts || [], recovering: recovering };
      if (!drafts || !drafts.length) throw new Error("标注图片未创建，标注保留待重试");
      var delivery = {
        sessionId: sessionId, attachmentIds: drafts.map(function (draft) { return draft.id; }),
      };
      await settleMark(mark, recovering ? "retry" : "prepare", delivery);
      if (!stillCurrent() || !canInsert(found.shell) || snapshotOf(found.shell).draftRev !== span.draftRev
        || mark.leaseUntil <= Date.now()) throw new Error("输入框或标注租约已变化，标注保留待重试");
      try {
        if (recovering) {
          var oldIds = mark.delivery.attachmentIds.concat(mark.delivery.replacedAttachmentIds || []);
          for (var oldId of oldIds) {
            if (snapshotOf(found.shell).attachmentIds.includes(oldId) && !found.shell.removeAttachment(oldId)) {
              throw new Error("旧标注图片暂时不能移除，请稍后恢复");
            }
          }
          if (typeof found.conversation.resolveDraftAttachments === "function") {
            found.conversation.releaseDraftAttachments(found.conversation.resolveDraftAttachments(oldIds));
          }
        }
        if (!found.shell.actions.addAttachments(drafts.map(function (draft) { return draft.id; }))) {
          throw new Error("标注图片未附上，标注保留待重试");
        }
        var chunk = (span.start ? "\n" : "") + mark.prompt + "\n";
        if (!(recovering && containsPrompt(snapshotOf(found.shell).draft, mark.prompt))
          && !found.shell.actions.insertText(chunk, span)) throw new Error("输入框已变化，标注保留待重试");
        pendingRollback = null;
        mark.delivery = delivery;
        if (typeof found.shell.actions.persistDraft === "function") found.shell.actions.persistDraft();
      } catch (error) {
        // An editor callback may fail after it has already changed the document.
        // Keep the durable delivery whenever the text is present; releasing it
        // would permit a later renderer to append that same text again.
        if (containsPrompt(snapshotOf(found.shell).draft, mark.prompt)) {
          mark.delivery = delivery;
          pendingRollback = null;
        }
        throw error;
      }
    }

    function fullyInserted(found, sessionId, mark) {
      var snap = snapshotOf(found.shell);
      return mark.delivery.sessionId === sessionId && snap && containsPrompt(snap.draft, mark.prompt)
        && mark.delivery.attachmentIds.every(function (id) { return snap.attachmentIds.includes(id); })
        && !(mark.delivery.replacedAttachmentIds || []).some(function (id) { return snap.attachmentIds.includes(id); });
    }

    function MarkInbox(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var ctx = props && props.ctx;
      var ref = React.useRef(null);
      var recoveryState = React.useState(null);
      var recovery = recoveryState[0];
      var setRecovery = recoveryState[1];
      var pollErrorState = React.useState("");
      var pollError = pollErrorState[0];
      var setPollError = pollErrorState[1];
      var recoveryAction = React.useRef(null);
      React.useEffect(function () {
        if (!sessionId || !ctx) return undefined;
        var alive = true;
        var lastError = "";
        function surface(message, target) {
          var canNotify = Boolean(target && typeof target.notify === "function");
          if (message === lastError) return;
          lastError = message;
          if (canNotify) {
            target.notify("error", message);
            if (alive) setPollError("");
            return;
          }
          if (alive) setPollError(message);
        }
        function clearFailure() {
          if (!lastError) return;
          lastError = "";
          if (alive) setPollError("");
        }
        async function tick() {
          if (!alive || inFlight || !shown(ref.current)) return;
          inFlight = true;
          var found;
          var mark;
          try {
            found = shellFor(ctx, sessionId);
            if (pendingRollback) {
              mark = pendingRollback.mark;
              var wasRecovering = pendingRollback.recovering;
              rollbackImage();
              if (!wasRecovering) await settleMark(mark, "release");
              mark = null;
              return;
            }
            if (!found) throw new Error("标注等待可用的会话输入框");
            if (!found.shell.actions) throw new Error("当前输入框未提供标注插入接口");
            if (!canInsert(found.shell)) return;
            var span = found.shell.actions.captureInsertion();
            var body = await request({ headers: { "x-dsh-chrome-consumer": consumer } });
            mark = body.mark;
            if (!mark) { setRecovery(null); clearFailure(); return; }
            var current = shellFor(ctx, sessionId);
            if (!alive || !shown(ref.current) || !current || current.binding !== found.binding
              || current.shell !== found.shell || snapshotOf(found.shell).draftRev !== span.draftRev
              || !canInsert(found.shell) || !Number.isFinite(mark.leaseUntil) || mark.leaseUntil <= Date.now()) {
              if (!mark.delivery) await settleMark(mark, "release");
              mark = null;
              if (alive) throw new Error("输入框或标注租约已变化，标注保留待重试");
              return;
            }
            if (mark.delivery) {
              if (!fullyInserted(found, sessionId, mark)) {
                setRecovery(mark);
                mark = null;
                return;
              }
            } else {
              await insertMark(found, sessionId, mark, span, function () {
                var current = shellFor(ctx, sessionId);
                return alive && shown(ref.current) && current && current.binding === found.binding && current.shell === found.shell;
              }, false);
            }
            // A previous insertion may have survived only in memory after a
            // persistence exception. Never acknowledge that delivery until the
            // current draft has been persisted successfully, including retries.
            if (typeof found.shell.actions.persistDraft !== "function") throw new Error("输入框不能保存标注草稿");
            await found.shell.actions.persistDraft();
            var inserted = mark;
            mark = null;
            await settleMark(inserted, "ack");
            setRecovery(null);
            clearFailure();
          } catch (error) {
            var message = error && error.message || "标注插入失败";
            if (mark) {
              try {
                var keepDelivery = pendingRollback && pendingRollback.recovering;
                rollbackImage();
                if (!keepDelivery && !mark.delivery) await settleMark(mark, "release");
              } catch (releaseError) {
                message += "；" + (releaseError && releaseError.message || "标注释放失败");
              }
            }
            surface(message, found && found.shell);
          } finally { inFlight = false; }
        }
        recoveryAction.current = async function (id, action) {
          if (!alive || inFlight || !shown(ref.current)) return;
          inFlight = true;
          var found;
          try {
            found = shellFor(ctx, sessionId);
            if (!found || !canInsert(found.shell)) throw new Error("输入框正忙，请稍后处理标注");
            var body = await request({ headers: { "x-dsh-chrome-consumer": consumer } });
            var mark = body.mark;
            if (!mark) { setRecovery(null); return; }
            if (mark.id !== id || !mark.delivery || mark.delivery.sessionId !== sessionId) {
              throw new Error("标注归属已变化，请回到接收标注的原会话");
            }
            var current = shellFor(ctx, sessionId);
            if (!alive || !shown(ref.current) || !current || current.binding !== found.binding || current.shell !== found.shell) {
              throw new Error("会话已变化，标注已保留");
            }
            if (action === "restore") {
              var span = found.shell.actions.captureInsertion();
              await insertMark(found, sessionId, mark, span, function () {
                var current = shellFor(ctx, sessionId);
                return alive && shown(ref.current) && current && current.binding === found.binding && current.shell === found.shell;
              }, true);
            }
            if (typeof found.shell.actions.persistDraft !== "function") throw new Error("输入框不能保存标注草稿");
            await found.shell.actions.persistDraft();
            await settleMark(mark, "ack");
            setRecovery(null);
            clearFailure();
          } catch (error) {
            var message = error && error.message || "标注恢复失败";
            try { rollbackImage(); } catch (rollbackError) { message += "；" + rollbackError.message; }
            surface(message, found && found.shell);
          } finally { inFlight = false; }
        };
        tick();
        var timer = setInterval(tick, 1200);
        window.addEventListener("focus", tick);
        return function () {
          alive = false;
          recoveryAction.current = null;
          clearInterval(timer);
          window.removeEventListener("focus", tick);
        };
      }, [sessionId, ctx]);
      var markCardStyle = {
        padding: "8px 12px",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l3))",
        borderRadius: 12,
        fontSize: 13,
      };
      function markButton(label, action) {
        return React.createElement("button", {
          type: "button",
          className: "dsh-chrome-mark-button",
          onClick: function () { if (recoveryAction.current) recoveryAction.current(recovery.id, action); },
        }, label);
      }
      if (recovery) return React.createElement("div", {
        ref: ref, "data-chrome-mark": "recovery", role: "status",
        style: markCardStyle,
      },
      React.createElement("style", null, ".dsh-chrome-mark-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-chrome-mark-button:focus-visible{outline:2px solid Highlight;outline-offset:2px}"),
      pollError ? React.createElement("div", { role: "alert" }, pollError) : null,
      React.createElement("div", null, recovery.delivery.sessionId === sessionId
        ? "上次页面标注的接收被中断，尚未再次插入。请检查草稿或已发送的消息，再选择恢复或确认。恢复会补回图片，并复用草稿中仍存在的完整标注文字。"
        : "有一份页面标注等待恢复，请回到上次接收它的原会话处理。"),
      recovery.delivery.sessionId === sessionId && markButton("重新放入草稿", "restore"),
      recovery.delivery.sessionId === sessionId && markButton("已接收，完成确认", "ack"));
      if (pollError) return React.createElement("div", {
        ref: ref,
        "data-chrome-mark": "error",
        role: "alert",
        style: markCardStyle,
      }, pollError);
      return React.createElement("span", {
        ref: ref,
        "data-chrome-mark": "1",
        style: { display: "block", width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" },
      });
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "chrome", order: 30, label: "页面标注" },
          function (props) {
            return React.createElement(MarkInbox, { sessionId: props && props.sessionId, ctx: ctx });
          },
        );
      });
    }

    void exports;
    module.exports = { apply: apply, inject: inject };
    return module.exports;
  },
});
