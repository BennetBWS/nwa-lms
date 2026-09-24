import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INITIAL_PASSWORD_LENGTH,
  INITIAL_PASSWORD_CHARSET,
  MIN_INITIAL_PASSWORD_LENGTH,
  generateInitialPassword,
} from "./initial-password";

describe("generateInitialPassword", () => {
  it("defaults to 14 characters", () => {
    assert.equal(DEFAULT_INITIAL_PASSWORD_LENGTH, 14);
    assert.equal(generateInitialPassword().length, 14);
  });

  it("honors an explicit length of 12 and 16", () => {
    assert.equal(MIN_INITIAL_PASSWORD_LENGTH, 12);
    assert.equal(generateInitialPassword(12).length, 12);
    assert.equal(generateInitialPassword(16).length, 16);
  });

  it("rejects lengths that are too short or not integers", () => {
    for (const length of [11, 0, -1, -14, 12.5, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => generateInitialPassword(length),
        /integer >= 12/,
        `length ${length} should throw`
      );
    }
  });

  it("uses only characters from the charset", () => {
    const allowed = new Set(INITIAL_PASSWORD_CHARSET);
    for (let n = 0; n < 200; n++) {
      const password = generateInitialPassword();
      for (const ch of password) {
        assert.ok(allowed.has(ch), `unexpected character ${JSON.stringify(ch)}`);
      }
    }
  });

  it("does not delegate to Math.random for the default source", () => {
    const original = Math.random;
    let called = false;
    Math.random = () => {
      called = true;
      return 0;
    };
    try {
      generateInitialPassword();
    } finally {
      Math.random = original;
    }
    assert.equal(called, false);
  });

  it("uses independent random values per call (1000 unique passwords)", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) seen.add(generateInitialPassword());
    assert.equal(seen.size, 1000);
  });
});

describe("INITIAL_PASSWORD_CHARSET", () => {
  it("excludes visually ambiguous characters", () => {
    for (const ch of "0Oo1lI2Zz5Ss") {
      assert.ok(!INITIAL_PASSWORD_CHARSET.includes(ch), `charset must not contain ${ch}`);
    }
  });

  it("has 50 unique characters", () => {
    assert.equal(INITIAL_PASSWORD_CHARSET.length, 50);
    assert.equal(new Set(INITIAL_PASSWORD_CHARSET).size, 50);
  });
});

describe("generateInitialPassword with an injected randomIndex", () => {
  it("repeats the first character when randomIndex always returns 0", () => {
    const password = generateInitialPassword(12, () => 0);
    assert.equal(password, INITIAL_PASSWORD_CHARSET[0].repeat(12));
  });

  it("maps each returned index to the charset character at that position", () => {
    const indices = [0, 1, 2, 21, 22, 43, 44, 49, 10, 30, 45, 5, 48, 7];
    let i = 0;
    const password = generateInitialPassword(indices.length, () => indices[i++]);
    const expected = indices.map((idx) => INITIAL_PASSWORD_CHARSET[idx]).join("");
    assert.equal(password, expected);
    assert.equal(password[0], "A");
    assert.equal(password[7], "9");
  });

  it("calls randomIndex exactly `length` times with max = 50", () => {
    for (const length of [12, 14, 16, 32]) {
      const calls: number[] = [];
      generateInitialPassword(length, (max) => {
        calls.push(max);
        return 0;
      });
      assert.equal(calls.length, length);
      assert.ok(calls.every((max) => max === 50));
    }
  });

  it("does not call randomIndex when the length is rejected", () => {
    let called = 0;
    assert.throws(() =>
      generateInitialPassword(11, () => {
        called++;
        return 0;
      })
    );
    assert.equal(called, 0);
  });
});
