"use strict";

const path = require('path');

const Util = require('rk-utils');
const { _, fs, eachAsync_ } = Util;

const Linker = require('./Linker');
const { Connector, Validators } = require('@genx/data');

/**
 * Oolong DSL api
 * @module Oolong
 */

 function createConnector(context, schemaName) {
    let deployment = context.schemaDeployment[schemaName];

    if (!deployment) {
        throw new Error(`Schema "${schemaName}" has no configured deployment and is ignored in modeling.`);
    }

    let { dataSource, connectionString, options } = deployment;
    let [ driver ] = dataSource.split('.');

    return Connector.createConnector(driver, connectionString, { logger: context.logger, ...options });       
 }

 async function importDataFilesByList(migrator, dataSetPath, dataListFile) {
    let dataList = fs.readFileSync(dataListFile).toString().match(/^.+$/gm);

    if (!dataList) {
        return;
    }

    return eachAsync_(dataList, async line => {
        line = line.trim();

        if (line.length > 0 && line[0] !== '#') {            
            let dataFile = path.join(dataSetPath, line);
            if (!fs.existsSync(dataFile)) {
                throw new Error(`Data file "${dataFile}" not found.`);
            }

            await migrator.load_(dataFile);
        }
    }); 
 }

 async function importDataFiles(migrator, folderName) {
    let dataSetPath = path.join(migrator.dbScriptPath, 'data', folderName);
    let dataListFile = path.join(dataSetPath, 'index.list');

    let runtimeDataSetPath, runtimeDataSetFile, imported = false;    

    if (migrator.appModule.runtimeEnv) {
        runtimeDataSetPath = path.join(dataSetPath, migrator.appModule.runtimeEnv);        
        runtimeDataSetFile = path.join(runtimeDataSetPath, 'index.list');
    }    

    if (fs.existsSync(dataListFile)) {
        await importDataFilesByList(migrator, dataSetPath, dataListFile);      
        imported = true;  
    } else {
        migrator.appModule.log('warn', `Dataset index file "${dataListFile}" not exist.`)
    }
    
    if (runtimeDataSetFile && fs.existsSync(runtimeDataSetFile)) {
        await importDataFilesByList(migrator, runtimeDataSetPath, runtimeDataSetFile);    
        imported = true;      
    } else if (migrator.appModule.runtimeEnv) {
        migrator.appModule.log(imported ? 'info' : 'warn', `Dataset index file of "${migrator.appModule.runtimeEnv}" env "${runtimeDataSetFile}" not exist.`)
    }
    
    if (!imported) {
        throw new Error(`Entry file of dataset "${folderName}" not found.`);
    }    
 }



/**
 * Deploy database scripts into database.
 * @param {object} context
 * @property {Logger} context.logger - Logger object
 * @property {string} context.modelPath
 * @property {string} context.dslSourcePath 
 * @property {string} context.scriptSourcePath 
 * @property {object} context.schemaDeployment   
 * @param {bool} reset
 * @returns {Promise}
 */
exports.migrate_ = async (context, reset = false) => {
    context.logger.log('verbose', 'Start deploying models ...');

    if (reset) {
        await eachAsync_(Object.keys(context.schemaDeployment).reverse(), async (schemaName) => {
            let connector = createConnector(context, schemaName);
            assert: connector;
    
            try {
                let Migration = require(`../migration/${connector.driver}`);
                let migration = new Migration(context, schemaName, connector);
    
                await migration.reset_();    
            } catch (error) {
                throw error;
            } finally {
                await connector.end_();
            } 
        });
    }

    return eachAsync_(context.schemaDeployment, async (deployment, schemaName) => {
        let connector = createConnector(context, schemaName);
        assert: connector;

        try {
            let Migration = require(`../migration/${connector.driver}`);
            let migration = new Migration(context, schemaName, connector);

            await migration.create_(deployment.extraOptions);      

            await importDataFiles(migration, '_init');  
        } catch (error) {
            throw error;
        } finally {
            await connector.end_();
        } 
    });
};

/**
 * @param {object} context
 * @param {string} schemaName
 */
exports.dataset_ = async (context, schemaName) => {
    let connector = createConnector(context, schemaName);
    assert: connector;
    
    let dataSetPath = path.join(context.scriptSourcePath, connector.driver, connector.database, 'data');

    if (!fs.existsSync(dataSetPath)) {
        return [];
    } else {
        let dataSets = fs.readdirSync(dataSetPath);
        let validDs = [];
        dataSets.forEach(ds => {
            let indexFile = path.join(dataSetPath, ds, 'index.list');
            if (fs.existsSync(indexFile)) {
                validDs.push(ds);
            }
        });

        return validDs;
    }
}

/**
 * Import a data set into database
 * @param {object} context
 * @property {Logger} context.logger - Logger object
 * @property {string} context.scriptSourcePath  
 * @param {string} schemaName
 * @param {string} datasetName
 * @returns {Promise}
 */
exports.import_ = async (context, schemaName, datasetName) => {
    let connector = createConnector(context, schemaName);
    assert: connector;
    
    try {
        let Migration = require(`../migration/${connector.driver}`);
        let migration = new Migration(context, schemaName, connector);

        await importDataFiles(migration, datasetName);            
    } catch (error) {
        throw error;
    } finally {
        await connector.end_();
    } 
};

/**
 * Extract database structure into oolong dsl
 * @param {object} context
 * @property {Connector} context.connector
 * @property {Logger} context.logger 
 * @property {string} context.dslReverseOutputPath 
 * @property {string} context.driver
 * @property {object} context.connOptions 
 * @returns {Promise}
 */
exports.reverse_ = async (context) => {   
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
    } 
};

exports.getValidatorList = () => {
    return Object.keys(Validators);    
}