import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeErrorSummary } from "./safe-error";

// Dummy values only. Never put real personal data or secrets here.
const DUMMY_EMAIL = "taro.dummy@example.com";
const DUMMY_SECRET = "dummy-secret-Pa55-XYZ";

function errorWithCode(code: unknown, name = "PrismaClientKnownRequestError"): Error {
  const err = new Error(`Unique constraint failed on ${DUMMY_EMAIL}`);
  err.name = name;
  Object.assign(err, { code });
  return err;
}

function assertOnlyKeys(value: object, keys: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

describe("safeErrorSummary", () => {
  it("returns only `name` for a plain Error", () => {
    const summary = safeErrorSummary(new Error("boom"));
    assertOnlyKeys(summary, ["name"]);
    assert.deepEqual(summary, { name: "Error" });
  });

  it("returns only `name` and `code` for a Prisma-style error", () => {
    const summary = safeErrorSummary(errorWithCode("P2002"));
    assertOnlyKeys(summary, ["name", "code"]);
    assert.deepEqual(summary, { name: "PrismaClientKnownRequestError", code: "P2002" });
  });

  it("does not leak message, meta or stack", () => {
    const err = errorWithCode("P2002");
    err.message = `duplicate ${DUMMY_EMAIL} ${DUMMY_SECRET}`;
    err.stack = `Error: ${DUMMY_EMAIL}\n    at ${DUMMY_SECRET} (file.ts:1:1)`;
    Object.assign(err, {
      meta: { target: ["email"], email: DUMMY_EMAIL, password: DUMMY_SECRET },
      clientVersion: DUMMY_SECRET,
      cause: new Error(DUMMY_EMAIL),
    });

    const json = JSON.stringify(safeErrorSummary(err));
    assert.ok(!json.includes(DUMMY_EMAIL), "must not contain the email");
    assert.ok(!json.includes(DUMMY_SECRET), "must not contain the secret");
    assert.ok(!json.includes("taro.dummy"), "must not contain the email local part");
    assert.equal(json, JSON.stringify({ name: "PrismaClientKnownRequestError", code: "P2002" }));
  });

  it("does not leak data from a non-Error object", () => {
    const json = JSON.stringify(
      safeErrorSummary({ message: DUMMY_EMAIL, meta: { secret: DUMMY_SECRET }, stack: DUMMY_SECRET })
    );
    assert.ok(!json.includes(DUMMY_EMAIL));
    assert.ok(!json.includes(DUMMY_SECRET));
  });

  it("returns the code only when it matches P + 4 digits", () => {
    assert.equal(safeErrorSummary(errorWithCode("P2002")).code, "P2002");
    assert.equal(safeErrorSummary(errorWithCode("P1001")).code, "P1001");

    for (const code of ["P200", "P20021", "ECONNRESET", 2002, "p2002", " P2002", "P2002\n", null, undefined]) {
      const summary = safeErrorSummary(errorWithCode(code));
      assert.equal(summary.code, undefined, `code ${JSON.stringify(code)} must not be returned`);
      assertOnlyKeys(summary, ["name"]);
    }
  });

  it("returns the name of an Error subclass", () => {
    class InviteFailedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "InviteFailedError";
      }
    }
    assert.deepEqual(safeErrorSummary(new InviteFailedError(DUMMY_EMAIL)), {
      name: "InviteFailedError",
    });
    assert.deepEqual(safeErrorSummary(new TypeError(DUMMY_EMAIL)), { name: "TypeError" });
  });

  it("does not throw for non-Error inputs", () => {
    const inputs: unknown[] = [DUMMY_EMAIL, undefined, null, {}, { code: "P2002" }, 42, Symbol("x")];
    for (const input of inputs) {
      assert.doesNotThrow(() => safeErrorSummary(input));
    }
    assert.deepEqual(safeErrorSummary(DUMMY_EMAIL), { name: "string" });
    assert.deepEqual(safeErrorSummary(undefined), { name: "undefined" });
    assert.deepEqual(safeErrorSummary(null), { name: "object" });
    assert.deepEqual(safeErrorSummary({}), { name: "object" });
  });
});
