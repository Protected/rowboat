/* Module: Alpha -- Adds a command, "alpha", which performs a Wolfram Alpha query. */

var Module = require('./Module.js');
var wolfram = require('wolfram-alpha');

class ModAlpha extends Module {

    get requiredParams() { return [
        'apikey'                //Create a WA developer account: https://developer.wolframalpha.com/portal/
    ]; }
    
    get optionalParams() { return [
        'maxresults'               //Maximum amount of returned results
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Alpha', name);
        
        this._params['maxresults'] = 8;
        
        this._client = null;
        this._cache = {};
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        this._client = wolfram.createClient(this.param('apikey'));
      
      
        //Register callbacks
        
        this.mod('Commands').registerCommand(this, 'alpha', {
            description: "Computational knowledge engine.",
            args: ["string", true],
            minArgs: 1,
            types: ["regular"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let maxresults = 1;
            let countmatch = args.string[0].match(/^\(([1-9][0-9]*)\)$/);
            if (countmatch) {
                maxresults = Math.min(this.param('maxresults'), parseInt(countmatch[1]));
                args.string.shift();
            }
            
            if (!args.string.length || maxresults < 1) return false;
            
            let question = args.string.join(" ").trim();
            
            
            let showresults = (results, maxresults) => {
                if (!results || !results.length) {
                    ep.reply("No results.");
                    return;
                }
                
                let trueresults = [];
                let foundprimary = false;
                for (let i = 0; i < results.length && i < maxresults; i++) {
                    trueresults.push(results[i]);
                    if (results[i].primary) foundprimary = true;
                }
                
                if (!foundprimary) {
                    let primary = results.find((result) => result.primary);
                    if (primary) {
                        trueresults.push(primary);
                        foundprimary = true;
                    }
                }
                if (!foundprimary && results[maxresults]) {
                    trueresults.push(results[maxresults]);
                }
                
                ep.reply("Your query: '" + question + "'");
                
                let shownpics = {};

                for (let result of trueresults) {
                    ep.reply("**__" + result.title + "__**" + (maxresults > 1 && result.primary ? ' (P)' : ''));
                    for (let subpod of result.subpods) {
                        if (subpod.text.trim()) {
                            ep.reply("```\n" + subpod.text + "\n```");
                        } else if (subpod.image && !shownpics[subpod.image]) {
                            ep.reply(subpod.image);
                            shownpics[subpod.image] = true;
                        }
                    }
                }
            };
            
            
            if (!this._cache[question] || this._cache[question].length <= maxresults) {
                ep.reply(env.idToDisplayName(userid) + ': Please wait...');
                this._client.query(question)
                    .then((results) => {
                        this._cache[question] = results;
                        showresults(results, maxresults);
                    })
                    .catch((e) => {
                        this.log('error', e);
                        ep.reply("Error processing results.");
                    });
            } else {
                ep.reply(env.idToDisplayName(userid) + ': Showing cached results...');
                showresults(this._cache[question], maxresults);
            }
        
            return true;
        });
      
        return true;
    };

}


module.exports = ModAlpha;
