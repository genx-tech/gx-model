const path = require('path');
const { _, fs, eachAsync_ } = require('rk-utils');
const { throwIfFileNotExist, getDateNamedDir } = require('../utils/helpers');

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
 * @property {object} context.export   
 * @returns {Promise}
 */
module.exports = async (app, context) => {
    app.log('verbose', 'geml export');

    throwIfFileNotExist("gemlPath", context.gemlPath);

    let schemaName = app.option('schema');
    let override = app.option('override');

    let db = app.db(schemaName);
    
    let basePath = path.join(context.manifestPath, 'export');

    let exportOutput = getDateNamedDir(basePath, undefined, override);   

    const Migrator = require(`../migration/${db.connector.driver}`);
    const migrator = new Migrator(app, context, db);

    if (!context.export) {
        throw new Error('Config "geml.export" for is required.');
    }

    if (typeof context.export === "string") {
        const exportFilePath = path.resolve(app.options.configPath, context.export);
        context.export = fs.readJsonSync(exportFilePath, "utf8");
    } else if (Array.isArray(context.export)) {
        return eachAsync_(context.export, (exportFile) => {
            const exportFilePath = path.resolve(app.options.configPath, exportFile);
            const exportConfig = fs.readJsonSync(exportFilePath, "utf8");
            return migrator.export_(exportConfig, exportOutput);     
        });
    }

    return migrator.export_(context.export, exportOutput);     
};
