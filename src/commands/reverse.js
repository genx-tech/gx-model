const path = require('path');
const { _, eachAsync_ } = require('rk-utils');
const { throwIfFileNotExist, getSchemaConnectors, getDateNamedDir } = require('../utils/helpers');

/**
 * Build database scripts and entity models from oolong files.
 * @param {ServiceContainer} app
 * @param {object} context 
 * @property {string} context.gemlPath
 * @property {string} context.modelPath         
 * @property {string} context.scriptPath
 * @property {string} context.manifestPath
 * @property {bool} context.useJsonSource
 * @property {bool} context.saveIntermediate
 * @property {object} context.schemas   
 * @returns {Promise}
 */
module.exports = async (app, context) => {
    app.log('verbose', 'geml reverse');

    let schemaName = app.option('schema');
    let override = app.option('override');

    let schemaToConnector = getSchemaConnectors(app, context.schemas);
    let connector = schemaToConnector[schemaName];

    let basePath = path.join(context.manifestPath, 'reverse');

    let reverseOutput = getDateNamedDir(basePath, undefined, override);   

    const ReserveEngineering = require(`../modeler/database/${connector.driver}/ReverseEngineering`);
    let modeler = new ReserveEngineering(app, connector);

    await modeler.reverse_(reverseOutput);
};
