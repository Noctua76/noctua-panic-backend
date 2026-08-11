/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Anonymous Installation Routes
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * ----------------------------------------------------------------------------
 * HTTP entry point for confirmed anonymous PWA installations.
 *
 * Responsibilities:
 *
 * - Receive installation confirmations before login
 * - Attach server-derived request metadata
 * - Delegate processing to AnonymousInstallService
 * - Return HTTP responses
 *
 * No authentication.
 * No tenant data.
 * No SQL.
 * ============================================================================
 */

"use strict";

const express = require("express");

const AnonymousInstallService =
    require("./anonymous-install.service");

function createAnonymousInstallRouter() {

    const router = express.Router();

    router.post(
        "/",
        async (req, res, next) => {

            try {

                const installationRequest = {

                    ...req.body,

                    lastIp:
                        req.get("X-Real-IP") ||
                        req.ip,

                    lastUserAgent:
                        req.get("User-Agent") ||
                        null

                };

                const result =
                    await AnonymousInstallService.processInstallation(
                        installationRequest
                    );

                return res.status(200).json({

                    success: true,

                    data: result

                });

            }
            catch (error) {

                next(error);

            }

        }
    );

    return router;

}

module.exports = createAnonymousInstallRouter;