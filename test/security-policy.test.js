const test = require("node:test");
const assert = require("node:assert/strict");

const { accountAction, ipAction } = require("../security/auth-protection");
const {
  createCorsOptions,
} = require("../security/cors-policy");
const { requireSystemOwner } = require("../patrol/corrections");

function corsDecision(options, origin) {
  return new Promise((resolve) => {
    options.origin(origin, (error, allowed) => resolve({ error, allowed }));
  });
}

test("account throttle thresholds match the security policy", () => {
  assert.equal(accountAction(3), null);
  assert.deepEqual(accountAction(4), {
    seconds: 45,
    action: "delay_45s",
    securityEvent: false,
  });
  assert.equal(accountAction(6).seconds, 300);
  assert.equal(accountAction(8).seconds, 1800);
  assert.equal(accountAction(8).securityEvent, true);
});

test("IP throttling requires both attempts and distinct usernames", () => {
  assert.equal(ipAction(10, 1), null);
  assert.equal(ipAction(6, 2), null);
  assert.equal(ipAction(6, 3).seconds, 45);
  assert.equal(ipAction(8, 4).seconds, 300);
  assert.equal(ipAction(10, 5).seconds, 1800);
  assert.equal(ipAction(10, 5).securityEvent, true);
});

test("production CORS accepts only official frontends", async () => {
  const options = createCorsOptions({ NODE_ENV: "production" });
  assert.equal(
    (await corsDecision(options, "https://dashboard.aegislink.noctuacore.ai")).allowed,
    true
  );
  assert.equal(
    (await corsDecision(options, "https://guard.aegislink.noctuacore.ai")).allowed,
    true
  );
  assert.ok((await corsDecision(options, "https://noctua76.github.io")).error);
  assert.ok((await corsDecision(options, "http://localhost:5173")).error);
});

test("development CORS preserves loopback VS Code ports", async () => {
  const options = createCorsOptions({ NODE_ENV: "development" });
  assert.equal(
    (await corsDecision(options, "http://localhost:5500")).allowed,
    true
  );
  assert.equal(
    (await corsDecision(options, "http://127.0.0.1:5173")).allowed,
    true
  );
  assert.ok((await corsDecision(options, "http://localhost:61234")).error);
  assert.ok((await corsDecision(options, "https://example.com")).error);
});

test("patrol corrections are restricted to system_owner", () => {
  let nextCalled = false;
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  requireSystemOwner({ auth: { role: "administrator" } }, response, () => {
    nextCalled = true;
  });
  assert.equal(response.statusCode, 403);
  assert.equal(nextCalled, false);

  requireSystemOwner({ auth: { role: "system_owner" } }, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
