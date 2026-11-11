import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox, Row, Rows } from "./index";

describe("Checkbox", () => {
  it("is named by the text beside it and announces its state", () => {
    const { rerender } = render(
      <Checkbox checked={false} onChange={() => {}}>
        Oat milk
      </Checkbox>,
    );
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: "Oat milk" });
    expect(box.checked).toBe(false);

    rerender(
      <Checkbox checked onChange={() => {}}>
        Oat milk
      </Checkbox>,
    );
    expect(box.checked).toBe(true);
  });

  it("reports the opposite state when the box or its text is pressed", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox checked={false} onChange={onChange}>
        Oat milk
      </Checkbox>,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByText("Oat milk"));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(
      <Checkbox checked onChange={onChange}>
        Oat milk
      </Checkbox>,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("shows the state it is given, not the one a press asked for", () => {
    render(
      <Checkbox checked={false} onChange={() => {}}>
        Oat milk
      </Checkbox>,
    );
    const box = screen.getByRole<HTMLInputElement>("checkbox");
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it("reports nothing while disabled", () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} disabled onChange={onChange}>
        Oat milk
      </Checkbox>,
    );
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: "Oat milk" });
    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByText("Oat milk"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes its name from the label when there is no text beside it", () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Tick oat milk" />);
    expect(screen.getByRole("checkbox", { name: "Tick oat milk" })).toBeTruthy();
  });
});

describe("Rows", () => {
  it("is a list with one item per row", () => {
    render(
      <Rows aria-label="To buy">
        <Row>Oat milk</Row>
        <Row>Rice</Row>
      </Rows>,
    );
    expect(screen.getByRole("list", { name: "To buy" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Oat milk", "Rice"]);
  });
});
