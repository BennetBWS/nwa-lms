import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { reactivateStudent } from "@/lib/student-status";

// Reactivation (#7): clears User.deactivatedAt. sessionVersion and the password are unchanged.
export async function PUT(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (session?.user?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const result = await reactivateStudent(prisma, id);

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    // Fixed text only: no id, name or email in the log.
    if (result.changed) console.info("[admin] student reactivated");

    return NextResponse.json(result.student);
  } catch (error) {
    console.error("[admin] Failed to reactivate student", safeErrorSummary(error));
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
