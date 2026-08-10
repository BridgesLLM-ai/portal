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
    expect(screen.getByText(/42% · 0s/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Upload progress" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("shows durable phase feedback, reconnect copy, recent steps, and server-owned elapsed time", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-10T12:02:03.000Z"));
      render(
        <TypedConfirmationDialog
          open
          title="Updating Portal"
          description="The updater continues on the server."
          confirmLabel="Update"
          busy
          busyProgress={0.64}
          busyStartedAt="2026-08-10T12:00:00.000Z"
          busyPhaseLabel="Restarting Portal"
          busyPhaseDetail="Waiting for the API to return before postflight checks."
          busyConnectionState="reconnecting"
          busySteps={[
            { label: "Release verified", detail: "Signature and manifest matched." },
            { label: "Database migrated", detail: "Schema is current." },
          ]}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );

      expect(screen.getByText("Restarting Portal")).toBeInTheDocument();
      expect(screen.getByText(/Waiting for the API to return/)).toBeInTheDocument();
      expect(screen.getByText(/Portal is restarting or temporarily unavailable/i)).toBeInTheDocument();
      expect(screen.getByText("Release verified")).toBeInTheDocument();
      expect(screen.getByText("Database migrated")).toBeInTheDocument();
      expect(screen.getByText("64% · 2m 03s")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Restarting Portal" })).toHaveAttribute(
        "aria-valuetext",
        expect.stringContaining("64% complete"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves initial focus to the durable phase heading while busy", async () => {
    render(
      <TypedConfirmationDialog
        open
        title="Updating Portal"
        description="The updater continues on the server."
        confirmationPhrase="UPDATE PORTAL"
        confirmLabel="Update"
        busy
        busyProgress={0.48}
        busyPhaseLabel="Installing signed release"
        showConfirmAction={false}
        allowDismissWhileBusy
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const phaseHeading = screen.getByText("Installing signed release");
    await waitFor(() => expect(phaseHeading).toHaveFocus());
    expect(screen.queryByRole("textbox", { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
  });

  it("shows a fixed stale-feedback warning without advancing the progress bar", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-10T12:02:00.000Z"));
      render(
        <TypedConfirmationDialog
          open
          title="Updating Portal"
          description="The updater continues on the server."
          confirmLabel="Update"
          busy
          busyProgress={0.48}
          busyStartedAt="2026-08-10T12:00:00.000Z"
          busyUpdatedAt="2026-08-10T12:00:29.000Z"
          busyPhaseLabel="Installing signed release"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );

      expect(screen.getByText(/No new installer phase has been reported for over 90 seconds/i)).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Installing signed release" })).toHaveAttribute("aria-valuenow", "48");
    } finally {
      vi.useRealTimers();
    }
  });

  it("can render a terminal status dialog without a second confirmation action", () => {
    render(
      <TypedConfirmationDialog
        open
        title="Portal update needs recovery"
        description="Review the terminal updater receipt."
        confirmationPhrase="UPDATE PORTAL"
        confirmLabel="Update"
        showConfirmAction={false}
        cancelLabel="Close"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox", { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("lets a durable background operation be hidden without enabling its primary action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <TypedConfirmationDialog
        open
        title="Updating Portal"
        description="The updater is server-owned."
        confirmLabel="Update"
        busyLabel="Installing signed release"
        busy
        allowDismissWhileBusy
        cancelLabel="Hide for now"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Installing signed release" })).toBeDisabled();
    const hide = screen.getByRole("button", { name: "Hide for now" });
    expect(hide).toBeEnabled();
    await user.click(hide);
    expect(onCancel).toHaveBeenCalledTimes(1);
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
