/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Validator
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Validates all incoming Runtime requests.
 *
 * Responsibilities:
 *  - Validate Runtime Events
 *  - Validate Runtime States
 *  - Validate Installation UUID
 *  - Validate Runtime Version
 *  - Validate Payload
 *
 * No business logic.
 * No database access.
 * ============================================================================
 */

"use strict";

const RuntimeError = require("./errors");

const {

    RuntimeEvents,

    RuntimeStates

} = require("./contract");

class RuntimeValidator {

    /**
     * Validate complete Runtime request
     */
    static validateRuntimeRequest(payload) {

        RuntimeValidator.validatePayload(payload);

        RuntimeValidator.validateInstallationUuid(payload.installationUuid);

        RuntimeValidator.validateRuntimeVersion(payload.runtimeVersion);

        RuntimeValidator.validateEvent(payload.event);

        RuntimeValidator.validateState(payload.state);

    }

    /**
     * Validate payload existence
     */
    static validatePayload(payload) {

        if (!payload || typeof payload !== "object") {

            throw RuntimeError.invalidPayload();

        }

    }

    /**
     * Validate Installation UUID
     */
    static validateInstallationUuid(uuid) {

        if (!uuid || typeof uuid !== "string") {

            throw RuntimeError.invalidInstallationUuid();

        }

    }

    /**
     * Validate Runtime Version
     */
    static validateRuntimeVersion(version) {

        if (!version || typeof version !== "string") {

            throw RuntimeError.invalidPayload();

        }

    }

    /**
     * Validate Runtime Event
     */
    static validateEvent(event) {

        if (!Object.values(RuntimeEvents).includes(event)) {

            throw RuntimeError.invalidEvent(event);

        }

    }

    /**
     * Validate Runtime State
     */
    static validateState(state) {

        if (!Object.values(RuntimeStates).includes(state)) {

            throw RuntimeError.invalidState(state);

        }

    }

}

module.exports = RuntimeValidator;