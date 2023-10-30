/*
Copyright 2014-2017 Awkens
Copyright 2016-2023 Protected

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this software except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

"use strict";

import fs from 'fs';

import logger from './src/Logger.js';
import config from './src/Config.js';
import { parseAndExecuteArgs } from './src/CommandLine.js';
import registerCommandLineFeatures from './src/commandLineFeatures.js';
import Core from './src/Core.js';

const PIDFILE = "rowboat.pid";

//Check pidfile

if (fs.existsSync(PIDFILE)) {
    console.log("Rowboat is already running.");
    process.exit(1);
}

//Start up

if (!config.loadMasterConfig()) {
    logger.error("Unable to load master config.");
    process.exit(2);
}

if (!config.dontCatchRejections) {

    process.on('unhandledRejection', (reason, promise) => {
        logger.warn('Unhandled Rejection at: ' + JSON.stringify(promise) + ' Reason: ' + JSON.stringify(reason));
    });

}

let core = new Core();

process.on("SIGINT", () => {
    //Graceful shutdown
    core.beginShutdown();
});

fs.writeFileSync(PIDFILE, String(process.pid), {mode: 0o644});

process.on("exit", () => {
    //Cleanup
    core.performCleanup();
    fs.unlinkSync(PIDFILE);
    logger.info("Rowboat has ended gracefully.");
});

registerCommandLineFeatures();

let args = process.argv;
args.shift(); args.shift();

(async function() {
    "use strict";

    //Command line arguments

    let stop = await parseAndExecuteArgs(args, {core, config, editConfig: null}, ({editConfig, stop}) => {
        if (editConfig) {
            config.saveEditConfig(editConfig);
            logger.info("Saved configuration file.");
            return true;
        }
        if (stop) {
            return true;
        }
    });

    if (stop) {
        process.exit(0);
    }

    //Actual execution
    
    let fail = 0;

    if (!await core.loadEnvironments()) {
        logger.error("Unable to load environments.");
        fail = 3;
    }

    if (!await core.loadBehaviors()) {
        logger.error("Unable to load behaviors.");
        fail = 4;
    }

    if (fail) {
        //Give the logger time to write
        setTimeout(() => process.exit(fail), 1000);
    } else {
        await core.runEnvironments();
        logger.info("Rowboat " + config.version + " is now running.");
    }
})();
