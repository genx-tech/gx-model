const { _, eachAsync_ } = require('rk-utils');
const { throwIfFileNotExist, getSchemaConnectors, importDataFiles } = require('../utils/helpers');

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
    app.log('verbose', 'geml migrate');

    throwIfFileNotExist("modelPath", context.modelPath);
    throwIfFileNotExist("scriptPath", context.scriptPath);

    let schemaToConnector = getSchemaConnectors(app, context.schemas);

    let reset = app.option('reset');

    if (reset) {
        await eachAsync_(Object.keys(context.schemas).reverse(), async (schemaName) => {
            const connector = schemaToConnector[schemaName];
    
            const Migrator = require(`../migration/${connector.driver}`);
            const migrator = new Migrator(app, context, schemaName, connector);

            await migrator.reset_();    
        });
    }

    return eachAsync_(context.schemas, async (schemaConfig, schemaName) => {
        const connector = schemaToConnector[schemaName];
        const Migrator = require(`../migration/${connector.driver}`);
        const migrator = new Migrator(app, context, schemaName, connector);

        await migrator.create_(schemaConfig.extraOptions);      

        await importDataFiles(migrator, '_init');  
    });
};
