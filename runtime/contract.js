/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Contract
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Defines the public contract shared across the Runtime subsystem.
 *
 * This file contains ONLY immutable definitions:
 *  - Runtime Contract Version
 *  - Runtime Events
 *  - Runtime States
 *  - Runtime Capabilities
 *
 * No business logic belongs here.
 * ============================================================================
 */

"use strict";

/**
 * Runtime Contract Version
 */
const RuntimeContractVersion = "1.0.0";

/**
 * Runtime Lifecycle States
 */
const RuntimeStates = Object.freeze({

    BOOT: "BOOT",

    INSTALLED: "INSTALLED",

    CAN_INSTALL: "CAN_INSTALL",

    MANUAL_INSTALL: "MANUAL_INSTALL",

    UNSUPPORTED: "UNSUPPORTED"

});

/**
 * Runtime Event Types
 */
const RuntimeEvents = Object.freeze({

    RUNTIME_STARTED: "runtime_started",

    STATE_CHANGED: "state_changed",

    INSTALL_PROMPT_AVAILABLE: "install_prompt_available",

    INSTALL_PROMPT_SHOWN: "install_prompt_shown",

    INSTALL_ACCEPTED: "install_accepted",

    INSTALL_DISMISSED: "install_dismissed",

    INSTALLED: "installed",

    RUNTIME_UPDATED: "runtime_updated",

    RUNTIME_ERROR: "runtime_error"

});

/**
 * Runtime Capabilities
 */
const RuntimeCapabilities = Object.freeze({

    SERVICE_WORKER: "service_worker",

    MANIFEST: "manifest",

    INSTALL_PROMPT: "install_prompt",

    STANDALONE_MODE: "standalone_mode",

    PUSH_NOTIFICATIONS: "push_notifications",

    NOTIFICATIONS: "notifications"

});

module.exports = {

    RuntimeContractVersion,

    RuntimeStates,

    RuntimeEvents,

    RuntimeCapabilities

};