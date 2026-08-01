import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Pause the agent run when it asks the user a question.
 *
 * Without this hook the ask-question tool self-resolves as unanswered and the
 * run continues, so the Portal renders a card the user can no longer usefully
 * answer in-band. `before_tool_call` fires after the model selects the tool and
 * before it executes, and `requireApproval` holds the run open while an
 * approval surface resolves it -- which is what turns the Portal card into a
 * real answer surface.
 *
 * This plugin is deliberately optional. Portal renders and submits the card
 * whether or not it is installed; the only difference is whether the answer
 * lands as the tool's own resolution or as the user's next message. A missing
 * or failed plugin therefore degrades the experience and never breaks a run,
 * which matters because it ships inside a Portal install.
 */

const ASK_TOOL_NAMES = new Set(["ask_user_question", "AskUserQuestion"]);

/** Gateway caps: title 80 chars, description 256. Stay inside them. */
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 256;

/** Hard ceiling enforced by the Gateway regardless of what we request. */
const APPROVAL_TIMEOUT_MS = 600_000;

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function describeQuestions(params: Record<string, unknown>): {
  title: string;
  description: string;
} {
  const questions = Array.isArray((params as any)?.questions)
    ? (params as any).questions
    : [];
  const first = questions[0] && typeof questions[0] === "object" ? questions[0] : null;

  const header = bounded(first?.header, 24);
  const question = bounded(first?.question, DESCRIPTION_MAX);
  const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";

  return {
    title: bounded(header ? `Question: ${header}` : "The agent has a question", TITLE_MAX),
    description: bounded(
      question ? `${question}${extra}` : "The agent is waiting on your answer.",
      DESCRIPTION_MAX,
    ),
  };
}

export default definePluginEntry({
  id: "bridgesllm-ask-question",
  name: "BridgesLLM Ask Question",
  register(api) {
    api.on("before_tool_call", async (event) => {
      if (!ASK_TOOL_NAMES.has(String(event.toolName || ""))) return;

      const { title, description } = describeQuestions(
        (event.params || {}) as Record<string, unknown>,
      );

      return {
        requireApproval: {
          title,
          description,
          severity: "info",
          // Persistent trust makes no sense for a question: every question is
          // different, so "always allow" would silently skip future prompts.
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: APPROVAL_TIMEOUT_MS,
          // An unanswered question must not strand the run forever. Denying on
          // timeout returns a denied tool result and the agent proceeds.
          timeoutBehavior: "deny",
        },
      };
    });
  },
});
