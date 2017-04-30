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

        
        var replyEmptyList = (reply) => {
            reply("You have no alerts.");
        }

        var replyPatternNotFound = (reply) => {
            reply("You don't have that pattern.");
        }


        //Register callbacks
        
        for (var envname in opt.envs) {
            opt.envs[envname].on('messageSent', this.onMessageSent, this);
        }
        
        
        this.mod('Commands').registerRootDetails(this, 'alert', {description: "View and manipulate bot activity alerts."});
        
        
        this.mod('Commands').registerCommand(this, 'alert list', {
            description: "Lists existing bot activity alerts."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._data[env.name]) {
                replyEmptyList(ep.reply);
                return true;
            }
            
            let userblocks = this._data[env.name];
            if (!userblocks[userid]) {
                replyEmptyList(ep.reply);
                return true;
            }
            
            let rules = userblocks[userid];
            if (Object.keys(rules).length == 0) {
                replyEmptyList(ep.reply);
                return true;
            }

            for (let pattern in rules) {
                if (!rules.hasOwnProperty(pattern)) continue;
                ep.reply("`" + pattern + "` -> " + rules[pattern].message + (rules[pattern].ttl > 0 ? " (" + rules[pattern].ttl + ")" : ""));
            }

            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'alert add', {
            description: "Create a new bot activity alert.",
            args: ["pattern", "message", "ttl"],
            minArgs: 2
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._data[env.name]) {
                this._data[env.name] = {};
            }
            
            let userblocks = this._data[env.name];
            if (!userblocks[userid]) {
                userblocks[userid] = {};
            }

            let rules = userblocks[userid];

            try { new RegExp(args.pattern); } catch (e) {
                ep.reply("This pattern is not valid regex.");
                return true;
            }

            let ttl = null;
            if (!isNaN(parseInt(args.ttl))) {
                ttl = parseInt(args.ttl);
            } else {
                ttl = -1;
            }

            rules[args.pattern] = {
                message: args.message,
                ttl: ttl
            };

            this.saveData();
            ep.reply('Saved pattern `' + args.pattern + '` with message "' + args.message + '"');

            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'alert del', {
            description: "Remove an existing bot activity alert.",
            args: ["pattern"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._data[env.name]) {
                replyPatternNotFound(ep.reply);
                return true;
            }
            
            let userblocks = this._data[env.name];
            if (!userblocks[userid]) {
                replyPatternNotFound(ep.reply);
                return true;
            }
            
            let rules = userblocks[userid];
            if (!rules[args.pattern]) {
                replyPatternNotFound(ep.reply);
                return true;
            }

            delete rules[args.pattern];

            this.saveData();
            ep.reply('Deleted pattern `' + args.pattern + '`');

            return true;
        });
        

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
