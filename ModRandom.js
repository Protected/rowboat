/* Module: Random -- Adds a command, "random", which outputs a random number. */

var Module = require('./Module.js');
var random = require('meteor-random');

class ModRandom extends Module {

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Random', name);
    }
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand('random', {
            description: "Generates a random number using a cryptographically secure source of randomness.",
            args: ["max", "pub"],
            details: [
                "If MAX is not passed, a floating point number between 0 and 1 is returned.",
                "If MAX Is a positive integer, an integer between 0 and MAX is returned.",
                "If 0 is a dice descriptor with the format AdB, where A and B are integers, a roll of A dice with B facets is realistically simulated and the value returned. Up to 9 dice and 99 facets are accepted."
            ],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub) => {
        
            var val;
        
            if (args.max) {
                let facets = args.max.match(/^([1-9])d([1-9][0-9]?)$/);
                if (facets) {
                    val = 0;
                    for (let i = 0; i < facets[1]; i++) {
                        val += Math.floor(random.fraction() * facets[2]);
                    }
                } else if (args.max.match(/^[0-9]+$/)) {
                    val = Math.floor(random.fraction() * args.max);
                } else {
                    reply("Invalid argument.");
                    return false;
                }
            } else {
                val = random.fraction();
            }
            
            if (args.pub) {
                pub(val);
            } else {
                reply(val);
            }
        
            return true;
        });
      
        return true;
    };

}


module.exports = ModRandom;

