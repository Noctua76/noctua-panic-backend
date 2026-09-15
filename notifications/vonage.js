function sanitizeProviderError(error) {
  return String(error?.message || error || "Provider request failed")
    .replace(/(api[_-]?secret|api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[REDACTED PRIVATE KEY]")
    .slice(0, 1000);
}

function parseSmsProviderResponse(phone, data, httpOk = true) {
  const message = data?.messages?.[0] || null;
  const providerStatusCode = message?.status == null
    ? null
    : String(message.status);
  const submitted = httpOk && providerStatusCode === "0";

  return {
    phone,
    status: submitted ? "submitted" : "failed",
    provider: "vonage",
    provider_message_id: message?.["message-id"] || null,
    provider_status_code: providerStatusCode,
    error_message: submitted
      ? null
      : sanitizeProviderError(
          message?.["error-text"] ||
          (!httpOk ? "Vonage SMS HTTP request failed" : "Vonage SMS was not accepted")
        ),
  };
}

function createVonageProvider({ env = process.env, fetchImpl = fetch, voiceClient }) {
  async function sendSms(phone, text) {
    try {
      const baseUrl = (
        env.PUBLIC_BACKEND_URL ||
        "https://noctua-panic-backend-production.up.railway.app"
      ).replace(/\/+$/, "");
      const params = new URLSearchParams();
      params.append("api_key", env.VONAGE_API_KEY || "");
      params.append("api_secret", env.VONAGE_API_SECRET || "");
      params.append("to", phone);
      params.append("from", env.VONAGE_SMS_FROM || "AegisLink");
      params.append("text", text);
      params.append("callback", `${baseUrl}/webhooks/sms-delivery`);

      const response = await fetchImpl("https://rest.nexmo.com/sms/json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const data = await response.json();
      return parseSmsProviderResponse(phone, data, response.ok);
    } catch (error) {
      return {
        phone,
        status: "failed",
        provider: "vonage",
        provider_message_id: null,
        provider_status_code: null,
        error_message: sanitizeProviderError(error),
      };
    }
  }

  async function startVoiceCall(phone, context = {}) {
    try {
      const baseUrl = (
        env.PUBLIC_BACKEND_URL ||
        "https://noctua-panic-backend-production.up.railway.app"
      ).replace(/\/+$/, "");

      const response = await voiceClient.voice.createOutboundCall({
        to: [{ type: "phone", number: phone.replace("+", "") }],
        from: { type: "phone", number: env.VONAGE_FROM_NUMBER },
        answer_url: [`${baseUrl}/webhooks/answer`],
        event_url: [`${baseUrl}/webhooks/event`],
        event_method: "POST",
      });
      const callUuid = response?.uuid || response?.call_uuid || null;

      if (!callUuid) {
        throw new Error("Vonage Voice did not return a call UUID");
      }

      return {
        phone,
        status: "submitted",
        provider: "vonage",
        provider_call_uuid: callUuid,
        error_message: null,
        context,
      };
    } catch (error) {
      return {
        phone,
        status: "failed",
        provider: "vonage",
        provider_call_uuid: null,
        error_message: sanitizeProviderError(error),
        context,
      };
    }
  }

  return { sendSms, startVoiceCall };
}

module.exports = {
  createVonageProvider,
  parseSmsProviderResponse,
  sanitizeProviderError,
};
