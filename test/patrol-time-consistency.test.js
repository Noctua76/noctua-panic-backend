const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PATROL_MISSED_STATS_SQL } = require("../patrol/system-status-missed");

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const systemStatusSource = fs.readFileSync(
  path.join(__dirname, "../system-status.js"),
  "utf8"
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function renderInAthens(rawValue, browserTimezone) {
  const script = `
    const value = new Date(${JSON.stringify(rawValue)});
    process.stdout.write(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(value));
  `;
  return execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: browserTimezone },
    encoding: "utf8",
  });
}

test("patrol site API converts local company wall time to an unambiguous UTC instant", () => {
  const route = sourceSection(
    serverSource,
    'app.get("/patrols/sites"',
    '"/patrols/sites/:siteId/details"'
  );

  assert.match(
    route,
    /\(u\.scheduled_at AT TIME ZONE u\.timezone\) AT TIME ZONE 'UTC'/
  );
  assert.match(
    route,
    /\(sn\.next_patrol AT TIME ZONE sn\.next_timezone\) AT TIME ZONE 'UTC'/
  );
  assert.match(route, /YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"/);
  assert.doesNotMatch(
    route,
    /to_char\(\s*u\.scheduled_at\s*,\s*'YYYY-MM-DD"T"HH24:MI:SS\.MS'/
  );
});

test("the same UTC patrol instant renders as the same Athens time in different browser zones", () => {
  const rawApiValue = "2026-10-18T15:00:00.000Z";
  const athensBrowser = renderInAthens(rawApiValue, "Europe/Athens");
  const newYorkBrowser = renderInAthens(rawApiValue, "America/New_York");

  assert.equal(athensBrowser, newYorkBrowser);
  assert.match(athensBrowser, /18\/10\/2026, 18:00:00/);
});

test("the previous offset-less payload demonstrates the reproduced browser-dependent defect", () => {
  const oldRawApiValue = "2026-10-18T18:00:00.000";
  assert.notEqual(
    renderInAthens(oldRawApiValue, "Europe/Athens"),
    renderInAthens(oldRawApiValue, "America/New_York")
  );
});

test("System Status missed statistics use the two-hour lifecycle for all patrol types", () => {
  const section = PATROL_MISSED_STATS_SQL;

  assert.doesNotMatch(section, /INTERVAL '16 minutes'/);
  assert.match(section, /recurring_missed/);
  assert.match(section, /manual_missed/);
  assert.match(section, /random_missed/);
  assert.equal((section.match(/INTERVAL '2 hours'/g) || []).length, 3);
  assert.equal((section.match(/is_company_operational_at\(/g) || []).length, 3);
  assert.match(section, /s\.company_id = \$1/);
  assert.match(section, /rpo\.company_id = \$1/);
  assert.match(section, /MAX\(scheduled_at AT TIME ZONE timezone\) AS last_missed_at/);
  assert.match(section, /UNION ALL[\s\S]*manual_missed[\s\S]*UNION ALL[\s\S]*random_missed/);
  assert.match(systemStatusSource, /pool\.query\(PATROL_MISSED_STATS_SQL, \[companyId, null\]\)/);
});

test("missed boundary changes exactly at scheduled plus two hours, including midnight", () => {
  const scheduled = Date.parse("2026-10-18T15:00:00.000Z");
  const closes = scheduled + 2 * 60 * 60 * 1000;
  assert.equal(Date.parse("2026-10-18T16:59:59.999Z") >= closes, false);
  assert.equal(Date.parse("2026-10-18T17:00:00.000Z") >= closes, true);
  assert.equal(Date.parse("2026-10-18T17:00:00.001Z") >= closes, true);

  const crossMidnight = Date.parse("2026-10-18T20:30:00.000Z");
  assert.equal(
    new Date(crossMidnight + 2 * 60 * 60 * 1000).toISOString(),
    "2026-10-18T22:30:00.000Z"
  );
});
