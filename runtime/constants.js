/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Constants
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Internal Runtime configuration values.
 *
 * This file contains ONLY backend internal constants.
 * It is NOT part of the public Runtime Contract.
 * ============================================================================
 */

"use strict";

/**
 * Runtime Version
 */
const RuntimeVersion = "1.2.0";

/**
 * Runtime Log Levels
 */
const RuntimeLogLevels = Object.freeze({

    INFO: "info",

    WARNING: "warning",

    ERROR: "error"

});

/**
 * Runtime Event Limits
 */
const RuntimeLimits = Object.freeze({

    MAX_DETAILS_SIZE: 10000,

    MAX_USER_AGENT_LENGTH: 1000,

    MAX_EVENT_NAME_LENGTH: 50

});

/**
 * Runtime Defaults
 */
const RuntimeDefaults = Object.freeze({

    UNKNOWN_BROWSER: "Unknown",

    UNKNOWN_PLATFORM: "Unknown",

    UNKNOWN_DEVICE: "Unknown",

    UNKNOWN_VERSION: "Unknown"

});

module.exports = {

    RuntimeVersion,

    RuntimeLogLevels,

    RuntimeLimits,

    RuntimeDefaults

};