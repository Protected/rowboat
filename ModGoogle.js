/* Module: Google -- Adds a command, "google", which performs a google search. */

var Module = require('./Module.js');
var request = require('request');

class ModGoogle extends Module {

    get requiredParams() { return [
        'apikey',               //Create project, enable google CS API and get a key from https://console.developers.google.com/apis/api/
        'cx'                    //Create a CSE and get the cx from the embed code at https://cse.google.com/cse/
    ]; }
    
    get optionalParams() { return [
        'results',              //Maximum amount of returned results (1 to 10)
        'safesearch',           //Enable safesearch
        'googleparams'          //List of allowed google API parameters. Syntax: !google --param=value ... searchstring
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Google', name);
        
        this._params['results'] = 3;
        this._params['safesearch'] = false;
        this._params['googleparams'] = ['c2coff','cr','dateRestrict','exactTerms','excludeTerms','fileType','gl','highRange','hq',
                'imgColorType','imgSize','imgType','lowRange','relatedSite','searchType','rights','sort','start'];
        
    }
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand('google', {
            description: "Let me google that for you.",
            args: ["string", true],
            types: ["regular"],
            permissions: ["trusted","administrator"]
        }, (env, type, userid, command, args, handle, reply) => {
        
            var url = 'https://www.googleapis.com/customsearch/v1?key=' + this.param('apikey') + '&cx=' + this.param('cx')
                    + '&num=' + this.param('results')
                    + '&safe=' + (this.param('safesearch') ? 'high' : 'off')
                    + '&googlehost=google.com&hl=en';

            //Read extra API parameters from arguments

            var extras = {};

            var words = args.string;
            for (var i = 0; i < words.length; i++) {
                let word = words[i];
                if (word.indexOf("--") < 0) break;
                if (word == "--") {
                    i += 1;
                    break;
                }
                
                let parts = /^--([a-zA-Z0-9]+)=(.*)$/.exec(word);
                let key = parts[1];
                if (!key) continue;
                if (this.param('googleparams').indexOf(parts[1]) < 0) continue;
                
                let value = parts[2];
                while (value.match(/^".*[^"]$/) && i < words.length) {
                    i += 1;
                    value = value + ' ' + words[i];
                }
                
                if (!value.length) continue;
                extras[key] = value;
            }
            
            //Complete URL for API request
            
            var search = words.slice(i).join(' ');
            if (!search.length) return false;
            
            for (let key in extras) {
                url += '&' + key + '=' + encodeURI(extras[key]);
            }
            
            if (search) url += '&q=' + encodeURI(search);
            
            //Perform API request
        
            request(url, (error, response, body) => {
                if (error) {
                    this.log('warn', error);
                    return true;
                }
                try {
                    let items = JSON.parse(body)['items'];
                    if (!items || !items.length) {
                        reply("No results found!");
                    } else {
                        for (let j = 0; j < items.length && j < this.param('results'); j++) {
                            reply(items[j]['title'] + ' - ' + items[j]['link']);
                        }
                    }
                } catch (err) {
                    this.log('warn', err);
                }
                return true;
            });
        
            return true;
        });
      
        return true;
    };

}


module.exports = ModGoogle;

