"use strict";

/**
 * Replace the default app logger
 * @module Feature_AppLogger
 */

const { Feature } = require('@genx/app');

module.exports = {

    /**
     * This feature is loaded at plugin stage
     * @member {string}
     */
    type: Feature.PLUGIN,

    /**
     * Load the feature
     * @param {App} app - The cli app module object
     * @param {string} loggerName - The logger name     
     */
    load_: (app, opt) => {
        const cache = app.getService('ttlMemCache');
        if (cache) {
            console.log('value of key:', opt.key);   
        }
    }
};