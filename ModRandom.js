/* Module: Random -- Adds a command, "random", which outputs a random number. */

var random = require('meteor-random');

var environments = null;
var modules = null;


var modname = "Random";
exports.name = modname;


exports.requiredenvironments = [];
exports.requiredmodules = ["Commands"];


exports.initialize = function(envs, mods, moduleRequest) {

    //Load parameters
    
    if (!envs) return false;
    environments = envs;
    modules = mods;
  
    //Register callbacks
    
    modules.Commands.registerCommand('random', {
        description: "Generates a random number.",
        args: ["max", "pub"],
        minArgs: 0
    }, function(env, type, userid, command, args, handle, reply, pub) {
    
        var val = random.fraction();
        if (args.max) val = Math.floor(val * args.max);
        
        if (args.pub) {
            pub(val);
        } else {
            reply(val);
        }
    
        return true;
    });
  
    return true;
};
