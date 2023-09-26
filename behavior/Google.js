/* Google -- Adds a command, "google", which performs a google search. */

import Behavior from "../src/Behavior.js";

export default class Google extends Behavior {

    get params() { return [
        {n: 'apikey', d: "Create project, enable google CS API and get a key from https://console.developers.google.com/apis/api/"},
        {n: 'cx', d: "Create a CSE and get the cx from the embed code at https://cse.google.com/cse/"},
        {n: 'results', d: "Maximum amount of returned results (1 to 10)"},
        {n: 'safesearch', d: "Enable safesearch"},
        {n: 'googleparams', d: "List of google API parameters allowed as arguments"}
    ]; }
    
    get defaults() { return {
        results: 3,
        safesearch: false,
        googleparams: ['c2coff','cr','dateRestrict','exactTerms','excludeTerms','fileType','gl','highRange','hq',
            'imgColorType','imgSize','imgType','lowRange','relatedSite','searchType','rights','sort','start']
    }; }

    get requiredBehaviors() { return {
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('Google', name);
        
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.be('Commands').registerCommand(this, 'google', {
            description: "Let me google that for you.",
            args: ["string", true],
            details: [
                "Use --PARAM=VALUE before the search string to pass additional Google API parameters to the request.",
                "Allowed parameters: " + this.param('googleparams').join(', '),
                "For details on each parameter: https://developers.google.com/custom-search/json-api/v1/reference/cse/list#parameters"
            ],
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let url = 'https://www.googleapis.com/customsearch/v1?key=' + this.param('apikey') + '&cx=' + this.param('cx')
                    + '&num=' + this.param('results')
                    + '&safe=' + (this.param('safesearch') ? 'high' : 'off')
                    + '&googlehost=google.com&hl=en';

            //Read extra API parameters from arguments

            let extras = {};

            let words = args.string;
            let i;
            for (i = 0; i < words.length; i++) {
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
            
            let search = words.slice(i).join(' ');
            if (!search.length) return false;
            
            for (let key in extras) {
                url += '&' + key + '=' + encodeURI(extras[key]);
            }
            
            if (search) url += '&q=' + encodeURI(search);
            
            //Perform API request

            try {
                let body = await this.jsonget(url);

                let items = body.items;
                if (!items || !items.length) {
                    ep.reply("No results found!");
                } else {
                    for (let j = 0; j < items.length && j < this.param('results'); j++) {
                        ep.reply(items[j]['title'] + ' - ' + items[j]['link']);
                    }
                }
            } catch (e) {
                this.log('warn', e);
                ep.reply("There was an error while attempting to query the Google API.");
            }

            return true;
        });
      
        return true;
    };

}

