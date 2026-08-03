/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Installation Handler
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Handles installation lifecycle operations.
 *
 * Responsibilities:
 *  - Create new installation
 *  - Update existing installation
 *
 * No validation.
 * No HTTP.
 * ============================================================================
 */

"use strict";

const RuntimeRepository = require("../repository");

class InstallationHandler {

    /**
     * Create or update installation
     */
    static async processInstallation(installation) {

    const existingInstallation =
        await RuntimeRepository.findInstallationByUuid(
            installation.installationUuid
        );

    if (!existingInstallation) {

        const createdInstallation =
            await RuntimeRepository.createInstallation(
                installation
            );

        return {

            installation: createdInstallation,

            previousState:
                installation.previousState || "BOOT"

        };

    }

    const confirmedInstalled =
        existingInstallation.current_state === "INSTALLED" ||
        installation.currentState === "INSTALLED";

    const confirmedStandalone =
        existingInstallation.standalone === true ||
        installation.standalone === true;

    const updatedInstallation =
        await RuntimeRepository.updateInstallation({

            ...installation,

            id: existingInstallation.id,

            currentState: confirmedInstalled
                ? "INSTALLED"
                : installation.currentState,

            standalone: confirmedStandalone

        });

    return {

        installation: updatedInstallation,

        previousState: existingInstallation.current_state

    };

}

}

module.exports = InstallationHandler;