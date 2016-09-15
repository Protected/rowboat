var jsonfile = require('jsonfile');

var config;
var environments = {};
var modules = {};

var modulerequests = {};

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


//Load master config

console.log("Welcome to Rowboat!");

var loadMasterConfig = exports.loadMasterConfig = function() {
    console.log("Loading master config...");

    try {
        config = jsonfile.readFileSync("config/config.json");
    } catch (e) {
        console.log("Failed to load master config. Error: " + e.message);
        return false;
    }

    if (Object.keys(config.environments).length < 1) {
        console.log("Environments provide connectivity. Please configure at least one environment.");
        return false;
    }

    if (config.modules.length < 1) {
        console.log("Modules provide behavior. Please configure at least one module.");
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
        var envtype = requireUncached("./Env" + config.environments[name] + ".js");
        if (!envtype) {
            console.log("Could not load the environment: " + name + " . Is the environment source in Rowboat's directory?");
            return false;
        }
        
        var env = new envtype(name);
        
        if (!env.initialize()) {
            console.log("Could not initialize the environment: " + name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
            return false;
        }
        
        env.registerOnError((env, err) => {
            console.log("[" + env.name + "] Error: " + err);
        });
        environments[env.name] = env;
        
        console.log("Successfully loaded environment: " + env.name);
    }
    
    return true;
}

if (!loadEnvironments()) return;


//Load and initialize modules

var loadModules = exports.loadModules = function() {

    for (let name in config.modules) {
        var modtype = requireUncached("./Mod" + config.modules[name] + ".js");
        if (!modtype) {
            console.log("Could not load the module: " + name + " . Is the module source in Rowboat's directory?");
            return false;
        }
        
        var mod = new modtype(name);
        
        if (!mod.isMultiInstanceable && name != mod.modName) {
            console.log("Could not load the module: " + name + " . This module is not multi-instanceable; It MUST be configuered with the name: " + mod.modName);
            return false;
        }
        
        for (let reqenv of mod.requiredenvironments) {
            if (!environments[reqenv]) {
                console.log("Could not initialize the module: " + mod.name + " because the required environment: " + reqenv + " is not loaded.");
                return false;
            }
        }
        
        for (let reqmod of mod.requiredmodules) {
            if (!modules[reqmod]) {
                console.log("Could not initialize the module: " + mod.name + " because the required module: " + reqmod + " is not loaded.");
                return false;
            }
        }
        
        var passenvs = Object.assign({}, environments);
        var passmodules = Object.assign({}, modules);
        
        if (mod.isRootAccess) {
            console.log("The module: " + mod.name + " requested access to the root module.");
            passmodules.root = self;
        }
        
        if (!mod.initialize(passenvs, passmodules, moduleRequest)) {
            console.log("Could not initialize the module: " + mod.name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
            return false;
        }
        
        modules[mod.name] = mod;
        console.log("Successfully loaded module: " + mod.name);
        
        if (modulerequests[mod.name]) {
            for (var j = 0; j < modulerequests[mod.name].length; j++) {
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
        console.log("Requesting disconnection of environment " + name + " ...");
        environments[name].disconnect();
    }
}

var runEnvironments = exports.runEnvironments = function() {
    for (let name in environments) {
        console.log("Requesting connection of environment " + name + " ...");
        environments[name].connect();
    }
}

runEnvironments();
console.log("Rowboat is now running.");
