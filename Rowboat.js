const jsonfile = require('jsonfile');
const logger = require('./Logger.js');
const api = require('./API.js');

var config;
var environments = {};
var modules = {};

var modulerequests = {};
var shared = {};

var self = this;


//Auxiliary functions

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

function moduleRequest(modname, callback) {
    if (modules[modname]) {
        callback(modules[modname]);
    } else {
        if (!modulerequests[modname]) {
            modulerequests[modname] = [];
        }
        modulerequests[modname].push(callback);
    }
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



//Auxiliary exports

exports.getAllEnvironments = function() {
    return environments;
}

exports.getAllModules = function() {
    return modules;
}


//Load master config

logger.info("Welcome to Rowboat!");

var loadMasterConfig = exports.loadMasterConfig = function() {
    logger.info("Loading master config...");

    try {
        config = jsonfile.readFileSync("config/config.json");
    } catch (e) {
        logger.error("Failed to load master config. Error: " + e.message);
        return false;
    }
    
    if (config.paths && config.paths.logger) {
        logger.setPathTemplate(config.paths.logger);
    }

    if (Object.keys(config.environments).length < 1) {
        logger.warn("Environments provide connectivity. Please configure at least one environment.");
        return false;
    }

    if (config.modules.length < 1) {
        logger.warn("Modules provide behavior. Please configure at least one module.");
        return false;
    }
    
    return true;
}

var resetContext = exports.resetContext = function() {
    environments = {};
    modules = {};
    modulerequests = {};
}

if (!loadMasterConfig()) return;


//Load and initialize environments

var loadEnvironments = exports.loadEnvironments = function() {

    for (let name in config.environments) {
        let envtype = requireUncached("./Env" + config.environments[name] + ".js");
        if (!envtype) {
            logger.error("Could not load the environment: " + name + " . Is the environment source in Rowboat's directory?");
            return false;
        }
        
        let env = new envtype(name);
        
        let sharedInstances = {};
        for (let sharedModule of env.sharedModules) {        
            let sharedName = env.envName + '_' + sharedModule;
            
            if (!shared[sharedName]) {
                shared[sharedName] = requireUncached("./" + sharedModule + ".js");
                if (!shared[sharedName]) {
                    logger.error("Could not initialize the environment: " + name + " . The shared module " + sharedModule + " could not be found.");
                    return false;
                }
            }
            
            sharedInstances[sharedModule] = shared[sharedName];
        }
        
        if (!env.initialize(sharedInstances)) {
            logger.error("Could not initialize the environment: " + name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
            return false;
        }
        
        env.on('error', (err) => {
            logger.warn("[" + env.name + "] Error: " + err);
        });
        environments[env.name] = env;
        
        logger.info("Successfully loaded environment: " + env.name);
    }
    
    return true;
}

if (!loadEnvironments()) return;


//Load and initialize modules

var loadModules = exports.loadModules = function() {

    for (let name of config.modules) {
        
        let type = null;
        if (typeof name == "object") {
            type = name[1];
            name = name[0];
        } else {
            type = name;
       }
        
        let modtype = requireUncached("./behavior/Mod" + type + ".js");
        if (!modtype) {
            logger.error("Could not load the module: " + name + " . Is the module source in Rowboat's directory?");
            return false;
        }
        
        let mod = new modtype(name);
        
        if (!mod.isMultiInstanceable && name != mod.modName) {
            logger.error("Could not load the module: " + name + " . This module is not multi-instanceable; It MUST be configuered with the name: " + mod.modName);
            return false;
        }
        
        for (let reqenv of mod.requiredEnvironments) {
            if (!envNameLoaded(reqenv)) {
                logger.error("Could not initialize the module: " + mod.name + " because the required environment type: " + reqenv + " is not loaded.");
                return false;
            }
        }
        
        for (let reqmod of mod.requiredModules) {
            if (!modNameLoaded(reqmod)) {
                logger.error("Could not initialize the module: " + mod.name + " because the required module type: " + reqmod + " is not loaded.");
                return false;
            }
        }
        
        let passenvs = Object.assign({}, environments);
        let passmodules = Object.assign({}, modules);
        let passconfig = Object.assign({}, config);
        
        if (mod.isRootAccess) {
            logger.info("The module: " + mod.name + " requested access to the root module.");
            passmodules.root = self;
        }

        if (!mod.initialize({
            envs: passenvs,
            mods: passmodules,
            config: passconfig,
            moduleRequest: moduleRequest,
            rootpath: __dirname
        })) {
            logger.error("Could not initialize the module: " + mod.name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
            return false;
        }
        
        modules[mod.name] = mod;
        logger.info("Successfully loaded module: " + mod.name);
        
        if (modulerequests[mod.name]) {
            for (let j = 0; j < modulerequests[mod.name].length; j++) {
                modulerequests[mod.name][j](mod);
            }
            delete modulerequests[mod.name];
        }
    }
    
    return true;
}

if (!loadModules()) return;


//Run environments

exports.stopEnvironments = function() {
    for (let name in environments) {
        logger.info("Requesting disconnection of environment " + name + " ...");
        environments[name].disconnect();
    }
}

var runEnvironments = exports.runEnvironments = function() {
    for (let name in environments) {
        logger.info("Requesting connection of environment " + name + " ...");
        environments[name].connect();
    }
}

runEnvironments();
logger.info("Rowboat is now running.");
