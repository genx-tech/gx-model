const path = require('path');
const { fs, _ } = require('rk-utils');
const { ServiceContainer } = require('@genx/app');
const { Validators: { validateObjectBySchema } } = require('@genx/data')

class AppInitiator {
    constructor(context) {
        this.app = context.app;
        this.cwd = context.cwd;
    }

    async run(command) {        
        let configFile = this.app.commandLine.option('config') || 'geml.json';                
        let configFullPath = path.resolve(this.cwd, configFile);

        if (!(fs.existsSync(configFullPath))) {
            throw new Error(`Config "${configFile}" not found!`);
        }

        let extName = path.extname(configFullPath);
        if (extName !== '.json') {
            throw new Error('Only supports JSON config.');
        }

        let configName = path.basename(configFullPath, extName);
        let configPath = path.dirname(configFullPath);
        let envAware = false;

        if (configName.endsWith('.default')) {
            envAware = true;
            configName = configName.substr(0, configName.length - 8);
        }

        this.container = new ServiceContainer('GemlCore', {
            workingPath: this.cwd,
            configPath,
            configName,            
            disableEnvAwareConfig: !envAware,
            allowedFeatures: [
                'configByHostname',                    
                'devConfigByGitUser',                
                'appLogger',
                'loggers',               
                'settings',
                'timezone',
                'version',                
                'dataSource'
            ]
        });

        this.container.replaceLogger(this.app.logger);

        await this.container.start_();

        this.container.option = (name) => {
            return this.app.commandLine.option(name);
        };

        let config = this.container.settings.geml;
        if (_.isEmpty(config)) {
            throw new Error('Empty geml config!');
        }

        let { 
            gemlPath, 
            modelPath, 
            scriptPath,
            manifestPath,
            useJsonSource,
            saveIntermediate 
        } = validateObjectBySchema(config, {
            'gemlPath': { type: 'text', default: 'geml' },
            'modelPath': { type: 'text', default: 'src/models' },
            'scriptPath': { type: 'text', default: 'src/scripts' },
            'manifestPath': { type: 'text', default: 'manifest' },
            'useJsonSource': { type: 'boolean', default: false },
            'saveIntermediate': { type: 'boolean', default: false }
        });
        
        gemlPath = this.container.toAbsolutePath(gemlPath);    
        modelPath = this.container.toAbsolutePath(modelPath);
        scriptPath = this.container.toAbsolutePath(scriptPath);
        manifestPath = this.container.toAbsolutePath(manifestPath);
        
        let gemlConfig = { 
            ...config,
            gemlPath, 
            modelPath, 
            scriptPath,
            manifestPath,
            useJsonSource,
            saveIntermediate  
        };

        let cmdMethod_ = require('./commands/' + command);        
        await cmdMethod_(this.container, gemlConfig);
    }
}

module.exports = AppInitiator;



/*
exports.migrate = async (core) => {
    core.app.log('verbose', 'oolong migrate');

    let oolongConfig = core.oolongConfig;

    let modelDir  = Util.getValueByPath(oolongConfig, 'oolong.modelDir');
    if (!modelDir) {
        throw new Error('"oolong.modelDir" not found in oolong config.');
    }

    let gemlSourceDir = Util.getValueByPath(oolongConfig, 'oolong.gemlSourceDir');
    if (!gemlSourceDir) {
        throw new Error('"oolong.gemlSourceDir" not found in oolong config.');
    }

    let scriptSourceDir = Util.getValueByPath(oolongConfig, 'oolong.scriptSourceDir');
    if (!scriptSourceDir) {
        throw new Error('"oolong.scriptSourceDir" not found in oolong config.');
    }

    let modelPath = core.app.toAbsolutePath(modelDir);    
    let dslSourcePath = core.app.toAbsolutePath(gemlSourceDir);    
    let scriptSourcePath = core.app.toAbsolutePath(scriptSourceDir);

    if (!fs.existsSync(modelPath)) {
        return Promise.reject(`Model directory "${modelPath}" not found.`);
    }

    if (!fs.existsSync(dslSourcePath)) {
        return Promise.reject(`DSL source directory "${dslSourcePath}" not found.`);
    }

    if (!fs.existsSync(scriptSourcePath)) {
        return Promise.reject(`Database scripts directory "${scriptSourcePath}" not found.`);
    }

    let useJsonSource = Util.getValueByPath(oolongConfig, 'oolong.useJsonSource', false);

    return core.api.migrate_({
        appModule: core.container,
        logger: core.app.logger,
        modelPath,
        dslSourcePath,        
        scriptSourcePath,
        useJsonSource,
        schemaDeployment: core.schemaDeployment
    }, core.option('reset'));
};

exports.dataset = async (core) => {
    core.app.log('verbose', 'oolong dataset');

    let dataset = await core.getDataset_();
    
    core.app.log('info', 'Available dataset: \n' + dataset.join('\n') + '\n');
}

exports.import = async (core) => {
    core.app.log('verbose', 'oolong import');

    let oolongConfig = core.oolongConfig;

    let modelDir  = Util.getValueByPath(oolongConfig, 'oolong.modelDir');
    if (!modelDir) {
        throw new Error('"oolong.modelDir" not found in oolong config.');
    }

    let scriptSourceDir = Util.getValueByPath(oolongConfig, 'oolong.scriptSourceDir');
    if (!scriptSourceDir) {
        throw new Error('"oolong.scriptSourceDir" not found in oolong config.');
    }
    
    let modelPath = core.app.toAbsolutePath(modelDir);    
    let scriptSourcePath = core.app.toAbsolutePath(scriptSourceDir);

    let schema = core.option('schema');    
    let dataset = core.option('dataset');    

    return core.api.import_({
        logger: core.app.logger,        
        modelPath,
        scriptSourcePath,        
        schemaDeployment: core.schemaDeployment
    }, schema, dataset);
}

exports.reverse = async (core) => {
    core.app.log('verbose', 'oolong reverse');

    let oolongConfig = core.oolongConfig;

    let dslReverseOutputDir = Util.getValueByPath(oolongConfig, 'oolong.dslReverseOutputDir');
    if (!dslReverseOutputDir) {
        throw new Error('"oolong.dslReverseOutputDir" not found in oolong config.');
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

    return core.api.reverse_({ 
        logger: core.app.logger,
        dslReverseOutputPath: outputDir,
        driver,
        connOptions
    });
};

exports.export = async (core) => {
    core.app.log('verbose', 'oolong reverse');

    let oolongConfig = core.oolongConfig;

    let dataExportDir = Util.getValueByPath(oolongConfig, 'oolong.dataExportDir');
    if (!dataExportDir) {
        throw new Error('"oolong.dataExportDir" not found in oolong config.');
    }

    let outputDir = core.app.toAbsolutePath(dataExportDir);

    //todo: relocation, and deep copy connection options
    let conn = core.option('conn');
    let [ driver ] = extractDriverAndConnectorName(conn);
    let connOptions = Util.getValueByPath(oolongConfig, 'dataSource.' + conn);
    assert: connOptions;    

    if (typeof connOptions.reverseRules === 'string') {
        connOptions.reverseRules = require(core.app.toAbsolutePath(connOptions.reverseRules));
    } 

    assert: !connOptions.reverseRules || _.isPlainObject(connOptions.reverseRules);

    return core.api.reverse_({ 
        logger: core.app.logger,
        dslReverseOutputPath: outputDir,
        driver,
        connOptions
    });
};

exports.listValidators = async (core) => {
    core.app.log('verbose', 'oolong listValidators');

    let list = core.api.getValidatorList();

    core.app.log('info', 'Available validators: \n' + list.join('\n') + '\n');
}*/