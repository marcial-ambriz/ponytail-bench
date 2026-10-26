import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/Page.tsx";

describe("HomePage header", () => {
  it("renders the app name as the page heading", () => {
    render(<PageHeader title="Stockly" />);

    expect(screen.getByRole("heading", { name: "Stockly" })).toBeInTheDocument();
  });
});
