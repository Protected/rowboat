import { verifyString } from 'discord.js';

import Environment from '../src/Environment.js';

const MAXIMUM_MSG_LENGTH = 2000;

const BASE_CHANNEL_OPERATIONS = [
    "TextChannel",
    "VoiceChannel"
];

export default class EnvStoat extends Environment {

    get description() { return "Connects to a Stoat server."; }

    get params() { return [

        {n: 'token', d: "Stoat bot token"},
        {n: 'server', d: "Server ID to operate on (bot must have been previously added to server)"},

        {n: 'privatemessages', d: "Environment will receive private messages to the bot"},
        {n: 'senddelay', d: "Message queue send delay (ms)"}

    ]; }
    
    get defaults() { return {
        privatemessages: false,
        senddelay: 500
    }; }

    get sharedModules() { return [
        'StoatClient'
    ]; }

    //Replace with @decorators once they become available
    get synchronousMethods() { 
        return super.synchronousMethods.concat(["extractRoleId", "extractChannelId", "extractRoleIdsFromCollection", "extractChannelIdsFromCollection"]);
    }
    
    constructor(name) {
        super('Stoat', name);

        this._localClient = null;  //StoatClient
        this._client = null;  //Actual stoat.js Client object
        this._server = null;  //stoat.js Server object for the server identified by this environment's 'server' ID.
        this._channels = {};
    }


    initialize(opt) {
        if (!super.initialize(opt)) { return false; }

        this._localClient = opt.sharedInstances.StoatClient;

        return true;
    }


    connect() {

        this.log(`Connecting to ${this.param('server')}`);

        return this._localClient.prepareClient(this, this.param('token'), this.param('senddelay'))
            .then(async (client) => {
                this._client = client;
                this._server = await client.servers.fetch(this.param('server'));
                
                if (!this._server) {
                    this.log('error', "Could not obtain server object.");
                }
                
                this._localClient.on("messageCreate", (message) => {
                    if (message.author.id === client.user.id) { return; }
                    
                    let type = "regular";
                    let channelid = message.channel.id;
                    
                    if (message.channel.type === "DirectMessage") {
                        if (!this.param('privatemessages')) { return; }
                        type = "private";
                        channelid = message.author.id;
                    } else {
                        if (message.channel.serverId !== this._server.id) { return; }
                    }

                    this.emit('message', this, type, message.content, message.author.id, channelid, message);
                });
                
                
                this._localClient.on("serverMemberJoin", (member) => {
                    if (member.server.id !== this._server.id) { return; }

                    const chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerJoin(member.id, chans, {reason: "add"});
                    }
                    for (const roleid of member.roles) {
                        this.emit('gotRole', this, member.id, roleid);
                    }
                });


                this._localClient.on("serverMemberLeave", (member) => {
                    if (member.server.id !== this._server.id) { return; }
                    if (!member.user.online) { return; }

                    const chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerPart(member.id, chans, {reason: "remove"});
                    }
                    for (const roleid of member.roles) {
                        this.emit('lostRole', this, member.id, roleid);
                    }
                });


                this._localClient.on("serverMemberUpdate", (member, previousMember) => {
                    if (member.server.id !== this._server.id) { return; }
                    if (!member.user.online) { return; }

                    //Channels
                
                    let had = {};
                    for (const chan of this.findAccessChannels(previousMember)) {
                        had[chan.id] = chan;
                    }
                    
                    const tojoin = [];
                    const topart = [];
                    
                    for (const chan of this.findAccessChannels(member)) {
                        if (!had[chan.id]) {
                            tojoin.push(chan);
                        } else {
                            delete had[chan.id];
                        }
                    }
                    for (const chanid in had) {
                        topart.push(had[chanid]);
                    }            
                
                    if (tojoin.length) {
                        this.triggerJoin(member.id, tojoin, {reason: "permissions"});
                    }
                    if (topart.length) {
                        this.triggerPart(previousMember.id, topart, {reason: "permissions"});
                    }
                    
                    //Roles
                    
                    had = {};
                    for (const roleid of previousMember.roles) {
                        had[roleid] = true;
                    }
                    
                    const toget = [];
                    const tolose = [];
                    
                    for (const roleid of member.roles) {
                        if (!had[roleid]) { toget.push(roleid); }
                        else { delete had[roleid]; }
                    }
                    for (const roleid in had) {
                        tolose.push(roleid);
                    }
                    
                    for (const roleid of toget) {
                        this.emit('gotRole', this, member.id, roleid, null, true);
                    }
                    
                    for (const roleid of tolose) {
                        this.emit('lostRole', this, previousMember.id, roleid, null, true);
                    }
                    
                });
                
                
                this._localClient.on("userUpdate", (user, previousUser) => {
                    let reason = null;

                    if (!previousUser.online && user.online) {
                        reason = "join";
                    }
                    if (previousUser.online && !user.online) {
                        reason = "part";
                    }
                    if (!reason) { return; }
                    
                    const member = this._server.getMember(user.id);
                    if (!member) { return; }
                    const chans = this.findAccessChannels(member);
                    
                    if (reason === "join") {
                        this.triggerJoin(member.id, chans, {reason: reason, status: user.presence});
                    }
                    if (reason === "part") {
                        if (member) {
                            this.triggerPart(member.id, chans, {reason: reason, status: previousUser.presence});
                        }
                    }
                });
                
                
                this.log("Environment is now ready!");
                
                this._hasConnected = true;
                this.emit('connected', this);
            });

    }

    disconnect() {
        return this._localClient.detachFromClient(this)
            .then(() => {
                this._client = null;
                this._server = null;
                this.log(`Disconnected from ${this._name}`);
                this.emit('disconnected', this);
            });
    }


    async msg(targetid, msg, options) {
        const targetchan = await this.getActualChanFromTarget(targetid);
        if (!targetchan || !options && !msg) { return false; }
        
        if (!options) {
            options = {};
        } else {
            options = {...options};
        }

        if (msg) {
            if (typeof msg === "object") {
                if (msg.type !== undefined) {
                    options.embeds = [msg];
                } else if (msg.originalUrl !== undefined) {
                    options.attachments = [msg];
                } else {
                    for (const key in msg) {
                        options[key] = msg[key];
                    }
                }
            } else {
                if (msg.length > MAXIMUM_MSG_LENGTH) {
                    let code = msg.trim().match(/^```[a-z]?/i);
                    if (!msg.trim().match(/```$/)) { code = undefined; }
                    const partPromises = [];
                    for (const part of this.splitMessage(msg, {
                        maxLength: MAXIMUM_MSG_LENGTH,
                        prepend: code ? code[0] : undefined,
                        append: code ? '```' : undefined
                    })) {
                        if (part !== msg) {
                            partPromises.push(this.msg(targetid, part, options));
                        }
                    }
                    return Promise.all(partPromises);
                } else {
                    options.content = msg;
                }
            }
        }

        return this._localClient.outbox(targetchan, options);
    }

    react(msg, emoji) {
        return this._localClient.reactionbox(msg, emoji);
    }
    
    notice(targetid, msg, options) {
        this.msg(targetid, msg, options);
    }


    idToDisplayName(id) {
        const member = this._server.getMember(id);
        if (member) { return member.displayName; }
        const user = this._client.users.get(id);
        if (user) { return user.displayName; }
        return id;
    }
    
    async displayNameToId(displayname) {
        let refuser = null;

        try {
            refuser = await this._server.fetchMember(displayname);  //By ID
        } catch (e) { /*do nothing*/ }
        if (!refuser) {
            const {members} = await this._server.fetchMembers();
            refuser = members.find(member => member.displayName === displayname);
        }

        if (refuser) {
            return refuser.id;
        }
        
        return null;
    }
    
    
    idToMention(id) {
        return "<@" + id + ">";
    }
    
    
    idIsSecured(id) {
        return !!this._server.getMember(id);
    }
    
    idIsAuthenticated(id) {
        return !!this._server.getMember(id);
    }

    
    async listUserIds(channel) {
        const targetchan = await this.getActualChanFromTarget(channel);
        if (!targetchan) { return []; }
        
        return targetchan.recipients.map(recipient => recipient.id);
    }
    
    listUserRoles(id, channel) {
        const member = this._server.getMember(id);
        if (!member) { return []; }
        return member.orderedRoles;
    }
    
    
    channelIdToDisplayName(channelid) {
        const channel = this._server.channels.find(channel => channel.id === channelid);
        if (channel) { return channel.name; }
        return channelid;
    }
    
    async channelIdToType(channelid) {
        const chan = await this.getActualChanFromTarget(channelid);
        if (!chan) { return "unknown"; }
        if (chan.type === undefined || chan.type === "DirectMessage") { return "private"; }
        return "regular";
    }
    
    roleIdToDisplayName(roleid) {
        const role = this._server.roles.get(roleid);
        if (role) { return role.name; }
        return roleid;
    }
    
    
    displayNameToRoleId(displayName) {
        if (!displayName) { return null; }
        const role = this._server.orderedRoles.find(r => r.name.toLowerCase() === displayName.toLowerCase());
        if (role) { return role.id; }
        return null;
    }
    
    
    normalizeFormatting(text) {
        text = String(text).replace(/<%([0-9A-Z]+)>/g, (match, id) => {
            const role = this._server.roles.get(id);
            if (!role) { return ""; }
            return "@" + role.name;
        });
        
        text = text.replace(/<@([0-9A-Z]+)>/g, (match, id) => {
            const user = this._server.getMember(id);
            if (!user) { return ""; }
            return "@" + user.displayName;
        });
        
        text = text.replace(/<#([0-9]+)>/g, (match, id) => {
            const chan = this._server.channels.find(channel => channel.id === id);
            if (!chan) { return ""; }
            return "#" + chan.name;
        });
    
        return text.replace(/~~(.*?)~~/g, "$1").replace(/(^|[^a-z0-9])_(.*?)_([^a-z0-9]|$)/gi, "$1*$2*$3");
    }
    
    
    applyFormatting(text) {
        //Normalized formatting is already fully compatible with Stoat (underline not supported)
        return String(text);
    }


    //Auxiliary methods
    
    get client() { return this._localClient; }
    get server() { return this._server; }
    
    
    async getActualChanFromTarget(targetid) {
        let targetchan = null;

        if (typeof targetid === "string") {
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.find(channel => BASE_CHANNEL_OPERATIONS.includes(channel.type) && channel.id === targetid);
            }
            if (!this._channels[targetid]) {
                const targetmember = this._server.getMember(targetid);
                if (targetmember) {
                    this._channels[targetid] = await targetmember.user.openDM();
                }
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.find(channel => BASE_CHANNEL_OPERATIONS.includes(channel.type) && channel.name.toLowerCase() === targetid.toLowerCase());
            }
            if (!this._channels[targetid] && this._server.queryMembersExperimental) {
                const query = await this._server.queryMembersExperimental(targetid);
                if (query.users.length) {
                    this._channels[targetid] = await query.users[0].openDM();
                }
            }
            if (this._channels[targetid]) {
                targetchan = this._channels[targetid];
            }
        } else {
            targetchan = targetid;
        }
        
        return targetchan;
    }


    findAccessChannels(member) {
        const channels = [];
        if (!member) { return channels; }
        
        for (const channel of member.server.channels) {
            if (member.hasPermission(channel, "ViewChannel")) {
                channels.push(channel);
            }
        }
        
        return channels;
    }
    
    
    triggerJoin(authorid, channels, info) {
        if (!info) { info = {}; }
        for (const channel of channels) {
            this.emit('join', this, authorid, channel.id, info);
        }
    }
    
    triggerPart(authorid, channels, info) {
        if (!info) { info = {}; }
        for (const channel of channels) {
            this.emit('part', this, authorid, channel.id, info);
        }
    }


    scanEveryMessage(channel, onMessage, onEnd) {
        if (!channel || !onMessage) { return; }
        let scanning = null;
        let promise = null;
        const scanner = () => {
            promise = channel.fetchMessagesWithUsers({
                limit: 100,
                before: scanning
            }).then(({messages}) => {
                let endNow = false;
                const messagesarr = [...messages.values()];
                if (messagesarr.length < 100) { endNow = true; }
                for (const message of messagesarr) {
                    promise = promise.then(() => onMessage(message));
                }
                if (!endNow) {
                    scanning = messagesarr[messagesarr.length - 1].id;
                    promise = promise.then(() => setTimeout(scanner, 500));
                } else if (onEnd) {
                    promise = promise.then(() => onEnd(channel));
                }
            });
        };
        scanner();
    }


    extractRoleId(roleid) {
        if (!roleid) { return null; }
        if (roleid.match(/^[0-9A-Z]+$/)) { return roleid; }
        const extr = roleid.match(/<%([0-9A-Z]+)>/);
        if (extr) { return extr[1]; }
        return null;
    }

    extractChannelId(channelid) {
        if (!channelid) { return null; }
        if (channelid.match(/^[0-9]+$/)) { return channelid; }
        const extr = channelid.match(/<#([0-9A-Z]+)>/);
        if (extr) { return extr[1]; }
        return null;
    }

    extractRoleIdsFromCollection(roleids) {
        if (!roleids) { return []; }
        return roleids.map(roleid => this.extractRoleId(roleid)).filter(checkroleid => !!checkroleid);
    }

    extractChannelIdsFromCollection(channelids) {
        if (!channelids) { return []; }
        return channelids.map(channelid => this.extractChannelId(channelid)).filter(checkchannelid => !!checkchannelid);
    }


    //Written by the djs contributors
    splitMessage(text, { maxLength = 2_000, char = '\n', prepend = '', append = '' } = {}) {
        text = verifyString(text);
        if (text.length <= maxLength) { return [text]; }
        let splitText = [text];
        if (Array.isArray(char)) {
            while (char.length > 0 && splitText.some(elem => elem.length > maxLength)) {
                const currentChar = char.shift();
                if (currentChar instanceof RegExp) {
                    splitText = splitText.flatMap(chunk => chunk.match(currentChar));
                } else {
                    splitText = splitText.flatMap(chunk => chunk.split(currentChar));
                }
            }
        } else {
            splitText = text.split(char);
        }
        if (splitText.some(elem => elem.length > maxLength)) { throw new RangeError('SPLIT_MAX_LEN'); }
        const messages = [];
        let msg = '';
        for (const chunk of splitText) {
            if (msg && (msg + char + chunk + append).length > maxLength) {
                messages.push(msg + append);
                msg = prepend;
            }
            msg += (msg && msg !== prepend ? char : '') + chunk;
        }
        return messages.concat(msg).filter(m => m);
    }

}
