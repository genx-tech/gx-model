const AppInitiator = require("../../src/AppInitiator");

module.exports = (app) => {
    let options = {
        'config': 'conf/app.default.json'
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


