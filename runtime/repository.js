/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Runtime Repository
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Handles all Runtime database operations.
 *
 * Responsibilities:
 *  - Read Runtime data
 *  - Insert Runtime data
 *  - Update Runtime data
 *
 * No business logic.
 * No validation.
 * ============================================================================
 */

"use strict";

const db = require("../db");

const RuntimeError = require("./errors");

class RuntimeRepository {

    /**
     * Find installation by UUID
     */
    static async findInstallationByUuid(installationUuid) {

        const query = `
            SELECT *
            FROM pwa_installations
            WHERE installation_uuid = $1
            LIMIT 1
        `;

        const values = [
            installationUuid
        ];

        try {

            const { rows } = await db.query(query, values);

            return rows[0] || null;

        }
        catch (error) {

            throw RuntimeError.databaseError(error);

        }

    }

        /**
     * Create new installation
     */
    static async createInstallation(installation) {

        const {

            companyId,
            userId,
            installationUuid,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            currentState,

            installPromptSupported,
            manifestSupported,
            serviceWorkerSupported,

            lastIp,
            lastUserAgent

        } = installation;

        const query = `
            INSERT INTO pwa_installations (

                company_id,
                user_id,

                installation_uuid,

                runtime_version,

                platform,
                device_type,
                device_name,
                os_version,

                browser,
                browser_version,

                standalone,

                current_state,

                install_prompt_supported,
                manifest_supported,
                service_worker_supported,

                first_seen,
                last_seen,

                last_ip,
                last_user_agent

            )
            VALUES (

                $1,$2,

                $3,

                $4,

                $5,$6,$7,$8,

                $9,$10,

                $11,

                $12,

                $13,$14,$15,

                NOW(),
                NOW(),

                $16,$17

            )

            RETURNING *;
        `;

        const values = [

            companyId,
            userId,

            installationUuid,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            currentState,

            installPromptSupported,
            manifestSupported,
            serviceWorkerSupported,

            lastIp,
            lastUserAgent

        ];

        try {

            const { rows } = await db.query(query, values);

            return rows[0];

        }
        catch (error) {

            throw RuntimeError.databaseError(error);

        }

    }

        /**
     * Update existing installation
     */
    static async updateInstallation(installation) {

        const {

            id,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            currentState,

            installPromptSupported,
            manifestSupported,
            serviceWorkerSupported,

            lastIp,
            lastUserAgent

        } = installation;

        const query = `
            UPDATE pwa_installations
            SET

                runtime_version = $2,

                platform = $3,
                device_type = $4,
                device_name = $5,
                os_version = $6,

                browser = $7,
                browser_version = $8,

                standalone = $9,

                current_state = $10,

                install_prompt_supported = $11,
                manifest_supported = $12,
                service_worker_supported = $13,

                last_seen = NOW(),

                last_ip = $14,
                last_user_agent = $15,

                updated_at = NOW()

            WHERE id = $1

            RETURNING *;
        `;

        const values = [

            id,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            currentState,

            installPromptSupported,
            manifestSupported,
            serviceWorkerSupported,

            lastIp,
            lastUserAgent

        ];

        try {

            const { rows } = await db.query(query, values);

            return rows[0] || null;

        }
        catch (error) {

            throw RuntimeError.databaseError(error);

        }

    }

        /**
     * Insert Runtime Log
     */
    static async insertRuntimeLog(runtimeLog) {

        const {

            companyId,
            userId,

            installationUuid,

            eventType,

            previousState,
            newState,

            runtimeVersion,

            details

        } = runtimeLog;

        const query = `
            INSERT INTO pwa_runtime_logs (

                company_id,
                user_id,

                installation_uuid,

                event_type,

                previous_state,
                new_state,

                runtime_version,

                details

            )
            VALUES (

                $1,
                $2,

                $3,

                $4,

                $5,
                $6,

                $7,

                $8

            )

            RETURNING *;
        `;

        const values = [

            companyId,
            userId,

            installationUuid,

            eventType,

            previousState,
            newState,

            runtimeVersion,

            details

        ];

        try {

            const { rows } = await db.query(query, values);

            return rows[0];

        }
        catch (error) {

            throw RuntimeError.databaseError(error);

        }

    }

}

module.exports = RuntimeRepository;