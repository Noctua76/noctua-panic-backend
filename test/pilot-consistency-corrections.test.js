const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  INCIDENT_RESOLVED_RECENT_HOURS,
  isResolvedIncidentRecent,
} = require("../incident-timeline");
const { shouldReverseGeocodeLocation } = require("../guard-location");

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const systemStatusSource = fs.readFileSync(
  path.join(__dirname, "../system-status.js"),
  "utf8"
);

test("tenant SMS and Voice history remains company scoped and separate from platform health", () => {
  const tenantServicesStart = systemStatusSource.indexOf("async function getTenantServices");
  const tenantServicesEnd = systemStatusSource.indexOf("async function tenantOverview", tenantServicesStart);
  const tenantServices = systemStatusSource.slice(tenantServicesStart, tenantServicesEnd);

  assert.match(tenantServices, /FROM alert_events ae\s*WHERE ae\.company_id = \$1/);
  assert.match(tenantServices, /WHERE ae\.company_id = \$1\s*AND \(ae\.provider_call_uuid/);
  assert.match(systemStatusSource, /sms_gateway: \{ \.\.\.platformByName\.sms_gateway, tenant_operation: tenantByName\.sms_gateway \}/);
  assert.match(systemStatusSource, /voice_calls: \{ \.\.\.platformByName\.voice_calls, tenant_operation: tenantByName\.voice_calls \}/);
});

test("resolved incidents remain recent strictly before the two-hour boundary", () => {
  const now = "2026-09-23T12:00:00.000Z";
  assert.equal(INCIDENT_RESOLVED_RECENT_HOURS, 2);
  assert.equal(isResolvedIncidentRecent("2026-09-23T10:00:00.001Z", now), true);
});

test("resolved incidents return to normal at and after the two-hour boundary", () => {
  const now = "2026-09-23T12:00:00.000Z";
  assert.equal(isResolvedIncidentRecent("2026-09-23T10:00:00.000Z", now), false);
  assert.equal(isResolvedIncidentRecent("2026-09-23T09:59:59.999Z", now), false);
  assert.match(serverSource, /resolved_time > NOW\(\) - \(\$3::int \* INTERVAL '1 hour'\)/);
});

test("stationary location keepalives do not repeatedly reverse geocode", () => {
  assert.equal(shouldReverseGeocodeLocation({
    previousLatitude: 38.04,
    previousLongitude: 23.79,
    previousAccuracy: 20,
    previousAddress: "Example 1, Athens",
    previousGeocodedAt: "2026-09-23T11:59:00.000Z",
    latitude: 38.0401,
    longitude: 23.7901,
    accuracy: 20,
    now: "2026-09-23T12:00:00.000Z",
  }), false);
});

test("failed address lookup is retried only after the controlled cooldown", () => {
  const location = {
    previousLatitude: 38.04,
    previousLongitude: 23.79,
    previousAccuracy: 20,
    previousAddress: null,
    previousGeocodedAt: "2026-09-23T11:55:00.000Z",
    latitude: 38.04,
    longitude: 23.79,
    accuracy: 20,
  };

  assert.equal(shouldReverseGeocodeLocation({
    ...location,
    now: "2026-09-23T12:00:00.000Z",
  }), false);
  assert.equal(shouldReverseGeocodeLocation({
    ...location,
    now: "2026-09-23T12:05:00.000Z",
  }), true);
});

test("missing address or meaningful movement requests reverse geocoding", () => {
  const base = {
    previousLatitude: 38.04,
    previousLongitude: 23.79,
    previousAccuracy: 15,
    latitude: 38.042,
    longitude: 23.792,
    accuracy: 15,
  };
  assert.equal(shouldReverseGeocodeLocation({ ...base, previousAddress: null }), true);
  assert.equal(shouldReverseGeocodeLocation({ ...base, previousAddress: "Old address" }), true);
  assert.match(serverSource, /GUARD_LOCATION_UPDATE_SQL/);
});

test("live Guard locations remain tenant scoped", () => {
  const start = serverSource.indexOf('"/guards/live-locations"');
  const end = serverSource.indexOf("// ----------------------------------------------------------\n// START SERVER", start);
  const route = serverSource.slice(start, end);

  assert.match(route, /\$1::boolean = true\s*OR s\.company_id = \$2/);
  assert.match(route, /req\.auth\.company_id/);
});
