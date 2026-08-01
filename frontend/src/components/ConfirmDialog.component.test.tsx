// @vitest-environment jsdom
import "../test/setup";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog";

function ConfirmDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete project
      </button>
      <ConfirmDialog
        open={open}
        title="Delete Alpha"
        message="This cannot be undone."
        confirmLabel="Delete permanently"
        onConfirm={vi.fn()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe("ConfirmDialog keyboard behavior", () => {
  it("moves focus to the safe action, closes on Escape, and restores the opener focus", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHarness />);

    const opener = screen.getByRole("button", { name: "Delete project" });
    await user.click(opener);

    expect(
      screen.getByRole("alertdialog", { name: "Delete Alpha" }),
    ).toBeVisible();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Delete Alpha" }),
      ).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });

  it("locks every dismissal path and shows progress while a destructive action is running", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete Alpha"
        message="This cannot be undone."
        confirmLabel="Delete permanently"
        busy
        busyLabel="Deleting project…"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Deleting project…" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Delete permanently" }),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll('button[aria-busy="true"]')).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close confirmation dialog" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("alertdialog", { name: "Delete Alpha" }).parentElement!,
    );
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
