/* Memo -- Save a public message for another user to be auto-delivered on activity. */

import moment from 'moment';

import Behavior from '../src/Behavior.js';

export default class Memo extends Behavior {

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        {n: 'outboxSize', d: "Maximum amount of undelivered memos"},
        {n: 'inboxDisplaySize', d: "Maximum amount of recent memos to display"},
        {n: 'inboxTsCutoff', d: "How recent memos must be to be in the inbox (seconds)"},
        {n: 'tsFormat', d: "How to format timestamps (moment.js)"}
    ]; }

    get defaults() { return {
        datafile: null,
        outboxSize: 10,
        inboxDisplaySize: 10,
        inboxTsCutoff: 2592000,  //30 days
        tsFormat: "ddd MMM D HH:mm:ss"
    }; }
    
    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('Memo', name);

        this._envExists = null;
        this._envProxy = null;
        
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


    initialize(opt) {
        if (!super.initialize(opt)) return false;
       
        this._envExists = opt.envExists;
        this._envProxy = opt.envProxy;

        //Load data
        
        this._memo = this.loadData();
        if (this._memo === false) return false;

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
        

        //Register callbacks
        
        this.env().on('join', this.onJoin, this);
        this.env().on('message', this.onMessage, this);
        
        this.be("Commands").registerRootDetails(this, 'memo', {description: 'Commands for writing, reading and canceling messages for other users.'});

        const permAdmin = this.be("Users").defaultPermAdmin;
        
        let ssoptions = {
            description: "Leaves a message for another user.",
            args: ["args", true],
            details: [
                "**save|strongsave** [<delay>] [{env}] (=handle|[+]displayname|[+]userid) [& [{env}] ...] message ...",
                "  Send a message to one or more recipients. Multiple recipients are separated by &. After the list of recipients, write the desired message.",
                "  Each recipient by default is a nickname or ID of the user in the current environment. Prefix the recipient with {env} to target another environment.",
                "  To force the recipient to be authenticated before delivering, prefix it with a '+' symbol. By default, the receipient doesn't have to be authenticated.",
                "  Use =HANDLE as the recipient to target a Rowboat user account.",
                "  If you prefix the parameters with <delay> the message can only be delivered after a delay. Specify the delay as [[hh:]mm:]ss or using #[dhms] where # is a number."
            ],
            unobtrusive: true
        };
        
        let sscallback = (strong) => async (env, type, userid, channelid, command, args, handle, ep) => {
            if (!await env.idIsAuthenticated(userid)) {
                ep.reply("Your environment (" + env.name + ") ID is not authenticated. Only authenticated users can use this command.");
                return true;
            }
            
            //Send a memo to one or more recipients
        
            let elements = await this.parseDescriptor(env.name, args.args);
            
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
                delay: elements.delay,
                from: {
                    env: env.name,
                    handle: handle,
                    display: await env.idToDisplayName(userid),
                    userid: userid
                },
                to: elements.to,
                strong: strong,
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
            
            this._memo.save();
            
            return true;
        };
        
        this.be("Commands").registerCommand(this, 'memo save', ssoptions, sscallback(false));
        this.be("Commands").registerCommand(this, 'memo strongsave', ssoptions, sscallback(true));

                
        this.be("Commands").registerCommand(this, 'memo cancel', {
            description: "Cancels an undelivered message pending delivery to a user.",
            args: ["id"],
            details: [
                "Deletes a pending message. Use the ID you received when you sent the message.",
                "If at least one recipient already received the message, this command will only remove all pending recipients and the message will not be deleted."
            ]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
            //Cancel a memo or remove all undelivered recipients
        
            let id = parseInt(args.id);
            if (isNaN(id)) {
                ep.priv("Please provide the numeric ID of the message you wish to cancel.");
                return true;
            }
            
            let register = this._memo[id];
            if (!register
                    || (register.from.env != env.name || register.from.userid != userid)
                        && (!register.from.handle || register.from.handle != handle)
                        && !await this.be("Users").testPermissions(env.name, userid, channelid, [permAdmin], false, handle)) {
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
            
            this._memo.save();
            
            return true;
        });
        
        
        this.be("Commands").registerCommand(this, 'memo outbox', {
            description: "Shows information about messages you have left for other users.",
            args: ["id", true],
            details: [
                "Without arguments, shows a summarized list of messages you have sent whose delivery is not completed.",
                "Alternatively, pass an ID to see the details of a specific message you have sent."
            ],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
            //Obtain information on memos I sent
        
            let id = parseInt(args.id[0]);
            if (isNaN(id)) {
            
                let target_envname = env.name;
                let target_userid = userid;
                let target_handle = handle;
                
                if (await this.be("Users").testPermissions(env.name, userid, channelid, [permAdmin], false, handle) && args.id.length > 1) {
                    target_userid = args.id[1];
                    target_envname = args.id[2] || env.name;
                    target_handle = args.id[3];
                }
        
                let outbox = this.createOutbox(target_envname, target_userid, target_handle).slice(0, this.param("outboxSize"));
                
                if (outbox.length) {
                    for (let register of outbox) {
                        let delivered = register.to.filter((recipient) => recipient.done).length;
                        ep.priv("(**" + register.id + "**) " + moment.unix(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + " [Delivery: " + delivered + "/" + register.to.length + "]");
                    }
                } else ep.priv("Your outbox is empty.");
                
            } else {
            
                let register = this._memo[id];
                if (!register
                        || (register.from.env != env.name || register.from.userid != userid)
                            && (!register.from.handle || register.from.handle != handle)
                            && !await this.be("Users").testPermissions(env.name, userid, channelid, [permAdmin], false, handle)) {
                    ep.priv("You have not sent a message with the ID " + id);
                    return true;
                }
                
                let delaypart = '';
                if (register.delay) {
                    delaypart = ' (w/ ' + this.userFriendlyDelay(register.delay) + ' delay)';
                }
                
                ep.priv("(**" + register.id + "**) " + (register.strong ? "[S] " : "") + register.msg);
                ep.priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment.unix(register.ts).format(this.param('tsFormat')) + delaypart);
                
                for (let recipient of register.to) {
                    ep.priv("  " + (recipient.done ? "**DELIVERED**" : "Pending") + " To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "") + " on " + recipient.env));
                }
            
            }
            
            return true;
        });
        
        
        this.be("Commands").registerCommand(this, 'memo inbox', {
            description: "Shows information about messages you have received from other users.",
            args: ["id"],
            details: [
                "Without arguments, shows a summarized list of messages you have recently received. ",
                "Alternatively, pass an ID to see the details of a message you have received."
            ],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
            //Obtain information on memos I received
        
            let changes = 0;
            let display = await env.idToDisplayName(userid);
            let isauth = await env.idIsAuthenticated(userid);

        
            let id = parseInt(args.id);
            if (isNaN(id)) {
            
                let inbox = this.createInbox(env.name, userid, display, handle, isauth, this.param("inboxTsCutoff")).slice(0, this.param("inboxDisplaySize"));
                
                if (inbox.length) {
                    for (let register of inbox) {
                        let isnew = this.markMemoAsDelivered(register, env.name, userid, display, handle, isauth);
                        if (isnew) {
                            changes += 1;
                            this.log('Delivered message ' + register.id + ' to ' + userid + ' on environment ' + env.name + ' while listing inbox.');
                        }
                        ep.priv("(**" + register.id + "**) " + moment.unix(register.ts).format(this.param('tsFormat')) + " " + (register.msg.length <= 100 ? register.msg : register.msg.substr(0, 97) + "...") + (isnew ? " [NEW]" : ""));
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
                ep.priv("Sent by " + (register.from.handle ? "=__" + register.from.handle + "__" : "__" + register.from.display + "___ (" + register.from.userid + ")") + " at " + moment.unix(register.ts).format(this.param('tsFormat')));
                
                for (let recipient of recipients) {
                    ep.priv("  (Delivered " + moment.unix(recipient.done).format(this.param('tsFormat')) + ") To: " + (recipient.handle ? "=__" + recipient.handle + "__" : (recipient.auth ? "+" : "") + "__" + recipient.display + "__" + (recipient.display != recipient.userid ? " (" + recipient.userid + ")" : "") + " on " + recipient.env));
                }
            
            }
            
            if (changes) this._memo.save();
            
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #


    //Miscellaneous
    
    objectValues(obj) {
        let vals = [];
        for (let key in obj) {
            if (obj.propertyIsEnumerable(key)) {
                vals.push(obj[key]);
            }
        }
        return vals;
    }
    
    userFriendlyDelay(delay) {
        let days = Math.floor(delay / 86400.0);
        delay -= days * 86400;
        let hours = Math.floor(delay / 3600.0);
        delay -= hours * 3600;
        let minutes = Math.floor(delay / 60.0);
        delay -= minutes * 60;
        let result = "";
        if (days) result += (days + "d") + " ";
        if (hours) result += (hours + "h") + " ";
        if (minutes) result += (minutes + "m") + " ";
        if (delay) result += (delay + "s") + " ";
        return result.trim();
    }
    
    
    //Indexation helpers
    
    indexFromHandle(register) {
        if (!register || !register.id || !register.from || !register.from.handle) return false;

        if (!this._memoFromHandle[register.from.handle]) {
            this._memoFromHandle[register.from.handle] = [];
        } else if (this._memoFromHandle[register.from.handle].find(indexed => indexed.id == register.id)) {
            return true;
        }
        
        this._memoFromHandle[register.from.handle].push(register);
                
        return true;    
    }
    
    indexFromUserid(register) {
        if (!register || !register.id || !register.from || !register.from.env || !register.from.userid) return false;

        let envindex = this._memoFromUserid[register.from.env];
        if (!envindex) envindex = this._memoFromUserid[register.from.env] = {};
        
        if (!envindex[register.from.userid]) {
            envindex[register.from.userid] = [];
        } else if (envindex[register.from.userid].find(indexed => indexed.id == register.id)) {
            return true;
        }
        
        envindex[register.from.userid].push(register);
        
        return true;
    }
    
    indexToHandle(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        let succ = 0;

        for (let recipient of register.to) {
            if (!recipient.handle) continue;
        
            if (!this._memoToHandle[recipient.handle]) {
                this._memoToHandle[recipient.handle] = [];
            } else if (this._memoToHandle[recipient.handle].find(indexed => indexed.id == register.id)) {
                continue;
            }
        
            this._memoToHandle[recipient.handle].push(register);
        
            succ += 1;
        }
        
        return succ;
    }
    
    indexToDisplay(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        let succ = 0;

        for (let recipient of register.to) {
        
            let envindex = this._memoToDisplay[recipient.env];
            if (!envindex) envindex = this._memoToDisplay[recipient.env] = {};
            
            let lcdisplay = recipient.display;
            if (!lcdisplay) continue;
            lcdisplay = lcdisplay.toLowerCase();
            
            if (!envindex[lcdisplay]) {
                envindex[lcdisplay] = [];
            } else if (envindex[lcdisplay].find(indexed => indexed.id == register.id)) {
                continue;
            }
            
            envindex[lcdisplay].push(register);
        
            succ += 1;
        }
        
        return succ;
    }
    
    indexToUserid(register) {
        if (!register || !register.id || !register.to || !register.to.length) return false;

        let succ = 0;

        for (let recipient of register.to) {

            let envindex = this._memoToUserid[recipient.env];
            if (!envindex) envindex = this._memoToUserid[recipient.env] = {};
            
            if (!envindex[recipient.userid]) {
                envindex[recipient.userid] = [];
            } else if (envindex[recipient.userid].find(indexed => indexed.id == register.id)) {
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
    
    
    //Descriptor parser - Input is "[<delay>] [{env}] (=handle|[+]displayname|[+]id) [& ...] message ...", return {delay: seconds, to: [{env, handle, display, userid, auth}, ...], message}
    
    async parseDescriptor(currentenv, descriptor) {
        let result = {
            delay: 0,
            to: [],
            message: null
        };
        
        //<delay>
        
        let delaydescriptor = descriptor[0].match(/^<(.*)>$/);
        if (delaydescriptor) {
            delaydescriptor = delaydescriptor[1];
            
            let parts = delaydescriptor.match(/^((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)$/);
            if (parts) {
                result.delay = parseInt(parts[5]) + (parseInt(parts[4])||0) * 60 + (parseInt(parts[3])||0) * 3600;
            } else {
                parts = delaydescriptor.replace(/ /g, "").match(/(([0-9]+)d)?(([0-9]+)h)?(([0-9]+)m)?(([0-9]+)s?)?/);
                if (parts[8]) result.delay = parts[8];
                if (parts[6]) result.delay += parts[6] * 60;
                if (parts[4]) result.delay += parts[4] * 3600;
                if (parts[2]) result.delay += parts[2] * 86400;
            }
        
            descriptor.shift();
        }
        
        while (descriptor.length) {

            //{env}

            let env = currentenv;
            let recipient = descriptor.shift();
        
            let checkenv = recipient.match(/^\{(.*)\}$/);
            if (checkenv) {
                env = (this._envExists(checkenv[1]) ? checkenv[1] : null);
                recipient = descriptor.shift();
            }
            
            if (!env || !recipient) {
                return {error: 1};
            }
            
            let checkhandle = /^=(.*)$/.exec(recipient);
            if (checkhandle) {
                //=handle
            
                let handle = checkhandle[1];
                if (!await this.be('Users').getUser(handle)) return {error: 2, subject: handle};
                
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
                
                let envobj = this._envProxy(env);
                
                let otherid = await envobj.displayNameToId(recipient);
                let otherdisplay = await envobj.idToDisplayName(recipient);
                
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
    
        let outbox = {};
        
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

        let result = [];

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
    
        let tsthreshold = moment().unix() - tscutoff;
    
        let inbox = {};
        
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
        let changed = 0;
    
        for (let recipient of this.getMatchingRecipients(register, env, userid, display, handle, isauth, true)) {
            changed += 1;
            recipient.done = moment().unix();
        }
        
        return changed;
    }
    
    async deliverMemo(register, envobj, targetid, channelid) {
        let targetdisplay = await envobj.idToMention(targetid);
        let delaypart = '';
        if (register.delay) {
            delaypart = ' (w/ ' + this.userFriendlyDelay(register.delay) + ' delay)';
        }
        await envobj.msg(channelid, await envobj.applyFormatting('Message from **' + (register.from.display || register.from.userid) + '** to **' + (targetdisplay || targetid) + '** sent on ' + moment.unix(register.ts).format(this.param('tsFormat')) + delaypart + ':'));
        envobj.msg(channelid, '    ' + register.msg);
    }
    
    onJoin(env, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, channelid, false);
    }
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        this.triggerMemoDelivery(env, authorid, channelid, true);
    }
    
    async triggerMemoDelivery(env, authorid, channelid, strong) {
        let handles = await this.be('Users').getHandlesById(env.name, authorid, true);
        let display = await env.idToDisplayName(authorid);
        let isauth = await env.idIsAuthenticated(authorid);
        let receive = {};
        
        let now = moment().unix();
        
        for (let handle of handles) {
            if (!this._memoToHandle[handle]) continue;
            for (let register of this._memoToHandle[handle]) {
                if (register.strong && !strong) continue;
                if (register.delay && now < register.ts + register.delay) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, handle, true, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        if (display) {
            let lcdisplay = display.toLowerCase();
            if (this._memoToDisplay[env.name] && this._memoToDisplay[env.name][lcdisplay]) {
                for (let register of this._memoToDisplay[env.name][lcdisplay]) {
                    if (register.strong && !strong) continue;
                    if (register.delay && now < register.ts + register.delay) continue;
                    if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                    receive[register.id] = register;
                }
            }
        }
        
        if (this._memoToUserid[env.name] && this._memoToUserid[env.name][authorid]) {
            for (let register of this._memoToUserid[env.name][authorid]) {
                if (register.strong && !strong) continue;
                if (register.delay && now < register.ts + register.delay) continue;
                if (!this.getMatchingRecipients(register, env.name, authorid, display, null, isauth, true).length) continue;
                receive[register.id] = register;
            }
        }
        
        receive = this.objectValues(receive).sort((a, b) => (a.id - b.id));
        let changed = 0;
        for (let register of receive) {
            let deliveries = this.markMemoAsDelivered(register, env.name, authorid, display, handles[0], isauth);
            if (deliveries) {
                await this.deliverMemo(register, env, authorid, channelid);
                this.log('Delivered message ' + register.id + ' to ' + authorid + ' on environment ' + env.name + ' and channel ' + channelid);
                changed += deliveries;
            }
        }
        
        if (changed) this._memo.save();
    }
    
    
}
