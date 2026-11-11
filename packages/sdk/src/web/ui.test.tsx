import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chip, Dialog, Field, IconButton, Input, Segmented, Switch } from "./index";

describe("Switch", () => {
  it("announces its state and reports the opposite one when pressed", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Enable Grocery" />);
    const control = screen.getByRole("switch", { name: "Enable Grocery" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe("Segmented", () => {
  it("marks the chosen option as pressed and reports a new choice", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Theme"
        value="dark"
        onChange={onChange}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });
});

describe("Chip", () => {
  it("is a toggle button", () => {
    render(<Chip pressed>Rust</Chip>);
    expect(screen.getByRole("button", { name: "Rust", pressed: true })).toBeTruthy();
  });
});

describe("IconButton", () => {
  it("gets its name from the label", () => {
    render(<IconButton label="Search">x</IconButton>);
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });
});

describe("Field", () => {
  it("ties the label and the hint to the control", () => {
    render(
      <Field label="Name" hint="Shown to others">
        {({ id, hintId }) => <Input id={id} aria-describedby={hintId} defaultValue="Sam" />}
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Shown to others").id);
  });
});

describe("Dialog", () => {
  it("mounts its content only while open and reports a request to close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open={false} onClose={onClose} label="Move app">
        <button type="button">Move</button>
      </Dialog>,
    );
    expect(screen.queryByText("Move")).toBeNull();

    rerender(
      <Dialog open onClose={onClose} label="Move app">
        <button type="button">Move</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Move app" }) as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Move")).toBeTruthy();

    // A click on the content is not a click on the backdrop.
    fireEvent.pointerDown(screen.getByText("Move"));
    fireEvent.click(screen.getByText("Move"));
    expect(onClose).not.toHaveBeenCalled();
    // A click on the backdrop lands on the dialog itself, pressed and released there.
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Dialog open={false} onClose={onClose} label="Move app">
        <button type="button">Move</button>
      </Dialog>,
    );
    expect(dialog.open).toBe(false);
    expect(screen.queryByText("Move")).toBeNull();
  });

  it("is not closed by a drag that starts inside and ends over the backdrop, as when selecting text", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="Add a person">
        <input aria-label="Email address" defaultValue="lin@example.com" />
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Add a person" });
    const field = screen.getByRole("textbox", { name: "Email address" });

    // Pressed in the field, released over the backdrop: the browser sends the click to what the
    // two have in common, which is the dialog itself.
    fireEvent.pointerDown(field);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    // The other way round, pressed over the backdrop and released on the content, the click lands
    // on the dialog too; that press was outside.
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is not closed by the browser's late report of an earlier close", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="Move app">
        <button type="button">Move</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Move app" }) as HTMLDialogElement;

    // The browser sends "close" a moment after a dialog closes. This one was
    // closed and opened again in that moment: the report is about the past.
    fireEvent(dialog, new Event("close"));
    expect(onClose).not.toHaveBeenCalled();

    // Escape: the browser closes the dialog itself, then reports it.
    dialog.removeAttribute("open");
    fireEvent(dialog, new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
