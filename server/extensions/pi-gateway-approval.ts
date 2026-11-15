/**
 * Multi-Agent Gateway Approval & Permission Gate Extension for Pi
 *
 * Implements Pi's standard on("tool_call") permission hook (reference: https://pi.dev/packages
 * and @earendil-works/pi-coding-agent examples/extensions/permission-gate.ts).
 *
 * When the current session is configured with "manual" permission mode (via gateway settings or env),
 * it intercepts mutating/execution tools (e.g. bash, write, edit) and prompts for confirmation
 * via ctx.ui.confirm(`tool_approval:${event.toolName}`, payload).
 * In RPC mode, this emits an extension_ui_request which the gateway maps directly to a native
 * Kimi Web approval card. User's decision ("approved" / "rejected") is fed back via extension_ui_response.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Non-mutating or already-interactive tools that don't need execution approval
const BYPASS_TOOLS = new Set([
  "read",
  "ask_user_question",
  "todo",
  "lsp_diagnostics",
  "get_search_content",
]);

export default function (pi: ExtensionAPI) {
  function getPermissionMode(sessionId: string): string {
    try {
      const explicitPath = process.env.PI_GATEWAY_SETTINGS;
      const defaultPath = path.join(
        os.homedir(),
        ".config",
        "multi-agent-gateway",
        "session-settings.pi.json",
      );
      const targetPath = explicitPath && fs.existsSync(explicitPath) ? explicitPath : defaultPath;
      if (fs.existsSync(targetPath)) {
        const raw = fs.readFileSync(targetPath, "utf8");
        const parsed = JSON.parse(raw);
        return (
          parsed?.permission?.[sessionId] ||
          parsed?.permission?.__default__ ||
          "default"
        );
      }
    } catch {}
    return "default";
  }

  pi.on("tool_call", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const mode = getPermissionMode(sessionId);

    // Only intercept when session permission is explicitly 'manual'
    if (mode !== "manual") {
      return undefined;
    }

    const toolName = event.toolName;
    if (BYPASS_TOOLS.has(toolName)) {
      return undefined;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Tool '${toolName}' blocked: manual approval required but no interactive UI available`,
      };
    }

    const inputData = event.input;
    const inputStr = typeof inputData === "string" ? inputData : JSON.stringify(inputData);
    const confirmed = await ctx.ui.confirm(`tool_approval:${toolName}`, inputStr);

    if (!confirmed) {
      return {
        block: true,
        reason: `Tool execution of '${toolName}' was rejected by user in Web UI`,
      };
    }

    return undefined;
  });
}
