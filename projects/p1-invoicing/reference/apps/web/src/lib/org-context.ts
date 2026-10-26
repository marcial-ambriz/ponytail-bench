import { createContext, useContext } from "react";

import type { Org } from "./data.ts";

export const OrgContext = createContext<Org | null>(null);

/** The organization of the current `/orgs/$orgId` page (set by OrgLayout). */
export function useOrg(): Org {
  const org = useContext(OrgContext);
  if (!org) throw new Error("useOrg must be used inside OrgLayout");
  return org;
}
