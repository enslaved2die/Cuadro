import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeCompare, checkRateLimit, recordFailedAttempt, clearFailedAttempts, createSession, validateSession, revokeSession } from "../src/api/auth.js";

test("Security: timingSafeCompare accurately checks passwords", () => {
  assert.equal(timingSafeCompare("secret123", "secret123"), true);
  assert.equal(timingSafeCompare("secret123", "wrongpass"), false);
  assert.equal(timingSafeCompare("secret123", "secret12"), false);
  assert.equal(timingSafeCompare("secret123", "secret1234"), false);
  assert.equal(timingSafeCompare("", ""), true);
  assert.equal(timingSafeCompare(undefined as any, "secret"), false);
});

test("Security: Brute-force rate limiting blocks IP after 5 failed attempts", () => {
  const testIp = "192.168.1.99";
  clearFailedAttempts(testIp);

  // Attempts 1 to 4 should not block
  for (let i = 1; i <= 4; i++) {
    const res = recordFailedAttempt(testIp);
    assert.equal(res.blocked, false, `Attempt ${i} should not be blocked`);
  }

  // 5th attempt should trigger block
  const fifth = recordFailedAttempt(testIp);
  assert.equal(fifth.blocked, true, "5th attempt must trigger block");
  assert.ok(fifth.retryAfterSeconds! > 0);

  // Subsequent checks should be blocked
  const check = checkRateLimit(testIp);
  assert.equal(check.blocked, true, "Subsequent check should be blocked");

  // Clearing should reset
  clearFailedAttempts(testIp);
  const afterReset = checkRateLimit(testIp);
  assert.equal(afterReset.blocked, false, "Should not be blocked after reset");
});

test("Security: Session tokens can be created, validated, and revoked", () => {
  const token = createSession("127.0.0.1");
  assert.ok(token && token.length === 64);

  assert.equal(validateSession(token), true);
  assert.equal(validateSession("invalid-token-12345678901234567890123456789012"), false);

  revokeSession(token);
  assert.equal(validateSession(token), false);
});
