/* Module: Alerts -- Adds a command, "alert", which allows users to specify alert patterns. */

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

        this.dataPath = this._globalConfig["paths"] ? this._globalConfig["paths"].data : ".";

        this.loadData();

        let self = this;

        for (var envname in envs) {
            envs[envname].on('messageSent', this.onMessageSent, this);
        }

        //Register callbacks
        this.mod('Commands').registerCommand(this, 'alert', {
            description: "Configures alerts.",
            args: ["action","pattern","message", "ttl",true],
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
                    ep.reply("`" + pattern + " -> " + rules[pattern].message + " ("+rules[pattern].ttl+")`");
                }
            }
        }

        function doAdd(env, type, userid, channelid, command, args, handle, ep) {
            let players, rules, ttl;
            if ( !self.data[env.name] ) {
                self.data[env.name] = {};
            }
            players = self.data[env.name];

            if ( !players[userid] ) {
                players[userid] = {};
            }

            rules = players[userid];

            if ( Array.isArray(args["message"]) ) {
                args["message"] = args["message"].join(" ");
            }

            if ( !args["pattern"] ){
                ep.reply("The pattern can't be empty.");
                return;
            }

            if ( !args["message"] ){
                ep.reply("The message can't be empty.");
                return;
            }

            try { new RegExp(args["pattern"]); } catch (e) { ep.reply("That pattern is not valid regex."); return; }

            if ( !isNaN(parseInt(args["ttl"])) ){
                ttl = parseInt(args["ttl"]);
            } else {
                ttl = -1;
            }

            rules[args["pattern"]] = {
                message: args["message"],
                ttl: ttl
            };

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
        let fullPath = this.dataPath + this.dataFileName;
        jf.writeFileSync(fullPath, this.data);
    }

    loadData() {
        let fullPath = this.dataPath + this.dataFileName;
        try {
            fs.accessSync(fullPath, fs.F_OK);
        } catch (e) {
            jf.writeFileSync(fullPath, {});
        }

        try {
            this.data = jf.readFileSync(fullPath);
        } catch(e) {
        }
    }

    onMessageSent(env, type, targetId, message) {
        if (type != "regular") return;

        let self = this;
        let envData = this.data[env.name];
        let dirty = false;

        _.each(envData, function(userData, userID) {
            _.each(userData, function(alertData, pattern){
                try {
                    if (message.match(pattern)) {
                        dirty = true;
                        //Send message
                        env.msg(userID, alertData.message);

                        if (alertData.ttl > 0) {
                            alertData.ttl -= 1;
                        }
                        if (alertData.ttl == 0) {
                            delete self.data[env.name][userID][pattern];
                        }
                    }
                } catch (e) {
                    env.msg(userID, "Pattern `"+pattern+"` is failing! Please remove it ASAP.");
                }
            });
        });

        if ( dirty ) {
            this.saveData();
        }
    }

}


module.exports = ModAlerts;

