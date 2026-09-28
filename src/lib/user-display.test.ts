import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { avatarInitial, displayName, greetingTitle } from "./user-display";

// #32: the signed-in user's name in the sidebar and the dashboard heading.
// All names are dummies.

describe("displayName", () => {
  it("returns null when there is no usable name", () => {
    assert.equal(displayName(null), null);
    assert.equal(displayName(undefined), null);
    assert.equal(displayName(123), null);
    assert.equal(displayName({ name: "山田" }), null);
    assert.equal(displayName(""), null);
    assert.equal(displayName("   "), null);
    assert.equal(displayName("\u3000\t\n"), null);
  });

  it("trims and collapses whitespace", () => {
    assert.equal(displayName("  山田 太郎  "), "山田 太郎");
    assert.equal(displayName("山田   太郎"), "山田 太郎");
    assert.equal(displayName("山田\u3000\u3000太郎"), "山田 太郎");
    assert.equal(displayName("Taro\t\nYamada"), "Taro Yamada");
  });

  it("does not truncate long names", () => {
    const long = "寿限無".repeat(50);
    assert.equal(displayName(long), long);
  });
});

describe("avatarInitial", () => {
  it("returns null when there is no name", () => {
    assert.equal(avatarInitial(null), null);
    assert.equal(avatarInitial(undefined), null);
    assert.equal(avatarInitial(0), null);
    assert.equal(avatarInitial(""), null);
    assert.equal(avatarInitial("   "), null);
  });

  it("takes the first character of a Japanese name", () => {
    assert.equal(avatarInitial("山田 太郎"), "山");
  });

  it("upper-cases Latin letters", () => {
    assert.equal(avatarInitial("taro"), "T");
    assert.equal(avatarInitial("Taro"), "T");
  });

  it("skips leading whitespace", () => {
    assert.equal(avatarInitial("   山田"), "山");
    assert.equal(avatarInitial("\u3000taro"), "T");
  });

  it("keeps emoji sequences whole", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // ZWJ sequence
    assert.equal(avatarInitial(`${family}さん`), family);
    const thumbsUp = "\u{1F44D}\u{1F3FD}"; // skin tone modifier
    assert.equal(avatarInitial(`${thumbsUp}taro`), thumbsUp);
    const flag = "\u{1F1EF}\u{1F1F5}"; // regional indicators
    assert.equal(avatarInitial(`${flag}太郎`), flag);
  });

  it("keeps combining characters with their base", () => {
    const ga = "か\u3099"; // NFD "が"
    assert.equal(avatarInitial(`${ga}くと`), ga);
  });

  it("keeps surrogate pairs whole", () => {
    assert.equal(avatarInitial("𠮷田"), "𠮷");
  });
});

describe("greetingTitle", () => {
  it("greets by name", () => {
    assert.equal(greetingTitle("  山田   太郎 "), "おかえりなさい、山田 太郎 さん");
  });

  it("greets without a name", () => {
    assert.equal(greetingTitle(null), "おかえりなさい");
    assert.equal(greetingTitle(undefined), "おかえりなさい");
    assert.equal(greetingTitle("  "), "おかえりなさい");
  });
});
