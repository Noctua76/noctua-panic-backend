const PRODUCTION_ORIGINS = new Set([
  "https://dashboard.aegislink.noctuacore.ai",
  "https://guard.aegislink.noctuacore.ai",
]);

const DEVELOPMENT_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isProductionEnvironment(env) {
  return (
    env.NODE_ENV === "production" ||
    Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME)
  );
}

function createCorsOptions(env = process.env) {
  const production = isProductionEnvironment(env);
  const allowedOrigins = new Set(PRODUCTION_ORIGINS);

  if (!production) {
    for (const origin of DEVELOPMENT_ORIGINS) {
      allowedOrigins.add(origin);
    }

    for (const origin of parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS)) {
      allowedOrigins.add(origin);
    }
  }

  return {
    origin(origin, callback) {
      const normalizedOrigin = origin?.replace(/\/$/, "");

      if (
        !origin ||
        allowedOrigins.has(normalizedOrigin)
      ) {
        callback(null, true);
        return;
      }

      const error = new Error("Origin is not allowed by Aegis Link CORS policy");
      error.code = "CORS_ORIGIN_DENIED";
      callback(error);
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

module.exports = {
  DEVELOPMENT_ORIGINS,
  PRODUCTION_ORIGINS,
  createCorsOptions,
  isProductionEnvironment,
};
