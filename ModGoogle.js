/* Module: Google -- Adds a command, "google", which performs a google search. */

var Module = require('./Module.js');
var request = require('request');

class ModGoogle extends Module {

    get requiredParams() { return [
        'apikey',               //Create project, enable google CS API and get a key from https://console.developers.google.com/apis/api/
        'cx'                    //Create a CSE and get the cx from the embed code at https://cse.google.com/cse/
    ]; }

    get RequiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Google', name);
    }
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand('google', {
            description: "Let me google that for you.",
            args: ["string"],
            types: ["regular"],
            permissions: ["trusted","admin"]
        }, (env, type, userid, command, args, handle, reply) => {
        
            request('https://www.googleapis.com/customsearch/v1?key=' + this.param('apikey') + '&cx=' + this.param('cx') + '&q=' + encodeURI(args.string),
                (error, response, body) => {
                    if (error) {
                        //TODO
                        console.log(error);
                        return true;
                    }
                    try {
                        reply(JSON.parse(body)['items'][0]['title'] + ' - ' + JSON.parse(body)['items'][0]['link']);
                    } catch (err) {
                        //TODO
                        console.log(err);
                    }
                    return true;
                }
            );
        
            return true;
        });
      
        return true;
    };

}


module.exports = ModGoogle;

