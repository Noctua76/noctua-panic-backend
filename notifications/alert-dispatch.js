const { createAlertRecipientResolver } = require("./recipients");
const { createVonageProvider, sanitizeProviderError } = require("./vonage");

function channelSummary(results) {
  const attempted = results.length;
  const submitted = results.filter((item) => item.status === "submitted").length;
  const failed = attempted - submitted;

  let status = "not_attempted";
  if (attempted > 0 && failed === 0) status = "completed";
  else if (submitted > 0 && failed > 0) status = "partial_failure";
  else if (attempted > 0) status = "failed";

  return { attempted, submitted, failed, status };
}

function overallStatus(sms, voice) {
  const attempted = sms.attempted + voice.attempted;
  const submitted = sms.submitted + voice.submitted;
  const failed = sms.failed + voice.failed;

  if (attempted === 0 || submitted === 0) return "failed";
  if (failed > 0) return "partial_failure";
  return "completed";
}

function publicNotification(notification) {
  const result = {
    phone: notification.phone,
    status: notification.status,
    provider: notification.provider,
    error_message: notification.error_message || null,
  };

  if (Object.hasOwn(notification, "provider_message_id")) {
    result.provider_message_id = notification.provider_message_id;
    result.provider_status_code = notification.provider_status_code;
  }
  if (Object.hasOwn(notification, "provider_call_uuid")) {
    result.provider_call_uuid = notification.provider_call_uuid;
  }

  return result;
}

function createAlertDispatcher({ pool, env = process.env, fetchImpl = fetch, voiceClient }) {
  const recipientResolver = createAlertRecipientResolver({ pool, env });
  const provider = createVonageProvider({ env, fetchImpl, voiceClient });

  async function recordRecipientResult({ mode, source, companyId, context, channel, result }) {
    const success = result.status === "submitted";
    const eventType = channel === "sms"
      ? "SMS_NOTIFICATION_RESULT"
      : success ? "VOICE_CALL_SUBMITTED" : "VOICE_CALL_FAILED";

    await pool.query(
      `
      INSERT INTO alert_events (
        event_type, mode, source, status, company_id, incident_id,
        site_id, guard_id, recipient_phone, provider,
        provider_message_id, provider_call_uuid, voice_attempted,
        voice_status, event_payload
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
      )
      `,
      [
        eventType,
        mode,
        source,
        result.status,
        companyId,
        context.incident_id || null,
        context.site_id || null,
        context.guard_id || null,
        result.phone,
        result.provider,
        result.provider_message_id || null,
        result.provider_call_uuid || null,
        channel === "voice" ? 1 : 0,
        channel === "voice" ? result.status : null,
        JSON.stringify({
          channel,
          provider_status_code: result.provider_status_code || null,
          error: result.error_message || null,
        }),
      ]
    );
  }

  async function recordSummary({ mode, source, companyId, context, recipientResolution, result }) {
    await pool.query(
      `
      INSERT INTO alert_events (
        event_type, mode, source, status, company_id, incident_id,
        site_id, guard_id, recipients_count, sms_attempted,
        sms_submitted, sms_sent, sms_failed, voice_attempted,
        voice_submitted, voice_failed, voice_status, provider, event_payload
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,$18::jsonb
      )
      `,
      [
        mode === "test" ? "test_alert" : "WEBAPP_ALERT",
        mode,
        source,
        result.status,
        companyId,
        context.incident_id || null,
        context.site_id || null,
        context.guard_id || null,
        result.recipients_count,
        result.sms.attempted,
        result.sms.submitted,
        result.sms.failed,
        result.voice.attempted,
        result.voice.submitted,
        result.voice.failed,
        result.voice.status,
        "vonage",
        JSON.stringify({
          mode,
          recipient_source: recipientResolution.source,
          fallback_used: recipientResolution.fallback_used,
          result,
        }),
      ]
    );
  }

  async function dispatchAlertNotifications({
    mode,
    source,
    companyId,
    message,
    incident_id = null,
    site_id = null,
    guard_id = null,
  }) {
    if (!companyId) throw new Error("Authenticated company context is required");
    if (!message) throw new Error("Alert message is required");

    const context = { incident_id, site_id, guard_id };
    const recipientResolution = await recipientResolver.getAlertRecipientsForCompany(companyId);
    const recipients = recipientResolution.recipients;
    const smsRecipients = recipients.filter((item) => item.sms_enabled);
    const voiceRecipients = recipients.filter((item) => item.voice_enabled);

    const [smsRaw, voiceRaw] = await Promise.all([
      Promise.all(smsRecipients.map((item) => provider.sendSms(item.phone, message))),
      Promise.all(voiceRecipients.map((item) => provider.startVoiceCall(item.phone, context))),
    ]);
    const smsNotifications = smsRaw.map(publicNotification);
    const voiceNotifications = voiceRaw.map(publicNotification);
    const sms = channelSummary(smsNotifications);
    const voice = channelSummary(voiceNotifications);
    const result = {
      status: overallStatus(sms, voice),
      mode,
      source,
      tested_at: mode === "test" ? new Date().toISOString() : null,
      recipients_count: recipients.length,
      recipient_source: recipientResolution.source,
      fallback_used: recipientResolution.fallback_used,
      sms,
      voice,
      notifications: { sms: smsNotifications, voice: voiceNotifications },
    };

    for (const notification of smsNotifications) {
      await recordRecipientResult({ mode, source, companyId, context, channel: "sms", result: notification });
    }
    for (const notification of voiceNotifications) {
      await recordRecipientResult({ mode, source, companyId, context, channel: "voice", result: notification });
    }
    await recordSummary({ mode, source, companyId, context, recipientResolution, result });

    return result;
  }

  return {
    dispatchAlertNotifications,
    getAlertRecipientsForCompany: recipientResolver.getAlertRecipientsForCompany,
    provider,
  };
}

module.exports = {
  channelSummary,
  createAlertDispatcher,
  overallStatus,
  sanitizeProviderError,
};
