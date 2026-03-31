import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Clean existing data
  await prisma.notification.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.quizAttempt.deleteMany();
  await prisma.quizQuestion.deleteMany();
  await prisma.quiz.deleteMany();
  await prisma.progress.deleteMany();
  await prisma.lesson.deleteMany();
  await prisma.section.deleteMany();
  await prisma.course.deleteMany();
  await prisma.user.deleteMany();

  // Create users
  const hashedPassword = await bcrypt.hash("password123", 10);

  const student = await prisma.user.create({
    data: {
      email: "student@nwa.com",
      name: "田中 太郎",
      password: hashedPassword,
      role: "STUDENT",
    },
  });

  const instructor = await prisma.user.create({
    data: {
      email: "instructor@nwa.com",
      name: "山田 先生",
      password: hashedPassword,
      role: "INSTRUCTOR",
    },
  });

  console.log("Users created:", student.email, instructor.email);

  // Create courses
  const coursesData = [
    { name: "STEP1 ITリテラシー", description: "PC基礎操作・ネットリテラシー・ツール活用", order: 1, icon: "it", color: "#6366F1" },
    { name: "STEP2 HTML・CSS", description: "Webページの構造とデザインを基礎から学ぶ", order: 2, icon: "html", color: "#EF4444" },
    { name: "STEP3 JavaScript", description: "DOM操作・イベント処理などJS基礎を固める", order: 3, icon: "js", color: "#3B82F6" },
    { name: "STEP4 AI（Antigravity・Claude, etc）", description: "AIツールを活用した次世代Web制作を実践", order: 4, icon: "ag", color: "#A78BFA" },
    { name: "STEP5 模擬案件", description: "模擬案件で実務フロー・納品までをシミュレーション", order: 5, icon: "mock", color: "#F59E0B" },
    { name: "STEP6 ポートフォリオ", description: "案件獲得に向けたポートフォリオサイトを構築", order: 6, icon: "portfolio", color: "#22C55E" },
    { name: "STEP7 案件獲得", description: "営業・提案・契約など案件獲得の実践ノウハウ", order: 7, icon: "sales", color: "#EC4899" },
  ];

  const courses = [];
  for (const c of coursesData) {
    const course = await prisma.course.create({ data: c });
    courses.push(course);
  }

  console.log("Courses created:", courses.length);

  // Create sections and lessons for each course
  const sectionsData: Record<number, { title: string; lessons: { title: string; type: "VIDEO" | "TEXT" | "PDF" | "QUIZ"; duration?: string }[] }[]> = {
    0: [ // STEP1 ITリテラシー
      { title: "PC基礎", lessons: [
        { title: "PC基本操作", type: "VIDEO", duration: "10:00" },
        { title: "ファイル管理", type: "VIDEO", duration: "8:30" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "ネット・ツール", lessons: [
        { title: "ネットリテラシー", type: "VIDEO", duration: "12:00" },
        { title: "ツール活用基礎", type: "VIDEO", duration: "15:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
    ],
    1: [ // STEP2 HTML・CSS
      { title: "HTML基礎", lessons: [
        { title: "HTML基本構造", type: "VIDEO", duration: "10:00" },
        { title: "テキスト・リスト要素", type: "VIDEO", duration: "12:00" },
        { title: "フォーム要素", type: "VIDEO", duration: "14:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "CSS基礎", lessons: [
        { title: "セレクター・プロパティ", type: "VIDEO", duration: "11:00" },
        { title: "ボックスモデル", type: "VIDEO", duration: "13:00" },
        { title: "Flexbox", type: "VIDEO", duration: "16:00" },
        { title: "レスポンシブデザイン", type: "VIDEO", duration: "18:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "8問" },
      ]},
    ],
    2: [ // STEP3 JavaScript
      { title: "JS基礎", lessons: [
        { title: "変数・データ型", type: "VIDEO", duration: "10:00" },
        { title: "条件分岐・ループ", type: "VIDEO", duration: "12:00" },
        { title: "関数", type: "VIDEO", duration: "14:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "DOM・イベント", lessons: [
        { title: "DOM操作", type: "VIDEO", duration: "15:00" },
        { title: "イベント処理", type: "VIDEO", duration: "13:00" },
        { title: "非同期処理", type: "VIDEO", duration: "16:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "8問" },
      ]},
    ],
    3: [ // STEP4 AI
      { title: "AI基礎", lessons: [
        { title: "AI制作ツールとは", type: "VIDEO", duration: "8:30" },
        { title: "環境セットアップ", type: "VIDEO", duration: "12:45" },
        { title: "プロンプトの基本", type: "VIDEO", duration: "10:20" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "実践サイト制作", lessons: [
        { title: "LP構成の設計", type: "VIDEO", duration: "15:00" },
        { title: "ヘッダー・ナビ作成", type: "VIDEO", duration: "18:30" },
        { title: "レスポンシブ実装", type: "VIDEO", duration: "22:15" },
        { title: "フォーム実装", type: "VIDEO", duration: "14:00" },
        { title: "AG制作フロー PDF", type: "PDF", duration: "3P" },
        { title: "確認クイズ", type: "QUIZ", duration: "8問" },
      ]},
      { title: "応用テクニック", lessons: [
        { title: "アニメーション指示", type: "VIDEO", duration: "11:00" },
        { title: "複数ページサイト", type: "VIDEO", duration: "16:30" },
        { title: "デバッグ・修正依頼", type: "VIDEO", duration: "14:20" },
      ]},
    ],
    4: [ // STEP5 模擬案件
      { title: "案件フロー", lessons: [
        { title: "案件の流れ", type: "VIDEO", duration: "10:00" },
        { title: "ヒアリング手法", type: "VIDEO", duration: "12:00" },
        { title: "デザインカンプ読解", type: "VIDEO", duration: "15:00" },
      ]},
      { title: "実践課題", lessons: [
        { title: "課題1: カフェLP", type: "TEXT" },
        { title: "課題2: 美容サロン", type: "TEXT" },
        { title: "課題3: IT企業", type: "TEXT" },
        { title: "課題4: レストラン", type: "TEXT" },
        { title: "課題5: アパレルEC", type: "TEXT" },
      ]},
    ],
    5: [ // STEP6 ポートフォリオ
      { title: "ポートフォリオ制作", lessons: [
        { title: "ポートフォリオとは", type: "VIDEO", duration: "8:00" },
        { title: "構成設計", type: "VIDEO", duration: "12:00" },
        { title: "実績ページ作成", type: "VIDEO", duration: "18:00" },
        { title: "デプロイ・公開", type: "VIDEO", duration: "10:00" },
      ]},
    ],
    6: [ // STEP7 案件獲得
      { title: "営業・獲得", lessons: [
        { title: "営業の基本", type: "VIDEO", duration: "10:00" },
        { title: "提案書作成", type: "VIDEO", duration: "14:00" },
        { title: "契約・請求", type: "VIDEO", duration: "12:00" },
        { title: "クラウドソーシング活用", type: "VIDEO", duration: "11:00" },
      ]},
    ],
  };

  for (let ci = 0; ci < courses.length; ci++) {
    const sections = sectionsData[ci] || [];
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      const section = await prisma.section.create({
        data: { courseId: courses[ci].id, title: sec.title, order: si + 1 },
      });
      for (let li = 0; li < sec.lessons.length; li++) {
        const l = sec.lessons[li];
        await prisma.lesson.create({
          data: {
            sectionId: section.id,
            title: l.title,
            type: l.type,
            duration: l.duration || null,
            order: li + 1,
          },
        });
      }
    }
  }

  console.log("Sections & lessons created");

  // Create some notifications for the student
  await prisma.notification.createMany({
    data: [
      { userId: student.id, title: "山田先生が質問に回答", message: "AI（AG） - L16 の質問に回答がありました", read: false },
      { userId: student.id, title: "STEP5「模擬案件」が開放されました", message: "STEP4完了後に受講可能", read: false },
      { userId: student.id, title: "JS DOM操作クイズ — 90点", message: "合格おめでとう！", read: true },
    ],
  });

  console.log("Notifications created");
  console.log("Seed completed!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
