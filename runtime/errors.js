/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Errors
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Defines all Runtime-specific errors.
 *
 * Every Runtime error extends the native Error object and includes:
 *  - error code
 *  - HTTP status
 *  - optional details
 * ============================================================================
 */

"use strict";

class RuntimeError extends Error {

    constructor(code, message, status = 400, details = null) {

        super(message);

        this.name = "RuntimeError";

        this.code = code;

        this.status = status;

        this.details = details;

        Error.captureStackTrace?.(this, RuntimeError);

    }

}

/**
 * --------------------------------------------------------------------------
 * Factory Methods
 * --------------------------------------------------------------------------
 */

RuntimeError.invalidEvent = (event) =>
    new RuntimeError(
        "RUNTIME_INVALID_EVENT",
        `Unsupported runtime event: ${event}`,
        400
    );

RuntimeError.invalidState = (state) =>
    new RuntimeError(
        "RUNTIME_INVALID_STATE",
        `Unsupported runtime state: ${state}`,
        400
    );

RuntimeError.invalidPayload = () =>
    new RuntimeError(
        "RUNTIME_INVALID_PAYLOAD",
        "Invalid runtime payload.",
        400
    );

RuntimeError.invalidInstallationUuid = () =>
    new RuntimeError(
        "RUNTIME_INVALID_INSTALLATION_UUID",
        "Installation UUID is missing or invalid.",
        400
    );

RuntimeError.databaseError = (details = null) =>
    new RuntimeError(
        "RUNTIME_DATABASE_ERROR",
        "Runtime database operation failed.",
        500,
        details
    );

RuntimeError.internal = (details = null) =>
    new RuntimeError(
        "RUNTIME_INTERNAL_ERROR",
        "Unexpected runtime error.",
        500,
        details
    );

module.exports = RuntimeError;