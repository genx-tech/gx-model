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
                'dataSource',
                'env'
            ]
        });

        this.container.replaceLogger(this.app.logger);

        await this.container.start_();

        this.app.once('stopping', stopper => {
            stopper.push((async () => {                
                await this.container.stop_();
            })());
        });

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
            'manifestPath': { type: 'text', default: 'manifests' },
            'useJsonSource': { type: 'boolean', default: false },
            'saveIntermediate': { type: 'boolean', default: false }
        });

        this.container.options.modelPath = modelPath;
        
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

        if (!_.isEmpty(gemlConfig.schemas)) {            
            const { load_: useDb } = require('@genx/app/lib/features/useDb');
            await useDb(this.container, gemlConfig.schemas);
        }

        let cmdMethod_ = require('./commands/' + command);        

        try {
            await cmdMethod_(this.container, gemlConfig);
        } catch (error) {
            dev: {
                throw error;
            }

            this.app.logError(error);
            process.exit(1);
        }        
    }
}

module.exports = AppInitiator;