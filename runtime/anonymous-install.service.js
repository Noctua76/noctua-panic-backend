/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Anonymous Installation Service
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * ----------------------------------------------------------------------------
 * Processes confirmed anonymous PWA installations.
 *
 * Responsibilities:
 *
 * - Validate anonymous installation requests
 * - Normalize installation data
 * - Coordinate anonymous installation persistence
 *
 * No tenant data.
 * No SQL.
 * No HTTP.
 * ============================================================================
 */

"use strict";

const AnonymousInstallRepository =
    require("./anonymous-install.repository");

const RuntimeError = require("./errors");

const CONFIRMATION_METHODS = new Set([
    "appinstalled",
    "standalone_launch"
]);

class AnonymousInstallService {

    /**
     * Process confirmed anonymous installation
     */
    static async processInstallation(installationRequest) {

        if (
            !installationRequest ||
            typeof installationRequest !== "object" ||
            Array.isArray(installationRequest)
        ) {
            throw RuntimeError.invalidPayload();
        }

        const installationUuid =
            this.validateInstallationUuid(
                installationRequest.installationUuid
            );

        const runtimeVersion =
            this.validateRequiredString(
                installationRequest.runtimeVersion,
                20
            );

        const platform =
            this.validateRequiredString(
                installationRequest.platform,
                50
            );

        const deviceType =
            this.validateRequiredString(
                installationRequest.deviceType,
                20
            );

        const deviceName =
            this.validateOptionalString(
                installationRequest.deviceName,
                100
            );

        const osVersion =
            this.validateOptionalString(
                installationRequest.osVersion,
                30
            );

        const browser =
            this.validateRequiredString(
                installationRequest.browser,
                50
            );

        const browserVersion =
            this.validateOptionalString(
                installationRequest.browserVersion,
                30
            );

        const standalone =
            this.validateBoolean(
                installationRequest.standalone
            );

        const confirmationMethod =
            this.validateConfirmationMethod(
                installationRequest.confirmationMethod
            );

        if (
            confirmationMethod === "standalone_launch" &&
            standalone !== true
        ) {
            throw RuntimeError.invalidPayload();
        }

        const lastIp =
            this.validateOptionalString(
                installationRequest.lastIp,
                45
            );

        const lastUserAgent =
            this.validateOptionalText(
                installationRequest.lastUserAgent
            );

        const installation =
            await AnonymousInstallRepository.upsertInstallation({

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

            });

        return {
            installation
        };

    }

    /**
     * Validate installation UUID
     */
    static validateInstallationUuid(value) {

        if (
            typeof value !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                value.trim()
            )
        ) {
            throw RuntimeError.invalidInstallationUuid();
        }

        return value.trim().toLowerCase();

    }

    /**
     * Validate required string
     */
    static validateRequiredString(value, maxLength) {

        if (
            typeof value !== "string" ||
            value.trim().length === 0 ||
            value.trim().length > maxLength
        ) {
            throw RuntimeError.invalidPayload();
        }

        return value.trim();

    }

    /**
     * Validate optional string
     */
    static validateOptionalString(value, maxLength) {

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        if (
            typeof value !== "string" ||
            value.trim().length > maxLength
        ) {
            throw RuntimeError.invalidPayload();
        }

        return value.trim() || null;

    }

    /**
     * Validate optional text
     */
    static validateOptionalText(value) {

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        if (typeof value !== "string") {
            throw RuntimeError.invalidPayload();
        }

        return value.trim() || null;

    }

    /**
     * Validate boolean
     */
    static validateBoolean(value) {

        if (typeof value !== "boolean") {
            throw RuntimeError.invalidPayload();
        }

        return value;

    }

    /**
     * Validate confirmation method
     */
    static validateConfirmationMethod(value) {

        if (
            typeof value !== "string" ||
            !CONFIRMATION_METHODS.has(value)
        ) {
            throw RuntimeError.invalidPayload();
        }

        return value;

    }

}

module.exports = AnonymousInstallService;