import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { api, ApiError } from "./api.ts";

export type Role = "clerk" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<User | null> => {
    try {
      return await api<User>("/api/me");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 30_000,
});

export async function signIn(queryClient: QueryClient, email: string, password: string) {
  await api("/api/auth/sign-in/email", { body: { email, password } });
  await refreshSession(queryClient);
}

export async function signUp(
  queryClient: QueryClient,
  name: string,
  email: string,
  password: string,
) {
  await api("/api/auth/sign-up/email", { body: { name, email, password } });
  await refreshSession(queryClient);
}

export async function signOut(queryClient: QueryClient) {
  await api("/api/auth/sign-out", { body: {} });
  queryClient.clear();
  queryClient.setQueryData(meQuery.queryKey, null);
}

async function refreshSession(queryClient: QueryClient) {
  queryClient.clear();
  await queryClient.fetchQuery(meQuery);
}
