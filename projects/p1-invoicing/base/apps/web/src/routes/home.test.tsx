import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomePage } from "./home.tsx";

describe("HomePage", () => {
  it("renders the app name", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { name: "Ledgerly" })).toBeInTheDocument();
  });
});
