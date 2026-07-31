/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Routes
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * HTTP entry point for the Runtime subsystem.
 *
 * Responsibilities:
 *  - Receive authenticated Runtime requests
 *  - Enforce tenant isolation
 *  - Delegate processing to RuntimeService
 *  - Return HTTP responses
 * ============================================================================
 */

"use strict";

const express = require("express");

const RuntimeService = require("./service");

function createRuntimeRouter({ requireGuardAuth }) {

    if (typeof requireGuardAuth !== "function") {

        throw new TypeError(
            "Runtime routes require a valid requireGuardAuth middleware"
        );

    }

    const router = express.Router();

    router.post(
        "/",
        requireGuardAuth,
        async (req, res, next) => {

            try {

                const runtimeRequest = {

                    ...req.body,

                    companyId: req.guard.company_id,

                    guardId: req.guard.guard_id,

                    sessionId: req.guard.session_id,

                    siteId: req.guard.site_id,

                    ip: req.ip,

                    userAgent: req.get("User-Agent")

                };

                const result =
                    await RuntimeService.processRuntime(runtimeRequest);

                return res.status(200).json({

                    success: true,

                    data: result

                });

            } catch (error) {

                next(error);

            }

        }
    );

    return router;

}

module.exports = createRuntimeRouter;