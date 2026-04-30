import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Clean existing data (order matters for FK constraints)
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

  // ═══════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════
  const hashedPassword = await bcrypt.hash("password123", 10);

  const student = await prisma.user.create({
    data: { email: "student@nwa.com", name: "田中 太郎", password: hashedPassword, role: "STUDENT" },
  });
  const instructor = await prisma.user.create({
    data: { email: "instructor@nwa.com", name: "山田 先生", password: hashedPassword, role: "INSTRUCTOR" },
  });
  console.log("Users created");

  // ═══════════════════════════════════════
  // COURSES (8 steps)
  // ═══════════════════════════════════════
  const coursesData = [
    { name: "STEP1 ITリテラシー", description: "PC基礎操作・ネットリテラシー・ツール活用", order: 1, icon: "it", color: "#6366F1" },
    { name: "STEP2 HTML", description: "Webページの骨格をHTMLで構築する", order: 2, icon: "html", color: "#EF4444" },
    { name: "STEP3 CSS", description: "デザインやレイアウトをCSSで実装する", order: 3, icon: "css", color: "#3B82F6" },
    { name: "STEP4 AIコーディング（Antigravity）", description: "AIツール（Antigravity）を使った次世代コーディング", order: 4, icon: "ag", color: "#A78BFA" },
    { name: "STEP5 Apple模写コーディング", description: "Appleの公式サイトを模写してコーディング力を鍛える", order: 5, icon: "mock", color: "#F97316" },
    { name: "STEP6 模擬案件挑戦", description: "実際の案件を想定した制作に挑戦", order: 6, icon: "mock", color: "#F59E0B" },
    { name: "STEP7 ポートフォリオ作成", description: "案件獲得に向けたポートフォリオサイトを構築", order: 7, icon: "portfolio", color: "#22C55E" },
    { name: "STEP8 案件応募", description: "クラウドソーシングで実案件に応募する方法を学ぶ", order: 8, icon: "sales", color: "#EC4899" },
  ];
  const courses: any[] = [];
  for (const c of coursesData) {
    courses.push(await prisma.course.create({ data: c }));
  }
  console.log("Courses created:", courses.length);

  // ═══════════════════════════════════════
  // SECTIONS & LESSONS
  // ═══════════════════════════════════════
  type LessonDef = { title: string; type: "VIDEO" | "TEXT" | "PDF" | "QUIZ"; duration?: string };
  type SectionDef = { title: string; lessons: LessonDef[] };

  const sectionsData: Record<number, SectionDef[]> = {
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
    1: [ // STEP2 HTML
      { title: "HTML基礎", lessons: [
        { title: "HTML基本構造", type: "VIDEO", duration: "10:00" },
        { title: "テキスト・リスト要素", type: "VIDEO", duration: "12:00" },
        { title: "フォーム要素", type: "VIDEO", duration: "14:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "HTML応用", lessons: [
        { title: "セマンティックタグ", type: "VIDEO", duration: "10:00" },
        { title: "リンク・画像・テーブル", type: "VIDEO", duration: "12:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
    ],
    2: [ // STEP3 CSS
      { title: "CSS基礎", lessons: [
        { title: "セレクター・プロパティ", type: "VIDEO", duration: "11:00" },
        { title: "ボックスモデル", type: "VIDEO", duration: "13:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "5問" },
      ]},
      { title: "CSSレイアウト", lessons: [
        { title: "Flexbox", type: "VIDEO", duration: "16:00" },
        { title: "Gridレイアウト", type: "VIDEO", duration: "14:00" },
        { title: "レスポンシブデザイン", type: "VIDEO", duration: "18:00" },
        { title: "確認クイズ", type: "QUIZ", duration: "8問" },
      ]},
    ],
    3: [ // STEP4 AIコーディング（Antigravity）
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
    4: [ // STEP5 Apple模写コーディング (新規)
      { title: "準備編", lessons: [
        { title: "Appleサイトの構造分析", type: "VIDEO", duration: "12:00" },
        { title: "制作環境のセットアップ", type: "VIDEO", duration: "10:00" },
      ]},
      { title: "実践編", lessons: [
        { title: "ヘッダー・ナビゲーション", type: "VIDEO", duration: "18:00" },
        { title: "ヒーローセクション", type: "VIDEO", duration: "20:00" },
        { title: "製品カードセクション", type: "VIDEO", duration: "22:00" },
        { title: "フッター", type: "VIDEO", duration: "14:00" },
        { title: "レスポンシブ対応", type: "VIDEO", duration: "16:00" },
        { title: "最終仕上げ・レビュー", type: "VIDEO", duration: "12:00" },
      ]},
    ],
    5: [ // STEP6 模擬案件挑戦
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
    6: [ // STEP7 ポートフォリオ作成
      { title: "ポートフォリオ制作", lessons: [
        { title: "ポートフォリオとは", type: "VIDEO", duration: "8:00" },
        { title: "構成設計", type: "VIDEO", duration: "12:00" },
        { title: "実績ページ作成", type: "VIDEO", duration: "18:00" },
        { title: "デプロイ・公開", type: "VIDEO", duration: "10:00" },
      ]},
    ],
    7: [ // STEP8 案件応募
      { title: "案件応募・獲得", lessons: [
        { title: "営業の基本", type: "VIDEO", duration: "10:00" },
        { title: "提案書作成", type: "VIDEO", duration: "14:00" },
        { title: "契約・請求", type: "VIDEO", duration: "12:00" },
        { title: "クラウドソーシング活用", type: "VIDEO", duration: "11:00" },
      ]},
    ],
  };

  // Track all created lessons by course index for progress seeding
  const allLessons: Record<number, any[]> = {};
  // Track QUIZ-type lessons for linking mini quizzes
  const quizLessons: Record<number, any[]> = {};

  for (let ci = 0; ci < courses.length; ci++) {
    allLessons[ci] = [];
    quizLessons[ci] = [];
    const sections = sectionsData[ci] || [];
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      const section = await prisma.section.create({
        data: { courseId: courses[ci].id, title: sec.title, order: si + 1 },
      });
      for (let li = 0; li < sec.lessons.length; li++) {
        const l = sec.lessons[li];
        const lesson = await prisma.lesson.create({
          data: { sectionId: section.id, title: l.title, type: l.type, duration: l.duration || null, order: li + 1 },
        });
        allLessons[ci].push(lesson);
        if (l.type === "QUIZ") quizLessons[ci].push(lesson);
      }
    }
  }
  console.log("Sections & lessons created");

  // ═══════════════════════════════════════
  // QUIZZES (STEP1〜3)
  // ═══════════════════════════════════════

  // --- STEP1 Quiz Questions ---
  const step1FinalQs = [
    { question: "コンピュータの頭脳にあたる部品は？", options: ["CPU", "HDD", "RAM", "GPU"], correctIndex: 0 },
    { question: "OSの正式名称は？", options: ["Operating System", "Open Source", "Online Service", "Output System"], correctIndex: 0 },
    { question: "1GBは何MB？", options: ["100MB", "500MB", "1024MB", "2048MB"], correctIndex: 2 },
    { question: "ファイルの拡張子 .pdf の用途は？", options: ["画像", "文書", "音声", "動画"], correctIndex: 1 },
    { question: "フィッシング詐欺の特徴は？", options: ["偽サイトに誘導する", "PCを高速化する", "ファイルを圧縮する", "通信を暗号化する"], correctIndex: 0 },
    { question: "パスワードの安全な管理方法は？", options: ["メモ帳に書く", "パスワードマネージャーを使う", "全サイト同じにする", "ブラウザに全て保存"], correctIndex: 1 },
    { question: "クラウドストレージの例は？", options: ["Google Drive", "Microsoft Word", "Chrome", "Slack"], correctIndex: 0 },
    { question: "Wi-Fiの暗号化方式で最も安全なのは？", options: ["WEP", "WPA", "WPA2", "WPA3"], correctIndex: 3 },
    { question: "ZIPファイルの用途は？", options: ["ファイルの圧縮・まとめ", "動画再生", "印刷", "メール送信"], correctIndex: 0 },
    { question: "ショートカットキー Ctrl+Z の機能は？", options: ["コピー", "貼り付け", "元に戻す", "保存"], correctIndex: 2 },
  ];

  const step1Mini1Qs = [
    { question: "デスクトップとは？", options: ["PC起動後の最初の画面", "キーボードの種類", "プリンターの部品", "USBの規格"], correctIndex: 0 },
    { question: "右クリックで表示されるのは？", options: ["コンテキストメニュー", "タスクバー", "デスクトップ", "ファイル"], correctIndex: 0 },
    { question: "ファイルを完全に削除するには？", options: ["ゴミ箱に入れるだけ", "ゴミ箱を空にする", "名前を変更する", "移動する"], correctIndex: 1 },
  ];

  const step1Mini2Qs = [
    { question: "URLの先頭 https:// の s は？", options: ["secure", "speed", "server", "system"], correctIndex: 0 },
    { question: "ブラウザのブックマーク機能は？", options: ["ページを保存する", "印刷する", "メールする", "ダウンロードする"], correctIndex: 0 },
    { question: "Googleドキュメントの特徴は？", options: ["オフライン専用", "共同編集できる", "有料のみ", "画像編集用"], correctIndex: 1 },
  ];

  // --- STEP2 HTML Quiz Questions ---
  const htmlFinalQs = [
    { question: "HTMLで見出しを表すタグは？", options: ["<h1>", "<div>", "<span>", "<p>"], correctIndex: 0 },
    { question: "HTMLの正式名称は？", options: ["HyperText Markup Language", "High Tech Modern Language", "Home Tool Markup Language", "HyperText Machine Language"], correctIndex: 0 },
    { question: "<a>タグのhref属性の用途は？", options: ["リンク先URLを指定", "文字色を変更", "画像を表示", "フォントを指定"], correctIndex: 0 },
    { question: "HTMLで画像を表示するタグは？", options: ["<img>", "<image>", "<pic>", "<photo>"], correctIndex: 0 },
    { question: "<ul>タグの用途は？", options: ["順序なしリスト", "順序ありリスト", "テーブル", "フォーム"], correctIndex: 0 },
    { question: "class属性とid属性の違いは？", options: ["classは複数要素、idは1つだけ", "同じ", "idは複数要素", "classは使えない"], correctIndex: 0 },
    { question: "HTMLのセマンティックタグはどれ？", options: ["<header>", "<div>", "<span>", "<b>"], correctIndex: 0 },
    { question: "HTMLで段落を表すタグは？", options: ["<p>", "<br>", "<div>", "<span>"], correctIndex: 0 },
    { question: "<table>タグ内の行を表すタグは？", options: ["<tr>", "<td>", "<th>", "<col>"], correctIndex: 0 },
    { question: "input type='submit' の機能は？", options: ["フォームを送信", "テキスト入力", "チェックボックス", "ファイル選択"], correctIndex: 0 },
  ];

  const htmlMini1Qs = [
    { question: "HTMLファイルの拡張子は？", options: [".html", ".css", ".js", ".txt"], correctIndex: 0 },
    { question: "<br>タグの用途は？", options: ["改行", "太字", "リンク", "画像"], correctIndex: 0 },
    { question: "<form>タグの用途は？", options: ["入力フォーム作成", "表の作成", "リスト作成", "画像表示"], correctIndex: 0 },
    { question: "input type='text' は？", options: ["テキスト入力欄", "チェックボックス", "ラジオボタン", "送信ボタン"], correctIndex: 0 },
  ];

  const htmlMini2Qs = [
    { question: "<header>タグの用途は？", options: ["ページのヘッダー部分", "見出し", "段落", "リンク"], correctIndex: 0 },
    { question: "<img>タグのalt属性は？", options: ["代替テキスト", "画像サイズ", "リンク先", "スタイル"], correctIndex: 0 },
    { question: "<table>タグ内の行を表すタグは？", options: ["<tr>", "<td>", "<th>", "<col>"], correctIndex: 0 },
    { question: "target='_blank' の効果は？", options: ["新しいタブで開く", "同じタブで開く", "ダウンロード", "リンクを無効化"], correctIndex: 0 },
  ];

  // --- STEP3 CSS Quiz Questions ---
  const cssFinalQs = [
    { question: "CSSでテキストの色を変えるプロパティは？", options: ["color", "text-color", "font-color", "foreground"], correctIndex: 0 },
    { question: "CSSのボックスモデルに含まれないのは？", options: ["margin", "padding", "border", "font-size"], correctIndex: 3 },
    { question: "Flexboxで主軸方向を変えるプロパティは？", options: ["flex-direction", "justify-content", "align-items", "flex-wrap"], correctIndex: 0 },
    { question: "レスポンシブデザインに使うCSSは？", options: ["@media", "@import", "@font-face", "@keyframes"], correctIndex: 0 },
    { question: "CSSで要素を非表示にするプロパティは？", options: ["display: none", "visible: false", "show: off", "hide: true"], correctIndex: 0 },
    { question: "CSSのmarginとpaddingの違いは？", options: ["marginは外側、paddingは内側", "同じ", "marginは内側", "paddingは外側"], correctIndex: 0 },
    { question: "position: relativeの意味は？", options: ["元の位置を基準に移動", "画面固定", "絶対位置", "初期値"], correctIndex: 0 },
    { question: "CSSセレクターの .class の書き方は？", options: [".クラス名", "#クラス名", "@クラス名", "$クラス名"], correctIndex: 0 },
    { question: "flex-grow: 1 の意味は？", options: ["余白を均等に分配", "固定サイズ", "縮小許可", "折り返し"], correctIndex: 0 },
    { question: "box-sizing: border-box の効果は？", options: ["paddingとborderを幅に含む", "marginを幅に含む", "効果なし", "要素を非表示"], correctIndex: 0 },
    { question: "gap プロパティの役割は？", options: ["子要素間の余白", "外側余白", "行間", "ボーダー太さ"], correctIndex: 0 },
    { question: "min-width: 768px のメディアクエリは？", options: ["タブレット以上", "スマホのみ", "PC専用", "全デバイス"], correctIndex: 0 },
  ];

  const cssMini1Qs = [
    { question: "CSSファイルの拡張子は？", options: [".css", ".html", ".js", ".scss"], correctIndex: 0 },
    { question: "CSSで要素の背景色を設定するプロパティは？", options: ["background-color", "color", "fill", "bg"], correctIndex: 0 },
    { question: "CSSのpaddingは何の余白？", options: ["要素の内側", "要素の外側", "ボーダーの外側", "テキストの間隔"], correctIndex: 0 },
    { question: "font-size: 16px の意味は？", options: ["文字サイズを16pxに設定", "行の高さを16pxに設定", "余白を16pxに設定", "幅を16pxに設定"], correctIndex: 0 },
  ];

  const cssMini2Qs = [
    { question: "flex-grow: 1 の意味は？", options: ["余白を均等に分配", "固定サイズ", "縮小許可", "折り返し"], correctIndex: 0 },
    { question: "gap プロパティの役割は？", options: ["子要素間の余白", "外側余白", "行間", "ボーダー太さ"], correctIndex: 0 },
    { question: "min-width: 768px のメディアクエリは？", options: ["タブレット以上", "スマホのみ", "PC専用", "全デバイス"], correctIndex: 0 },
    { question: "box-sizing: border-box の効果は？", options: ["paddingとborderを幅に含む", "marginを幅に含む", "効果なし", "要素を非表示"], correctIndex: 0 },
    { question: "display: gridで列を定義するプロパティは？", options: ["grid-template-columns", "flex-direction", "justify-content", "align-items"], correctIndex: 0 },
  ];

  // Create quizzes helper
  async function createQuiz(
    title: string, type: "FINAL" | "MINI", courseId: string | null, lessonId: string | null,
    questions: { question: string; options: string[]; correctIndex: number }[]
  ) {
    const quiz = await prisma.quiz.create({
      data: { title, type, courseId, lessonId },
    });
    for (let i = 0; i < questions.length; i++) {
      await prisma.quizQuestion.create({
        data: { quizId: quiz.id, question: questions[i].question, options: questions[i].options, correctIndex: questions[i].correctIndex, order: i + 1 },
      });
    }
    return quiz;
  }

  // STEP1 quizzes
  await createQuiz("STEP1 修了テスト", "FINAL", courses[0].id, null, step1FinalQs);
  if (quizLessons[0][0]) await createQuiz("PC基礎 ミニテスト", "MINI", null, quizLessons[0][0].id, step1Mini1Qs);
  if (quizLessons[0][1]) await createQuiz("ネット・ツール ミニテスト", "MINI", null, quizLessons[0][1].id, step1Mini2Qs);

  // STEP2 HTML quizzes
  await createQuiz("STEP2 修了テスト", "FINAL", courses[1].id, null, htmlFinalQs);
  if (quizLessons[1][0]) await createQuiz("HTML基礎 ミニテスト", "MINI", null, quizLessons[1][0].id, htmlMini1Qs);
  if (quizLessons[1][1]) await createQuiz("HTML応用 ミニテスト", "MINI", null, quizLessons[1][1].id, htmlMini2Qs);

  // STEP3 CSS quizzes
  await createQuiz("STEP3 修了テスト", "FINAL", courses[2].id, null, cssFinalQs);
  if (quizLessons[2][0]) await createQuiz("CSS基礎 ミニテスト", "MINI", null, quizLessons[2][0].id, cssMini1Qs);
  if (quizLessons[2][1]) await createQuiz("CSSレイアウト ミニテスト", "MINI", null, quizLessons[2][1].id, cssMini2Qs);

  console.log("Quizzes created");

  // ═══════════════════════════════════════
  // PROGRESS (student)
  // ═══════════════════════════════════════
  // STEP1: all 6 complete
  for (const lesson of allLessons[0]) {
    await prisma.progress.create({
      data: { userId: student.id, lessonId: lesson.id, completed: true, completedAt: new Date(Date.now() - 30 * 86400000) },
    });
  }
  // STEP2: all lessons complete
  for (const lesson of allLessons[1]) {
    await prisma.progress.create({
      data: { userId: student.id, lessonId: lesson.id, completed: true, completedAt: new Date(Date.now() - 20 * 86400000) },
    });
  }
  // STEP3: 4/7 complete
  for (let i = 0; i < 4 && i < allLessons[2].length; i++) {
    await prisma.progress.create({
      data: { userId: student.id, lessonId: allLessons[2][i].id, completed: true, completedAt: new Date(Date.now() - 10 * 86400000 + i * 86400000) },
    });
  }
  // STEP4: 8/13 complete
  for (let i = 0; i < 8 && i < allLessons[3].length; i++) {
    await prisma.progress.create({
      data: { userId: student.id, lessonId: allLessons[3][i].id, completed: true, completedAt: new Date(Date.now() - 5 * 86400000 + i * 43200000) },
    });
  }
  console.log("Progress created");

  // ═══════════════════════════════════════
  // ASSIGNMENTS (student × STEP6 模擬案件挑戦)
  // ═══════════════════════════════════════
  const twoWeeksLater = new Date(Date.now() + 14 * 86400000);
  await prisma.assignment.createMany({
    data: [
      { userId: student.id, courseId: courses[5].id, title: "課題1: カフェLP", status: "APPROVED", feedback: "合格！コードがきれいです" },
      { userId: student.id, courseId: courses[5].id, title: "課題2: 美容サロン", status: "REVIEW" },
      { userId: student.id, courseId: courses[5].id, title: "課題3: IT企業コーポレート", status: "WORKING", deadline: twoWeeksLater },
      { userId: student.id, courseId: courses[5].id, title: "課題4: レストラン予約", status: "LOCKED" },
      { userId: student.id, courseId: courses[5].id, title: "課題5: アパレルEC風", status: "LOCKED" },
    ],
  });
  console.log("Assignments created");

  // ═══════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════
  await prisma.notification.createMany({
    data: [
      { userId: student.id, title: "山田先生が質問に回答", message: "AIコーディング（AG） - L16 の質問に回答がありました", read: false },
      { userId: student.id, title: "STEP5「Apple模写コーディング」が開放されました", message: "STEP4完了後に受講可能", read: false },
      { userId: student.id, title: "CSSレイアウト ミニテスト — 90点", message: "合格おめでとう！", read: true },
      { userId: student.id, title: "課題1 合格！", message: "カフェLPの課題が承認されました", read: true },
      { userId: student.id, title: "新しいレッスンが追加されました", message: "STEP4 応用テクニックに新レッスン", read: false },
    ],
  });
  console.log("Notifications created");

  console.log("\n=== Seed completed! ===");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
