/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Log Handler
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Handles Runtime event logging.
 *
 * Responsibilities:
 *  - Persist Runtime events
 *  - Maintain audit trail
 *
 * No validation.
 * No HTTP.
 * ============================================================================
 */

"use strict";

const RuntimeRepository = require("../repository");

class LogHandler {

    /**
     * Store Runtime event
     */
    static async writeRuntimeLog(runtimeLog) {

        return RuntimeRepository.insertRuntimeLog(
            runtimeLog
        );

    }

}

module.exports = LogHandler;