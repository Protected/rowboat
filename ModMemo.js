/* Module: Memo -- Save a public message for another user to be auto-delivered on activity. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');
var moment = require('moment');

class ModMemo extends Module {


    get optionalParams() { return [
        'datafile',
        'permission'            //Permission required for !memo
    ]; }
    
    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Memo', name);
        
        this._params['datafile'] = 'memo.data.json';
        
        //Main: List of {id: #, ts, from: {env, handle, display, userid}, recipients: [{env, handle, display, userid, auth}, ...], strong: true/false, msg: "text"}
        this._memo = [];
        
        //Indices
        this._memoId = {};
        this._memoFromHandle = {};
        this._memoFromUserid = {};  //ENV: {...}, ...
        this._memoToHandle = {};
        this._memoToDisplay = {};  //ENV: {...}, ...
        this._memoToUserid = {};  //ENV: {...}, ...
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
       
        //Load data
        
        if (!this.loadMemos()) return false;
        

        //Register callbacks
        
        for (var envname in envs) {
            envs[envname].registerOnJoin(this.onJoin, this);
            envs[envname].registerOnMessage(this.onMessage, this);
        }

        
        this.mod("Commands").registerCommand('memo', {
            description: "Send or cancel a memo. Action: save or strongsave. Descriptor: [{env}] (=handle|[+]displayname|[+]id) [& ...] message ...",
            args: ["action", "descriptor", true],
            minArgs: 2,
            permissions: (this.param('permission') ? [this.param('permission')] : null)
        }, (env, type, userid, command, args, handle, reply) => {
            
            if (args.action == "save" || args.action == "strongsave") {
            
                //TODO
                
            } else if (args.action == "cancel") {
            
                //TODO
            
            } else if (args.action == "outbox") {
            
                //TODO
            
            } else {
                reply("I don't recognize that action.");
            }
            
            return true;
        });
        
        return true;
    }
    
    
    // # Module code below this line #


    //Memo file manipulation

    loadMemos() {
        var datafile = this.param('datafile');
     
        try {
            fs.accessSync(datafile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(datafile, {});
        }

        try {
            this._memo = jsonfile.readFileSync(datafile);
        } catch (e) {
            return false;
        }
        if (!this._memo) this._memo = [];
        
        //Build indices
        
        //TODO
        
        return true;
    }

    saveMemos() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFileSync(datafile, this._activitydata);
    }
    
    
    //Indexation helpers
    
    indexId(register) {
        if (!register || !register.id) return false;
        
        //TODO
        
        return true;
    }
    
    indexFromHandle(register) {
        if (!register || !register.id) return false;

        //TODO
        
        return true;    
    }
    
    indexFromUserid(env, register) {
        if (!register || !register.id) return false;

        //TODO
        
        return true;
    }
    
    indexToHandle(register) {
        if (!register || !register.id) return false;

        //TODO
        
        return true;
    }
    
    indexToDisplay(env, register) {
        if (!register || !register.id) return false;

        //TODO
        
        return true;
    }
    
    indexToUserid(env, register) {
        if (!register || !register.id) return false;

        //TODO
        
        return true;
    }
    
    
    //Event handlers
    
    onJoin(env, authorid, channelid, rawobj) {
        //TODO
    }
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        //TODO
    }
    
    
}


module.exports = ModMemo;
