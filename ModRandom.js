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
        
        this.mod('Commands').registerCommand(this, 'random', {
            description: "Generates a random number using a cryptographically secure source of randomness.",
            args: ["max", "pub"],
            details: [
                "If MAX is not passed, a floating point number between 0 and 1 is returned.",
                "If MAX is a positive integer, an integer between 0 and MAX is returned.",
                "Pass PUB as 1 to display the resulting random number in public even if you used the command in private."
            ],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var val;
        
            if (args.max) {
                if (args.max.match(/^[0-9]+$/)) {
                    val = Math.floor(random.fraction() * args.max);
                } else {
                    ep.reply("Invalid argument.");
                    return false;
                }
            } else {
                val = random.fraction();
            }
            
            if (args.pub) {
                ep.pub(env.idToDisplayName(userid) + ': ' + val);
            } else {
                ep.reply(env.idToDisplayName(userid) + ': ' + val);
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'roll', {
            description: "Generates a dice roll using a cryptographically secure source of randomness.",
            args: ["expr", true],
            details: [
                "EXPR is an expression containing sums and subtractions between dice (in the format AdB where A and B are integers) and constants."
            ],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var expr = args.expr.join(" ").replace(/(\+ *-|- *\+)/g, '-').replace(/([0-9])([+-])/g, '$1 $2').replace(/([+-])([0-9])/g, '$1 $2').replace(/ +/g, " ").split(" ");
            for (let i = 1; i < expr.length; i += 2) {
                if (expr[i] != "-" && expr[i] != "+") {
                    ep.reply("Invalid token '" + expr[i] + "' on position " + i + ".");
                    return true;
                }
            }
        
            var dicepos = {};
            var resolved = expr.slice();
            for (let i = 0; i < resolved.length; i++) {
                let facets = resolved[i].match(/^([1-9][0-9]?)?d([1-9][0-9]?)$/);
                if (facets) {
                    let val = 0;
                    for (let j = 0; j < facets[1]; j++) {
                        val += Math.floor(random.fraction() * facets[2]) + 1;
                    }
                    resolved[i] = val;
                    dicepos[i] = true;
                }
            }

            var rep = expr.join(" ");
            
            if (Object.keys(dicepos).length > 0) {
                rep += ' = ' + resolved.map((val, i) => {
                    if (dicepos[i]) {
                        return "__" + val + "__";
                    }
                }).join(" ");
            }
            
            if (resolved.length > 1) {
                let result = resolved[0];
                for (let i = 2; i < resolved.length; i++) {
                    if (resolved[i-1] == "+") {
                        result += resolved[i];
                    } else if (resolved[i-1] == "-") {
                        result -= resolved[i];
                    }
                }
                rep += ' = **' + result;
            }

            ep.reply(env.idToDisplayName(userid) + ': ' + rep);
        
            return true;
        });
        
      
        return true;
    };

}


module.exports = ModRandom;

