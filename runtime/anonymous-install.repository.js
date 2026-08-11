/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Anonymous Installation Repository
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * ----------------------------------------------------------------------------
 * Handles database operations for anonymous PWA installations.
 *
 * Responsibilities:
 *
 * - Read anonymous installation data
 * - Insert anonymous installation data
 * - Update anonymous installation data
 *
 * No tenant data.
 * No business logic.
 * No validation.
 * ============================================================================
 */

"use strict";

const db = require("../db");

const RuntimeError = require("./errors");

class AnonymousInstallRepository {

    /**
     * Find anonymous installation by UUID
     */
    static async findInstallationByUuid(installationUuid) {

        const query = `
            SELECT *
            FROM pwa_anonymous_installations
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
     * Create or update anonymous installation
     */
    static async upsertInstallation(installation) {

        const {

            installationUuid,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            confirmationMethod,

            lastIp,
            lastUserAgent

        } = installation;

        const query = `
            INSERT INTO pwa_anonymous_installations (

                installation_uuid,

                runtime_version,

                platform,
                device_type,
                device_name,
                os_version,

                browser,
                browser_version,

                standalone,

                confirmation_method,

                first_seen,
                last_seen,
                installed_at,

                last_ip,
                last_user_agent

            )
            VALUES (

                $1,

                $2,

                $3,
                $4,
                $5,
                $6,

                $7,
                $8,

                $9,

                $10,

                NOW(),
                NOW(),
                NOW(),

                $11,
                $12

            )

            ON CONFLICT (installation_uuid)
            DO UPDATE SET

                runtime_version = EXCLUDED.runtime_version,

                platform = EXCLUDED.platform,
                device_type = EXCLUDED.device_type,
                device_name = EXCLUDED.device_name,
                os_version = EXCLUDED.os_version,

                browser = EXCLUDED.browser,
                browser_version = EXCLUDED.browser_version,

                standalone = EXCLUDED.standalone,

                confirmation_method = EXCLUDED.confirmation_method,

                last_seen = NOW(),

                last_ip = EXCLUDED.last_ip,
                last_user_agent = EXCLUDED.last_user_agent,

                updated_at = NOW()

            RETURNING *;
        `;

        const values = [

            installationUuid,

            runtimeVersion,

            platform,
            deviceType,
            deviceName,
            osVersion,

            browser,
            browserVersion,

            standalone,

            confirmationMethod,

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

}

module.exports = AnonymousInstallRepository;