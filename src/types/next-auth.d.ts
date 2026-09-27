import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "STUDENT" | "INSTRUCTOR";
    } & DefaultSession["user"];
  }

  // Returned by `authorize` (src/lib/auth.ts). Optional because the same type is
  // used for other shapes (e.g. AdapterUser) by NextAuth.
  interface User {
    role?: "STUDENT" | "INSTRUCTOR";
    /** User.sessionVersion at sign-in (#11). */
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: "STUDENT" | "INSTRUCTOR";
    id: string;
    /** User.sessionVersion at sign-in (#11). Missing on tokens issued before #11. */
    sv?: number;
  }
}
