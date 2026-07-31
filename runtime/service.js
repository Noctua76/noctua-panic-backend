/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Service
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Orchestrates the Runtime subsystem.
 *
 * Responsibilities:
 *  - Validate Runtime request
 *  - Coordinate Runtime handlers
 *  - Return unified Runtime result
 *
 * No SQL.
 * No HTTP.
 * ============================================================================
 */

"use strict";

const RuntimeValidator = require("./validator");

const Handlers = require("./handlers");

class RuntimeService {

    /**
     * Process Runtime request
     */
    static async processRuntime(runtimeRequest) {

        RuntimeValidator.validateRuntimeRequest(runtimeRequest);

        const installation =
            await Handlers.InstallationHandler.processInstallation(runtimeRequest);

        const state =
            await Handlers.StateHandler.processStateTransition({

                previousState: runtimeRequest.previousState,

                newState: runtimeRequest.state

            });

        const runtimeLog =
            await Handlers.LogHandler.writeRuntimeLog({

                companyId: runtimeRequest.companyId,

                userId: runtimeRequest.userId,

                installationUuid: runtimeRequest.installationUuid,

                eventType: runtimeRequest.event,

                previousState: state.previousState,

                newState: state.newState,

                runtimeVersion: runtimeRequest.runtimeVersion,

                details: runtimeRequest.details || {}

            });

        return {

            installation,

            state,

            runtimeLog

        };

    }

}

module.exports = RuntimeService;