export async function sendChatMessage(message: string): Promise<string> {
  await new Promise(r => setTimeout(r, 1500));
  const responses = [
    "素晴らしい質問ですね！HTMLでは要素を組み合わせてページを構築します。具体的には...",
    "Flexboxを使うと簡単に実装できますよ。display: flex を親要素に指定してみてください。",
    "JavaScriptで実現するなら、まずは変数の宣言から始めましょう。letやconstを使います。",
    "CSSのGrid Layoutも便利ですよ。display: grid を使うと2次元レイアウトが簡単に作れます。",
    "レスポンシブデザインには @media クエリを使います。ブレークポイントを設定して、画面サイズに応じたスタイルを定義しましょう。",
    "まずはHTMLの基本構造から始めましょう。<!DOCTYPE html>、<html>、<head>、<body>タグが基本です。",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}
