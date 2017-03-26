/* Module: Alerts -- Adds a command, "alert", which allows users to specify alert patterns. */

var Module = require('./Module.js');
var jf = require('jsonfile');
var fs = require('fs');

class ModAlerts extends Module {


    get optionalParams() { return [
        'datafile'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Alerts', name);
        
        this._params['datafile'] = 'alerts.data.json';
        
        this._data = {};
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._params['datafile'] = this.dataPath() + this._params['datafile'];
        this.loadData();

        for (var envname in opt.envs) {
            opt.envs[envname].on('messageSent', this.onMessageSent, this);
        }

        //Register callbacks
        
        this.mod('Commands').registerCommand(this, 'alert', {
            description: "Configures alerts.",
            args: ["action", "pattern", "message", "ttl", true],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            switch(args["action"]) {
                case "list": doList(env, type, userid, channelid, command, args, handle, ep); break;
                case "add": doAdd(env, type, userid, channelid, command, args, handle, ep); break;
                case "del": doDel(env, type, userid, channelid, command, args, handle, ep); break;
                default: {
                    ep.reply("Invalid action.");
                }
            }


            return true;
        });

        var doList = (env, type, userid, channelid, command, args, handle, ep) => {
            let players, rules;
            if (!this._data[env.name]) {
                replyEmptyList(ep.reply);
                return;
            }
            players = this._data[env.name];

            if (!players[userid]) {
                replyEmptyList(ep.reply);
                return;
            }
            rules = players[userid];

            if (Object.keys(rules).length == 0) {
                replyEmptyList(ep.reply);
                return;
            }

            if (rules.length) {
                for (let pattern in rules) {
                    if (rules.hasOwnProperty(pattern)) {
                        ep.reply("`" + pattern + "` -> " + rules[pattern].message + (rules[pattern].ttl > 0 ? " (" + rules[pattern].ttl + ")" : ""));
                    }
                }
            } else {
                replyEmptyList(ep.reply);
            }
        }

        var doAdd = (env, type, userid, channelid, command, args, handle, ep) => {
            let players, rules, ttl;
            if (!this._data[env.name]) {
                this._data[env.name] = {};
            }
            players = this._data[env.name];

            if (!players[userid]) {
                players[userid] = {};
            }

            rules = players[userid];

            if (Array.isArray(args["message"])) {
                args["message"] = args["message"].join(" ");
            }

            if (!args["pattern"]) {
                ep.reply("The pattern can't be empty.");
                return;
            }

            if (!args["message"]) {
                ep.reply("The message can't be empty.");
                return;
            }

            try { new RegExp(args["pattern"]); } catch (e) {
                ep.reply("That pattern is not valid regex.");
                return;
            }

            if (!isNaN(parseInt(args["ttl"]))) {
                ttl = parseInt(args["ttl"]);
            } else {
                ttl = -1;
            }

            rules[args["pattern"]] = {
                message: args["message"],
                ttl: ttl
            };

            this.saveData();

            ep.reply('Saved pattern `' + args["pattern"] + '` with message "' + args["message"] + '"');
        }

        var doDel = (env, type, userid, channelid, command, args, handle, ep) => {
            let players, rules;
            if (!this._data[env.name]) {
                replyPatternNotFound(ep.reply);
                return;
            }
            players = this._data[env.name];

            if (!players[userid]) {
                replyPatternNotFound(ep.reply);
                return;
            }
            rules = players[userid];

            if (!rules[args["pattern"]]) {
                replyPatternNotFound(ep.reply);
                return;
            }

            delete rules[args["pattern"]];

            this.saveData();

            ep.reply('Deleted pattern `' + args["pattern"] + '`');
        }


        var replyEmptyList = (reply) => {
            reply("You have no alerts.");
        }

        var replyPatternNotFound = (reply) => {
            reply("You don't have that pattern.");
        }

        return true;
    };
    
    
    // # Module code below this line #
    

    saveData() {
        var fullPath = this.param('datafile');
        jf.writeFileSync(fullPath, this._data);
    }
    

    loadData() {
        var fullPath = this.param('datafile');
        
        try {
            fs.accessSync(fullPath, fs.F_OK);
        } catch (e) {
            jf.writeFileSync(fullPath, {});
        }

        try {
            this._data = jf.readFileSync(fullPath);
        } catch(e) {
            return false;
        }
        
        if (!this._data) this._data = {};
        
        return true;
    }
    

    onMessageSent(env, type, targetid, message) {
        let dirty = false;

        for (let userid in this._data[env.name]) {
            if (type != "regular" && userid != targetid) continue;
            for (let pattern in this._data[env.name][userid]) {
                let alertData = this._data[env.name][userid][pattern];
                
                if (message.indexOf('`' + pattern + '`') > -1) continue;
                
                if (message.match(pattern)) {

                    env.msg(userid, alertData.message);

                    if (alertData.ttl > 0) {
                        alertData.ttl -= 1;
                        dirty = true;
                    }
                    if (alertData.ttl == 0) {
                        delete this._data[env.name][userid][pattern];
                        dirty = true;
                    }
                }
                
            }
        }

        if (dirty) {
            this.saveData();
        }
    }

}


module.exports = ModAlerts;
