const { Starters: { startWorker } } = require('@genx/app');

/**
 * Run a test function in a cli app
 * @param {*} workingPath 
 * @param {*} testToRun 
 * @returns {Promise.<*>}
 */
module.exports = (workingPath, testToRun) => startWorker(testToRun, {
    workerName: "tester",
    workingPath: workingPath,
    configName: "geml",
    configPath: "./",
    disableEnvAwareConfig: true,
    /*
    logger: {
        level: 'debug'
    }*/
});