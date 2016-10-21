/* Module: Memo -- Save a public message for another user to be auto-delivered on activity. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');
var moment = require('moment');

class ModMemo extends Module {


    get optionalParams() { return [
        'datafile',
        'permission',           //Permission required for !memo
        'outboxSize',           //Maximum undelivered memos
        'inboxDisplaySize',     //Maximum recent memos to display
        'inboxTsCutoff',        //How recent memos must be to be in the inbox (seconds)
        'tsFormat'              //How to format timestamps (moment.js)
    ]; }
    
    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Memo', name);
        
        this._params['datafile'] = 'memo.data.json';
        this._params['outboxSize'] = 10;
        this._params['inboxDisplaySize'] = 10;
        this._params['inboxTsCutoff'] = 2592000;  //30 days
        this._params['tsFormat'] = "ddd MMM D HH:mm:ss";
        
        //Main: Map of #: {id: #, ts, from: {env, handle, display, userid}, to: [{env, handle, display, userid, auth}, ...], strong: true/false, msg: "text"}
        this._memo = {};
        this._nextId = 1;
        
        //Indices
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
            description: "Send or cancel a message. Actions: 'save|strongsave [{env}] (=handle|[+]displayname|[+]userid) [& ...] message ...', 'cancel ID', 'outbox', 'inbox'",
            args: ["action", "descriptor", true],
            minArgs: 2,
            permissions: (this.param('permission') ? [this.param('permission')] : null),
            unobtrusive: true
        }, (env, type, userid, command, args, handle, reply, pub, priv) => {
            
            if (!env.idIsAuthenticated(userid)) {
                reply("Your environment (" + env.name + ") ID is not authenticated. Only authenticated users can use this command.");
            }
            
            if (args.action == "save" || args.action == "strongsave") {
                //Send a memo to one or more recipients
            
                let elements = this.parseDescriptor(env.name, args.descriptor);
                
                if (elements.error) {
                    if (elements.error == 1) {
                        priv("Malformed recipient: Environment doesn't exist or missing target user.");
                    } else if (elements.error == 2) {
                        priv("User account not found: " + elements.subject);
                    } else {
                        priv("Parse error " + elements.error);
                    }
                    return true;
                }
                
                if (!elements.message || !elements.to.length) {
                    priv("Please include a message to be delivered and at least one recipient.");
                    return true;
                }
                
                if (this.createOutbox(env.name, userid, handle).length >= this.param("outboxSize")) {
                    priv("Your outbox is full. Please cancel one or more pending messages or wait for them to be delived.");
                    return true;
                }
                
                let register = {
                    id: this._nextId++,
                    ts: moment().unix(),
                    from: {
                        env: env.name,
                        handle: handle,
                        display: env.idToDisplayName(userid),
                        userid: userid
                    },
                    to: elements.to,
                    strong: (args.action == "strongsave"),
                    msg: elements.message
                };
                
                this._memo[register.id] = register;
                this.indexFromHandle(register);
                this.indexFromUserid(register);
                this.indexToHandle(register);
                this.indexToDisplay(register);
                this.indexToUserid(register);
                
                priv("Your message has successfully been scheduled for delivery with the ID **" + register.id + "**.");
                
                this.saveMemos();
                
            } else if (args.action == "cancel") {
                //Cancel a memo or remove all undelivered recipients
            
                let id = parseInt(args.descriptor);
                if (id == NaN) {
                    priv("Please provide the numeric ID of the message you wish to cancel.");
                    return true;
                }
                
                let register = this._memo[id];
                if (!register || (register.from.env != env.name || register.from.userid != userid) && (!register.from.handle || register.from.handle != handle)) {
                    priv("You do not have a message with the ID " + id);
                    return true;
                }
                
                let delivered = register.to.filter((recipient) => recipient.done);
                
                if (delivered.length == register.to.length) {
                    priv("The message with the ID **" + id + "** has already been delivered!");
                } else if (delivered.length) {
                    register.to = delivered;
                    priv("The message with the ID **" + id + "** had already been delivered to " + delivered.length + " recipient" + (delivered.length != 1 ? "s" : "") + ". All undelivered recipients were removed.");
                } else {
                    this.removeFromIndices(register);
                    delete this._memo[register.id];
                    priv("The message with the ID **" + id + "** was successfully canceled.");
                }
                
                this.saveMemos();
            
            } else if (args.action == "outbox") {
                //Obtain information on memos I sent
            
                let id = parseInt(args.descriptor);
                if (id == NaN) {
            
                    let outbox = this.createOutbox(env.name, userid, handle).slice(0, this.param("outboxSize"));
                    
                    for (let register in outbox) {
                        let delivered = register.to.filter((recipient) => recipient.done).length;
                        priv("(**" + register.id + "**) " + moment(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + " [Delivery: " + delivered + "/" + register.to.length + "]");
                    }
                    
                } else {
                
                    let register = this._memo[id];
                    if (!register || (register.from.env != env.name || register.from.userid != userid) && (!register.from.handle || register.from.handle != handle)) {
                        priv("You have not sent a message with the ID " + id);
                        return true;
                    }
                    
                    priv("(**" + register.id + "**) " + (register.strong ? "[S] " : "") + register.msg);
                    priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment(register.ts).format(this.param('tsFormat')));
                    
                    for (let recipient of register.to) {
                        priv("  " + (recipient.done ? "**DELIVERED**" : "Pending") + " To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "")));
                    }
                
                }

            } else if (args.action == "inbox") {
                //Obtain information on memos I received
            
                let changes = 0;
                let display = env.idToDisplayName(userid);
                let isauth = env.idIsAuthenticated(userid);

            
                let id = parseInt(args.descriptor);
                if (id == NaN) {
                
                    let inbox = this.createInbox(env.name, userid, display, handle, isauth, this.param("inboxTsCutoff")).slice(0, this.param("inboxDisplaySize"));
                    
                    for (let register in inbox) {
                        let isnew = this.markMemoAsDelivered(register, env.name, userid, display, handle, isauth);
                        if (isnew) changes += 1;
                        priv("(**" + register.id + "**) " + moment(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + (isnew ? " [NEW]" : ""));
                    }
                    
                } else {
                
                    let register = this._memo[id];
                    if (!register) {
                        priv("You have not received a message with the ID " + id);
                        return true;
                    }

                    let recipients = getMatchingRecipients(register, env.name, userid, display, handle, isauth);
                    if (!recipients.length) {
                        priv("You have not received a message with the ID " + id);
                        return true;
                    }
                
                    let isnew = false;
                    for (let recipient of recipients) {
                        if (!recipient.done) {
                            isnew = true;
                            changes += 1;
                            recipient.done = moment().unix();
                        }
                    }
                    
                    priv("(**" + register.id + "**) " + (register.strong ? "[S] " : "") + register.msg);
                    priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment(register.ts).format(this.param('tsFormat')));
                    
                    for (let recipient of recipients) {
                        priv("  (Delivered " + moment(recipient.done).format(this.param('tsFormat')) + ") To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "")));
                    }
                
                }
                
                if (changes) this.saveMemos();
                        
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
        if (!this._memo) this._memo = {};
        
        //Next ID
        
        this._nextId = Object.keys(this._memo).reduce((highestId, id) => Math.max(highestId, id), 0) + 1;
        
        //Build indices
        
        for (let id in this._memo) {
            let register = this._memo[id];
            this.indexFromHandle(register);
            this.indexFromUserid(register);
            this.indexToHandle(register);
            this.indexToDisplay(register);
            this.indexToUserid(register);
        }
        
        return true;
    }

    saveMemos() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFileSync(datafile, this._memo);
    }
    
    
    //Indexation helpers
    
    indexFromHandle(register) {
        if (!register || !register.id || !register.from || !register.from.handle) return false;

        if (!this._memoFromHandle[register.from.handle]) {
            this._memoFromHandle[register.from.handle] = [];
        } else if (this._memoFromHandle[register.from.handle].find((indexed) => (indexed.id == register.id))) {
            return true;
        }
        
        this._memoFromHandle[register.from.handle].push(register);
                
        return true;    
    }
    
    indexFromUserid(register) {
        if (!register || !register.id || !register.from || !register.from.env || !register.from.userid) return false;

        var envindex = this._memoFromUserid[register.from.env];
        if (!envindex) envindex = this._memoFromUserid[register.from.env] = {};
        
        if (!envindex[register.from.userid]) {
            envindex[register.from.userid] = [];
        } else if (envindex[register.from.userid].find((indexed) => (indexed.id == register.id))) {
            return true;
        }
        
        envindex[register.from.userid].push(register);
        
        return true;
    }
    
    indexToHandle(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        var succ = 0;

        for (let recipient of register.to) {
            if (!recipient.handle) continue;
        
            if (!this._memoToHandle[recipient.handle]) {
                this._memoToHandle[recipient.handle] = [];
            } else if (this._memoToHandle[recipient.handle].find((indexed) => (indexed.id == register.id))) {
                continue;
            }
        
            this._memoToHandle[recipient.handle].push(register);
        
            succ += 1;
        }
        
        return succ;
    }
    
    indexToDisplay(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        var succ = 0;

        for (let recipient of register.to) {
        
            var envindex = this._memoToDisplay[recipient.env];
            if (!envindex) envindex = this._memoToDisplay[recipient.env] = {};
            
            let lcdisplay = recipient.display.toLowerCase();
            
            if (!envindex[lcdisplay]) {
                envindex[lcdisplay] = [];
            } else if (envindex[lcdisplay].find((indexed) => (indexedid == register.id))) {
                continue;
            }
            
            envindex[lcdisplay].push(register);
        
            succ += 1;
        }
        
        return succ;
    }
    
    indexToUserid(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        var succ = 0;

        for (let recipient of register.to) {

            var envindex = this._memoToDisplay[recipient.env];
            if (!envindex) envindex = this._memoToDisplay[recipient.env] = {};
            
            if (!envindex[recipient.userid]) {
                envindex[recipient.userid] = [];
            } else if (envindex[recipient.userid].find((indexed) => (indexed.id == register.id))) {
                continue;
            }
            
            envindex[recipient.userid].push(register);
        
            succ += 1;
        }
        
        return succ;
    }
    
    removeFromIndices(register) {
        if (!register || !register.id) return false;
        
        if (register.from && register.from.handle && this.memoFromHandle[register.from.handle]) {
            this.memoFromHandle[register.from.handle] = this.memoFromHandle[register.from.handle].filter((indexed) => (indexed.id != register.id));
        }
        
        if (register.from && register.from.env && register.from.userid && this.memoFromUserid[register.from.env] && this.memoFromUserid[register.from.env][register.from.userid]) {
            this.memoFromUserid[register.from.env][register.from.userid]
                    = this.memoFromUserid[register.from.env][register.from.userid].filter((indexed) => (indexed.id != register.id));
        }
        
        if (register.to && register.to.length) {
            for (let recipient of register.to) {
                
                if (recipient.handle && this.memoToHandle[recipient.handle]) {
                    this.memoToHandle[recipient.handle] = this.memoToHandle[recipient.handle].filter((indexed) => (indexed.id != register.id));
                }
                
                if (recipient.env && recipient.display && this._memoToDisplay[recipient.env] && this._memoToDisplay[recipient.env][recipient.display]) {
                    this._memoToDisplay[recipient.env][recipient.display] = this._memoToDisplay[recipient.env][recipient.display].filter((indexed) => (indexed.id != register.id));
                }
                
                if (recipient.env && recipient.userid && this._memoToUserid[recipient.env] && this._memoToUserid[recipient.env][recipient.userid]) {
                    this._memoToUserid[recipient.env][recipient.userid] = this._memoToUserid[recipient.env][recipient.userid].filter((indexed) => (indexed.id != register.id));
                }
                
            }
        }
        
        return true;
    }
    
    
    //Descriptor parser - Input is "[{env}] (=handle|[+]displayname|[+]id) [& ...] message ...", return {to: [{env, handle, display, userid, auth}, ...], message}
    
    parseDescriptor(currentenv, descriptor) {
        var result = {
            to: [],
            message: null
        };
        
        while (descriptor.length) {

            //{env}

            let env = currentenv;
            let recipient = descriptor.shift();
        
            let checkenv = recipient.match(/\{(.*)\}/);
            if (checkenv) {
                env = (this.env(checkenv[1]) ? checkenv[1] : null);
                recipient = descriptor.shift();
            }
            
            if (!env || !recipient) {
                return {error: 1};
            }
            
            let checkhandle = /^=(.*)$/.match(recipient);
            if (checkhandle) {
                //=handle
            
                let handle = checkhandle[1];
                if (!this.mod('Users').getUser(handle)) return {error: 2, subject: handle};
                
                result.to.push({
                    env: env,
                    handle: handle,
                    display: null,
                    userid: null,
                    auth: true,
                    done: 0
                });
                
            } else {
                //+name_or_id
                
                let auth = false;
                let checkauth = /^\+(.*)$/.match(recipient);
                if (checkauth) {
                    auth = true;
                    recipient = recipient[1];
                }
                
                while (descriptor.length && recipient.match(/^".*[^"]$/)) {
                    recipient = recipient + ' ' + descriptor.shift();
                }
                
                let m = recipient.match(/^"([^ ]* .*)"$/);
                if (m) recipient = m[1];
                
                let item = {
                    env: env,
                    handle: null,
                    display: null,
                    userid: null,
                    auth: auth,
                    done: 0
                };
                
                let envobj = this.env(env);
                
                let otherid = envobj.displayNameToId(recipient);
                let otherdisplay = envobj.idToDisplayName(recipient);
                
                if (!otherid && !otherdisplay) {
                    item.display = recipient;
                    item.userid = recipient;
                } else if (!otherdisplay) {
                    item.display = recipient;
                    item.userid = otherid;
                } else {
                    item.userid = recipient;
                }
            
                result.to.push(item);
            }
            
            if (descriptor[0] != "&") break;
        
            descriptor.shift();
        }
        
        result.message = descriptor.join(" ");
        
        return result;
    }
    
    
    //Outbox generation helper (combine handle and userid outboxes)
    
    createOutbox(env, userid, handle) {
    
        var outbox = {};
        
        if (this._memoFromHandle[handle]) {
            for (let register of this._memoFromHandle[handle]) {
                if (register.to.filter((recipient) => !recipient.done).length) {
                    outbox[id] = register;
                }
            }
        }
        
        if (this._memoFromUserid[env] && this._memoFromUserid[env][userid]) {
            for (let register of this._memoFromUserid[env][userid]) {
                if (register.to.filter((recipient) => !recipient.done).length) {
                    outbox[id] = register;
                }
            }
        }
        
        return Object.values(outbox).sort((a, b) => (a.id - b.id));
    }
    
    
    //Inbox generation and memo reception helpers
    
    getMatchingRecipients(register, env, userid, display, handle, isauth, notdone) {
        if (!register) return [];

        var result = [];

        for (let recipient of register.to) {
            if (handle && recipient.handle == handle) {
                
                result.push(recipient);
                
            } else if (env && recipient.env == env
                    && (userid && recipient.userid == userid || display && recipient.display == display)
                    && isauth || !recipient.auth
                    && !notdone || !recipient.done) {
                    
                result.push(recipient);
                
            }
        }
        
        return result;
    }
    
    
    createInbox(env, userid, display, handle, isauth, tscutoff) {
    
        var tsthreshold = moment().unix() - tscutoff;
    
        var inbox = {};
        
        if (this._memoToHandle[handle]) {
            for (let register of this._memoToHandle[handle]) {
                if (register.ts < tsthreshold) continue;
                inbox[id] = register;
            }
        }
        
        if (this._memoToUserid[env] && this._memoToUserid[env][userid]) {
            for (let register of this._memoToUserid[env][userid]) {
            
                if (register.ts < tsthreshold && this.getMatchingRecipients(register, env, userid, display, handle, isauth).length) {
                    inbox[id] = register;
                }
                
            }
        }
        
        if (this._memoToDisplay[env] && this._memoToDisplay[env][display]) {
            for (let register of this._memoToDisplay[env][display]) {
            
                if (register.ts < tsthreshold && this.getMatchingRecipients(register, env, userid, display, handle, isauth).length) {
                    inbox[id] = register;
                }
                
            }
        }
    
        return Object.values(inbox).sort((a, b) => (b.id - a.id));
    }
    
    
    //Event handlers
    
    markMemoAsDelivered(register, env, userid, display, handle, isauth) {
        var changed = 0;
    
        for (let recipient of this.getMatchingRecipients(register, env, userid, display, handle, isauth, true)) {
            changed += 1;
            recipient.done = moment().unix();
        }
        
        return changed;
    }
    
    deliverMemo(register, envobj, targetid) {
        var targetdisplay = envobj.idToDisplayName(targetid);
        envobj.msg(targetid, envobj.applyFormatting('Message from **' + (register.from.display || register.from.userid) + '** to **' + (targetdisplay || targetid) + '** sent on ' + moment(register.ts).format(this.param('tsFormat')) + ':'));
        envobj.msg(targetid, '    ' + register.msg);
    }
    
    onJoin(env, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, false);
    }
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, true);
    }
    
    triggerMemoDelivery(env, authorid, strong) {
        var handles = this.mod('Users').getHandlesById(env.name, authorid, true);
        var display = env.idToDisplayName(authorid);
        var isauth = env.idIsAuthenticated(authorid);
        var receive = {};
        
        for (let handle of handles) {
            if (!this._memoToHandle[handle]) continue;
            for (let register of this._memoToHandle[handle]) {
                if (register.strong && !strong) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, handle, true, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        if (this._memoToDisplay[env.name] && this._memoToDisplay[env.name][display]) {
            for (let register of this._memoToDisplay[env.name][display]) {
                if (register.strong && !strong) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        if (this.memoToUserid[env.name] && this.memoToUserid[env.name][authorid]) {
            for (let register of this.memoToUserid[env.name][authorid]) {
                if (register.strong && !strong) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        receive = Object.values(receive).sort((a, b) => (a.id - b.id));
        for (let register of receive) {
            this.deliverMemo(register, env, authorid);
            this.markMemoAsDelivered(register, env.name, authorid, display, handles[0], isauth);
        }
    }
    
    
}


module.exports = ModMemo;
