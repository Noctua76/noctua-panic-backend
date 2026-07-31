/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * State Handler
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Handles Runtime state transitions.
 *
 * Responsibilities:
 *  - Process Runtime state changes
 *
 * No validation.
 * No HTTP.
 * ============================================================================
 */

"use strict";

class StateHandler {

    /**
     * Process Runtime state transition
     */
    static async processStateTransition(runtimeState) {

        return {

            previousState: runtimeState.previousState,

            newState: runtimeState.newState

        };

    }

}

module.exports = StateHandler;