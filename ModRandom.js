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
                "EXPR is an expression containing sums and subtractions between dice and constants.",
                "  EXPR ::= (DICE | CONSTANT) ((+ | -) EXPR)?",
                "  DICE ::= *? AMOUNT? d FACETS EXCL_LOWEST? EXCL_HIGHEST?",
                "  EXCL_LOWEST ::= \\ 0-9",
                "  EXCL_HIGHEST ::= / 0-9",
                "  The asterisk will expand individual rolls in a DICE expression.",
                "  AMOUNT is the amount of dice in the roll, between 1 and 99 (defaults to 1).",
                "  FACETS is the amount of facets per die in the roll, between 1 and 99."
            ],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            //Normalize expression
        
            var expr = args.expr.join(" ").replace(/(\+ *-|- *\+)/g, '-').replace(/([0-9])([+-])/g, '$1 $2').replace(/([+-])([0-9])/g, '$1 $2').replace(/ +/g, " ").split(" ");
            for (let i = 1; i < expr.length; i += 2) {
                if (expr[i] != "-" && expr[i] != "+") {
                    ep.reply("Invalid token '" + expr[i] + "' on position " + i + ".");
                    return true;
                }
            }
        
            //Roll all dice in expression (store expansion if needed)
        
            var dicepos = {};
            var resolved = expr.slice();
            for (let i = 0; i < resolved.length; i++) {
                let facets = resolved[i].match(/^(\*?)([1-9][0-9]?)?d([1-9][0-9]?)(\\([1-9]))?(\/([1-9]))?$/);
                if (facets) {
                    //Dice
                    let dice = [];
                    for (let j = 0; j < (facets[2] || 1); j++) {
                        let die = Math.floor(random.fraction() * facets[3]) + 1;
                        dice.push(die);
                    }
                    let val;
                    if (facets[5] || facets[7]) {
                        //Exclude highest/lowest
                        if (dice.length - (facets[5] || 0) - (facets[7] || 0) < 1) {
                            ep.reply("Trying to remove too many dice on position " + i + ".");
                            return true;
                        }
                        dice.sort();
                        val = dice.reduce((sum, die, j) => (j >= (facets[5] || 0) && j < (dice.length - (facets[7] || 0)) ? sum + die : sum), 0);
                        if (facets[5]) dice.splice(facets[5], 0, "\\");
                        if (facets[7]) dice.splice(dice.length - facets[7], 0, "/");
                    } else {
                        val = dice.reduce((sum, die) => sum + die, 0);
                    }
                    resolved[i] = val;
                    dicepos[i] = (facets[1] ? dice : true);
                } else if (resolved[i].match(/^[0-9]+$/)) {
                    //Constant
                    resolved[i] = parseInt(resolved[i]);
                }
            }
            
            //Prepare intermediate output

            var rep = expr.join(" ");
            
            if (Object.keys(dicepos).length > 0) {
                rep += '\n    = ' + resolved.map((val, i) => {
                    if (dicepos[i]) {
                        if (dicepos[i] !== true) {
                            return "__" + val + "__ [" + dicepos[i].join(" ") + "]";
                        } else {
                            return "__" + val + "__";
                        }
                    }
                    return val;
                }).join(" ");
            }
            
            //Prepare total and reply
            
            if (resolved.length > 1) {
                let result = resolved[0];
                for (let i = 2; i < resolved.length; i++) {
                    if (resolved[i-1] == "+") {
                        result += resolved[i];
                    } else if (resolved[i-1] == "-") {
                        result -= resolved[i];
                    }
                }
                rep += '\n    = **' + result + '**';
            }

            ep.reply(env.idToDisplayName(userid) + ': ' + rep);
        
            return true;
        });
        
      
        return true;
    };

}


module.exports = ModRandom;

