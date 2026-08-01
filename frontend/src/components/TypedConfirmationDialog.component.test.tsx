// @vitest-environment jsdom
import "../test/setup";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TypedConfirmationDialog from "./TypedConfirmationDialog";

function TypedDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reset project
      </button>
      <TypedConfirmationDialog
        open={open}
        title="Reset Alpha"
        description="This cannot be undone."
        confirmationPhrase="RESET Alpha"
        confirmLabel="Reset permanently"
        onCancel={() => setOpen(false)}
        onConfirm={vi.fn()}
      />
    </>
  );
}

describe("TypedConfirmationDialog modal behavior", () => {
  it("focuses the typed confirmation field and restores the opener after dismissal", async () => {
    const user = userEvent.setup();
    render(<TypedDialogHarness />);
    const opener = screen.getByRole("button", { name: "Reset project" });

    await user.click(opener);
    const input = await screen.findByLabelText(/Type RESET Alpha to continue/i);
    await waitFor(() => expect(input).toHaveFocus());
    expect(
      screen.getByRole("button", { name: "Reset permanently" }),
    ).toBeDisabled();

    await user.type(input, "RESET Alpha");
    expect(
      screen.getByRole("button", { name: "Reset permanently" }),
    ).toBeEnabled();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Reset Alpha" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("blocks every dismissal route and exposes exactly one working primary action while busy", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TypedConfirmationDialog
        open
        title="Reset Alpha"
        description="This cannot be undone."
        confirmLabel="Reset permanently"
        busyLabel="Resetting project…"
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Reset Alpha" });
    // The primary action is present exactly once, labelled with the busy text,
    // and disabled — never a second faded "active-looking" copy behind it.
    const busyButton = screen.getByRole("button", {
      name: "Resetting project…",
    });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveClass("opacity-100");
    expect(busyButton).not.toHaveClass("disabled:opacity-45");
    expect(
      screen.queryByRole("button", { name: "Reset permanently" }),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll('button[aria-busy="true"]')).toHaveLength(
      1,
    );
    await user.keyboard("{Escape}");
    await user.click(dialog.parentElement!);

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
  });

  it("shows a live progress indicator while an operation of unknown length runs", async () => {
    // Scope fake timers to the interval/clock only; ViewportModal's focus
    // management relies on a real requestAnimationFrame.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      render(
        <TypedConfirmationDialog
          open
          title="Restart Ollama"
          description="This restarts the Ollama service."
          confirmLabel="Restart"
          busyLabel="Restarting…"
          busy
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      expect(screen.getByText(/Working… 0s/)).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.getByText(/Working… 6s/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a determinate bar and percentage when the caller supplies progress", () => {
    render(
      <TypedConfirmationDialog
        open
        title="Uploading"
        description="Uploading the bundle."
        confirmLabel="Upload"
        busy
        busyProgress={0.42}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("fires onConfirm exactly once even on a rapid double click", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <TypedConfirmationDialog
        open
        title="Reset Alpha"
        description="This cannot be undone."
        confirmationPhrase="RESET Alpha"
        confirmLabel="Reset permanently"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.type(
      await screen.findByLabelText(/Type RESET Alpha to continue/i),
      "RESET Alpha",
    );
    const confirm = screen.getByRole("button", { name: "Reset permanently" });
    // Two synchronous clicks before the parent can flip `busy`: the internal
    // guard must still deliver exactly one confirmation.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("RESET Alpha");
  });
});
