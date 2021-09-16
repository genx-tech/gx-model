const {
    Starters: { startCommand },
} = require("@genx/app");
const { _, findKey } = require("@genx/july");
const pkg = require("../../package.json");

const AppInitiator = require("../AppInitiator");
const { Commands, getCommandOptions } = require("./commands");

const binItem = findKey(pkg.bin, (v) => v === "bin/geml.js");

const afterCommandConfirmed = (cli) => {
    let cmd = cli.argv._[0];
    let options = getCommandOptions(cli, cmd);
    cli.usage.options = { ...cli.usage.options, ...options };
    cli.parse(cli.usage.options);
};

const onVerboseMode = (cli) => {
    if (cli.argv['verbose']) {
        cli.app.options.logger.level = 'verbose';
        cli.app.resetLogger();        
    }
};

function main() {
    startCommand(
        (app) => {
            let cmd = app.commandLine;

            if (cmd.option("help")) {
                cmd.showUsage();
                return;
            }

            if (cmd.option("version")) {
                console.log(pkg.version);
                return;
            }

            let command = cmd.argv._[0];

            const appInitiator = new AppInitiator({
                app,
                cwd: process.cwd(),
            });

            return appInitiator.run(command);
        },
        {
            commandName: binItem,
            config: {
                version: pkg.version,
                commandLine: {
                    banner: `Gen-X entity modeling command line v${pkg.version}`,
                    program: binItem,
                    arguments: [
                        {
                            name: "command",
                            required: true,
                            inquire: true,
                            promptType: "list",
                            promptMessage: "What command are you going to execute?",
                            choicesProvider: _.map(Commands, (desc, cmd) => ({ name: `${cmd} - ${desc}`, value: cmd })),
                            afterInquire: afterCommandConfirmed,
                            onArgumentExists: afterCommandConfirmed,
                        },
                    ],
                    options: {
                        s: {
                            desc: "Silent mode",
                            alias: ["silent"],
                            bool: true,
                            default: false,
                        },
                        v: {
                            desc: "Show version information",
                            alias: ["version"],
                            bool: true,
                            default: false,
                        },
                        verbose: {
                            desc: "Show verbose information",
                            bool: true,
                            default: false,
                            afterInquire: onVerboseMode,
                            onArgumentExists: onVerboseMode,
                        },
                        h: {
                            desc: "Show usage message",
                            alias: ["help"],
                            bool: true,
                            default: false,
                        },
                        c: {
                            desc: "Config path",
                            alias: ["conf", "config"],
                        },
                    },
                    silentMode: (cli) => cli.argv["silent"] || cli.argv["version"] || cli.argv["help"],
                    nonValidationMode: (cli) => cli.argv["version"] || cli.argv["help"],
                    showUsageOnError: true,
                    showArguments: (cli) => cli.argv["verbose"],
                },
            },
        }
    );
}

if (!module.parent) {
    main();
} else {
    module.exports = main;
}
