"use strict";

require("source-map-support/register");

const path = require('path');

const {
  fs,
  _
} = require('rk-utils');

const {
  ServiceContainer
} = require('@genx/app');

const {
  Validators: {
    validateObjectBySchema
  }
} = require('@genx/data');

class AppInitiator {
  constructor(context) {
    this.app = context.app;
    this.cwd = context.cwd;
  }

  async run(command) {
    let configFile = this.app.commandLine.option('config') || 'geml.json';
    let configFullPath = path.resolve(this.cwd, configFile);

    if (!fs.existsSync(configFullPath)) {
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
      allowedFeatures: ['configByHostname', 'devConfigByGitUser', 'appLogger', 'loggers', 'settings', 'timezone', 'version', 'dataSource', 'env']
    });
    this.container.replaceLogger(this.app.logger);
    await this.container.start_();
    this.app.once('stopping', stopper => {
      stopper.push((async () => {
        await this.container.stop_();
      })());
    });

    this.container.option = name => {
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
      'gemlPath': {
        type: 'text',
        default: 'geml'
      },
      'modelPath': {
        type: 'text',
        default: 'src/models'
      },
      'scriptPath': {
        type: 'text',
        default: 'src/scripts'
      },
      'manifestPath': {
        type: 'text',
        default: 'manifests'
      },
      'useJsonSource': {
        type: 'boolean',
        default: false
      },
      'saveIntermediate': {
        type: 'boolean',
        default: false
      }
    });
    this.container.options.modelPath = modelPath;
    gemlPath = this.container.toAbsolutePath(gemlPath);
    modelPath = this.container.toAbsolutePath(modelPath);
    scriptPath = this.container.toAbsolutePath(scriptPath);
    manifestPath = this.container.toAbsolutePath(manifestPath);
    let gemlConfig = { ...config,
      gemlPath,
      modelPath,
      scriptPath,
      manifestPath,
      useJsonSource,
      saveIntermediate
    };

    if (!_.isEmpty(gemlConfig.schemas)) {
      const {
        load_: useDb
      } = require('@genx/app/lib/features/useDb');

      await useDb(this.container, gemlConfig.schemas);
    }

    let cmdMethod_ = require('./commands/' + command);

    try {
      await cmdMethod_(this.container, gemlConfig);
    } catch (error) {
      throw error;
      this.app.logError(error);
      process.exit(1);
    }
  }

}

module.exports = AppInitiator;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9BcHBJbml0aWF0b3IuanMiXSwibmFtZXMiOlsicGF0aCIsInJlcXVpcmUiLCJmcyIsIl8iLCJTZXJ2aWNlQ29udGFpbmVyIiwiVmFsaWRhdG9ycyIsInZhbGlkYXRlT2JqZWN0QnlTY2hlbWEiLCJBcHBJbml0aWF0b3IiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJhcHAiLCJjd2QiLCJydW4iLCJjb21tYW5kIiwiY29uZmlnRmlsZSIsImNvbW1hbmRMaW5lIiwib3B0aW9uIiwiY29uZmlnRnVsbFBhdGgiLCJyZXNvbHZlIiwiZXhpc3RzU3luYyIsIkVycm9yIiwiZXh0TmFtZSIsImV4dG5hbWUiLCJjb25maWdOYW1lIiwiYmFzZW5hbWUiLCJjb25maWdQYXRoIiwiZGlybmFtZSIsImVudkF3YXJlIiwiZW5kc1dpdGgiLCJzdWJzdHIiLCJsZW5ndGgiLCJjb250YWluZXIiLCJ3b3JraW5nUGF0aCIsImRpc2FibGVFbnZBd2FyZUNvbmZpZyIsImFsbG93ZWRGZWF0dXJlcyIsInJlcGxhY2VMb2dnZXIiLCJsb2dnZXIiLCJzdGFydF8iLCJvbmNlIiwic3RvcHBlciIsInB1c2giLCJzdG9wXyIsIm5hbWUiLCJjb25maWciLCJzZXR0aW5ncyIsImdlbWwiLCJpc0VtcHR5IiwiZ2VtbFBhdGgiLCJtb2RlbFBhdGgiLCJzY3JpcHRQYXRoIiwibWFuaWZlc3RQYXRoIiwidXNlSnNvblNvdXJjZSIsInNhdmVJbnRlcm1lZGlhdGUiLCJ0eXBlIiwiZGVmYXVsdCIsIm9wdGlvbnMiLCJ0b0Fic29sdXRlUGF0aCIsImdlbWxDb25maWciLCJzY2hlbWFzIiwibG9hZF8iLCJ1c2VEYiIsImNtZE1ldGhvZF8iLCJlcnJvciIsImxvZ0Vycm9yIiwicHJvY2VzcyIsImV4aXQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLEVB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LENBQVo7QUFDQUMsSUFBQUEsVUFBVSxHQUFHLEtBQUtsQixTQUFMLENBQWV5QixjQUFmLENBQThCUCxVQUE5QixDQUFiO0FBQ0FDLElBQUFBLFlBQVksR0FBRyxLQUFLbkIsU0FBTCxDQUFleUIsY0FBZixDQUE4Qk4sWUFBOUIsQ0FBZjtBQUVBLFFBQUlPLFVBQVUsR0FBRyxFQUNiLEdBQUdkLE1BRFU7QUFFYkksTUFBQUEsUUFGYTtBQUdiQyxNQUFBQSxTQUhhO0FBSWJDLE1BQUFBLFVBSmE7QUFLYkMsTUFBQUEsWUFMYTtBQU1iQyxNQUFBQSxhQU5hO0FBT2JDLE1BQUFBO0FBUGEsS0FBakI7O0FBVUEsUUFBSSxDQUFDakQsQ0FBQyxDQUFDMkMsT0FBRixDQUFVVyxVQUFVLENBQUNDLE9BQXJCLENBQUwsRUFBb0M7QUFDaEMsWUFBTTtBQUFFQyxRQUFBQSxLQUFLLEVBQUVDO0FBQVQsVUFBbUIzRCxPQUFPLENBQUMsOEJBQUQsQ0FBaEM7O0FBQ0EsWUFBTTJELEtBQUssQ0FBQyxLQUFLN0IsU0FBTixFQUFpQjBCLFVBQVUsQ0FBQ0MsT0FBNUIsQ0FBWDtBQUNIOztBQUVELFFBQUlHLFVBQVUsR0FBRzVELE9BQU8sQ0FBQyxnQkFBZ0JZLE9BQWpCLENBQXhCOztBQUVBLFFBQUk7QUFDQSxZQUFNZ0QsVUFBVSxDQUFDLEtBQUs5QixTQUFOLEVBQWlCMEIsVUFBakIsQ0FBaEI7QUFDSCxLQUZELENBRUUsT0FBT0ssS0FBUCxFQUFjO0FBRVIsWUFBTUEsS0FBTjtBQUdKLFdBQUtwRCxHQUFMLENBQVNxRCxRQUFULENBQWtCRCxLQUFsQjtBQUNBRSxNQUFBQSxPQUFPLENBQUNDLElBQVIsQ0FBYSxDQUFiO0FBQ0g7QUFDSjs7QUFuSGM7O0FBc0huQkMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCNUQsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuY29uc3QgeyBmcywgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgU2VydmljZUNvbnRhaW5lciB9ID0gcmVxdWlyZSgnQGdlbngvYXBwJyk7XG5jb25zdCB7IFZhbGlkYXRvcnM6IHsgdmFsaWRhdGVPYmplY3RCeVNjaGVtYSB9IH0gPSByZXF1aXJlKCdAZ2VueC9kYXRhJylcblxuY2xhc3MgQXBwSW5pdGlhdG9yIHtcbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0KSB7XG4gICAgICAgIHRoaXMuYXBwID0gY29udGV4dC5hcHA7XG4gICAgICAgIHRoaXMuY3dkID0gY29udGV4dC5jd2Q7ICAgICAgICBcbiAgICB9XG5cbiAgICBhc3luYyBydW4oY29tbWFuZCkgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25maWdGaWxlID0gdGhpcy5hcHAuY29tbWFuZExpbmUub3B0aW9uKCdjb25maWcnKSB8fCAnZ2VtbC5qc29uJzsgICAgICAgICAgICAgICAgXG4gICAgICAgIGxldCBjb25maWdGdWxsUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLmN3ZCwgY29uZmlnRmlsZSk7XG5cbiAgICAgICAgaWYgKCEoZnMuZXhpc3RzU3luYyhjb25maWdGdWxsUGF0aCkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZpZyBcIiR7Y29uZmlnRmlsZX1cIiBub3QgZm91bmQhYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZXh0TmFtZSA9IHBhdGguZXh0bmFtZShjb25maWdGdWxsUGF0aCk7XG4gICAgICAgIGlmIChleHROYW1lICE9PSAnLmpzb24nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgc3VwcG9ydHMgSlNPTiBjb25maWcuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29uZmlnTmFtZSA9IHBhdGguYmFzZW5hbWUoY29uZmlnRnVsbFBhdGgsIGV4dE5hbWUpO1xuICAgICAgICBsZXQgY29uZmlnUGF0aCA9IHBhdGguZGlybmFtZShjb25maWdGdWxsUGF0aCk7XG4gICAgICAgIGxldCBlbnZBd2FyZSA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChjb25maWdOYW1lLmVuZHNXaXRoKCcuZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICBlbnZBd2FyZSA9IHRydWU7XG4gICAgICAgICAgICBjb25maWdOYW1lID0gY29uZmlnTmFtZS5zdWJzdHIoMCwgY29uZmlnTmFtZS5sZW5ndGggLSA4KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY29udGFpbmVyID0gbmV3IFNlcnZpY2VDb250YWluZXIoJ0dlbWxDb3JlJywge1xuICAgICAgICAgICAgd29ya2luZ1BhdGg6IHRoaXMuY3dkLFxuICAgICAgICAgICAgY29uZmlnUGF0aCxcbiAgICAgICAgICAgIGNvbmZpZ05hbWUsICAgICAgICAgICAgXG4gICAgICAgICAgICBkaXNhYmxlRW52QXdhcmVDb25maWc6ICFlbnZBd2FyZSxcbiAgICAgICAgICAgIGFsbG93ZWRGZWF0dXJlczogW1xuICAgICAgICAgICAgICAgICdjb25maWdCeUhvc3RuYW1lJywgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICdkZXZDb25maWdCeUdpdFVzZXInLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAnYXBwTG9nZ2VyJyxcbiAgICAgICAgICAgICAgICAnbG9nZ2VycycsICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJ3NldHRpbmdzJyxcbiAgICAgICAgICAgICAgICAndGltZXpvbmUnLFxuICAgICAgICAgICAgICAgICd2ZXJzaW9uJywgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJ2RhdGFTb3VyY2UnLFxuICAgICAgICAgICAgICAgICdlbnYnXG4gICAgICAgICAgICBdXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuY29udGFpbmVyLnJlcGxhY2VMb2dnZXIodGhpcy5hcHAubG9nZ2VyKTtcblxuICAgICAgICBhd2FpdCB0aGlzLmNvbnRhaW5lci5zdGFydF8oKTtcblxuICAgICAgICB0aGlzLmFwcC5vbmNlKCdzdG9wcGluZycsIHN0b3BwZXIgPT4ge1xuICAgICAgICAgICAgc3RvcHBlci5wdXNoKChhc3luYyAoKSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuY29udGFpbmVyLnN0b3BfKCk7XG4gICAgICAgICAgICB9KSgpKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5jb250YWluZXIub3B0aW9uID0gKG5hbWUpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFwcC5jb21tYW5kTGluZS5vcHRpb24obmFtZSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGNvbmZpZyA9IHRoaXMuY29udGFpbmVyLnNldHRpbmdzLmdlbWw7XG4gICAgICAgIGlmIChfLmlzRW1wdHkoY29uZmlnKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdFbXB0eSBnZW1sIGNvbmZpZyEnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IFxuICAgICAgICAgICAgZ2VtbFBhdGgsIFxuICAgICAgICAgICAgbW9kZWxQYXRoLCBcbiAgICAgICAgICAgIHNjcmlwdFBhdGgsXG4gICAgICAgICAgICBtYW5pZmVzdFBhdGgsXG4gICAgICAgICAgICB1c2VKc29uU291cmNlLFxuICAgICAgICAgICAgc2F2ZUludGVybWVkaWF0ZSBcbiAgICAgICAgfSA9IHZhbGlkYXRlT2JqZWN0QnlTY2hlbWEoY29uZmlnLCB7XG4gICAgICAgICAgICAnZ2VtbFBhdGgnOiB7IHR5cGU6ICd0ZXh0JywgZGVmYXVsdDogJ2dlbWwnIH0sXG4gICAgICAgICAgICAnbW9kZWxQYXRoJzogeyB0eXBlOiAndGV4dCcsIGRlZmF1bHQ6ICdzcmMvbW9kZWxzJyB9LFxuICAgICAgICAgICAgJ3NjcmlwdFBhdGgnOiB7IHR5cGU6ICd0ZXh0JywgZGVmYXVsdDogJ3NyYy9zY3JpcHRzJyB9LFxuICAgICAgICAgICAgJ21hbmlmZXN0UGF0aCc6IHsgdHlwZTogJ3RleHQnLCBkZWZhdWx0OiAnbWFuaWZlc3RzJyB9LFxuICAgICAgICAgICAgJ3VzZUpzb25Tb3VyY2UnOiB7IHR5cGU6ICdib29sZWFuJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgICdzYXZlSW50ZXJtZWRpYXRlJzogeyB0eXBlOiAnYm9vbGVhbicsIGRlZmF1bHQ6IGZhbHNlIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5jb250YWluZXIub3B0aW9ucy5tb2RlbFBhdGggPSBtb2RlbFBhdGg7XG4gICAgICAgIFxuICAgICAgICBnZW1sUGF0aCA9IHRoaXMuY29udGFpbmVyLnRvQWJzb2x1dGVQYXRoKGdlbWxQYXRoKTsgICAgXG4gICAgICAgIG1vZGVsUGF0aCA9IHRoaXMuY29udGFpbmVyLnRvQWJzb2x1dGVQYXRoKG1vZGVsUGF0aCk7XG4gICAgICAgIHNjcmlwdFBhdGggPSB0aGlzLmNvbnRhaW5lci50b0Fic29sdXRlUGF0aChzY3JpcHRQYXRoKTtcbiAgICAgICAgbWFuaWZlc3RQYXRoID0gdGhpcy5jb250YWluZXIudG9BYnNvbHV0ZVBhdGgobWFuaWZlc3RQYXRoKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBnZW1sQ29uZmlnID0geyBcbiAgICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICAgIGdlbWxQYXRoLCBcbiAgICAgICAgICAgIG1vZGVsUGF0aCwgXG4gICAgICAgICAgICBzY3JpcHRQYXRoLFxuICAgICAgICAgICAgbWFuaWZlc3RQYXRoLFxuICAgICAgICAgICAgdXNlSnNvblNvdXJjZSxcbiAgICAgICAgICAgIHNhdmVJbnRlcm1lZGlhdGUgIFxuICAgICAgICB9O1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGdlbWxDb25maWcuc2NoZW1hcykpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IHsgbG9hZF86IHVzZURiIH0gPSByZXF1aXJlKCdAZ2VueC9hcHAvbGliL2ZlYXR1cmVzL3VzZURiJyk7XG4gICAgICAgICAgICBhd2FpdCB1c2VEYih0aGlzLmNvbnRhaW5lciwgZ2VtbENvbmZpZy5zY2hlbWFzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjbWRNZXRob2RfID0gcmVxdWlyZSgnLi9jb21tYW5kcy8nICsgY29tbWFuZCk7ICAgICAgICBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgY21kTWV0aG9kXyh0aGlzLmNvbnRhaW5lciwgZ2VtbENvbmZpZyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5hcHAubG9nRXJyb3IoZXJyb3IpO1xuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gQXBwSW5pdGlhdG9yOyJdfQ==