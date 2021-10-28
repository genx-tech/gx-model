const path = require("path");
const { _ } = require("@genx/july");
const { fs } = require("@genx/sys");
const { ServiceContainer } = require("@genx/app");
const {
    Validators: { validateObjectBySchema },
} = require("@genx/data");

class AppInitiator {
    constructor(context) {
        this.app = context.app;
        this.cwd = context.cwd;
    }

    async run(command) {
        let gemlConfig;

        if (command !== "init") {
            let configFile = this.app.commandLine.option("config");
            let configFullPath;

            if (configFile) {
                configFullPath = path.resolve(this.cwd, configFile);

                if (!fs.existsSync(configFullPath)) {
                    throw new Error(`Config "${configFile}" not found!`);
                }
            } else {
                configFullPath = path.resolve(this.cwd, 'conf/app.default.json');

                if (!fs.existsSync(configFullPath)) {
                    configFullPath = path.resolve(this.cwd, 'conf/server.default.json');
                    if (!fs.existsSync(configFullPath)) {
                        throw new Error('Either "conf/app.default.json" or "conf/server.default.json" not found.');
                    }
                }
            }
            

            let extName = path.extname(configFullPath);
            if (extName !== ".json") {
                throw new Error("Only supports JSON config.");
            }

            let configName = path.basename(configFullPath, extName);
            let configPath = path.dirname(configFullPath);
            let envAware = false;

            if (configName.endsWith(".default")) {
                envAware = true;
                configName = configName.substr(0, configName.length - 8);
            }

            this.container = new ServiceContainer(this.app.name, {
                workingPath: this.cwd,
                configPath,
                configName,
                disableEnvAwareConfig: !envAware,
                allowedFeatures: [
                    "configByHostname",
                    "devConfigByGitUser",
                    "appLogger",
                    "loggers",
                    "settings",
                    "timezone",
                    "version",
                    "dataSource",
                    "env",
                ],
            });

            this.container.replaceLogger(this.app.logger);

            await this.container.start_();

            this.app.once("stopping", (stopper) => {
                stopper.push(
                    (async () => {
                        await this.container.stop_();
                    })()
                );
            });

            this.container.option = (name) => {
                return this.app.commandLine.option(name);
            };

            let config = this.container.settings.geml;
            if (_.isEmpty(config)) {
                throw new Error("Empty geml config!");
            }

            let { gemlPath, modelPath, scriptPath, manifestPath, useJsonSource, saveIntermediate } =
                validateObjectBySchema(config, {
                    gemlPath: { type: "text", default: "geml" },
                    modelPath: { type: "text", default: "src/models" },
                    scriptPath: { type: "text", default: "src/scripts" },
                    manifestPath: { type: "text", optional: true },
                    useJsonSource: { type: "boolean", optional: true, default: false },
                    saveIntermediate: { type: "boolean", optional: true, default: false },
                });

            this.container.options.modelPath = modelPath;

            gemlPath = this.container.toAbsolutePath(gemlPath);
            modelPath = this.container.toAbsolutePath(modelPath);
            scriptPath = this.container.toAbsolutePath(scriptPath);
            manifestPath = this.container.toAbsolutePath(manifestPath);

            gemlConfig = {                
                ...config,
                gemlPath,
                modelPath,
                scriptPath,
                manifestPath,
                useJsonSource,
                saveIntermediate,
                configFullPath
            };

            if (!_.isEmpty(gemlConfig.schemas)) {
                const { load_: useDb } = require("@genx/app/lib/features/useDb");
                await useDb(this.container, gemlConfig.schemas);
            }
        } else {
            this.container = this.app;
        }

        let cmdMethod_ = require("./commands/" + command);

        try {
            await cmdMethod_(this.container, gemlConfig);
        } catch (error) {
            throw error;
            //this.app.log('error', error.message);
            process.exit(1);
        }
    }
}

module.exports = AppInitiator;
