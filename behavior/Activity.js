import moment from 'moment';

import Behavior from '../src/Behavior.js';

export default class Activity extends Behavior {

    get description() { return "Commands for checking a user's most recent activity/presence"; }

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        {n: 'linesPerUser', d: "Amount of lines per user to keep (for !last)"},
        {n: 'channelblacklist', d: "List of [[environment, channelid], ...] of the channels to be ignored"}
    ]; }

    get defaults() { return {
        datafile: null,
        linesPerUser: 5,
        channelblacklist: []
    }; }
    
    get requiredBehaviors() { return {
        Users: "Users",
        Commands: "Commands"
    }; }

    constructor(name) {
        super('Activity', name);
        
        //Main map: {ENV => {NICKNAME => {REGISTER}, ...}, ...}
        this._activitydata = {};
        
        //Indices
        this._authorseen = {};
        this._authorspoke = {};
        
        //Timer
        this._activitysaver = null;
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;
       
        //Load data
        
        this._activitydata = this.loadData(null, null, {quiet: true});
        if (this._activitydata === false) return false;
        
        for (let envname in this._activitydata) {
            for (let nicknamelc in this._activitydata[envname]) {
                let register = this._activitydata[envname][nicknamelc];
                this.authorSeen(envname, register);
                this.authorSpoke(envname, register);
            }
        }

        var self = this;
        this._activitysaver = setInterval(() => {
            self._activitydata.save();
        }, 30000);


        //Register callbacks
        
        this.env().on('join', this.onJoin, this);
        this.env().on('part', this.onPart, this);
        this.env().on('message', this.onMessage, this);

        
        this.be("Commands").registerCommand(this, 'seen', {
            description: "Reports when a user was last seen (or if the user was never seen).",
            args: ["nickname", "environment"],
            details: ["Prefix NICKNAME with = to reference a local user account instead."],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
            
            let envobj = null;
            let envname = args.environment;
            if (!envname) {
                envname = env.name;
                envobj = env;
            } else {
                envobj = this.env(envname);
            }
                
            let register = null;
            
            if (args.nickname[0] == "=") {
                //Lookup by handle
            
                for (let id in this._authorseen[envname]) {
                    let validate = await this.be("Users").isIdHandle(args.nickname.substr(1), envname, id);
                    if (validate) {
                        if (!register || this._authorseen[envname][id].seen[2] > register.seen[2]) {
                            register = this._authorseen[envname][id];
                        }
                    }
                }
                
            } else {
                //Lookup by nickname
                
                if (this._activitydata[envname]) {
                    let check = this._activitydata[envname][args.nickname.toLowerCase()];
                    if (check) register = check;
                }
                
            }
            
            if (!register) {
                ep.reply("I have never seen __" + args.nickname + "__ in *" + envname + "*.");
            } else if (register.seenreason === true) {
                ep.reply("__" + args.nickname + "__ joined *" + envobj.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + ".");
            } else if (register.seenreason === false) {
                ep.reply("__" + args.nickname + "__ talked in *" + envobj.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + ".");
            } else {
                let reason = 'unknown';
                if (typeof register.seenreason == "object") {
                    reason = register.seenreason[0];
                    if (register.seenreason[1]) reason += ' (' + register.seenreason[1] + ')';
                }
                ep.reply("__" + args.nickname + "__ left *" + envobj.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + " (reason: " + reason + ").");
            }
            
            return true;
        });
        
        
        this.be("Commands").registerCommand(this, 'last', {
            description: "Repeats a user's latest chat lines in record.",
            args: ["nickname", "environment"],
            details: ["Prefix NICKNAME with = to reference a local user account instead."],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let envobj = null;
            let envname = args.environment;
            if (!envname) {
                envname = env.name;
                envobj = env;
            } else {
                envobj = this.env(envname);
            }
            
            let entries = [];
            
            if (args.nickname[0] == "=") {
                //Lookup by handle
            
                for (let id in this._authorspoke[envname]) {
                    let validate = await this.be("Users").isIdHandle(args.nickname.substr(1), envname, id);
                    if (validate) {
                        for (let entry of this._authorspoke[envname][id]) {
                            entries.push(entry);
                        }
                    }
                }
            
            } else {
                //Lookup by nickname
                
                if (this._activitydata[envname]) {
                    let check = this._activitydata[envname][args.nickname.toLowerCase()];
                    if (check) entries = check.last;
                }
                
            }
            
            entries = entries.slice(-1 * this.param('linesPerUser'));
            
            if (!entries.length) {
                ep.reply("I have never read anything by " + args.nickname + " in " + envname + ".");
            } else {
                ep.reply('Latest lines of ' + args.nickname + ' in ' + envname + ':');
                for (let entry of entries) {
                    ep.reply('[' + envobj.channelIdToDisplayName(entry[0]) + '] (' + moment.unix(entry[2]).format('ddd YYYY-MM-DD HH:mm:ss') + ') ' + entry[3]);
                }
            }
            
            return true;
        });
        
        
        this.be("Commands").registerCommand(this, 'roleseen', {
            description: "Short activity report for a role.",
            args: ["role"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let role = env.server.roles.cache.find(r => r.name == args.role);
            let registers = {};
            
            for (let member of role.members.values()) {
                if (this._authorseen[env.name]) {
                    let nickname = (member.nickname || member.user.username);
                    let check = this._authorseen[env.name][member.id];
                    if (check) registers[nickname] = check;
                    else registers[nickname] = null;
                }
            }
            
            for (let nickname in registers) {
                let register = registers[nickname];
                if (!register) {
                    ep.reply("__" + nickname + "__: Never seen.");
                } else if (register.seenreason === true) {
                    ep.reply("__" + nickname + "__: Joined *" + env.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + ".");
                } else if (register.seenreason === false) {
                    ep.reply("__" + nickname + "__: Talked in *" + env.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + ".");
                } else {
                    let reason = 'unknown';
                    if (typeof register.seenreason == "object") {
                        reason = register.seenreason[0];
                        if (register.seenreason[1]) reason += ' (' + register.seenreason[1] + ')';
                    }
                    ep.reply("__" + nickname + "__: Left *" + env.channelIdToDisplayName(register.seen[0]) + "* " + moment.unix(register.seen[2]).fromNow() + ".");
                }
            }
            
            return true;
        });

        
        return true;
    }
    
    
    // # Module code below this line #


    //Activity file manipulation
    
    getNickRegister(env, nickname) {
        let envregister = this._activitydata[env];
        if (!envregister) envregister = this._activitydata[env] = {};
        
        let nickregister = envregister[nickname.toLowerCase()];
        if (!nickregister) nickregister = envregister[nickname.toLowerCase()] = {
            nickname: nickname,
            seen: null,  //[channelid, authorid, timestamp]
            seenreason: null,
            last: []  //Each entry: [channelid, authorid, timestamp, message]
        };
        
        return nickregister;
    }

    getAllNickRegisters(env) {
        let envregister = this._activitydata[env];
        if (!envregister) envregister = this._activitydata[env] = {};
        return Object.values(envregister);
    }

    
    
    //Helpers for indexing registers by author (used only in runtime)
    
    authorSeen(env, register) {
        if (!register || !register.seen) return false;
        let authorid = register.seen[1];
        
        let envindex = this._authorseen[env];
        if (!envindex) envindex = this._authorseen[env] = {};
        
        if (!envindex[authorid] || register.seen[2] > envindex[authorid].seen[2]) {
            envindex[authorid] = register;
        }
        return true;
    }
    
    authorSpoke(env, register) {
        if (!register || !register.last || !register.last.length) return false;
        
        let envindex = this._authorspoke[env];
        if (!envindex) envindex = this._authorspoke[env] = {};
        
        for (let entry of register.last) {
            let authorid = entry[1];
            if (!envindex[authorid]) envindex[authorid] = [];
            envindex[authorid].push(entry);
        }
        return true;
    }
    
    
    //Event handlers
    
    onJoin(env, authorid, channelid, rawobj) {
        if (this.param('channelblacklist').find(item => item[0] == env.name && item[1] == channelid)) return;
        
        let nickname = env.idToDisplayName(authorid);
        let register = this.getNickRegister(env.name, nickname);
        
        register.seen = [channelid, authorid, moment().unix()];
        register.seenreason = true;
        
        this.authorSeen(env.name, register);
    }
    
    
    onPart(env, authorid, channelid, rawobj) {
        if (this.param('channelblacklist').find(item => item[0] == env.name && item[1] == channelid)) return;
        
        let nickname = env.idToDisplayName(authorid);
        let register = this.getNickRegister(env.name, nickname);
        
        register.seen = [channelid, authorid, moment().unix()];
        register.seenreason = rawobj.reason;
        
        this.authorSeen(env.name, register);
    }
    
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (this.param('channelblacklist').find(item => item[0] == env.name && item[1] == channelid)) return;
        
        let nickname = env.idToDisplayName(authorid);
        let register = this.getNickRegister(env.name, nickname);
        let ts = moment().unix();
        
        register.seen = [channelid, authorid, ts];
        register.seenreason = false;
        
        this.authorSeen(env.name, register);
        
        register.last.push([channelid, authorid, ts, message]);
        while (register.last.length > this.param('linesPerUser')) {
            register.last.shift();
        }
        
        this.authorSpoke(env.name, register);
    }
    
    
}
