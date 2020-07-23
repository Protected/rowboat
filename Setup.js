var jsonfile = require('jsonfile');
var minimist = require('minimist');
var fs = require('fs');
var rs = require('readline-sync');
var logger = require('./Logger.js');

var config = {};
var environments = {};
var modules = {};

var self = this;


//Auxiliary functions

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

function envNameLoaded(envname) {
    for (let thatName in environments) {
        if (environments[thatName].envName == envname) {
            return true;
        }
    }
    return false;
}

function modNameLoaded(modname) {
    for (let thatName in modules) {
        if (modules[thatName].modName == modname) {
            return true;
        }
    }
    return false;
}

function envConfigPath(env) {
    return "config/" + env.name.toLowerCase() + "." + env.envName.toLowerCase() + ".env.json";
}

function modConfigPath(mod) {
    var configname = mod.modName.toLowerCase();
    if (mod.isMultiInstanceable) configname = mod.name.toLowerCase() + "." + configname;
    return "config/" + configname + ".mod.json";
}

//Modified npm toposort
//getRequirements and getNodeId are a string (property/method name) or a function (taking the node as argument)
function requirementSort(nodes, getRequirements, getNodeId) {
    var cursor = nodes.length
        , sorted = new Array(cursor)
        , visited = {}
        , i = cursor;
        
    if (!getNodeId) {
        getNodeId = function(node) { return node; }
    } else if (typeof getNodeId != "string" && typeof getNodeId != "function") {
        throw new Error('Incorrect type for getNodeId.');
    }
    
    if (typeof getRequirements != "string" && typeof getRequirements != "function") {
        throw new Error('Incorrect type for getRequirements.');
    }

    while (i--) {
        if (!visited[i]) visit(nodes[i], i, []);
    }

    return sorted.reverse();

    function visit(node, i, predecessors) {
        
        var actuallyGetNodeId = (node) => {
            if (typeof getNodeId == "function") return getNodeId(node);
            if (typeof node[getNodeId] == "function") return node[getNodeId]();
            return node[getNodeId];
        };
        
        var findNodeInList = (node) => (eachnode) => {
            return actuallyGetNodeId(node) == actuallyGetNodeId(eachnode);
        };
        var findNodeidInList = (nodeid) => (eachnode) => {
            return nodeid == actuallyGetNodeId(eachnode);
        };

        if (!~nodes.findIndex(findNodeInList(node))) {
            throw new Error('Missing requirement: ' + actuallyGetNodeId(node));
        }    
        if (predecessors.findIndex(findNodeInList(node)) >= 0) {
            throw new Error('Cyclic dependency: ' + actuallyGetNodeId(node));
        }

        if (visited[i]) return;
        visited[i] = true;

        var outgoing;
        if (typeof getRequirements == "string") {
            outgoing = (typeof node[getRequirements] == "function" ? node[getRequirements]() : node[getRequirements]);
        } else {
            outgoing = getRequirements(node);
        }
        
        if (i = outgoing.length) {
            var preds = predecessors.concat(node);
            do {
                var childid = outgoing[--i];
                var childindex = nodes.findIndex(findNodeidInList(childid));
                if (!~childindex) {
                    throw new Error('Missing requirement: ' + childid);
                }
                visit(nodes[childindex], childindex, preds);
            } while (i)
        }

        sorted[--cursor] = node;
    }
}


logger.info("Rowboat setup tool");

var args = minimist(process.argv.slice(2), {stopEarly: true, alias: {
    help: ["h", "?"],
    log: "l",
    safe: "s",
    env: ["e", "envs"],
    dry: "d",
    full: "u",
    force: "f",
    ask: "a"
}, string: ["env", "log"], boolean: ["help", "safe", "dry", "full", "force", "ask"]});

if (args.help) {
    logger.info("This tool writes Rowboat configuration files to config/ .");
    logger.info("");
    logger.info("Syntax: " + process.argv[1] + " [OPTIONS...] [MODULES]");
    logger.info("");
    logger.info("MODULES: ");
    logger.info("    Zero or more modules separated by semicolons (;) . If none is passed, the full config.json will be used.");
    logger.info("    To name a multi-instanceable module use NAME,MODULE instead of just MODULE.");
    logger.info("");
    logger.info("OPTIONS: ");
    logger.info("    --help, -h                 Shows this help.");
    logger.info("    --log, -l PATH             Specify the path of the logfile, overriding existing config.json path.");
    logger.info("    --env, -e ENVIRONMENTS     A list of NAME,ENVIRONMENT separated by semicolons, overriding config.json.");
    logger.info("    --ask, -a                  Interactively ask which modules to set up. Pass -e without arguments to also ask for environments.");
    logger.info("    --full, -u                 Write all parameters to config files instead of just required parameter stubs.");
    logger.info("    --force, -f                Replace existing environment and module config params.");
    logger.info("    --safe, -s                 Don't write to config.json. Don't replace defined parameters with undefined defaults.");
    logger.info("    --dry, -d                  Don't write anywhere (simulate only).");
    logger.info("");
    return;
}


//Load master config

logger.info("Loading master config...");
logger.enableConsole();

try {
    config = jsonfile.readFileSync("config/config.json");
} catch (e) {
    config.environments = {};
    config.paths = {
        logger: "[logs/]Y-MM-DD[.log]",
        data: "data/"
    };
}

if (args.log) {
    if (!config.paths) config.paths = {};
    config.paths.logger = args.log;
}
if (config.paths && config.paths.logger) {
    logger.setPathTemplate(config.paths.logger);
}

logger.info("== Master config setup");

var envnames = [];  //Modules to target during setup
var modnames = [];

if (args.env) {
    if (args.env === true) {
        if (args.ask) {
            
            console.log('Please enter instance names for all desired Environment instances (leave blank to continue).');
            
            for (let file of fs.readdirSync('environment')) {
                let matchname = file.match(/^Env([A-Z0-9].*)\.js$/);
                if (!matchname) continue;
                matchname = matchname[1];
                
                let firstline = fs.readFileSync('./environment/' + file).toString().match(/^(.*?)\n/);
                if (firstline) firstline = firstline[1];
                else firstline = "";
                
                let headline = firstline.match(new RegExp('/\\* (Environment: ' + matchname + ' -- .*)\\*/'));
                if (headline) headline = headline[1].trim();
                else headline = 'Environment: ' + matchname;
                
                console.log('-> ' + headline);
                
                let name;
                while (name = rs.question('Instance name: ')) {
                    config.environments[name] = matchname;
                    envnames.push(name);
                }
            }
            
            console.log('Your environments: ', JSON.stringify(config.environments, 4));
            if (!rs.keyInYN('Continue? ')) return;
            
        }
    } else {
    
        config.environments = {};
        for (let pair of args.env.split(';')) {
            let nameenv = pair.split(',');
            if (config.environments[nameenv[0]]) {
                logger.error("You requested the environment '" + pair + "', but the name '" + nameenv[0] + "' is already in use by an environment of the type '" + config.environments[nameenv[0]] + "'.");
                return;
            }
            logger.info("Setting environment '" + nameenv[0] + "' with the type '" + nameenv[1] + "'.");
            config.environments[nameenv[0]] = nameenv[1];
            envnames.push(nameenv[0]);
        }
        
    }
}

if (args._[0]) {
    let modulenames = {};
    config.modules = [];
    for (let pair of args._[0].split(';')) {
        let namemod = pair.split(',');
        if (modulenames[namemod[0]]) {
            logger.error("You requested the module '" + pair, "', but the name '" + namemod[0] + "' is already in use by a previously declared module. Please make sure all module instances use a unique name.");
            return;
        }
        logger.info("Setting module '" + namemod[0] + "' with the type '" + (namemod[1] || namemod[0]) + "'.");
        config.modules.push(namemod[1] ? namemod : pair);
        modnames.push(namemod[0]);
    }
}

if (args.ask) {
    console.log('Please choose whether to include each module. Type an instance name if the module is multi-instanceable.');

    for (let file of fs.readdirSync('behavior')) {
        let matchname = file.match(/^Mod([A-Z0-9].*)\.js$/);
        if (!matchname) continue;
        matchname = matchname[1];
        
        if (config.modules.indexOf(matchname) > -1) continue;
        
        let firstline = fs.readFileSync('./behavior/' + file).toString().match(/^(.*?)\n/);
        if (firstline) firstline = firstline[1];
        else firstline = "";
        
        let headline = firstline.match(new RegExp('/\\* (Module: ' + matchname + ' -- .*)\\*/'));
        if (headline) headline = headline[1].trim();
        else headline = 'Module: ' + matchname;
        
        console.log('-> ' + headline);
        
        let name;
        while (true) {
            let once = true;
            name = rs.question('Include? (y/n): ');
            if (!name || name == "n" || name == "N") break;
            if (name.length == 1) name = matchname;
            else once = false;
            config.modules.push(name == matchname ? name : [name, matchname]);
            modnames.push(name);
            if (once) break;
        }
    }

    console.log('Your modules: ', JSON.stringify(config.modules, 4));
    if (!rs.keyInYN('Continue? ')) return;
}

if (!config.modules || config.modules.length < 1) {
    logger.error("No modules known or specified. Nothing to do!");
    return;
}


//Load environments

for (let name in config.environments) {
    var envtype = requireUncached("./environment/Env" + config.environments[name] + ".js");
    if (!envtype) {
        logger.error("Could not load the environment: " + name + " . Is the environment source in Rowboat's directory?");
        return;
    }
    
    var env = new envtype(name);
    environments[env.name] = env;
    logger.info("Successfully loaded environment: " + env.name);
}
    

//Load modules


let needmodsort = false;
let modstosort = [];

for (let name of config.modules) {
    
    let type = null;
    if (typeof name == "object") {
        type = name[1];
        name = name[0];
    } else {
        type = name;
   }
    
    var modtype = requireUncached("./behavior/" + type + ".js");
    if (!modtype) {
        logger.error("Could not load the module: " + name + " . Is the module source in Rowboat's directory?");
        return;
    }
    
    var mod = new modtype(name);
    
    if (!mod.isMultiInstanceable && name != mod.modName) {
        logger.error("Could not load the module: " + name + " . This module is not multi-instanceable; It MUST be configuered with the name: " + mod.modName);
        return;
    }
    
    for (let reqenv of mod.requiredEnvironments) {
        if (!envNameLoaded(reqenv)) {
            logger.error("The module: " + mod.name + " requires an environment of the type: " + reqenv + " but one is not loaded at this time.");
            return;
        }
    }
    
    for (let reqmod of mod.requiredModules) {
        if (!modNameLoaded(reqmod)) {
            logger.warn("The module: " + mod.name + " requires the module: " + reqmod + " but none is loaded at this time!");
            needmodsort = true;
        }
    }
    
    if (mod.isRootAccess) {
        logger.info("The module: " + mod.name + " accesses the root module.");
    }
    
    modules[mod.name] = mod;
    modstosort.push(mod);
    logger.info("Successfully loaded module: " + mod.name);
}


if (needmodsort) {
    logger.info("Let me try to reorder the modules in order to fix all unmet dependencies...");
    let bestorder;
    try {
        bestorder = requirementSort(modstosort, "requiredModules", "modName");
    } catch (e) {
        logger.error("Error: " + e);
        return;
    }
    let showresult = [];
    config.modules = [];
    for (let mod of bestorder) {
        if (mod.isMultiInstanceable) {
            showresult.push(mod.name + ',' + mod.modName);
            config.modules.push([mod.name, mod.modName]);
        } else {
            showresult.push(mod.modName);
            config.modules.push(mod.modName);
        }
    }
    logger.info("Resulting order: " + showresult.join(";"));
}

if (!args.safe && !args.dry) {
    logger.info("Saving config.json ...");
    jsonfile.writeFileSync("config/config.json", config, {spaces: 4});
}


logger.info("== Setting up environment configs...");

for (let name of envnames) {
    let env = environments[name];
    let path = envConfigPath(env);
    logger.info("> " + path);
    
    let envconf = {};
    try {
        envconf = jsonfile.readFileSync(path);
    } catch (e) {
        logger.info("File doesn't yet exist.");
    }
    
    let paramsToProcess = env.requiredParams;
    if (args.full) paramsToProcess = paramsToProcess.concat(env.optionalParams);
    
    for (let param of paramsToProcess) {
        let action = 'Add: ';
        let def = env.param(param);
        
        if (envconf[param] !== undefined) {
            if (!args.force || args.safe && def === undefined) {
                logger.info('Keep: ' + param + ' = ' + envconf[param]);
                continue;
            }
            action = 'Replace: ';
        }
        logger.info(action + param + ' = ' + (def || null));
        envconf[param] = (def || null);
    }
    
    if (!args.dry && Object.keys(envconf).length) {
        logger.info("Saving...");
        jsonfile.writeFileSync(path, envconf, {spaces: 4});
    }
}


logger.info("== Setting up module configs...");

for (let name of modnames) {
    let mod = modules[name];
    let path = modConfigPath(mod);
    logger.info("> " + path);
    
    let modconf = {};
    try {
        modconf = jsonfile.readFileSync(path);
    } catch (e) {
        logger.info("File doesn't yet exist.");
    }
    
    let paramsToProcess = mod.requiredParams;
    if (args.full) paramsToProcess = paramsToProcess.concat(mod.optionalParams);
    
    for (let param of paramsToProcess) {
        let action = 'Add: ';
        let def = mod.param(param);
        
        if (modconf[param] !== undefined) {
            if (!args.force || args.safe && def === undefined) {
                logger.info('Keep: ' + param + ' = ' + modconf[param]);
                continue;
            }
            action = 'Replace: ';
        }
        logger.info(action + param + ' = ' + (def || null));
        modconf[param] = (def || null);
    }
    
    if (!args.dry && Object.keys(modconf).length) {
        logger.info("Saving...");
        jsonfile.writeFileSync(path, modconf, {spaces: 4});
    }
}


logger.info("!SETUP COMPLETE! Now edit the files in config/ and add the missing values.");
