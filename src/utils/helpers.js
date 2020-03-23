const path = require('path');
const { _, fs, eachAsync_ } = require('rk-utils');

exports.throwIfFileNotExist = (name, filePath) => {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Path [${name}="${filePath}"] not exist.`);
    }
}

exports.getSchemaConnectors = (app, schemas) => _.mapValues(schemas, (schemaConfig, name) => {
    let connector = app.getService(schemaConfig.dataSource);
    if (!connector) {
        throw new Error(`Connector service not found for data source [${schemaConfig.dataSource}] of schmea "${name}".`);
    } 
    return connector;
});

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

exports.importDataFiles = async function (migrator, folderName) {
    let dataSetPath = path.join(migrator.dbScriptPath, 'data', folderName);
    let dataListFile = path.join(dataSetPath, 'index.list');

    let runtimeDataSetPath, stageDataSetFile, imported = false;    

    if (process.env.STAGE_ENV) {
        runtimeDataSetPath = path.join(dataSetPath, process.env.STAGE_ENV);        
        stageDataSetFile = path.join(runtimeDataSetPath, 'index.list');
    }    

    if (fs.existsSync(dataListFile)) {
        await importDataFilesByList(migrator, dataSetPath, dataListFile);      
        imported = true;  
    } else {
        migrator.app.log('warn', `Dataset index file "${dataListFile}" not exist.`)
    }
    
    if (stageDataSetFile && fs.existsSync(stageDataSetFile)) {
        await importDataFilesByList(migrator, runtimeDataSetPath, stageDataSetFile);    
        imported = true;      
    } else if (process.env.STAGE_ENV) {
        migrator.app.log(imported ? 'info' : 'warn', `Dataset index file of "${process.env.STAGE_ENV}" stage env "${stageDataSetFile}" not exist.`)
    }
    
    if (!imported) {
        throw new Error(`Entry file of dataset "${folderName}" not found.`);
    }    
 }