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
    var pendingAcknowledgment = null;
    var pendingRollback = null;

    function snapshotOf(shell) {
      if (!shell) return null;
      if (shell.snapshot) return shell.snapshot;
      if (shell.state && shell.state.getSnapshot) return shell.state.getSnapshot();
      return null;
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
      var response = await fetch(API_PATH, { ...init, signal: AbortSignal.timeout(10_000) });
      var body = await response.json();
      if (!response.ok || !body || body.ok !== true) throw new Error(body && body.error || "标注请求失败");
      return body;
    }

    function settleMark(mark, action) {
      return request({ method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: mark.id, claim: mark.claim, consumer: consumer, action: action }) });
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

    function insertMark(found, sessionId, mark, span) {
      if (!canInsert(found.shell)) throw new Error("输入框正忙，标注保留待重试");
      if (typeof found.conversation.createDrafts !== "function"
        || typeof found.conversation.releaseDraftAttachments !== "function"
        || typeof found.shell.removeAttachment !== "function") throw new Error("输入框不能安全附加标注图片");
      var file = fileFromJpeg(mark.image, "page-mark-" + mark.id + ".jpg");
      var drafts = found.conversation.createDrafts(sessionId, [file]);
      pendingRollback = { mark: mark, found: found, drafts: drafts || [] };
      if (!drafts || !drafts.length || !found.shell.actions.addAttachments(drafts.map(function (draft) { return draft.id; }))) {
        throw new Error("标注图片未附上，标注保留待重试");
      }
      var chunk = (span.start ? "\n" : "") + mark.prompt + "\n";
      if (!found.shell.actions.insertText(chunk, span)) throw new Error("输入框已变化，标注保留待重试");
      pendingRollback = null;
    }

    function MarkInbox(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var ctx = props && props.ctx;
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (!sessionId || !ctx) return undefined;
        var alive = true;
        var lastError = "";
        async function tick() {
          if (!alive || inFlight || !shown(ref.current)) return;
          inFlight = true;
          var found;
          var mark;
          try {
            found = shellFor(ctx, sessionId);
            if (pendingRollback) {
              mark = pendingRollback.mark;
              rollbackImage();
              await settleMark(mark, "release");
              return;
            }
            if (pendingAcknowledgment) {
              var renewed = await request({ headers: { "x-dsh-chrome-consumer": consumer } });
              if (renewed.mark && renewed.mark.id === pendingAcknowledgment.id) {
                if (renewed.mark.claim !== pendingAcknowledgment.claim) throw new Error("已插入标注的租约已变化，请检查当前输入框");
                pendingAcknowledgment = renewed.mark;
              } else if (renewed.mark) {
                await settleMark(renewed.mark, "release");
              }
              await settleMark(pendingAcknowledgment, "ack");
              pendingAcknowledgment = null;
              lastError = "";
              return;
            }
            if (!found) throw new Error("标注等待可用的会话输入框");
            if (!found.shell.actions) throw new Error("当前输入框未提供标注插入接口");
            if (!canInsert(found.shell)) return;
            var span = found.shell.actions.captureInsertion();
            var body = await request({ headers: { "x-dsh-chrome-consumer": consumer } });
            mark = body.mark;
            if (!mark) return;
            var current = shellFor(ctx, sessionId);
            if (!alive || !shown(ref.current) || !current || current.binding !== found.binding
              || current.shell !== found.shell || snapshotOf(found.shell).draftRev !== span.draftRev
              || !canInsert(found.shell) || !Number.isFinite(mark.leaseUntil) || mark.leaseUntil <= Date.now()) {
              await settleMark(mark, "release");
              mark = null;
              if (alive) throw new Error("输入框或标注租约已变化，标注保留待重试");
              return;
            }
            insertMark(found, sessionId, mark, span);
            pendingAcknowledgment = mark;
            mark = null;
            await settleMark(pendingAcknowledgment, "ack");
            pendingAcknowledgment = null;
            lastError = "";
          } catch (error) {
            var message = error && error.message || "标注插入失败";
            if (mark) {
              try {
                rollbackImage();
                await settleMark(mark, "release");
              } catch (releaseError) {
                message += "；" + (releaseError && releaseError.message || "标注释放失败");
              }
            }
            if (message !== lastError && found && typeof found.shell.notify === "function") found.shell.notify("error", message);
            lastError = message;
          } finally { inFlight = false; }
        }
        tick();
        var timer = setInterval(tick, 1200);
        window.addEventListener("focus", tick);
        return function () {
          alive = false;
          clearInterval(timer);
          window.removeEventListener("focus", tick);
        };
      }, [sessionId, ctx]);
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
