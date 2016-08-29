var jsonfile = require('jsonfile');

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

var environments = {};
var modules = {};


//Load master config

console.log("Welcome to Rowboat!");
console.log("Loading master config...");

try {
    var config = jsonfile.readFileSync("config.json");
} catch (e) {
    console.log("Failed to load master config. Error: " + e.message);
    return;
}

if (config.environments.length < 1) {
    console.log("Environments provide connectivity. Please configure at least one environment.");
    return;
}

if (config.modules.length < 1) {
    console.log("Modules provide behavior. Please configure at least one module.");
    return;
}


//Load and initialize environments

for (var i = 0; i < config.environments.length; i++) {
    var env = requireUncached("./Env" + config.environments[i] + ".js");
    if (!env) {
        console.log("Could not load the environment: " + config.environments[i] + " . Is the environment source in Rowboat's directory?");
        return;
    }
    
    if (!env.initialize()) {
        console.log("Could not initialize the environment: " + config.environments[i] + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
        return;
    }
    
    env.registerOnError(function(env, err) {
        console.log("[" + env + "] Error: " + err);
    });
    environments[env.name] = env;
    
    console.log("Successfully loaded environment: " + env.name);
}


//Load and initialize modules

for (var i = 0; i < config.modules.length; i++) {
    var mod = requireUncached("./Mod" + config.modules[i] + ".js");
    if (!mod) {
        console.log("Could not load the module: " + config.modules[i] + " . Is the module source in Rowboat's directory?");
        return;
    }
    
    for (var j = 0; j < mod.requiredenvironments.length; j++) {
        if (!environments[mod.requiredenvironments[j]]) {
            console.log("Could not initialize the module: " + mod.name + " because the required environment: " + mod.requiredenvironments[j] + " is not loaded.");
            return;
        }
    }
    
    if (!mod.initialize(environments)) {
        console.log("Could not initialize the module: " + mod.name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
        return;
    }
    
    modules[mod.name] = mod;
    console.log("Successfully loaded module: " + mod.name);
}


//Connect environments

var envs = Object.keys(environments);
for (var i = 0; i < envs.length; i++) {
    console.log("Requesting connection of environment " + envs[i] + " ...");
    environments[envs[i]].connect();
}


console.log("Rowboat is now running.");
