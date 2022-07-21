const AppInitiator = require("../../src/AppInitiator");

module.exports = (app, configFile) => {
    let options = {
        'config': configFile
    };
    
    const appInitiator = new AppInitiator({
        app,
        cwd: app.toAbsolutePath(),
    });                    
    
    app.commandLine = {                      
        option: (name) => {
            return options[name]
        }
    };
    
    return appInitiator;
}


