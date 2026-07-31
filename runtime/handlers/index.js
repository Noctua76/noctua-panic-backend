/**
 * ============================================================================
 * Aegis Link PWA Runtime
 * Handlers Index
 * ----------------------------------------------------------------------------
 * Version : 1.0.0
 *
 * Purpose
 * --------
 * Public entry point for all Runtime handlers.
 * ============================================================================
 */

"use strict";

const InstallationHandler = require("./installation.handler");
const StateHandler = require("./state.handler");
const LogHandler = require("./log.handler");

module.exports = {

    InstallationHandler,

    StateHandler,

    LogHandler

};