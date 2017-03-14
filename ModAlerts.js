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
        this.mod('Commands').registerCommand(this, 'alert', {
            description: "Configures alerts.",
            args: ["action","pattern","message",true],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            switch(args["action"]){
                case "list": doList(env, type, userid, channelid, command, args, handle, ep); break;
                case "add": doAdd(env, type, userid, channelid, command, args, handle, ep); break;
                case "del": doDel(env, type, userid, channelid, command, args, handle, ep); break;
                default: {
                    ep.reply("Invalid action.");
                }
            }


            return true;
        });

        function doList(env, type, userid, channelid, command, args, handle, ep) {
            let players, rules;
            if ( !self.data[env.name] ) {
                replyEmptyList(ep.reply);
                return;
            }
            players = self.data[env.name];

            if ( !players[userid] ) {
                replyEmptyList(ep.reply);
                return;
            }
            rules = players[userid];

            if ( Object.keys(rules).length == 0 ) {
                replyEmptyList(ep.reply);
                return;
            }

            ep.reply("List of alerts: ");
            for( let pattern in rules ){
                if (rules.hasOwnProperty(pattern)) {
                    ep.reply(pattern + " -> " + rules[pattern]);
                }
            }
        }

        function doAdd(env, type, userid, channelid, command, args, handle, ep) {
            let players, rules;
            if ( !self.data[env.name] ) {
                self.data[env.name] = {};
            }
            players = self.data[env.name];

            if ( !players[userid] ) {
                players[userid] = {};
            }

            rules = players[userid];

            if ( !args["pattern"] ){
                ep.reply("The pattern can't be empty.");
                return;
            }

            if ( !args["message"] ){
                ep.reply("The message can't be empty.");
                return;
            }

            rules[args["pattern"]] = args["message"];

            self.saveData();

            ep.reply("Saved pattern \""+args["pattern"]+"\" with message \""+args["message"]+"\"");
        }

        function doDel(env, type, userid, channelid, command, args, handle, ep) {
            let players, rules;
            if ( !self.data[env.name] ) {
                replyPatternNotFound(ep.reply);
                return;
            }
            players = self.data[env.name];

            if ( !players[userid] ) {
                replyPatternNotFound(ep.reply);
                return;
            }
            rules = players[userid];

            if ( !rules[args["pattern"]] ){
                replyPatternNotFound(ep.reply);
                return;
            }

            delete rules[args["pattern"]];

            self.saveData();

            ep.reply("Deleted pattern \""+args["pattern"]+"\"");
        }


        function replyEmptyList(reply){
            reply("You have no alerts.");
        }

        function replyPatternNotFound(reply){
            reply("You don't have that pattern.");
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

