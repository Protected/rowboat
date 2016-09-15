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
        if (!super(envs, mods, moduleRequest)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand('random', {
            description: "Generates a random number.",
            args: ["max", "pub"],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub) => {
        
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

}
