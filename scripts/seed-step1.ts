import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const section1Lessons = [
  { code: "NWA101", title: "ITリテラシー", url: "https://docs.google.com/document/d/1nGra3kAaHJu0mVNr8gnI2NmJVWrUcbd4tqCO1lr_RDk/edit?usp=sharing" },
  { code: "NWA102", title: "ブラウザ", url: "https://docs.google.com/document/d/1i-Erbma_XyZbGzWPifc5L4QZJ213G5u4GIZH9YmmTyM/edit?usp=sharing" },
  { code: "NWA103", title: "ハードウェアとOS", url: "https://docs.google.com/document/d/1moKmeVPtQjlX5HH1WLp7XmgzdJP_iOmRQK_tNv6-ACA/edit?usp=sharing" },
  { code: "NWA104", title: "コマンドプロンプト", url: "https://docs.google.com/document/d/15T_WFqKIcCaQpMzaQSBq2myFUhIEa6JlUMSw_KPOg1Q/edit?usp=sharing" },
  { code: "NWA105", title: "サーバーサイドとクライアントサイド", url: "https://docs.google.com/document/d/1yTMQLwyteqi81kz49o5QMDxUkQfOwibDk3vYPu8HPHc/edit?usp=sharing" },
  { code: "NWA106", title: "WebアプリとネイティブApp", url: "https://docs.google.com/document/d/1txV31yDr0I7Zk2xE9tbGOA85PUpbh6qiymG2XfZJYK0/edit?usp=sharing" },
  { code: "NWA107", title: "WordPress", url: "https://docs.google.com/document/d/1WgLvuQ6hgsKbvlyNI4_EnlFisRFqh0w4hGzBMpFBmsc/edit?usp=sharing" },
  { code: "NWA108", title: "プログラミング学習のコツ", url: "https://docs.google.com/document/d/1sVUPFBjwWnntctbSUCwF7GqiI2Gm-G_dqergvLAdzZ8/edit?usp=sharing" },
  { code: "NWA109", title: "パソコンを使いこなそう", url: "https://docs.google.com/document/d/126oYItEF00LpYwBBDEdhOip_QX6r1hnUL-9l3K1XqWY/edit?usp=sharing" },
  { code: "NWA110", title: "Googleサービスを使いこなそう", url: "https://docs.google.com/document/d/1ateu5TzFeETM0acbXB-rVXZInGBPLOzs8_Ut4WAORuo/edit?usp=sharing" },
  { code: "NWA111", title: "Googleデベロッパーツール", url: "https://docs.google.com/document/d/1lADDK585Nay88q1IYLA2N4xavXCMQeQdZ-Q56Ff8Mhs/edit?usp=sharing" },
  { code: "NWA112", title: "タイピング速度を上げよう", url: "https://docs.google.com/document/d/1HUrmlfy4Qriqfryu3d22z4boIM7rCjdCeJXPHbtxZFs/edit?usp=sharing" },
  { code: "NWA113", title: "エンジニアが導入すべきアプリ", url: "https://docs.google.com/document/d/1hhVcQdVHnjYby0cj6sP1-ZmOmiZyTLoUJFhQAyuhyt0/edit?usp=sharing" },
  { code: "NWA114", title: "情報収集のコツ", url: "https://docs.google.com/document/d/1Fru0r3MImq1k-1UMMmYzDxiAVeSQPRqB4434gHfkp7o/edit?usp=sharing" },
  { code: "NWA115", title: "必須ブックマークリスト", url: "https://docs.google.com/document/d/1SR_z9EcYwHF8kE-U1oJ0R_YMPxzC7uY5zFobLBal7IA/edit?usp=sharing" },
  { code: "NWA116", title: "IT用語", url: "https://docs.google.com/document/d/1dboP5jsP3OJ5AZ9zXkZPFcpMYSYBce6emappHVEOqcA/edit?usp=sharing" },
];

const section2Lessons = [
  { code: "NWA200", title: "ガイダンス", url: "https://docs.google.com/document/d/1HTnYVpu97xGC5TDW9XfikPyhakD5uvZel7piQqp_xqw/edit?usp=sharing" },
  { code: "NWA201", title: "プログラミングの必要性", url: "https://docs.google.com/document/d/1kU4FHEnX_1nKMyAlHWPbMX8-aDEBjU_HuDIqzQrbwwQ/edit?usp=sharing" },
  { code: "NWA202", title: "プログラミングの概念", url: "https://docs.google.com/document/d/1nyl8Yh7NG5DQgyZ_-WGYHB_jd38wjlKseTGhhghoUzM/edit?usp=sharing" },
  { code: "NWA203", title: "プログラミング学習を始める", url: "https://docs.google.com/document/d/1xqo4WQfuAKvG0YLD72BiLxRe1BFEzB1Xn4I4zRBquqY/edit?usp=sharing" },
  { code: "NWA204", title: "プログラミング言語を知ろう", url: "https://docs.google.com/document/d/18A2DP1zdBUD61RfmZpPlYraDjS8kNpyCwHw6nJaFdeI/edit?usp=sharing" },
  { code: "NWA205", title: "ライブラリとフレームワーク", url: "https://docs.google.com/document/d/14cuQzRxtLF69XYeJj_5vv1gyBNvKnPP7c0pX7rdFJTs/edit?usp=sharing" },
  { code: "NWA206", title: "プログラミング学習の進め方", url: "https://docs.google.com/document/d/1a5Q_vvWxoJEGgefJ2KuX_gPyGhR7K-Q1Eu3jBc0MFCs/edit?usp=sharing" },
  { code: "NWA207", title: "Webアプリ開発を始める前に", url: "https://docs.google.com/document/d/13GxebPWUy57uD5moAF7iMzJOlNAYlD1m6D-5lY3XpYY/edit?usp=sharing" },
  { code: "NWA208", title: "Webアプリ開発を始める前に2", url: "https://docs.google.com/document/d/1VWmQ32EsEukEE9mcwnAWMHYIvd9TMjn8X6kDFtkQlHM/edit?usp=sharing" },
  { code: "NWA209", title: "Webアプリのサービス企画", url: "https://docs.google.com/document/d/1dTU9URke6wTMXHbKPk_Azl6SPOQBeiqvUHBviKJwXi0/edit?usp=sharing" },
  { code: "NWA210", title: "Webアプリを開発する方法", url: "https://docs.google.com/document/d/1OMfNYZ3QplOEkMh6vHNTKoadg8vZ8i9nokjXodCzD-A/edit?usp=sharing" },
  { code: "NWA211", title: "初心者がWebアプリ開発でつまずく理由", url: "https://docs.google.com/document/d/1eCZFCd99TK4XSSyUvY51m5w6upIgNnLCxIgowvJnrSA/edit?usp=sharing" },
  { code: "NWA212", title: "初心者がエラーを克服する方法", url: "https://docs.google.com/document/d/1U3MG0jNgbxgsW1TCRpqM0X842F9M0iQcHlaJcOTQS7g/edit?usp=sharing" },
  { code: "NWA213", title: "アプリ開発に先生が必要な理由", url: "https://docs.google.com/document/d/1Z6OSob-tbRVO8-K7nULQVBS0K0uexAu3jEt01p49ovw/edit?usp=sharing" },
];

async function main() {
  console.log("STEP1 seed script starting...");

  // Get STEP1 course
  const step1 = await prisma.course.findFirst({ where: { order: 1 } });
  if (!step1) {
    throw new Error("STEP1 course not found");
  }
  console.log(`Found STEP1 course: ${step1.name} (${step1.id})`);

  // Get existing sections for STEP1
  const existingSections = await prisma.section.findMany({
    where: { courseId: step1.id },
    include: { lessons: true },
  });

  const existingLessonIds = existingSections.flatMap((s) => s.lessons.map((l) => l.id));
  console.log(`Existing sections: ${existingSections.length}, lessons: ${existingLessonIds.length}`);

  // Delete related data in FK-safe order
  if (existingLessonIds.length > 0) {
    // Progress
    const delProgress = await prisma.progress.deleteMany({ where: { lessonId: { in: existingLessonIds } } });
    console.log(`Deleted progress records: ${delProgress.count}`);

    // Comments
    const delComments = await prisma.comment.deleteMany({ where: { lessonId: { in: existingLessonIds } } });
    console.log(`Deleted comments: ${delComments.count}`);

    // Mini quizzes linked to these lessons (QuizAttempt → QuizQuestion → Quiz)
    const miniQuizzes = await prisma.quiz.findMany({ where: { lessonId: { in: existingLessonIds } } });
    const miniQuizIds = miniQuizzes.map((q) => q.id);
    if (miniQuizIds.length > 0) {
      await prisma.quizAttempt.deleteMany({ where: { quizId: { in: miniQuizIds } } });
      await prisma.quizQuestion.deleteMany({ where: { quizId: { in: miniQuizIds } } });
      await prisma.quiz.deleteMany({ where: { id: { in: miniQuizIds } } });
      console.log(`Deleted mini quizzes: ${miniQuizIds.length}`);
    }

    // Lessons
    const delLessons = await prisma.lesson.deleteMany({ where: { id: { in: existingLessonIds } } });
    console.log(`Deleted lessons: ${delLessons.count}`);
  }

  // Delete sections
  if (existingSections.length > 0) {
    await prisma.section.deleteMany({ where: { courseId: step1.id } });
    console.log(`Deleted sections: ${existingSections.length}`);
  }

  // Create Section 1: ITリテラシー基礎
  const sec1 = await prisma.section.create({
    data: { courseId: step1.id, title: "ITリテラシー基礎", order: 1 },
  });
  for (let i = 0; i < section1Lessons.length; i++) {
    const l = section1Lessons[i];
    await prisma.lesson.create({
      data: {
        sectionId: sec1.id,
        title: l.title,
        type: "TEXT",
        content: l.url,
        pdfUrl: null,
        duration: l.code,
        order: i + 1,
      },
    });
  }
  console.log(`Section 1 created with ${section1Lessons.length} lessons`);

  // Create Section 2: Web・プログラミング入門
  const sec2 = await prisma.section.create({
    data: { courseId: step1.id, title: "Web・プログラミング入門", order: 2 },
  });
  for (let i = 0; i < section2Lessons.length; i++) {
    const l = section2Lessons[i];
    await prisma.lesson.create({
      data: {
        sectionId: sec2.id,
        title: l.title,
        type: "TEXT",
        content: l.url,
        pdfUrl: null,
        duration: l.code,
        order: i + 1,
      },
    });
  }
  console.log(`Section 2 created with ${section2Lessons.length} lessons`);

  // Verify
  const totalLessons = await prisma.lesson.count({
    where: { section: { courseId: step1.id } },
  });
  console.log(`\n=== Done! Total lessons in STEP1: ${totalLessons} ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
