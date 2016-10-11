/* Module: Random -- Adds a command, "random", which outputs a random number. */

var Module = require('./Module.js');
var random = require('meteor-random');

class ModRandom extends Module {

    get RequiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Random', name);
    }
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand('random', {
            description: "Generates a random number.",
            args: ["max", "pub"],
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

