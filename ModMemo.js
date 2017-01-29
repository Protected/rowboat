/* Module: Memo -- Save a public message for another user to be auto-delivered on activity. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');
var moment = require('moment');

var PERM_ADMIN = 'administrator';

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
            envs[envname].on('join', this.onJoin, this);
            envs[envname].on('message', this.onMessage, this);
        }

        
        this.mod("Commands").registerCommand(this, 'memo', {
            description: "Send or cancel a message. Actions: save, strongsave, cancel, outbox, inbox",
            args: ["action", "descriptor", true],
            details: [
                "**save|strongsave** [{env}] (=handle|[+]displayname|[+]userid) [& ...] message ...",
                "  Send a message to one or more recipients. Multiple recipients are separated by &. After the list of recipients, write the desired message.",
                "  Each recipient by default is a nickname or ID of the user in the current environment. Prefix the recipient with {env} to target another environment.",
                "  To force the recipient to be authenticated before delivering, prefix it with a '+' symbol. By default, the receipient doesn't have to be authenticated.",
                "  Use =HANDLE as the recipient to target a Rowboat user account.",
                "**cancel** ID",
                "  Deletes a pending message. Use the ID you received when you sent the message.",
                "  If at least one recipient already received the message, this command will only remove all pending recipients. The message will not be deleted.",
                "**outbox** [ID]",
                "  Shows a summarized list of messages you have sent whose delivery is not completed. Alternatively, pass an ID to see the details of a message you have sent.",
                "**inbox** [ID]",
                "  Shows a summarized list of messages you have recently received. Alternatively, pass an ID to see the details of a message you have received."
            ],
            minArgs: 1,
            permissions: (this.param('permission') ? [this.param('permission')] : null),
            unobtrusive: true
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            if (!env.idIsAuthenticated(userid)) {
                ep.reply("Your environment (" + env.name + ") ID is not authenticated. Only authenticated users can use this command.");
                return true;
            }
            
            if (args.action == "save" || args.action == "strongsave") {
                //Send a memo to one or more recipients
            
                let elements = this.parseDescriptor(env.name, args.descriptor);
                
                if (elements.error) {
                    if (elements.error == 1) {
                        ep.priv("Malformed recipient: Environment doesn't exist or missing target user.");
                    } else if (elements.error == 2) {
                        ep.priv("User account not found: " + elements.subject);
                    } else {
                        ep.priv("Parse error " + elements.error);
                    }
                    return true;
                }
                
                if (!elements.message || !elements.to.length) {
                    ep.priv("Please include a message to be delivered and at least one recipient.");
                    return true;
                }
                
                if (this.createOutbox(env.name, userid, handle).length >= this.param("outboxSize")) {
                    ep.priv("Your outbox is full. Please cancel one or more pending messages or wait for them to be delived.");
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
                
                ep.priv("Your message has successfully been scheduled for delivery with the ID **" + register.id + "**.");
                this.log('Registered new message ' + register.id + ' for delivery: ' + userid + ' on ' + env.name + '. Recipients: ' + elements.to.length);
                
                this.saveMemos();
                
            } else if (args.action == "cancel") {
                //Cancel a memo or remove all undelivered recipients
            
                let id = parseInt(args.descriptor[0]);
                if (isNaN(id)) {
                    ep.priv("Please provide the numeric ID of the message you wish to cancel.");
                    return true;
                }
                
                let register = this._memo[id];
                if (!register
                        || (register.from.env != env.name || register.from.userid != userid)
                            && (!register.from.handle || register.from.handle != handle)
                            && !this.mod("Users").testPermissions(env.name, userid, [PERM_ADMIN], false, handle)) {
                    ep.priv("You do not have a message with the ID " + id);
                    return true;
                }
                
                let delivered = register.to.filter((recipient) => recipient.done);
                
                if (delivered.length == register.to.length) {
                    ep.priv("The message with the ID **" + id + "** has already been delivered!");
                } else if (delivered.length) {
                    register.to = delivered;
                    ep.priv("The message with the ID **" + id + "** had already been delivered to " + delivered.length + " recipient" + (delivered.length != 1 ? "s" : "") + ". All undelivered recipients were removed.");
                    this.log('Removed undelivered recipients from message ' + id + ' by request from ' + userid + ' on ' + env.name);
                } else {
                    this.removeFromIndices(register);
                    delete this._memo[register.id];
                    ep.priv("The message with the ID **" + id + "** was successfully canceled.");
                    this.log('Canceled message ' + id + ' by request from ' + userid + ' on ' + env.name);
                }
                
                this.saveMemos();
            
            } else if (args.action == "outbox") {
                //Obtain information on memos I sent
            
                let id = parseInt(args.descriptor[0]);
                if (isNaN(id)) {
                
                    let target_envname = env.name;
                    let target_userid = userid;
                    let target_handle = handle;
                    
                    if (this.mod("Users").testPermissions(env.name, userid, [PERM_ADMIN], false, handle) && args.descriptor.length > 1) {
                        target_userid = args.descriptor[1];
                        target_envname = args.descriptor[2] || env.name;
                        target_handle = args.descriptor[3];
                    }
            
                    let outbox = this.createOutbox(target_envname, target_userid, target_handle).slice(0, this.param("outboxSize"));
                    
                    if (outbox.length) {
                        for (let register of outbox) {
                            let delivered = register.to.filter((recipient) => recipient.done).length;
                            ep.priv("(**" + register.id + "**) " + moment(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + " [Delivery: " + delivered + "/" + register.to.length + "]");
                        }
                    } else ep.priv("Your outbox is empty.");
                    
                } else {
                
                    let register = this._memo[id];
                    if (!register
                            || (register.from.env != env.name || register.from.userid != userid)
                                && (!register.from.handle || register.from.handle != handle)
                                && !this.mod("Users").testPermissions(env.name, userid, [PERM_ADMIN], false, handle)) {
                        ep.priv("You have not sent a message with the ID " + id);
                        return true;
                    }
                    
                    ep.priv("(**" + register.id + "**) " + (register.strong ? "[S] " : "") + register.msg);
                    ep.priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment(register.ts).format(this.param('tsFormat')));
                    
                    for (let recipient of register.to) {
                        ep.priv("  " + (recipient.done ? "**DELIVERED**" : "Pending") + " To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "") + " on " + recipient.env));
                    }
                
                }

            } else if (args.action == "inbox") {
                //Obtain information on memos I received
            
                let changes = 0;
                let display = env.idToDisplayName(userid);
                let isauth = env.idIsAuthenticated(userid);

            
                let id = parseInt(args.descriptor[0]);
                if (isNaN(id)) {
                
                    let inbox = this.createInbox(env.name, userid, display, handle, isauth, this.param("inboxTsCutoff")).slice(0, this.param("inboxDisplaySize"));
                    
                    if (inbox.length) {
                        for (let register of inbox) {
                            let isnew = this.markMemoAsDelivered(register, env.name, userid, display, handle, isauth);
                            if (isnew) {
                                changes += 1;
                                this.log('Delivered message ' + register.id + ' to ' + userid + ' on environment ' + env.name + ' while listing inbox.');
                            }
                            ep.priv("(**" + register.id + "**) " + moment(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + (isnew ? " [NEW]" : ""));
                        }
                    } else ep.priv("Your inbox is empty.");
                    
                } else {
                
                    let register = this._memo[id];
                    if (!register) {
                        ep.priv("You have not received a message with the ID " + id);
                        return true;
                    }

                    let recipients = this.getMatchingRecipients(register, env.name, userid, display, handle, isauth);
                    if (!recipients.length) {
                        ep.priv("You have not received a message with the ID " + id);
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
                    
                    ep.priv("(**" + register.id + "**) " + (register.strong ? "[S] " : "") + register.msg);
                    ep.priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment(register.ts).format(this.param('tsFormat')));
                    
                    for (let recipient of recipients) {
                        ep.priv("  (Delivered " + moment(recipient.done).format(this.param('tsFormat')) + ") To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "") + " on " + recipient.env));
                    }
                
                }
                
                if (changes) this.saveMemos();
                        
            } else {
                ep.reply("I don't recognize that action.");
            }
            
            return true;
        });
        
        return true;
    }
    
    
    // # Module code below this line #


    //Miscellaneous
    
    objectValues(obj) {
        var vals = [];
        for (var key in obj) {
            if (obj.propertyIsEnumerable(key)) {
                vals.push(obj[key]);
            }
        }
        return vals;
    }
    
    
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
            
            let lcdisplay = recipient.display;
            if (!lcdisplay) continue;
            lcdisplay = lcdisplay.toLowerCase();
            
            if (!envindex[lcdisplay]) {
                envindex[lcdisplay] = [];
            } else if (envindex[lcdisplay].find((indexed) => (indexed.id == register.id))) {
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

            var envindex = this._memoToUserid[recipient.env];
            if (!envindex) envindex = this._memoToUserid[recipient.env] = {};
            
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
        
        if (register.from && register.from.handle && this._memoFromHandle[register.from.handle]) {
            this._memoFromHandle[register.from.handle] = this._memoFromHandle[register.from.handle].filter((indexed) => (indexed.id != register.id));
        }
        
        if (register.from && register.from.env && register.from.userid && this._memoFromUserid[register.from.env] && this._memoFromUserid[register.from.env][register.from.userid]) {
            this._memoFromUserid[register.from.env][register.from.userid]
                    = this._memoFromUserid[register.from.env][register.from.userid].filter((indexed) => (indexed.id != register.id));
        }
        
        if (register.to && register.to.length) {
            for (let recipient of register.to) {
                
                if (recipient.handle && this._memoToHandle[recipient.handle]) {
                    this._memoToHandle[recipient.handle] = this._memoToHandle[recipient.handle].filter((indexed) => (indexed.id != register.id));
                }
                
                let lcdisplay = recipient.display;
                if (lcdisplay) {
                    lcdisplay = lcdisplay.toLowerCase();
                    if (recipient.env && this._memoToDisplay[recipient.env] && this._memoToDisplay[recipient.env][lcdisplay]) {
                        this._memoToDisplay[recipient.env][lcdisplay] = this._memoToDisplay[recipient.env][lcdisplay].filter((indexed) => (indexed.id != register.id));
                    }
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
            
            let checkhandle = /^=(.*)$/.exec(recipient);
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
                let checkauth = /^\+(.*)$/.exec(recipient);
                if (checkauth) {
                    auth = true;
                    recipient = checkauth[1];
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
                
                item.display = otherdisplay || recipient;
                item.userid = otherid || recipient;
            
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
                    outbox[register.id] = register;
                }
            }
        }
        
        if (this._memoFromUserid[env] && this._memoFromUserid[env][userid]) {
            for (let register of this._memoFromUserid[env][userid]) {
                if (register.to.filter((recipient) => !recipient.done).length) {
                    outbox[register.id] = register;
                }
            }
        }
        
        return this.objectValues(outbox).sort((a, b) => (a.id - b.id));
    }
    
    
    //Inbox generation and memo reception helpers
    
    getMatchingRecipients(register, env, userid, display, handle, isauth, notdone) {
        if (!register) return [];

        var result = [];

        for (let recipient of register.to) {
            if (handle && recipient.handle == handle
                    && (!notdone || !recipient.done)) {
                
                result.push(recipient);
                
            } else if (env && recipient.env == env
                    && (userid && recipient.userid == userid || display && recipient.display && recipient.display.toLowerCase() == display.toLowerCase())
                    && (isauth || !recipient.auth)
                    && (!notdone || !recipient.done)) {
                    
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
                inbox[register.id] = register;
            }
        }
        
        if (this._memoToUserid[env] && this._memoToUserid[env][userid]) {
            for (let register of this._memoToUserid[env][userid]) {
            
                if (register.ts > tsthreshold && this.getMatchingRecipients(register, env, userid, display, handle, isauth).length) {
                    inbox[register.id] = register;
                }
                
            }
        }
        
        if (display) {
            let lcdisplay = display.toLowerCase();
            if (this._memoToDisplay[env] && this._memoToDisplay[env][lcdisplay]) {
                for (let register of this._memoToDisplay[env][lcdisplay]) {
                
                    if (register.ts < tsthreshold && this.getMatchingRecipients(register, env, userid, display, handle, isauth).length) {
                        inbox[register.id] = register;
                    }
                    
                }
            }
        }
    
        return this.objectValues(inbox).sort((a, b) => (b.id - a.id));
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
    
    deliverMemo(register, envobj, targetid, channelid) {
        var targetdisplay = envobj.idToMention(targetid);
        envobj.msg(channelid, envobj.applyFormatting('Message from **' + (register.from.display || register.from.userid) + '** to **' + (targetdisplay || targetid) + '** sent on ' + moment(register.ts).format(this.param('tsFormat')) + ':'));
        envobj.msg(channelid, '    ' + register.msg);
    }
    
    onJoin(env, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, channelid, false);
    }
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, channelid, true);
    }
    
    triggerMemoDelivery(env, authorid, channelid, strong) {
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
        
        if (display) {
            let lcdisplay = display.toLowerCase();
            if (this._memoToDisplay[env.name] && this._memoToDisplay[env.name][lcdisplay]) {
                for (let register of this._memoToDisplay[env.name][lcdisplay]) {
                    if (register.strong && !strong) continue;
                    if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                    receive[register.id] = register;
                }
            }
        }
        
        if (this._memoToUserid[env.name] && this._memoToUserid[env.name][authorid]) {
            for (let register of this._memoToUserid[env.name][authorid]) {
                if (register.strong && !strong) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        receive = this.objectValues(receive).sort((a, b) => (a.id - b.id));
        var changed = 0;
        for (let register of receive) {
            let deliveries = this.markMemoAsDelivered(register, env.name, authorid, display, handles[0], isauth);
            if (deliveries) {
                this.deliverMemo(register, env, authorid, channelid);
                this.log('Delivered message ' + register.id + ' to ' + authorid + ' on environment ' + env.name + ' and channel ' + channelid);
                changed += deliveries;
            }
        }
        
        if (changed) this.saveMemos();
    }
    
    
}


module.exports = ModMemo;
