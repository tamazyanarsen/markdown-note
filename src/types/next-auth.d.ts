import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** Одобрен ли пользователь. См. events.createUser в src/lib/auth.ts. */
      isApproved: boolean;
    } & DefaultSession["user"];
  }
}

export {};
