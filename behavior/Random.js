/* Random -- Adds randomizer, shuffle and dice roll commands. */

import random from 'meteor-random';

import Behavior from '../src/Behavior.js';

export default class Random extends Behavior {

    get requiredBehaviors() { return {
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('Random', name);

    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.be('Commands').registerCommand(this, 'random', {
            description: "Generates a random number using a cryptographically secure source of randomness.",
            args: ["max", "pub"],
            details: [
                "If MAX is not passed, a floating point number between 0 and 1 is returned.",
                "If MAX is a positive integer, an integer between 0 and MAX is returned.",
                "Pass PUB as 1 to display the resulting random number in public even if you used the command in private."
            ],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let val;
        
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
        
        
        this.be('Commands').registerCommand(this, 'shuffle', {
            description: "Knuth shuffles a list or a deck of cards using a cryptographically secure source of randomness.",
            args: ["items", true],
            details: [
                "ITEMS is a list of items to shuffle separated by spaces. Special syntaxes: ",
                "  #deck# - Expand to 52-card deck.",
                "  #deck#RANKS# - Expand to restricted 52-card deck, where RANKS can be: A234567890JQK ."
            ],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let items = this.cleanupItems(args.items);
            items = this.shuffle(items);
            ep.reply(env.idToDisplayName(userid) + ": " + items.join(" "));
            
            return true;
        });


        this.be('Commands').registerCommand(this, 'pick', {
            description: "Picks a random item from a set using a cryptographically secure source of randomness.",
            args: ["items", true],
            details: [
                "ITEMS is the set of items to pick from separated by spaces. Special syntaxes: ",
                "  #deck# - Expand to 52-card deck.",
                "  #deck#RANKS# - Expand to restricted 52-card deck, where RANKS can be: A234567890JQK ."
            ],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let items = this.cleanupItems(args.items);
            let pick = items[Math.floor(random.fraction() * items.length)];
            ep.reply(env.idToDisplayName(userid) + ": " + pick);
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'roll', {
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
        
            let expr = args.expr.join(" ").replace(/(\+ *-|- *\+)/g, '-').replace(/([0-9])([+-])/g, '$1 $2').replace(/([+-])([0-9])/g, '$1 $2').replace(/ +/g, " ").split(" ");
            for (let i = 1; i < expr.length; i += 2) {
                if (expr[i] != "-" && expr[i] != "+") {
                    ep.reply("Invalid token '" + expr[i] + "' on position " + i + ".");
                    return true;
                }
            }
        
            //Roll all dice in expression (store expansion if needed)
        
            let dicepos = {};
            let resolved = expr.slice();
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

            let rep = expr.join(" ");
            
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
    
    
    // # Module code below this line #
    
    
    standardDeck(ranks) {
        if (!ranks) ranks = "A234567890JQK";
        if (typeof ranks == "string") ranks = ranks.split("");
        let suits = ['♠', '♥', '♦', '♣'];
        let deck = [];
        for (let suit of suits) {
            for (let rank of ranks) {
                deck.push(rank + suit);
            }
        }
        return deck;
    }
    
    
    shuffle(list) {
        for (let i = list.length; i; i--) {
            let j = Math.floor(random.fraction() * i);
            [list[i - 1], list[j]] = [list[j], list[i - 1]];
        }
        return list;
    }


    cleanupItems(initems) {
        let items = initems;

        //Expand decks
        
        for (let i = 0; i < items.length; i++) {
            let matchdeck = items[i].match(/\#deck\#(([A234567890JQK]+)#)?/i);
            if (!matchdeck) continue;
            let ranks = matchdeck[2];
            if (ranks) ranks = ranks.toUpperCase();
            let deck = this.standardDeck(ranks);
            items = items.slice(0, i).concat(deck, items.slice(i + 1));
            i += deck.length - 1;
        }
        
        //Validate syntax and add generic syntax if needed
        
        items = items.map((item) => item.trim()).filter((item) => !!item || item === 0);
        
        return items;
    }


}
