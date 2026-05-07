import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export async function POST(request: Request) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // Invalidate any existing unused tokens for this user
      await prisma.passwordReset.updateMany({
        where: { userId: user.id, used: false },
        data: { used: true },
      });

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.passwordReset.create({
        data: { userId: user.id, token, expiresAt },
      });

      const resetUrl = `https://nwa-lms.vercel.app/reset-password?token=${token}`;

      if (!resend) {
        console.log("[RESEND] RESEND_API_KEY not set. Reset URL:", resetUrl);
      } else {
        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: user.email,
          subject: "NWA - パスワードリセット",
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0B1120; color: #F1F5F9; border-radius: 16px;">
              <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style="height: 40px; filter: brightness(0) invert(1); margin-bottom: 24px;" />
              <h2 style="margin: 0 0 16px; font-size: 22px; color: #F1F5F9;">パスワードリセット</h2>
              <p style="color: #94A3B8; line-height: 1.7; margin: 0 0 24px;">
                以下のリンクからパスワードを再設定してください。
              </p>
              <a href="${resetUrl}" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #60A5FA, #3B82F6); color: #fff; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 15px;">
                パスワードを再設定する
              </a>
              <p style="margin: 24px 0 0; font-size: 12px; color: #475569;">
                ※このリンクは1時間で無効になります。<br />
                心当たりがない場合はこのメールを無視してください。
              </p>
            </div>
          `,
        });
      }
    }

    // Always return success to prevent user enumeration
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("forgot-password error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
