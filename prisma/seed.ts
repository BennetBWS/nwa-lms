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
  // COURSES
  // ═══════════════════════════════════════
  const coursesData = [
    { name: "STEP1 ITリテラシー", description: "PC基礎操作・ネットリテラシー・ツール活用", order: 1, icon: "it", color: "#6366F1" },
    { name: "STEP2 HTML・CSS", description: "Webページの構造とデザインを基礎から学ぶ", order: 2, icon: "html", color: "#EF4444" },
    { name: "STEP3 JavaScript", description: "DOM操作・イベント処理などJS基礎を固める", order: 3, icon: "js", color: "#3B82F6" },
    { name: "STEP4 AI（Antigravity・Claude, etc）", description: "AIツールを活用した次世代Web制作を実践", order: 4, icon: "ag", color: "#A78BFA" },
    { name: "STEP5 模擬案件", description: "模擬案件で実務フロー・納品までをシミュレーション", order: 5, icon: "mock", color: "#F59E0B" },
    { name: "STEP6 ポートフォリオ", description: "案件獲得に向けたポートフォリオサイトを構築", order: 6, icon: "portfolio", color: "#22C55E" },
    { name: "STEP7 案件獲得", description: "営業・提案・契約など案件獲得の実践ノウハウ", order: 7, icon: "sales", color: "#EC4899" },
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
    0: [
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
    1: [
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
    2: [
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
    3: [
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
    4: [
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
    5: [
      { title: "ポートフォリオ制作", lessons: [
        { title: "ポートフォリオとは", type: "VIDEO", duration: "8:00" },
        { title: "構成設計", type: "VIDEO", duration: "12:00" },
        { title: "実績ページ作成", type: "VIDEO", duration: "18:00" },
        { title: "デプロイ・公開", type: "VIDEO", duration: "10:00" },
      ]},
    ],
    6: [
      { title: "営業・獲得", lessons: [
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

  // --- STEP2 Quiz Questions ---
  const step2FinalQs = [
    { question: "HTMLで見出しを表すタグは？", options: ["<h1>", "<div>", "<span>", "<p>"], correctIndex: 0 },
    { question: "HTMLの正式名称は？", options: ["HyperText Markup Language", "High Tech Modern Language", "Home Tool Markup Language", "HyperText Machine Language"], correctIndex: 0 },
    { question: "<a>タグのhref属性の用途は？", options: ["リンク先URLを指定", "文字色を変更", "画像を表示", "フォントを指定"], correctIndex: 0 },
    { question: "CSSでテキストの色を変えるプロパティは？", options: ["color", "text-color", "font-color", "foreground"], correctIndex: 0 },
    { question: "CSSのボックスモデルに含まれないのは？", options: ["margin", "padding", "border", "font-size"], correctIndex: 3 },
    { question: "Flexboxで主軸方向を変えるプロパティは？", options: ["flex-direction", "justify-content", "align-items", "flex-wrap"], correctIndex: 0 },
    { question: "レスポンシブデザインに使うCSSは？", options: ["@media", "@import", "@font-face", "@keyframes"], correctIndex: 0 },
    { question: "HTMLで画像を表示するタグは？", options: ["<img>", "<image>", "<pic>", "<photo>"], correctIndex: 0 },
    { question: "CSSで要素を非表示にするプロパティは？", options: ["display: none", "visible: false", "show: off", "hide: true"], correctIndex: 0 },
    { question: "<ul>タグの用途は？", options: ["順序なしリスト", "順序ありリスト", "テーブル", "フォーム"], correctIndex: 0 },
    { question: "class属性とid属性の違いは？", options: ["classは複数要素、idは1つだけ", "同じ", "idは複数要素", "classは使えない"], correctIndex: 0 },
    { question: "CSSのmarginとpaddingの違いは？", options: ["marginは外側、paddingは内側", "同じ", "marginは内側", "paddingは外側"], correctIndex: 0 },
    { question: "position: relativeの意味は？", options: ["元の位置を基準に移動", "画面固定", "絶対位置", "初期値"], correctIndex: 0 },
    { question: "CSSセレクターの .class の書き方は？", options: [".クラス名", "#クラス名", "@クラス名", "$クラス名"], correctIndex: 0 },
    { question: "HTMLのセマンティックタグはどれ？", options: ["<header>", "<div>", "<span>", "<b>"], correctIndex: 0 },
  ];

  const step2Mini1Qs = [
    { question: "HTMLファイルの拡張子は？", options: [".html", ".css", ".js", ".txt"], correctIndex: 0 },
    { question: "<br>タグの用途は？", options: ["改行", "太字", "リンク", "画像"], correctIndex: 0 },
    { question: "<form>タグの用途は？", options: ["入力フォーム作成", "表の作成", "リスト作成", "画像表示"], correctIndex: 0 },
    { question: "input type='text' は？", options: ["テキスト入力欄", "チェックボックス", "ラジオボタン", "送信ボタン"], correctIndex: 0 },
  ];

  const step2Mini2Qs = [
    { question: "CSSファイルの拡張子は？", options: [".css", ".html", ".js", ".scss"], correctIndex: 0 },
    { question: "flex-grow: 1 の意味は？", options: ["余白を均等に分配", "固定サイズ", "縮小許可", "折り返し"], correctIndex: 0 },
    { question: "gap プロパティの役割は？", options: ["子要素間の余白", "外側余白", "行間", "ボーダー太さ"], correctIndex: 0 },
    { question: "min-width: 768px のメディアクエリは？", options: ["タブレット以上", "スマホのみ", "PC専用", "全デバイス"], correctIndex: 0 },
    { question: "box-sizing: border-box の効果は？", options: ["paddingとborderを幅に含む", "marginを幅に含む", "効果なし", "要素を非表示"], correctIndex: 0 },
  ];

  // --- STEP3 Quiz Questions ---
  const step3FinalQs = [
    { question: "JavaScriptで変数を宣言するキーワードは？", options: ["let", "html", "css", "div"], correctIndex: 0 },
    { question: "constとletの違いは？", options: ["constは再代入不可", "同じ", "letは再代入不可", "constはグローバル"], correctIndex: 0 },
    { question: "typeof 'hello' の結果は？", options: ["string", "number", "boolean", "object"], correctIndex: 0 },
    { question: "配列の要素数を取得するプロパティは？", options: [".length", ".size", ".count", ".total"], correctIndex: 0 },
    { question: "if文の条件が false の時に実行されるのは？", options: ["else ブロック", "if ブロック", "for ブロック", "while ブロック"], correctIndex: 0 },
    { question: "for (let i = 0; i < 3; i++) の繰り返し回数は？", options: ["3回", "2回", "4回", "無限"], correctIndex: 0 },
    { question: "アロー関数の書き方は？", options: ["() => {}", "function() {}", "def() {}", "fn() {}"], correctIndex: 0 },
    { question: "document.getElementById() の用途は？", options: ["IDで要素を取得", "クラスで取得", "タグで取得", "全要素取得"], correctIndex: 0 },
    { question: "addEventListener の第1引数は？", options: ["イベント名", "コールバック", "要素", "オプション"], correctIndex: 0 },
    { question: "event.preventDefault() の用途は？", options: ["デフォルト動作を防止", "イベント発火", "要素削除", "ページ遷移"], correctIndex: 0 },
    { question: "JSON.parse() の用途は？", options: ["文字列→オブジェクト", "オブジェクト→文字列", "数値→文字列", "配列→文字列"], correctIndex: 0 },
    { question: "Promise の3つの状態は？", options: ["pending, fulfilled, rejected", "start, run, stop", "open, close, error", "new, old, done"], correctIndex: 0 },
    { question: "async/await の用途は？", options: ["非同期処理を同期的に書く", "変数宣言", "ループ処理", "条件分岐"], correctIndex: 0 },
    { question: "console.log() の用途は？", options: ["コンソールに出力", "ファイル保存", "アラート表示", "ページ遷移"], correctIndex: 0 },
    { question: "null と undefined の違いは？", options: ["nullは意図的な空、undefinedは未定義", "同じ", "nullは未定義", "undefinedは意図的"], correctIndex: 0 },
  ];

  const step3Mini1Qs = [
    { question: "letで宣言した変数は再代入できる？", options: ["できる", "できない", "条件による", "エラーになる"], correctIndex: 0 },
    { question: "NaN の意味は？", options: ["Not a Number", "No and Null", "New Array Number", "None"], correctIndex: 0 },
    { question: "return文の役割は？", options: ["関数から値を返す", "変数宣言", "ループ終了", "条件分岐"], correctIndex: 0 },
    { question: "テンプレートリテラルの記号は？", options: ["バッククォート ``", "シングルクォート ''", "ダブルクォート \"\"", "括弧 ()"], correctIndex: 0 },
  ];

  const step3Mini2Qs = [
    { question: "querySelector() と getElementById() の違いは？", options: ["querySelectorはCSS セレクタ指定", "同じ", "getElementByIdはクラス取得", "querySelectorはID専用"], correctIndex: 0 },
    { question: "innerHTML の用途は？", options: ["要素のHTML内容を取得/設定", "CSSを変更", "イベント追加", "属性を取得"], correctIndex: 0 },
    { question: "classList.add() の用途は？", options: ["クラスを追加", "クラスを削除", "クラスを全取得", "IDを追加"], correctIndex: 0 },
    { question: "fetch() の戻り値は？", options: ["Promise", "String", "Object", "Array"], correctIndex: 0 },
    { question: "try...catch の用途は？", options: ["エラーハンドリング", "ループ処理", "変数宣言", "関数定義"], correctIndex: 0 },
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

  // STEP2 quizzes
  await createQuiz("STEP2 修了テスト", "FINAL", courses[1].id, null, step2FinalQs);
  if (quizLessons[1][0]) await createQuiz("HTML基礎 ミニテスト", "MINI", null, quizLessons[1][0].id, step2Mini1Qs);
  if (quizLessons[1][1]) await createQuiz("CSS基礎 ミニテスト", "MINI", null, quizLessons[1][1].id, step2Mini2Qs);

  // STEP3 quizzes
  await createQuiz("STEP3 修了テスト", "FINAL", courses[2].id, null, step3FinalQs);
  if (quizLessons[2][0]) await createQuiz("JS基礎 ミニテスト", "MINI", null, quizLessons[2][0].id, step3Mini1Qs);
  if (quizLessons[2][1]) await createQuiz("DOM・イベント ミニテスト", "MINI", null, quizLessons[2][1].id, step3Mini2Qs);

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
  // STEP2: all 9 complete
  for (const lesson of allLessons[1]) {
    await prisma.progress.create({
      data: { userId: student.id, lessonId: lesson.id, completed: true, completedAt: new Date(Date.now() - 20 * 86400000) },
    });
  }
  // STEP3: 6/8 complete
  for (let i = 0; i < 6 && i < allLessons[2].length; i++) {
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
  // ASSIGNMENTS (student × STEP5)
  // ═══════════════════════════════════════
  const twoWeeksLater = new Date(Date.now() + 14 * 86400000);
  await prisma.assignment.createMany({
    data: [
      { userId: student.id, courseId: courses[4].id, title: "課題1: カフェLP", status: "APPROVED", feedback: "合格！コードがきれいです" },
      { userId: student.id, courseId: courses[4].id, title: "課題2: 美容サロン", status: "REVIEW" },
      { userId: student.id, courseId: courses[4].id, title: "課題3: IT企業コーポレート", status: "WORKING", deadline: twoWeeksLater },
      { userId: student.id, courseId: courses[4].id, title: "課題4: レストラン予約", status: "LOCKED" },
      { userId: student.id, courseId: courses[4].id, title: "課題5: アパレルEC風", status: "LOCKED" },
    ],
  });
  console.log("Assignments created");

  // ═══════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════
  await prisma.notification.createMany({
    data: [
      { userId: student.id, title: "山田先生が質問に回答", message: "AI（AG） - L16 の質問に回答がありました", read: false },
      { userId: student.id, title: "STEP5「模擬案件」が開放されました", message: "STEP4完了後に受講可能", read: false },
      { userId: student.id, title: "JS DOM操作クイズ — 90点", message: "合格おめでとう！", read: true },
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
