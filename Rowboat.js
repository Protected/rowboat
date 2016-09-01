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
        config = jsonfile.readFileSync("config.json");
    } catch (e) {
        console.log("Failed to load master config. Error: " + e.message);
        return false;
    }

    if (config.environments.length < 1) {
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

    for (var i = 0; i < config.environments.length; i++) {
        var env = requireUncached("./Env" + config.environments[i] + ".js");
        if (!env) {
            console.log("Could not load the environment: " + config.environments[i] + " . Is the environment source in Rowboat's directory?");
            return false;
        }
        
        if (!env.initialize()) {
            console.log("Could not initialize the environment: " + config.environments[i] + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
            return false;
        }
        
        env.registerOnError(function(env, err) {
            console.log("[" + env + "] Error: " + err);
        });
        environments[env.name] = env;
        
        console.log("Successfully loaded environment: " + env.name);
    }
    
    return true;
}

if (!loadEnvironments()) return;


//Load and initialize modules

var loadModules = exports.loadModules = function() {

    for (var i = 0; i < config.modules.length; i++) {
        var mod = requireUncached("./Mod" + config.modules[i] + ".js");
        if (!mod) {
            console.log("Could not load the module: " + config.modules[i] + " . Is the module source in Rowboat's directory?");
            return false;
        }
        
        for (var j = 0; j < mod.requiredenvironments.length; j++) {
            if (!environments[mod.requiredenvironments[j]]) {
                console.log("Could not initialize the module: " + mod.name + " because the required environment: " + mod.requiredenvironments[j] + " is not loaded.");
                return false;
            }
        }
        
        for (var j = 0; j < mod.requiredmodules.length; j++) {
            if (!modules[mod.requiredmodules[j]]) {
                console.log("Could not initialize the module: " + mod.name + " because the required module: " + mod.requiredmodules[j] + " is not loaded.");
                return false;
            }
        }
        
        var passenvs = Object.assign({}, environments);
        var passmodules = Object.assign({}, modules);
        
        if (mod.rootaccess) {
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
    var envs = Object.keys(environments);
    for (var i = 0; i < envs.length; i++) {
        console.log("Requesting disconnection of environment " + envs[i] + " ...");
        environments[envs[i]].disconnect();
    }
}

var runEnvironments = exports.runEnvironments = function() {
    var envs = Object.keys(environments);
    for (var i = 0; i < envs.length; i++) {
        console.log("Requesting connection of environment " + envs[i] + " ...");
        environments[envs[i]].connect();
    }
}

runEnvironments();
console.log("Rowboat is now running.");
