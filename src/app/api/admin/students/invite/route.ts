import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateInitialPassword } from "@/lib/initial-password";
import { safeErrorSummary } from "@/lib/safe-error";
import {
  INVITE_EXISTS_MESSAGE,
  inviteConflictFor,
  isUniqueConstraintError,
} from "@/lib/student-invite";
import bcrypt from "bcryptjs";

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (session?.user?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { email, name } = body;

    // Existing email (#7): 409 instead of a P2002 500. A deactivated student is
    // pointed to reactivation instead of being re-created.
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true, deactivatedAt: true },
    });
    const conflict = inviteConflictFor(existing);
    if (conflict) {
      return NextResponse.json(conflict, { status: 409 });
    }

    const password = generateInitialPassword();
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
        role: "STUDENT",
      },
    });

    // The response contains the plaintext initial password. Do not cache it.
    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name, password },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // A concurrent invite of the same email can still hit the unique constraint.
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: INVITE_EXISTS_MESSAGE, code: "EXISTS" },
        { status: 409 }
      );
    }
    console.error("Failed to invite student", safeErrorSummary(error));
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
