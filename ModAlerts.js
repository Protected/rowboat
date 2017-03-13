/* Module: Random -- Adds a command, "random", which outputs a random number. */

var Module = require('./Module.js');
var _ = require('lodash');
var jf = require('jsonfile');
var fs = require('fs');

class ModAlerts extends Module {

    get RequiredModules() {
        return [
            'Commands'
        ];
    }


    constructor(name) {
        super('Alerts', name);
        this.dataFileName = 'alerts.data.json';
        this.data = {};
    }

    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        this.loadData();

        let self = this;



        //Register callbacks
        this.mod('Commands').registerCommand('alert', {
            description: "Configures alerts.",
            args: ["action","pattern","message",true],
            minArgs: 1
        }, (env, type, userid, command, args, handle, reply, pub) => {

            switch(args["action"]){
                case "list": doList(env, type, userid, command, args, handle, reply, pub); break;
            }


            return true;
        });

        function doList(env, type, userid, command, args, handle, reply, pub) {
            let players, rules;
            if ( !this.data[env] ) {
                replyEmptyList(reply);
                return;
            }
            players = this.data[env];

            if ( !players[userid] ) {
                replyEmptyList(reply);
                return;
            }
            rules = players[userid];

            if ( Object.keys(rules).length == 0 ) {
                replyEmptyList(reply);
                return;
            }

            reply("List of alerts: ");
            for( let pattern in rules ){
                if (rules.hasOwnProperty(pattern)) {
                    reply(pattern + " -> " + rules[pattern]);
                }
            }
        }


        function replyEmptyList(reply){
            reply("You have no alerts.");
        }

        return true;
    };

    saveData() {
        jf.writeFileSync(this.dataFileName, this.data);
    }

    loadData() {
        try {
            fs.accessSync(this.dataFileName, fs.F_OK);
        } catch (e) {
            jf.writeFileSync(this.dataFileName, {});
        }

        try {
            this.data = jf.readFileSync(this.dataFileName);
        } catch(e) {
        }
    }

}


module.exports = ModAlerts;

