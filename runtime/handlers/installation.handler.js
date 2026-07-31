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

            return RuntimeRepository.createInstallation(
                installation
            );

        }

        return RuntimeRepository.updateInstallation({

            ...installation,

            id: existingInstallation.id

        });

    }

}

module.exports = InstallationHandler;