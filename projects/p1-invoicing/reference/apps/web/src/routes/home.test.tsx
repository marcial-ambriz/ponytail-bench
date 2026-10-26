import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrgList } from "./home.tsx";

describe("OrgList", () => {
  it("shows the empty state", () => {
    render(<OrgList orgs={[]} />);

    expect(screen.getByText("You are not a member of any organization yet")).toBeInTheDocument();
  });
});
