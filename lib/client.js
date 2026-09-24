window.__ModuleLoader__.load({
  id: "chrome",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];
    var API_PATH = "/api/chrome/mark";

    function snapshotOf(shell) {
      if (!shell) return null;
      if (shell.snapshot) return shell.snapshot;
      if (shell.state && shell.state.getSnapshot) return shell.state.getSnapshot();
      return null;
    }

    function shown(node) {
      if (!node || !node.isConnected) return false;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
      return node.getClientRects().length > 0;
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
      var input = conversation.input;
      var shell = typeof input.shell === "function" ? input.shell(sessionId) : null;
      if (!shell && typeof input.for === "function") shell = input.for(binding.ctx);
      if (!shell) return null;
      return { conversation: conversation, shell: shell };
    }

    function canInsert(shell) {
      var snap = snapshotOf(shell);
      return Boolean(
        snap
        && (snap.phase === "plain" || snap.phase === "claimed")
        && typeof shell.addAttachments === "function"
        && typeof shell.insertText === "function",
      );
    }

    function insertMark(ctx, sessionId, mark) {
      var found = shellFor(ctx, sessionId);
      if (!found) return "找不到会话";
      if (!canInsert(found.shell)) return "输入框正忙";
      if (typeof found.conversation.createDrafts !== "function") return "输入框不能附加图片";
      var file = fileFromJpeg(mark.image, "page-mark-" + mark.id + ".jpg");
      var drafts;
      try {
        drafts = found.conversation.createDrafts(sessionId, [file]);
      } catch (error) {
        return error && error.message ? error.message : "图片没放进输入框";
      }
      if (!drafts || !drafts.length || !found.shell.addAttachments(drafts.map(function (draft) { return draft.id; }))) {
        if (typeof found.conversation.releaseDraftAttachments === "function") found.conversation.releaseDraftAttachments(drafts || []);
        return "输入框不能附加图片";
      }
      var snap = snapshotOf(found.shell);
      var draft = snap && snap.draft ? snap.draft : "";
      var detect = draft;
      if (found.shell.projection && typeof found.shell.projection.detectText === "string") detect = found.shell.projection.detectText;
      var chunk = (detect && detect.slice(-1) !== "\n" ? "\n" : "") + mark.prompt;
      if (!found.shell.insertText(chunk, { start: detect.length, end: detect.length, draftRev: snap.draftRev }, false)) {
        return "图片已附上，文字没插入";
      }
      return "";
    }

    function MarkInbox(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var ctx = props && props.ctx;
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (!sessionId || !ctx) return undefined;
        var alive = true;
        var busy = false;
        function tick() {
          if (!alive || busy || !shown(ref.current)) return;
          var found = shellFor(ctx, sessionId);
          if (!found || !canInsert(found.shell)) return;
          busy = true;
          fetch(API_PATH)
            .then(function (response) { return response.json(); })
            .then(function (body) {
              if (!alive || !body || !body.ok || !body.mark) return;
              var error = insertMark(ctx, sessionId, body.mark);
              if (error && found.shell && typeof found.shell.notify === "function") found.shell.notify("error", error);
            })
            .catch(function () {})
            .then(function () { busy = false; });
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
        style: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" },
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
