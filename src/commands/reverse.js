const { _, eachAsync_ } = require('rk-utils');
const { throwIfFileNotExist, getSchemaConnectors } = require('../utils/helpers');
const Linker = require('../lang/Linker');

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
/*
    let schemaName = app.option('schema');

    let schemaToConnector = getSchemaConnectors(app, context.schemas);

    let connector = schemaToConnector[schemaName];

    let oolongConfig = core.oolongConfig;

    let dslReverseOutputDir = Util.getValueByPath(oolongConfig, 'oolong.dslReverseOutputDir');
    if (!dslReverseOutputDir) {
        throw new Error('"oolong.dslOutputDir" not found in oolong config.');
    }

    let outputDir = core.getReverseOutputDir(core.app.toAbsolutePath(dslReverseOutputDir));

    //todo: relocation, and deep copy connection options
    let conn = core.option('conn');
    let [ driver ] = extractDriverAndConnectorName(conn);
    let connOptions = Util.getValueByPath(oolongConfig, 'dataSource.' + conn);
    assert: connOptions;    

    if (typeof connOptions.reverseRules === 'string') {
        connOptions.reverseRules = require(core.app.toAbsolutePath(connOptions.reverseRules));
    } 

    assert: !connOptions.reverseRules || _.isPlainObject(connOptions.reverseRules);

    let ReserveEngineering = require(`../modeler/database/${context.driver}/ReverseEngineering`);
    
    let { connection: connectionString, ...options } = context.connOptions;  
    let connector = Connector.createConnector(context.driver, connectionString, { logger: context.logger, ...options });     
    assert: connector;  

    try {
        let modeler = new ReserveEngineering(context, connector);

        await modeler.reverse_(context.dslReverseOutputPath);
    } catch (error) {
        throw error;
    } finally {
        await connector.end_();
    } */

};
